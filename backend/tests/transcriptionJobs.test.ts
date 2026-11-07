import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { transcriptionDeps, TRANSCRIPTION_MAX_BYTES, registerTranscriptionJobs, setTranscriptionAvailabilityForTests } from "@/speech/transcriptionJobs";
import { setSupervisorFactoryForTests, scriptedProcess, resetSupervisorForTests } from "@/lib/supervisor";
import { sha256Hex } from "@/music/provenance";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mediaDeps, resetMediaDepsForTests } from "@/media/jobs";

const GB = 1_073_741_824;
function wav(seconds: number): Uint8Array { const samples = new Float32Array(seconds * 16_000); const bytes = new Uint8Array(44 + samples.length * 2); const view = new DataView(bytes.buffer); const tag = (p: number, s: string) => [...s].forEach((c, i) => bytes[p + i] = c.charCodeAt(0)); tag(0,"RIFF"); view.setUint32(4, bytes.length-8,true); tag(8,"WAVE"); tag(12,"fmt "); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true); view.setUint16(34,16,true); tag(36,"data"); view.setUint32(40,samples.length*2,true); for(let i=0;i<samples.length;i++) view.setInt16(44+i*2,0,true); return bytes; }
const source = wav(2);
const request = (payload: Record<string, unknown>) => app.request("/v1/audio/transcriptions/jobs", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({timeout_ms:20_000,...payload}) });
const base = (bytes = source, extra: Record<string, unknown> = {}) => ({ source:Buffer.from(bytes).toString("base64"), source_sha256:sha256Hex(bytes), ...extra });
const original = { ...transcriptionDeps };
beforeEach(() => { __resetJobsForTests(); __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes:128*GB, freeMemoryBytes:90*GB, tier:"p128" }); registerTranscriptionJobs(); setTranscriptionAvailabilityForTests(()=>true); setSupervisorFactoryForTests(async(role)=>scriptedProcess(role)); mediaDeps.toolbox={path:async(tool)=>tool==="ffmpeg"?"/fake/ffmpeg":"/fake/ffprobe",installed:()=>true}; mediaDeps.run=async()=>({code:0,stdout:"",stderr:"",aborted:false} as any); transcriptionDeps.probe=async()=>({has_audio:true,duration_s:2} as any); transcriptionDeps.extract=async(_ffmpeg,_src,out,_signal)=>{await Bun.write(out,source);}; transcriptionDeps.detect=async()=>[{startSample:0,endSample:16_000}]; transcriptionDeps.transcribe=async()=>({text:"Hello there",tokens:["▁Hello","▁there"],timestamps:[0.1,0.6],ys_log_probs:[-0.1,-0.2]}); });
afterEach(()=>{ Object.assign(transcriptionDeps,original); resetMediaDepsForTests(); setTranscriptionAvailabilityForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); rmSync(join(dataDir,"tmp","transcriptions"),{recursive:true,force:true}); });

test("scripted engine extracts, times words, reports ignored vocabulary and keeps transcript results in memory", async()=>{ const r=await request(base(source,{vocabulary:["MaiPai"]})); expect(r.status).toBe(200); const data=(await r.json() as any).data; expect(data.language).toBe("en"); expect(data.vocabulary_applied).toBe(false); expect(data.segments[0].words).toEqual([{text:"Hello",start:0.1,end:0.6},{text:"there",start:0.6,end:1}]); });
test("unsupported language, nonmedia file, bad checksum and oversize input are refused",async()=>{expect((await request(base(source,{language:"fr"}))).status).toBe(422);expect((await request(base(new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24])))).status).toBe(422);expect((await request({...base(),source_sha256:"0".repeat(64)})).status).toBe(422); const big=new Uint8Array(TRANSCRIPTION_MAX_BYTES+1); expect((await request(base(big))).status).toBe(413);});
test("range and memory estimate use only the selected range",async()=>{ const estimate=(await import("@/speech/transcriptionJobs")).transcriptionMemory({input:{from_s:10,to_s:20}} as any); expect(estimate.requestedBytes).toBe(2_306_000_000); });
test("cancel interrupts a transcription while it waits between spans",async()=>{ transcriptionDeps.transcribe=(_base,_samples,_hotwords,signal)=>new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("Cancelled.")),{once:true})); const r=await request(base(source,{timeout_ms:1})); const {job}=await r.json() as any; const cancelled=await app.request(`/v1/audio/transcriptions/jobs/${job}`,{method:"DELETE"}); expect(cancelled.status).toBe(200); expect((await cancelled.json() as any).state).toBe("cancelled"); });
test("a gated installed-engine probe is available on the dispatcher host", async()=>{ if(process.env.MAIPAI_REAL_ENGINES!=="1") return; const session=await (await import("@/lib/supervisor")).openRoleSession("stt"); try { const result=await transcriptionDeps.transcribe(session.baseUrl,new Float32Array(16_000),undefined,new AbortController().signal); expect(result.text.length).toBeGreaterThan(0); } finally { session.release(); } });

test("duration and out of file range errors use 413 and 422",async()=>{ transcriptionDeps.probe=async()=>({has_audio:true,duration_s:TRANSCRIPTION_MAX_BYTES as any} as any); let response=await request(base()); expect(response.status).toBe(413); transcriptionDeps.probe=async()=>({has_audio:true,duration_s:2} as any); response=await request(base(source,{from_s:1,to_s:4})); expect(response.status).toBe(422); });

// CAPTION-01g
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assignSpeakers, validateDiarizeOptions, DIARIZATION_FILES, diarizationFilesFor, installedDiarizationFiles } from "@/speech/diarization";
import { parseWorkerArgs } from "@/speech/worker";
import { speechWorkerCommand } from "@/lib/supervisor";
const diarDir = (withFiles: boolean) => { const dir = mkdtempSync(join(tmpdir(), "diar-")); if (withFiles) for (const file of Object.values(DIARIZATION_FILES)) writeFileSync(join(dir, file), "x"); process.env.MAIPAI_DIARIZATION_DIR = dir; return dir; };
afterEach(() => { delete process.env.MAIPAI_DIARIZATION_DIR; });

test("a selected range is cut by ffmpeg and every time is offset back to the original timeline", async () => {
  let seen: { fromS: number; toS: number } | undefined;
  transcriptionDeps.probe = async () => ({ has_audio: true, duration_s: 100 } as any);
  transcriptionDeps.extract = async (_f, _s, out, _sig, _p, range) => { seen = range; await Bun.write(out, source); };
  const r = await request(base(source, { from_s: 40, to_s: 42 })); expect(r.status).toBe(200);
  expect(seen).toEqual({ fromS: 40, toS: 42 });
  const segment = (await r.json() as any).data.segments[0]; expect(segment.words[0]).toEqual({ text: "Hello", start: 40.1, end: 40.6 }); expect(segment.start).toBe(40.1);
});
test("range and option validation use plain 422 messages", async () => {
  for (const extra of [{ from_s: 5 }, { from_s: 5, to_s: 5 }, { from_s: 5, to_s: 3 }, { num_speakers: 2 }, { diarize: true, num_speakers: 0 }, { diarize: true, num_speakers: 2.5 }, { diarize: true, num_speakers: 99 }]) {
    const r = await request(base(source, extra)); expect(r.status).toBe(422); expect(((await r.json()) as any).error.length).toBeGreaterThan(20);
  }
  expect(validateDiarizeOptions(true, 3)).toBeNull(); expect(validateDiarizeOptions(true)).toBeNull();
});
test("assignSpeakers picks the greatest overlap and numbers speakers by first appearance", () => {
  const segs = [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 }, { start: 50, end: 51 }];
  const turns = [{ start: 0, end: 1, speaker: 1 }, { start: 1, end: 4.5, speaker: 0 }, { start: 4.5, end: 12, speaker: 1 }];
  const out = assignSpeakers(segs, turns);
  expect(out.segments.map((s) => s.speaker)).toEqual(["spk-1", "spk-2", "spk-2", undefined]);
  expect(out.speakers).toEqual([{ id: "spk-1", label: "Speaker 1" }, { id: "spk-2", label: "Speaker 2" }]);
});
test("diarize assigns speakers from a fake diarizer, offset by the range", async () => {
  diarDir(true); let asked: number | undefined;
  transcriptionDeps.probe = async () => ({ has_audio: true, duration_s: 100 } as any);
  transcriptionDeps.diarize = async (_b, _wav, n) => { asked = n; return [{ start: 0, end: 1, speaker: 7 }]; };
  const r = await request(base(source, { diarize: true, num_speakers: 2, from_s: 10, to_s: 12 })); expect(r.status).toBe(200);
  const data = (await r.json() as any).data; expect(asked).toBe(2);
  expect(data.diarization).toBe("done"); expect(data.speakers).toEqual([{ id: "spk-1", label: "Speaker 1" }]); expect(data.segments[0].speaker).toBe("spk-1");
});
test("missing models, or a diarizer that fails, return the transcript without speakers", async () => {
  diarDir(false); let called = false; transcriptionDeps.diarize = async () => { called = true; return []; };
  let data = (await (await request(base(source, { diarize: true }))).json() as any).data;
  expect(called).toBe(false); expect(data.diarization).toBe("unavailable"); expect(data.diarization_note).toContain("not installed"); expect(data.segments[0].text).toBe("Hello there"); expect(data.speakers).toBeUndefined(); expect(data.segments[0].speaker).toBeUndefined();
  diarDir(true); transcriptionDeps.diarize = async () => { throw new Error("boom with text"); };
  const r = await request(base(source, { diarize: true })); expect(r.status).toBe(200); data = (await r.json() as any).data;
  expect(data.diarization).toBe("unavailable"); expect(data.diarization_note).not.toContain("boom"); expect(data.segments).toHaveLength(1);
});
test("without diarize the result has no speaker fields", async () => { const data = (await (await request(base())).json() as any).data; expect(data.diarization).toBeUndefined(); expect(data.speakers).toBeUndefined(); });

describe("speaker detection models installed as catalog components", () => {
  const record = (component: string, modelPath: string | null) => ({ modelPath, engineRequirements: { component } });
  const installed = () => {
    const root = mkdtempSync(join(tmpdir(), "diar-installed-"));
    const packageDir = join(root, "sherpa-onnx-pyannote-segmentation-3-0");
    mkdirSync(packageDir);
    writeFileSync(join(packageDir, "model.int8.onnx"), "seg");
    const embedding = join(root, "nemo_en_titanet_small.onnx");
    writeFileSync(embedding, "emb");
    return { packageDir, embedding };
  };

  test("both components installed give the two file paths; one missing or a deleted file gives none", () => {
    const { packageDir, embedding } = installed();
    const records = [record("diarization-segmentation", packageDir), record("diarization-embedding", embedding)];
    expect(installedDiarizationFiles(records)).toEqual({ segmentation: join(packageDir, "model.int8.onnx"), embedding });
    expect(installedDiarizationFiles(records.slice(0, 1))).toBeNull();
    expect(installedDiarizationFiles([record("diarization-segmentation", packageDir), record("diarization-embedding", null)])).toBeNull();
    expect(installedDiarizationFiles([record("diarization-segmentation", join(packageDir, "gone")), record("diarization-embedding", embedding)])).toBeNull();
  });

  test("the override folder wins over installed components and is checked on disk", () => {
    const { packageDir, embedding } = installed();
    const records = [record("diarization-segmentation", packageDir), record("diarization-embedding", embedding)];
    const before = process.env.MAIPAI_DIARIZATION_DIR;
    try {
      process.env.MAIPAI_DIARIZATION_DIR = join(tmpdir(), "no-such-diar-dir");
      expect(diarizationFilesFor(records)).toBeNull();
      delete process.env.MAIPAI_DIARIZATION_DIR;
      expect(diarizationFilesFor(records)?.embedding).toBe(embedding);
    } finally { if (before === undefined) delete process.env.MAIPAI_DIARIZATION_DIR; else process.env.MAIPAI_DIARIZATION_DIR = before; }
  });

  test("the worker command carries the two files and the worker reads them back", () => {
    const files = { segmentation: "/m/seg/model.int8.onnx", embedding: "/m/emb.onnx" };
    const command = speechWorkerCommand({ role: "stt", port: 9000, modelPath: "/m/parakeet", vadPath: "/m/vad.onnx", threads: 2, diarization: files }, { execPath: "/usr/bin/bun", main: "/app/index.ts", isCompiled: false });
    expect(parseWorkerArgs(command.slice(command.indexOf("speech-worker")).slice(0)).diarization).toEqual(files);
    const plain = speechWorkerCommand({ role: "stt", port: 9000, modelPath: "/m/parakeet", vadPath: "/m/vad.onnx", threads: 2 }, { execPath: "/usr/bin/bun", main: "/app/index.ts", isCompiled: false });
    expect(plain.includes("--diar-seg")).toBe(false);
    expect(parseWorkerArgs(plain.slice(plain.indexOf("speech-worker"))).diarization).toBeUndefined();
  });
});
