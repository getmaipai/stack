// MP-07: the sound effects service, its job API, the status envelope, the pins, the component with its licence and the disk
// plan, driven by a scripted worker (no model, no GPU). The real worker on real weights runs only when SFX_REAL_MODEL_DIR (the
// pinned folder), SFX_GEN_PYTHON (the prepared environment's python), SFX_GEN_SRC (the extracted stable-audio-3 source) and
// SFX_FFMPEG (an ffmpeg) all exist; it is never part of the gate.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob, listJobs } from "@/lib/jobs";
import { SFX_LICENCE, SFX_LICENCE_NOTICE, STACK_MODELS, STACK_SFX_MODEL, STACK_SFX_MODEL_ID } from "@/lib/modelCatalog";
import { ENGINE_BINARIES, ENGINE_ROLE, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { buildDiskPlan } from "@/lib/diskPlan";
import { PROFILE_TIERS } from "@/profiles";
import { componentDefs, DISK_ROW, startComponentInstall } from "@/lib/components";
import { licenceAcceptance } from "@/lib/licenceAcceptance";
import { dataDir } from "@/lib/paths";
import { __resetMusicProvenanceForTests, sha256Hex, wasMadeHere } from "@/music/provenance";
import { workDir } from "@/music/results";
import { registerSoundJobs, SOUND_JOB_KIND } from "@/sound/jobs";
import {
  SFX_MAX_SECONDS, SFX_PEAK_BYTES, sfxGen, sfxRequirementsFileFor, sfxWorkerEnv, sfxWorkerHandle,
  type SfxGenDeps, type SfxWorkerEvent, type SfxWorkerHandle, type SfxWorkerReply, type SfxWorkerRequest,
} from "@/sound/sfxGen";

const GB = 1_073_741_824;
let spawned = 0;
let killed = 0;
const requests: SfxWorkerRequest[] = [];
let inside = 0;
let maxInside = 0;

type Script = (request: SfxWorkerRequest, emit: (event: SfxWorkerEvent) => void) => Promise<SfxWorkerReply> | SfxWorkerReply;
const fakeM4a = (seed: string): Uint8Array => new TextEncoder().encode(`\u0000\u0000\u0000 ftypM4A \u0000\u0000\u0000\u0000M4A mp42isom fake-sound-${seed}`);
const okReply = (request: SfxWorkerRequest): SfxWorkerReply => ({ id: request.id, ok: true, duration_s: Math.min(request.seconds, 2.75), seed: request.seed, steps: request.steps, ms: 900, peak_bytes: 5_270_000_000, trimmed_s: 1.25, input_lufs: -19.3, normalised: true });

function scripted(script: Script = okReply, over: Partial<SfxGenDeps> = {}): SfxGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    installed: () => true,
    runtime: async () => ({ modelDir: "/models/sfx", ffmpeg: "/engines/ffmpeg/ffmpeg" }),
    spawn: async (): Promise<SfxWorkerHandle> => {
      spawned += 1;
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited,
        kill: () => { killed += 1; end(143); },
        send: async (request, options) => {
          requests.push(request);
          inside += 1; maxInside = Math.max(maxInside, inside);
          try {
            options.onEvent({ id: request.id, event: "stage", stage: "load" });
            options.onEvent({ id: request.id, event: "stage", stage: "sound", fraction: 0.5 });
            const reply = await Promise.race([script(request, options.onEvent), exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "stopped" }) as SfxWorkerReply)]);
            if (reply.ok) writeFileSync(request.output, fakeM4a(request.id));
            return reply;
          } finally { inside -= 1; }
        },
      };
    },
    ...over,
  };
}

function clean(): void {
  sfxGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetMusicProvenanceForTests();
  rmSync(join(dataDir, "music"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "music"), { recursive: true, force: true });
  rmSync(join(dataDir, "licence-acceptances.json"), { force: true });
}
beforeEach(() => {
  spawned = 0; killed = 0; requests.length = 0; inside = 0; maxInside = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerSoundJobs();
});
afterEach(() => { clean(); });

const post = (body: Record<string, unknown>) => app.request("/v1/audio/sound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const door = { prompt: "SECRET-PROMPT a heavy wooden door slamming shut", seconds: 3, timeout_ms: 5000 };
const codeOf = async (response: Response) => (await response.json() as { code: string }).code;

test("a sound is made, polled to done, fetched with a range, recorded as made here, and deleted", async () => {
  sfxGen.useDeps(scripted());
  const response = await post({ ...door, seed: 7 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ url: `/v1/audio/sound/${body.job}/file`, content_type: "audio/mp4", duration_s: 2.75, seed: 7, model: STACK_SFX_MODEL_ID, licence: SFX_LICENCE });
  // The worker is asked for a second more than the sound (the tail it then cuts), 8 steps, the pinned folder and the managed ffmpeg.
  expect(requests[0]).toMatchObject({ prompt: "SECRET-PROMPT a heavy wooden door slamming shut", seconds: 3, gen_seconds: 4, seed: 7, steps: 8, model_dir: "/models/sfx", ffmpeg: "/engines/ffmpeg/ffmpeg" });
  expect(await (await get(`/v1/audio/sound/${body.job}`)).json()).toMatchObject({ state: "done", phase: "ready", progress: 100, error: null, stage: null });
  const full = await get(body.data[0]!.url as string);
  expect(full.headers.get("content-type")).toBe("audio/mp4");
  const bytes = new Uint8Array(await full.arrayBuffer());
  expect(wasMadeHere(bytes)).toBe(true);
  const part = await get(body.data[0]!.url as string, { range: "bytes=2-5" });
  expect(part.status).toBe(206);
  expect((await app.request(`/v1/audio/sound/${body.job}`, { method: "DELETE" })).status).toBe(200);
  expect((await get(body.data[0]!.url as string)).status).toBe(404);
  expect((await get(`/v1/audio/sound/${body.job}`)).status).toBe(404);
  // The admission is back and the work folder is gone.
  expect(getGovernorStatus().loaded.every((item) => item.kind !== "generator")).toBe(true);
  expect(existsSync(workDir(body.job))).toBe(false);
});

test("a sound made here can be trimmed by the music edit", async () => {
  sfxGen.useDeps(scripted());
  const made = await (await post(door)).json() as { data: Array<{ url: string }> };
  const bytes = new Uint8Array(await (await get(made.data[0]!.url)).arrayBuffer());
  const { musicGen } = await import("@/music/musicGen");
  const { registerMusicJobs } = await import("@/music/jobs");
  registerMusicJobs();
  musicGen.useDeps({ supported: () => true, ensureEnvironment: async () => {}, installed: () => true, runtime: () => ({ ckptDir: "/m", ffmpeg: "/f" }), spawn: async () => { let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; }); return { exited, kill: () => end(0), send: async (request) => { writeFileSync(request.output, fakeM4a("edit")); return { id: request.id, ok: true, duration_s: 1, task: "trim" }; } }; } });
  try {
    const edit = await app.request("/v1/audio/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: "edit", source: Buffer.from(bytes).toString("base64"), source_sha256: sha256Hex(bytes), edit: { op: "trim", from_s: 0, to_s: 1.5 }, timeout_ms: 5000 }) });
    expect(edit.status).toBe(200);
  } finally { musicGen.useDeps(null); }
});

test("the description is never kept in a job record, on the feed or in the result store", async () => {
  sfxGen.useDeps(scripted());
  const body = await (await post(door)).json() as { job: string };
  expect(JSON.stringify(getJob(body.job))).not.toContain("SECRET-PROMPT");
  expect(getJob(body.job)!.input).toMatchObject({ seconds: 3, steps: 8, model: STACK_SFX_MODEL_ID });
  const results = join(dataDir, "music", "results", body.job);
  for (const file of readdirSync(results)) expect(readFileSync(join(results, file)).toString("latin1")).not.toContain("SECRET-PROMPT");
});

test("every breach of a limit is a 422 with its own code and a sentence that says what to change", async () => {
  sfxGen.useDeps(scripted());
  for (const [body, code] of [
    [{ prompt: "   " }, "bad_request"],
    [{ prompt: "x".repeat(1001) }, "too_long"],
    [{ prompt: "rain", seconds: 0.5 }, "bad_range"],
    [{ prompt: "rain", seconds: SFX_MAX_SECONDS + 1 }, "bad_range"],
    [{ prompt: "rain", steps: 3 }, "bad_range"],
    [{ prompt: "rain", steps: 17 }, "bad_range"],
    [{ prompt: "rain", loop: true }, "unsupported_option"],
  ] as Array<[Record<string, unknown>, string]>) {
    const response = await post(body);
    expect(response.status).toBe(422);
    const reply = await response.json() as { code: string; error: string };
    expect(reply.code).toBe(code);
    expect(reply.error.length).toBeGreaterThan(20);
  }
  expect(requests).toHaveLength(0);
});

test("past timeout_ms the answer is 202 with the stage in words; cancel stops the worker and returns the memory", async () => {
  let release!: (reply: SfxWorkerReply) => void;
  const gate = new Promise<SfxWorkerReply>((resolve) => { release = resolve; });
  sfxGen.useDeps(scripted(() => gate));
  const response = await post({ ...door, timeout_ms: 30 });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: string };
  await Bun.sleep(30);
  expect(await (await get(`/v1/audio/sound/${job}`)).json()).toMatchObject({ state: "running", stage: "sound", stage_label: "Making the sound", data: [] });
  // One generator admission of the measured peak, on the music queue.
  expect(getJob(job)).toMatchObject({ kind: SOUND_JOB_KIND, role: "music" });
  expect(getGovernorStatus().loaded.filter((item) => item.kind === "generator").map((item) => item.peakBytes)).toEqual([SFX_PEAK_BYTES]);
  expect(await (await app.request(`/v1/audio/sound/${job}`, { method: "DELETE" })).json()).toEqual({ job, state: "cancelled" });
  await Bun.sleep(30);
  expect(killed).toBe(1);
  expect(getGovernorStatus().loaded.filter((item) => item.kind === "generator")).toHaveLength(0);
  expect(await (await get(`/v1/audio/sound/${job}`)).json()).toMatchObject({ state: "cancelled", code: "cancelled" });
  release(okReply(requests[0]!));
});

test("sounds wait in line one at a time with a position; the fifth is refused queue_full", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sfxGen.useDeps(scripted(async (request) => { await gate; return okReply(request); }));
  const jobs: string[] = [];
  for (let i = 0; i < 4; i++) jobs.push(((await (await post({ ...door, timeout_ms: 20 })).json()) as { job: string }).job);
  expect(await (await get(`/v1/audio/sound/${jobs[1]}`)).json()).toMatchObject({ state: "queued", phase: "queued", position: 1 });
  const refused = await post({ ...door, timeout_ms: 20 });
  expect(refused.status).toBe(429);
  expect(await codeOf(refused)).toBe("queue_full");
  release();
  for (let i = 0; i < 100 && listJobs().some((job) => job.kind === SOUND_JOB_KIND && job.state !== "done"); i++) await Bun.sleep(20);
  expect(requests).toHaveLength(4);
  expect(spawned).toBe(1);
  expect(maxInside).toBe(1);
});

test("a failed sound carries the worker's code; an out-of-memory failure starts the next sound on a fresh worker", async () => {
  let first = true;
  sfxGen.useDeps(scripted((request) => {
    if (first) { first = false; return { id: request.id, ok: false, code: "out_of_memory", error: "The computer ran out of memory while making the sound. Close other big apps and try again." }; }
    return okReply(request);
  }));
  const failed = await post(door);
  expect(failed.status).toBe(507);
  expect(await codeOf(failed)).toBe("out_of_memory");
  expect((await post(door)).status).toBe(200);
  expect(spawned).toBe(2);
  sfxGen.useDeps(scripted((request) => ({ id: request.id, ok: false, code: "silent", error: "The sound came out silent. Try other words for it." })));
  const silent = await post(door);
  expect(silent.status).toBe(422);
  expect(await codeOf(silent)).toBe("silent");
});

test("not installed is a 503 with no worker; p16 makes no sounds; p32 does", async () => {
  sfxGen.useDeps(scripted(okReply, { installed: () => false }));
  const missing = await post(door);
  expect(missing.status).toBe(503);
  expect(await codeOf(missing)).toBe("not_installed");
  expect(spawned).toBe(0);
  sfxGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p16", totalMemoryBytes: 16 * GB, freeMemoryBytes: 8 * GB });
  const off = await post(door);
  expect(off.status).toBe(503);
  expect(await codeOf(off)).toBe("not_available_on_this_computer");
  __setGovernorTuningForTestsOnly({ tier: "p32", totalMemoryBytes: 32 * GB, freeMemoryBytes: 20 * GB });
  expect((await post(door)).status).toBe(200);
});

test("GET /stack/v1/sound says what is installed, what a sound may be and what to install, in Home's envelope", async () => {
  sfxGen.useDeps(scripted());
  const status = await (await get("/stack/v1/sound")).json() as { sound: Record<string, any> };
  expect(status.sound).toMatchObject({ available: true, tier: "p128", state: "needs-setup", code: null, reason: null });
  expect(status.sound.model).toEqual({ id: STACK_SFX_MODEL_ID, installed: true, licence: SFX_LICENCE, licence_accepted_at: null });
  expect(status.sound.limits).toEqual({ min_seconds: 1, max_seconds: 47, default_seconds: 5, min_steps: 4, max_steps: 16, default_steps: 8, max_prompt_chars: 1000, queue_max: 4, target_lufs: -16, loop: false });
  expect(status.sound.output).toEqual({ content_type: "audio/mp4", sample_rate: 44100, channels: 2 });
  expect(status.sound.memory).toMatchObject({ peak_gb: 6.5 });
  expect(status.sound.install.component).toBe(STACK_SFX_MODEL_ID);
  expect(status.sound.install.models.map((model: { id: string }) => model.id)).toEqual([STACK_SFX_MODEL_ID]);
  expect(status.sound.install.remaining_bytes).toBe(STACK_SFX_MODEL.download!.approx_bytes);
  expect(status.sound.worker.idle_exit_seconds).toBe(300);
  __setGovernorTuningForTestsOnly({ tier: "p16", totalMemoryBytes: 16 * GB });
  const off = await (await get("/stack/v1/sound")).json() as { sound: Record<string, any> };
  expect(off.sound).toMatchObject({ available: false, state: "off", code: "not_available_on_this_computer" });
  expect(off.sound.limits.max_seconds).toBe(0);
});

test("the pins are exact: the mirror at one revision, every file by sha256 and size, the licence files, and the engine source by commit", () => {
  expect(STACK_SFX_MODEL).toMatchObject({ role: "music", engine: "sfx-gen", component: "sound-effects", repo: "ddalcu/Stable-Audio-3-Small-SFX-MLX-Serve", revision: "977fd4791852ba56657a8c814cfd3b0049b2ebae", license: SFX_LICENCE });
  const files = STACK_SFX_MODEL.download!.files!;
  const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
  expect(byPath["model.safetensors"]).toEqual({ path: "model.safetensors", sha256: "ed9cf1b6172f1a8c2921a9560c21109ff3239524563ced9dce6dcdef41e2f515", bytes: 2_270_384_940 });
  expect(byPath["t5gemma-b-b-ul2/model.safetensors"]!.sha256).toBe("9b05ea5a4f211d023832f706fb2c0e83e4fc721b6da35ab69ceb0b55eb7800d3");
  expect(byPath["t5gemma-b-b-ul2/tokenizer.json"]!.sha256).toBe("7794135caa3ea73918949c902a781cc61dab674a4b59c17d85931c77c1114cbd");
  expect(byPath["t5gemma-b-b-ul2/tokenizer.model"]!.sha256).toBe("61a7b147390c64585d6c3543dd6fc636906c9af3865a5548f27f31aee1d4c8e2");
  for (const licenceFile of ["LICENSE.md", "LICENSE_GEMMA.md", "NOTICE", "model_config.json"]) expect(byPath[licenceFile]).toBeDefined();
  for (const file of files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(STACK_SFX_MODEL.download!.approx_bytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0));
  expect(STACK_SFX_MODEL.download!.sha256).toBe(byPath["model.safetensors"]!.sha256);
  expect(STACK_SFX_MODEL.download!.url).toContain("/ddalcu/Stable-Audio-3-Small-SFX-MLX-Serve/resolve/977fd4791852ba56657a8c814cfd3b0049b2ebae/model.safetensors");
  expect(STACK_MODELS.some((pin) => pin.id === STACK_SFX_MODEL_ID)).toBe(true);
  const engine = ENGINE_BINARIES.find((pin) => pin.name === "sfx-gen")!;
  expect(engine).toMatchObject({ tag: "790793b", platform: "darwin", arch: "arm64", verified: true });
  expect(engine.archive.url).toBe("https://codeload.github.com/Stability-AI/stable-audio-3/tar.gz/790793b89ddceea612be9ce42ff6830d18f6fa57");
  expect(engine.archive.sha256).toBe("8ff51d41f60e947c749cec7d4103e6e8add83c303ef288193812d6248d431454");
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === "sfx-gen")).toMatchObject({ version: "790793b", roles: ["music"] });
  expect(ENGINE_ROLE["sfx-gen"]).toBe("music");
  const requirements = readFileSync(sfxRequirementsFileFor("darwin", "arm64")!, "utf8");
  for (const line of requirements.split("\n").filter((entry) => /^[a-z0-9]/i.test(entry))) expect(line).toMatch(/^[A-Za-z0-9_.-]+==\S+ \\$/);
  expect(requirements).toContain("torch==2.7.1");
  expect(requirements).toContain("transformers==5.23.0");
  expect(sfxRequirementsFileFor("linux", "x64")).toBeNull();
});

test("the worker runs offline with no token or proxy, and everything it caches stays under the Stack's data", () => {
  process.env.HF_TOKEN = "hidden"; process.env.HTTPS_PROXY = "http://hidden"; process.env.HF_ENDPOINT = "https://elsewhere.invalid";
  try {
    const env = sfxWorkerEnv("/engines/sfx-gen/790793b");
    expect(env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONPATH: "/engines/sfx-gen/790793b", SFX_MAX_SECONDS: "47", SFX_TARGET_LUFS: "-16" });
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HF_ENDPOINT).toBeUndefined();
    expect(env.HOME!.startsWith(dataDir)).toBe(true);
  } finally { delete process.env.HF_TOKEN; delete process.env.HTTPS_PROXY; delete process.env.HF_ENDPOINT; }
});

test("the component is in the music group, optional on p32 and up, with its pin, its engine and the maker's licence to accept first", async () => {
  const unit = componentDefs().find((candidate) => candidate.id === STACK_SFX_MODEL_ID)!;
  expect(unit).toMatchObject({ group: "music", role: "music", tiers: ["p32", "p64", "p128"], label: "Make sound effects (Stable Audio 3 Small-SFX)" });
  expect(unit.pins.map((pin) => pin.id)).toEqual([STACK_SFX_MODEL_ID]);
  expect(unit.envs.map((env) => env.name)).toEqual(["sfx-gen"]);
  expect(unit.licenceNotice).toBe(SFX_LICENCE_NOTICE);
  expect(SFX_LICENCE_NOTICE.url).toContain("/ddalcu/Stable-Audio-3-Small-SFX-MLX-Serve/blob/977fd4791852ba56657a8c814cfd3b0049b2ebae/LICENSE.md");
  expect(SFX_LICENCE_NOTICE.summary.join(" ")).toContain("Powered by Stability AI");
  expect(SFX_LICENCE_NOTICE.summary.join(" ")).toContain("Gemma Terms of Use");
  expect(DISK_ROW[STACK_SFX_MODEL_ID]).toBe("sound-effects");
  await expect(startComponentInstall(STACK_SFX_MODEL_ID)).rejects.toMatchObject({ code: "licence_required", status: 409 });
  expect(licenceAcceptance(SFX_LICENCE_NOTICE.id)).toBeNull();
});

test("the disk plan has an optional sound effects row and its engine on p32 and up, and none on p16", () => {
  for (const tier of PROFILE_TIERS) {
    const plan = buildDiskPlan(tier);
    const row = plan.rows.find((candidate) => candidate.id === "sound-effects");
    if (tier.id === "p16") { expect(row).toBeUndefined(); continue; }
    expect(row).toMatchObject({ need: "optional", selectable: true, model_ids: [STACK_SFX_MODEL_ID], engines: ["engine:sound-effects", "engine:python"], download_bytes: STACK_SFX_MODEL.download!.approx_bytes });
    expect(plan.rows.find((candidate) => candidate.id === "engine:sound-effects")).toMatchObject({ kind: "engine", basis: "measured" });
    expect(plan.default_selected).not.toContain("sound-effects");
  }
});

test("the line protocol: ready, stage events for this job only, one reply, and a deadline", async () => {
  const lines: string[] = [];
  let push!: (line: string) => void;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`)); } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  let exit!: (code: number) => void;
  const child = { pid: undefined, stdin: { write: (data: string) => { lines.push(data); } }, stdout, stderr, exited: new Promise<number>((done) => { exit = done; }), kill: () => exit(143) };
  const worker = sfxWorkerHandle(child);
  push(JSON.stringify({ ready: true }));
  const events: SfxWorkerEvent[] = [];
  const reply = worker.send({ id: "s1", prompt: "rain", seconds: 3, gen_seconds: 4, seed: 1, steps: 8, output: "/x/song.m4a", model_dir: "/m", ffmpeg: "/f" }, { deadlineMs: 5_000, onEvent: (event) => events.push(event) });
  await Bun.sleep(10);
  push("Key pretransform.x not found in target state_dict or shape mismatch. Skipping.");
  push(JSON.stringify({ id: "other", event: "stage", stage: "sound" }));
  push(JSON.stringify({ id: "s1", event: "stage", stage: "sound", fraction: 0.1 }));
  push(JSON.stringify({ id: "s1", ok: true, duration_s: 2.5, seed: 1 }));
  expect(await reply).toMatchObject({ ok: true, duration_s: 2.5 });
  expect(events.map((event) => event.stage)).toEqual(["sound"]);
  expect(JSON.parse(lines[0]!)).toMatchObject({ id: "s1", gen_seconds: 4 });
  const late = await worker.send({ id: "s2", prompt: "rain", seconds: 3, gen_seconds: 4, seed: 1, steps: 8, output: "/x/song.m4a", model_dir: "/m", ffmpeg: "/f" }, { deadlineMs: 20, onEvent: () => {} });
  expect(late).toMatchObject({ ok: false, code: "timeout" });
  exit(0);
});

// ---- the real worker (bench lane, never in the gate) ----

const realDir = process.env.SFX_REAL_MODEL_DIR ?? "";
const real = !!realDir && existsSync(join(realDir, "model.safetensors")) && !!process.env.SFX_GEN_PYTHON && existsSync(process.env.SFX_GEN_PYTHON) && !!process.env.SFX_GEN_SRC && existsSync(join(process.env.SFX_GEN_SRC, "stable_audio_3")) && !!process.env.SFX_FFMPEG && existsSync(process.env.SFX_FFMPEG);
test.skipIf(!real)("the real worker makes a door slam offline, cuts its tail and sets its loudness (SFX_REAL_MODEL_DIR)", async () => {
  const script = join(import.meta.dir, "../src/sound/sfx_worker.py");
  const out = mkdtempSync(join(tmpdir(), "sfx-real-"));
  const child = Bun.spawn([process.env.SFX_GEN_PYTHON!, "-s", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...sfxWorkerEnv(process.env.SFX_GEN_SRC!), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" } });
  const worker = sfxWorkerHandle(child as never);
  try {
    const stages: string[] = [];
    const made = await worker.send({ id: "real-1", prompt: "a heavy wooden door slamming shut", seconds: 3, gen_seconds: 4, seed: 11, steps: 8, output: join(out, "door.m4a"), model_dir: realDir, ffmpeg: process.env.SFX_FFMPEG! }, { deadlineMs: 300_000, onEvent: (event) => stages.push(event.stage) });
    expect(made).toMatchObject({ ok: true, seed: 11, steps: 8, normalised: true });
    expect(made.duration_s!).toBeGreaterThan(0.5);
    expect(made.duration_s!).toBeLessThanOrEqual(3);
    expect(made.peak_bytes!).toBeLessThan(SFX_PEAK_BYTES);
    expect(stages).toEqual(["load", "sound", "save"]);
    const file = readFileSync(join(out, "door.m4a"));
    expect(file.subarray(4, 8).toString("latin1")).toBe("ftyp");
  } finally {
    worker.kill();
    rmSync(out, { recursive: true, force: true });
  }
}, 600_000);
