import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests, registerJobRunner, submitJob } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerRecordedSpeechJobs } from "@/recordedSpeech/jobs";
import { handle, recordedSpeech, type RecordedSpeechDeps, type RecordedSpeechRequest } from "@/recordedSpeech/recordedSpeech";
import { removeWorkerDir, startLeakyWorker, waitForWorkerRequest, waitForWorkerTreeGone, waitForWorkerPids } from "./helpers/leakyWorker";

const GB = 1_073_741_824;
function wav(seconds = 8): Uint8Array {
  const rate = 8_000, samples = rate * seconds, dataBytes = samples * 2, bytes = new Uint8Array(44 + dataBytes), view = new DataView(bytes.buffer);
  const put = (at: number, text: string) => bytes.set(new TextEncoder().encode(text), at);
  put(0, "RIFF"); view.setUint32(4, 36 + dataBytes, true); put(8, "WAVEfmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); put(36, "data"); view.setUint32(40, dataBytes, true); for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 13) * 1200), true); return bytes;
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
let seen: RecordedSpeechRequest | null;
function deps(): RecordedSpeechDeps { return { supported: () => true, installed: () => true, ensure: async () => {}, modelPath: () => "/models/fish", spawn: async () => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (request, stage) => { seen = request; stage("rendering", .5); writeFileSync(request.output, request.format === "wav" ? wav(2) : "ftyp-fake-aac"); return { ms: 10, duration: 2, sample_rate: 24_000 }; } }) }; }
const post = (body: unknown) => app.request("/v1/audio/speech/recorded", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);
const clip = b64(wav());
beforeEach(() => { seen = null; __resetJobsForTests(); __resetGovernorForTests(); rmSync(join(dataDir, "speech-recorded"), { recursive: true, force: true }); rmSync(join(dataDir, "tmp", "speech-recorded"), { recursive: true, force: true }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" }); registerRecordedSpeechJobs(); });
afterEach(() => { recordedSpeech.useDeps(null); rmSync(join(dataDir, "speech-recorded"), { recursive: true, force: true }); });

test("status exposes recorded speech installation and limits", async () => { recordedSpeech.useDeps(deps()); const status = await get("/stack/v1/speech-recorded"); expect(status.status).toBe(200); const payload = await status.json() as any; expect(payload.recorded_speech.limits.max_text_chars).toBe(4_000); expect(payload.recorded_speech.limits.max_speakers).toBe(4); expect(payload.recorded_speech.limits.peak_bytes).toBe(30_000_000_000); });
test("fake worker returns a WAV through the recorded-speech job", async () => { recordedSpeech.useDeps(deps()); const response = await post({ text: "Read this aloud.", reference: clip, reference_text: "A short reference sample." , format: "wav" }); expect(response.status).toBe(200); const body = await response.json() as any; expect(body.data.content_type).toBe("audio/wav"); expect((await get(body.data.url)).status).toBe(200); });
test("dialogue references pass together to one worker call", async () => { recordedSpeech.useDeps(deps()); const text = "<|speaker:0|> Hello. <|speaker:1|> Hi."; const response = await post({ text, speakers: [{ reference: clip, reference_text: "Speaker one." }, { reference: clip, reference_text: "Speaker two." }] }); expect(response.status).toBe(200); expect(seen?.text).toBe(text); expect(seen?.references).toHaveLength(2); });
test("rejects too much text, invalid reference duration, too many speakers and missing transcript", async () => { recordedSpeech.useDeps(deps()); expect((await post({ text: "x".repeat(4001) })).status).toBe(422); expect((await post({ text: "Hello.", reference: b64(wav(5)), reference_text: "sample" })).status).toBe(422); expect((await post({ text: "Hello.", speakers: Array.from({ length: 5 }, () => ({ reference: clip, reference_text: "sample" })) })).status).toBe(422); const missing = await post({ text: "Hello.", reference: clip }); expect(missing.status).toBe(422); expect((await missing.json() as any).error).toContain("sample's words"); });
test("unsupported tier reports unsupported", async () => { __setGovernorTuningForTestsOnly({ totalMemoryBytes: 16 * GB, freeMemoryBytes: 12 * GB, tier: "p16" }); recordedSpeech.useDeps(deps()); const status = await get("/stack/v1/speech-recorded"); expect((await status.json() as any).recorded_speech.state).toBe("unsupported"); expect((await post({ text: "Hello." })).status).toBe(503); });
test("recorded speech waits behind an active image generator", async () => {
  recordedSpeech.useDeps(deps()); let release!: () => void; let started = false;
  registerJobRunner("image_priority_test", async () => { started = true; await new Promise<void>((resolve) => { release = resolve; }); return {}; }, { generator: { role: "image", memory: () => ({ requestedBytes: 1_000_000_000, measuredPeakBytes: 1_000_000_000, engine: "test-image" }) } });
  const image = submitJob({ kind: "image_priority_test", role: "image", input: {} }); expect("refused" in image).toBe(false);
  for (let i = 0; i < 100 && !started; i++) await Bun.sleep(5);
  const speech = await post({ text: "Wait for the image.", timeout_ms: 1 }); expect(speech.status).toBe(202); expect(seen).toBeNull();
  release();
  for (let i = 0; i < 100 && !seen; i++) await Bun.sleep(10);
  expect(seen?.text).toBe("Wait for the image.");
});
test("request text is not placed in status, output metadata or worker diagnostics", async () => { recordedSpeech.useDeps(deps()); const secret = "never-log-this-script"; const response = await post({ text: secret, format: "wav" }); expect(response.status).toBe(200); const result = JSON.stringify(await response.json()); expect(result).not.toContain(secret); expect(seen?.text).toBe(secret); });
test("cancel kills the recorded speech worker process tree", async () => {
  process.env.MAIPAI_TEST_NO_PORTS = "1"; let dir = "";
  recordedSpeech.useDeps({ ...deps(), spawn: async () => { const started = startLeakyWorker(handle as any); dir = started.dir; return started.worker as any; } });
  try { const response = await post({ text: "Cancel this render.", timeout_ms: 1 }); expect(response.status).toBe(202); const id = (await response.json() as any).job; for (let i = 0; i < 500 && !dir; i++) await Bun.sleep(20); const pids = await waitForWorkerPids(join(dir, "pids")); await waitForWorkerRequest(join(dir, "accepted")); await app.request(`/v1/audio/speech/recorded/${id}`, { method: "DELETE" }); expect(await waitForWorkerTreeGone(pids)).toBe(true); }
  finally { if (dir) removeWorkerDir(dir); }
}, 30_000);
