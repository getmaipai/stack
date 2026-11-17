import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob } from "@/lib/jobs";
import { componentDefs } from "@/lib/components";
import { buildDiskPlan } from "@/lib/diskPlan";
import { STACK_SCORE_MODEL_BUNDLE } from "@/lib/modelCatalog";
import { scoreInstallModels } from "@/lib/installPlan";
import { partDef } from "@/lib/partDefs";
import { dataDir } from "@/lib/paths";
import { registerScoreJobs, SCORE_JOB_KIND, runScore, stashScore } from "@/score/jobs";
import { useScoreDepsForTests, SCORE_PEAK_BYTES, type ScoreDeps } from "@/score/scoreGen";
import type { Job } from "@/lib/jobs";

const GB = 1_073_741_824;
const scratch = mkdtempSync(join(tmpdir(), "score-test-"));
const audio = join(scratch, "input.wav");
let deps: ScoreDeps;
function scripted(): ScoreDeps {
  return { supported: () => true, ready: () => true, ensure: async () => {}, ffmpeg: async () => "/bin/ffmpeg", runWorker: async (req, _signal, stage) => {
    stage("score", 0.8); mkdirSync(req.output_dir, { recursive: true }); writeFileSync(join(req.output_dir, `${req.id}.mid`), new Uint8Array([77, 84, 104, 100])); writeFileSync(join(req.output_dir, `${req.id}.notes.json`), JSON.stringify([{ start: 0.1, end: 0.5, pitch: 60, velocity: 90 }])); return { id: req.id, ok: true, tempo_bpm: 120, notes: 1, ms: 40 };
  } };
}
function post(body: unknown) { return app.request("/v1/audio/score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function waitDone(id: string) { for (let i = 0; i < 80; i++) { const job = getJob(id); if (job?.state === "done" || job?.state === "failed") return job; await new Promise((resolve) => setTimeout(resolve, 25)); } throw new Error("job did not finish"); }
beforeEach(() => { __resetJobsForTests(); __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" }); rmSync(join(dataDir, "score"), { recursive: true, force: true }); writeFileSync(audio, "fake audio input"); deps = scripted(); useScoreDepsForTests(deps); registerScoreJobs(); });
afterEach(() => { useScoreDepsForTests(null); __resetJobsForTests(); rmSync(join(dataDir, "score"), { recursive: true, force: true }); });

test("POST accepts a Stack host path, queues score work, then serves MIDI and notes with tempo", async () => {
  const response = await post({ path: audio }); expect(response.status).toBe(200); const { id } = await response.json() as { id: string };
  const job = await waitDone(id); expect(job.state).toBe("done"); expect(job.result).toMatchObject({ tempo_bpm: 120, notes: 1 });
  const status = await (await app.request(`/v1/audio/score/${id}`)).json() as any; expect(status.data).toEqual({ midi: `/v1/audio/score/${id}/file?kind=midi`, notes: `/v1/audio/score/${id}/file?kind=notes` }); expect(status.result.tempo_bpm).toBe(120);
  expect((await app.request(`/v1/audio/score/${id}/file?kind=midi`)).headers.get("content-type")).toBe("audio/midi");
  expect(await (await app.request(`/v1/audio/score/${id}/file?kind=notes`)).json()).toEqual([{ start: 0.1, end: 0.5, pitch: 60, velocity: 90 }]);
});

test("multipart audio uploads enter the same score job route", async () => {
  const form = new FormData(); form.set("file", new File([new Uint8Array([1, 2, 3])], "melody.wav", { type: "audio/wav" }));
  const response = await app.request("/v1/audio/score", { method: "POST", body: form }); expect(response.status).toBe(200);
  const { id } = await response.json() as { id: string }; expect((await waitDone(id)).state).toBe("done");
});

test("queued score work holds one GB on the music generator admission", async () => {
  let entered!: () => void, release!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; });
  deps = { ...scripted(), runWorker: async (req, _signal, stage) => { entered(); await waiting; stage("score", 0.7); mkdirSync(req.output_dir, { recursive: true }); writeFileSync(join(req.output_dir, `${req.id}.mid`), new Uint8Array([77, 84])); writeFileSync(join(req.output_dir, `${req.id}.notes.json`), "[]"); return { id: req.id, ok: true, tempo_bpm: 100, notes: 0 }; } }; useScoreDepsForTests(deps);
  const response = await post({ path: audio }); const { id } = await response.json() as { id: string }; await started;
  expect(getGovernorStatus().loaded.filter((item) => item.kind === "generator").map((item) => item.peakBytes)).toContain(SCORE_PEAK_BYTES); release(); expect((await waitDone(id)).state).toBe("done");
});

test("GET /stack/v1/score reports bundled model identity and the current memory basis", async () => {
  const status = await (await app.request("/stack/v1/score")).json() as any;
  expect(status.score).toMatchObject({ engine: "score-gen", model: { id: "basic-pitch-0.4.0", bundled: true, licence: "Apache-2.0" }, memory: { peak_gb: 1, basis: "estimate" }, limits: { max_seconds: 600, max_notes: 20_000 } });
});

test("score job dispatch reports a readable missing input", async () => {
  const token = crypto.randomUUID(); stashScore(token, join(scratch, "missing.wav"), false); const job = { id: "score-job", input: { token } } as unknown as Job;
  await expect(runScore(job, new AbortController().signal, () => {})).rejects.toThrow("audio file is missing");
});

test("Basic Pitch is bundled with its component and its optional disk-plan engine row", () => {
  expect(STACK_SCORE_MODEL_BUNDLE).toMatchObject({ id: "basic-pitch-0.4.0", component: "score-gen", license: "Apache-2.0", bundled: true });
  expect(scoreInstallModels()).toEqual([]);
  expect(componentDefs().find((component) => component.id === "score-gen")?.summary).toBe(partDef("score-gen")!.description);
  const row = buildDiskPlan({ id: "p128", level: "max", resident: [], onDemand: [], notAvailable: [] } as any).rows.find((candidate) => candidate.id === "score-transcription");
  expect(row).toMatchObject({ need: "optional", engines: ["engine:score", "engine:python"], model_ids: [] });
});

const real = !!process.env.SCORE_REAL_AUDIO && !!process.env.SCORE_GEN_PYTHON && existsSync(process.env.SCORE_GEN_PYTHON) && !!process.env.SCORE_FFMPEG && existsSync(process.env.SCORE_FFMPEG);
test.skipIf(!real)("real Basic Pitch worker transcribes a short offline fixture", async () => {
  const fixture = join(scratch, "tone.wav"), out = join(scratch, "real-out"); mkdirSync(out, { recursive: true });
  const make = Bun.spawnSync([process.env.SCORE_FFMPEG!, "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "22050", "-ac", "1", "-y", fixture]); expect(make.exitCode).toBe(0);
  const child = Bun.spawn([process.env.SCORE_GEN_PYTHON!, "-s", new URL("../src/score/score_worker.py", import.meta.url).pathname], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HF_HUB_OFFLINE: "1", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
  child.stdin.write(JSON.stringify({ id: "real-score", input: fixture, output_dir: out, ffmpeg: process.env.SCORE_FFMPEG }) + "\n"); child.stdin.flush(); const output = await new Response(child.stdout).text(); expect(await child.exited).toBe(0); expect(JSON.parse(output).ok).toBe(true); expect(existsSync(join(out, "real-score.mid"))).toBe(true);
});
