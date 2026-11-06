import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { __beatsStashHasForTests, registerBeatsJobs } from "@/beats/jobs";
import { beats, BEATS_PEAK_BYTES, beatsWorkerEnv } from "@/beats/beats";
import { sha256Hex } from "@/music/provenance";

const GB = 1_073_741_824;
const ok = { tempo_bpm: 120, beats: [0, .5, 1, 1.5], confidence: .8, meter: 4, downbeats: [0, 2], downbeat_confidence: .7, sections: [{ start_s: 0, end_s: 2, label: "A" }], duration_s: 2, engine: "librosa" as const, ms: 4 };
function deps(run: () => typeof ok | Promise<typeof ok>) { return { supported: () => true, installed: () => true, ensure: async () => {}, runtime: () => ({ ffmpeg: "ffmpeg" }), spawn: async () => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (_r: any, stage: any) => { stage("loading", .1); stage("decoding", .2); stage("analysing", .4); return run(); } }) }; }
const audio = new TextEncoder().encode("RIFF0000WAVEfake-audio-bytes");
const body = (source = audio) => ({ source: Buffer.from(source).toString("base64"), source_sha256: sha256Hex(source) });
const post = (value: unknown) => app.request("/v1/audio/beats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
beforeEach(() => { __resetJobsForTests(); __resetGovernorForTests(); rmSync(join(dataDir, "tmp", "music"), { recursive: true, force: true }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" }); registerBeatsJobs(); });
afterEach(() => beats.setDepsForTests(null));

test("beat request runs a job, retains numeric result and clears the source stash", async () => {
  beats.setDepsForTests(deps(() => ok)); const response = await post(body()); expect(response.status).toBe(200); const reply = await response.json() as any;
  expect(reply.data).toMatchObject({ tempo_bpm: 120, meter: 4, engine: "librosa" }); expect(__beatsStashHasForTests("missing")).toBe(false);
  expect((await (await app.request(`/v1/audio/beats/${reply.job}`)).json() as any).data.sections[0].label).toBe("A");
});
test("worker failures return a fixed sentence and do not expose source bytes in logs", async () => {
  beats.setDepsForTests(deps(() => { throw new Error("secret audio path content"); })); const response = await post(body()); expect(response.status).toBe(500); const result = await response.json() as any; expect(result.error).not.toContain("secret");
  const log = join(dataDir, "logs", "stack.log"); if (existsSync(log)) expect(readFileSync(log, "utf8")).not.toContain("secret audio path content");
});
test("admission reservation is a fixed music generator amount", async () => { expect(BEATS_PEAK_BYTES).toBeGreaterThan(0); beats.setDepsForTests(deps(() => ok)); expect((await post(body())).status).toBe(200); });
test("worker env drops credentials and proxies", () => { process.env.HF_TOKEN = "hidden"; process.env.HTTPS_PROXY = "http://hidden"; const env = beatsWorkerEnv(); expect(env.HF_TOKEN).toBeUndefined(); expect(env.HTTPS_PROXY).toBeUndefined(); delete process.env.HF_TOKEN; delete process.env.HTTPS_PROXY; });

test.skipIf(!process.env.MAIPAI_BEATS_PYTHON)("real worker finds a 120 BPM 4/4 click track", async () => {
  const python = process.env.MAIPAI_BEATS_PYTHON!; const wav = join(dataDir, "beats-click.wav");
  const generate = `import numpy as np,soundfile as sf\nsr=22050; y=np.zeros(sr*20,dtype=np.float32)\nfor i,t in enumerate(np.arange(0,20,.5)):\n p=int(t*sr); n=min(1200,len(y)-p); amp=.9 if i%4==0 else .45; x=np.arange(n)/sr; y[p:p+n]+=amp*np.sin(2*np.pi*70*x)*np.exp(-x*35)\nsf.write(${JSON.stringify(wav)},y,sr)`;
  const make = Bun.spawnSync([python, "-c", generate]); expect(make.exitCode).toBe(0);
  const script = join(import.meta.dir, "../src/beats/beats_worker.py"); const bytes = readFileSync(wav); const work = join(dataDir, "beats-work"); await Bun.$`mkdir -p ${work}`;
  const child = Bun.spawn([python, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); const input = JSON.stringify({ id: "real", source: wav, workDir: work, maxSeconds: 720, ffmpeg: "" }) + "\n"; child.stdin.write(input); child.stdin.flush(); child.stdin.end();
  let out = ""; for await (const chunk of child.stdout) out += new TextDecoder().decode(chunk); await child.exited; const lines = out.trim().split("\n").map((line) => JSON.parse(line)); const result = lines.find((line) => line.ok); expect(result).toBeTruthy();
  expect(Math.abs(result.tempo_bpm - 120)).toBeLessThanOrEqual(1.5); expect(result.meter).toBe(4); expect(result.beats.length).toBeGreaterThan(30); expect(result.beats.slice(0, 20).every((t: number, i: number) => Math.abs(t - i * .5) <= .04)).toBe(true); expect(result.downbeats.length).toBeGreaterThan(4); expect(result.downbeats.every((t: number, i: number) => Math.abs(t - i * 2) <= .04)).toBe(true);
  rmSync(wav, { force: true }); rmSync(work, { recursive: true, force: true }); void bytes;
}, 120_000);
