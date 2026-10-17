// MUSIC-GEN-01 and -02: the music service, its job API, the made-here ledger, the
// pins and the plans, driven by a scripted worker (no model, no GPU). The real
// worker on real weights is a bench-lane test: it runs only with MUSIC_REAL=1,
// MUSIC_GEN_PYTHON (the prepared environment's python), MUSIC_GEN_SRC (the
// extracted ACE-Step source) and MUSIC_CKPT_DIR (the checkpoints folder) set.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob, listJobs } from "@/lib/jobs";
import { STACK_MODELS, STACK_MUSIC_LM_06, STACK_MUSIC_MODEL, STACK_MUSIC_MODELS } from "@/lib/modelCatalog";
import { PROFILE_TIERS } from "@/profiles";
import { ENGINE_BINARIES, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { registerMusicJobs, musicHistoryKey, stashSong, unstashSong, musicTracker } from "@/music/jobs";
import { __resetMusicProvenanceForTests, recordMadeSong, sha256Hex, wasMadeHere } from "@/music/provenance";
import { commitResult, deleteResult, readResult, resultsRoot, sweepResults, workDir, type MusicResultMeta } from "@/music/results";
import {
  assembleCheckpointDir, memoryVerdict, MUSIC_MAX_SECONDS, MUSIC_PEAK_BYTES, musicGen, MusicGenService, musicRequirementsFileFor, musicRoleState, tierAvailability, tierLimits, workerHandle,
  type MusicGenDeps, type WorkerEvent, type WorkerHandle, type WorkerReply, type WorkerRequest,
} from "@/music/musicGen";
import { dataDir } from "@/lib/paths";
import { __resetGenHistoryForTests, GenTracker, MUSIC_STAGES } from "@/lib/genProgress";
import { buildDiskPlan } from "@/lib/diskPlan";
import { collectComponentsCatalog } from "@/lib/componentsDoc";
import { componentDefs } from "@/lib/components";

const GB = 1_073_741_824;
let spawned = 0;
let killed = 0;
const requests: WorkerRequest[] = [];
let inside = 0;
let maxInside = 0;

type Script = (request: WorkerRequest, emit: (event: WorkerEvent) => void) => Promise<WorkerReply> | WorkerReply;
/** Bytes that look like an m4a (an `ftyp` box) and differ per request, so each song has its own hash. */
const fakeM4a = (seed: string): Uint8Array => new TextEncoder().encode(`\u0000\u0000\u0000 ftypM4A \u0000\u0000\u0000\u0000M4A mp42isom fake-audio-${seed}`);
const okReply = (request: WorkerRequest): WorkerReply => ({
  id: request.id, ok: true, duration_s: request.duration_s ?? 30, seed: request.seed ?? 5, task: request.op === "edit" ? request.edit?.op : request.task,
  lrc: request.lrc ? "[00:01.00]SECRET-LYRIC-LINE" : null, ms: 1234, peak_bytes: 20_000_000_000,
});

function scripted(script: Script = okReply, over: Partial<MusicGenDeps> = {}): MusicGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    installed: () => true,
    runtime: () => ({ ckptDir: "/models/music", ffmpeg: "/bin/ffmpeg" }),
    spawn: async (): Promise<WorkerHandle> => {
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
            const reply = await Promise.race([script(request, options.onEvent), exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "The music engine stopped before the song was finished. Try again." }) as WorkerReply)]);
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
  musicGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetMusicProvenanceForTests();
  rmSync(join(dataDir, "music"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "music"), { recursive: true, force: true });
}
beforeEach(() => {
  spawned = 0; killed = 0; requests.length = 0; inside = 0; maxInside = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerMusicJobs();
});
afterEach(() => { delete process.env.MUSIC_IDLE_MS; delete process.env.MUSIC_RESULT_KEEP; delete process.env.MUSIC_RESULT_TTL_MS; clean(); });

const post = (body: Record<string, unknown>) => app.request("/v1/audio/music", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const song = { task: "text2music", caption: "folk, warm, acoustic guitar", lyrics: "[Verse]\nSaturday pancakes", duration_s: 60, timeout_ms: 5000 };
type Err = { error: string; code: string };
const codeOf = async (response: Response) => (await response.json() as Err).code;

/** Makes one song and returns its job, its bytes (the file as fetched) and the base64 of them, for a change that starts from it. */
async function makeSong(over: Record<string, unknown> = {}) {
  const response = await post({ ...song, ...over });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<{ url: string }> };
  const bytes = new Uint8Array(await (await get(body.data[0]!.url)).arrayBuffer());
  return { job: body.job, bytes, base64: Buffer.from(bytes).toString("base64") };
}

// ---- the job API ----

test("a song is made, polled to done, fetched with and without a range, and deleted", async () => {
  musicGen.useDeps(scripted());
  const response = await post({ ...song, seed: 7 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ duration_s: 60, seed: 7, task: "text2music", model: STACK_MUSIC_MODEL.id, content_type: "audio/mp4", lrc: "[00:01.00]SECRET-LYRIC-LINE" });
  expect(body.data[0]!.ms).toBeGreaterThanOrEqual(0);
  expect(body.data[0]!.url).toBe(`/v1/audio/music/${body.job}/file`);
  expect(response.headers.get("x-maipai-engine")).toBeDefined();
  expect(requests[0]).toMatchObject({ task: "text2music", duration_s: 60, seed: 7, lm: "acestep-5Hz-lm-1.7B", lrc: true, ckpt_dir: "/models/music", ffmpeg: "/bin/ffmpeg", cache_gb: 2 });
  expect(requests[0]!.source).toBeUndefined();
  const status = await (await get(`/v1/audio/music/${body.job}`)).json() as Record<string, unknown>;
  expect(status).toMatchObject({ state: "done", phase: "ready", progress: 100, error: null, stage: null });
  const full = await get(body.data[0]!.url as string);
  expect(full.headers.get("content-type")).toBe("audio/mp4");
  const bytes = new Uint8Array(await full.arrayBuffer());
  const part = await get(body.data[0]!.url as string, { range: "bytes=2-5" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 2-5/${bytes.length}`);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(2, 6));
  expect((await app.request(`/v1/audio/music/${body.job}`, { method: "DELETE" })).status).toBe(200);
  expect((await get(body.data[0]!.url as string)).status).toBe(404);
  expect((await get(`/v1/audio/music/${body.job}`)).status).toBe(404);
  // The governor admission is back, and the work folder is gone.
  expect(getGovernorStatus().loaded).toHaveLength(0);
  expect(existsSync(workDir(body.job))).toBe(false);
});

test("neither the description, the lyrics, the title nor the lyric timings are kept in a job record, on the feed, in the result store or in the history", async () => {
  musicGen.useDeps(scripted());
  __resetGenHistoryForTests();
  const response = await post({ ...song, caption: "SECRET-CAPTION", lyrics: "SECRET-LYRICS-WORDS", title: "SECRET-TITLE", timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string };
  expect(JSON.stringify(listJobs())).not.toContain("SECRET");
  expect(JSON.stringify(getJob(body.job))).not.toContain("SECRET");
  const meta = readFileSync(join(resultsRoot(), body.job, "meta.json"), "utf8");
  expect(meta).not.toContain("SECRET");
  expect(readdirSync(join(resultsRoot(), body.job)).sort()).toEqual(["meta.json", "song.m4a"]);
  const history = join(dataDir, "gen-history.json");
  if (existsSync(history)) expect(readFileSync(history, "utf8")).not.toContain("SECRET");
  expect(requests[0]).toMatchObject({ caption: "SECRET-CAPTION", lyrics: "SECRET-LYRICS-WORDS", title: "SECRET-TITLE" });
});

test("past timeout_ms the answer is 202; the status shows the stage in words with a fraction that only rises and a time left; cancel stops the worker and returns the memory", async () => {
  __resetGenHistoryForTests();
  rmSync(join(dataDir, "gen-history.json"), { force: true });
  let release!: (reply: WorkerReply) => void;
  const gate = new Promise<WorkerReply>((resolve) => { release = resolve; });
  musicGen.useDeps(scripted((request, emit) => { emit({ id: request.id, event: "stage", stage: "load" }); emit({ id: request.id, event: "stage", stage: "plan", fraction: 0.5 }); return gate; }));
  const response = await post({ ...song, timeout_ms: 30 });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: string };
  await Bun.sleep(30);
  type Live = { state: string; stage: string | null; stage_label: string | null; progress_fraction: number | null; eta_seconds: number | null; progress: number; position: number | null; data: unknown[] };
  const plan = await (await get(`/v1/audio/music/${job}`)).json() as Live;
  expect(plan).toMatchObject({ state: "running", stage: "plan", stage_label: "Planning the song", data: [] });
  expect(plan.progress_fraction!).toBeGreaterThan(0.3);
  expect(plan.eta_seconds!).toBeGreaterThan(0);
  expect(plan.progress).toBe(Math.round(plan.progress_fraction! * 100));
  expect(getGovernorStatus().loaded.map((item) => item.kind)).toEqual(["generator"]);
  // the stages in order, each with its plain-words label, and the bar never goes back
  const tracker = musicTracker(job)!;
  const seen: Array<[string | null, string | null, number]> = [];
  for (const [stage, label, fraction] of [["music", "Making the music", 0.5], ["mix", "Mixing it down", 0.2], ["save", "Saving", 0]] as const) {
    tracker.enter(stage, Math.round(fraction * 1000), 1000);
    const live = await (await get(`/v1/audio/music/${job}`)).json() as Live;
    seen.push([live.stage, live.stage_label, live.progress_fraction!]);
    expect([live.stage, live.stage_label]).toEqual([stage, label]);
  }
  expect(seen.map((entry) => entry[2])).toEqual([...seen.map((entry) => entry[2])].sort((a, b) => a - b));
  const cancelled = await app.request(`/v1/audio/music/${job}`, { method: "DELETE" });
  expect(await cancelled.json()).toEqual({ job, state: "cancelled" });
  await Bun.sleep(30);
  expect(killed).toBe(1);
  expect(getGovernorStatus().loaded).toHaveLength(0);
  expect(existsSync(workDir(job))).toBe(false);
  expect(await (await get(`/v1/audio/music/${job}`)).json()).toMatchObject({ state: "cancelled", stage: null, stage_label: null, progress_fraction: null, eta_seconds: null, code: "cancelled" });
  release(okReply(requests[0]!));
});

test("a job that is running but has reported no stage yet is getting ready", async () => {
  musicGen.useDeps(scripted(() => new Promise<WorkerReply>(() => {}), { ensureEnvironment: (_progress, signal) => new Promise<void>((_, reject) => { signal?.addEventListener("abort", () => reject(new Error("cancelled"))); }) }));
  const { job } = await (await post({ ...song, timeout_ms: 20 })).json() as { job: string };
  await Bun.sleep(30);
  expect(await (await get(`/v1/audio/music/${job}`)).json()).toMatchObject({ state: "running", stage: "load", stage_label: "Getting ready" });
  await app.request(`/v1/audio/music/${job}`, { method: "DELETE" });
});

test("a second song waits behind the first with its position; the fifth is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  musicGen.useDeps(scripted(async (request) => { await gate; return okReply(request); }));
  const jobs: string[] = [];
  for (let i = 0; i < 4; i++) jobs.push(((await (await post({ ...song, timeout_ms: 20 })).json()) as { job: string }).job);
  expect(await (await get(`/v1/audio/music/${jobs[1]}`)).json()).toMatchObject({ state: "queued", phase: "queued", position: 1 });
  const refused = await post({ ...song, timeout_ms: 20 });
  expect(refused.status).toBe(429);
  expect(await codeOf(refused)).toBe("queue_full");
  release();
  await Bun.sleep(300);
  expect(requests).toHaveLength(4);
  expect(spawned).toBe(1);
  expect(maxInside).toBe(1);
});

test("a failed song carries the worker's code and status; an out-of-memory failure restarts the worker for the next song", async () => {
  let first = true;
  musicGen.useDeps(scripted((request) => { if (first) { first = false; return { id: request.id, ok: false, code: "out_of_memory", error: "The computer ran out of memory while making the song. Close other big apps and try again." }; } return okReply(request); }));
  const failed = await post(song);
  expect(failed.status).toBe(507);
  expect(await failed.json()).toMatchObject({ code: "out_of_memory", error: expect.stringContaining("Close other big apps") });
  const again = await post(song);
  expect(again.status).toBe(200);
  expect(spawned).toBe(2);
  musicGen.useDeps(scripted(() => ({ id: "x", ok: false, code: "bad_request", error: "a song can grow by 5 to 120 seconds, up to 240 seconds in all" }) as WorkerReply));
  const bad = await post(song);
  expect(bad.status).toBe(422);
  expect(await codeOf(bad)).toBe("bad_request");
});

// ---- validation: every 422, 413 and the plain 400 ----

test("every breach of a limit is a 422 with its own code and a sentence that says what to change", async () => {
  musicGen.useDeps(scripted());
  const cases: Array<[string, Record<string, unknown>, number, string]> = [
    ["a caption over 4000", { ...song, caption: "x".repeat(4001) }, 422, "too_long"],
    ["lyrics over 4000", { ...song, lyrics: "y".repeat(4001) }, 422, "too_long"],
    ["a title over 200", { ...song, title: "t".repeat(201) }, 422, "too_long"],
    ["under 10 seconds", { ...song, duration_s: 9 }, 422, "bad_range"],
    ["over the tier's longest", { ...song, duration_s: 241 }, 422, "bad_range"],
    ["a tempo below 30", { ...song, bpm: 29 }, 422, "bad_range"],
    ["a tempo above 300", { ...song, bpm: 301 }, 422, "bad_range"],
    ["nothing to make from", { task: "text2music" }, 422, "bad_request"],
    ["an instrumental with no description", { task: "text2music", instrumental: true, lyrics: "la la" }, 422, "bad_request"],
    ["a source on a new song", { ...song, source: "AAAA" }, 422, "bad_request"],
    ["a cover with no source", { task: "cover", caption: "jazz piano" }, 422, "bad_request"],
    ["a cover strength of 2", { task: "cover", caption: "jazz piano", source: "AAAA", strength: 2 }, 422, "bad_range"],
    ["a repaint with no stretch", { task: "repaint", caption: "x", source: "AAAA" }, 422, "bad_request"],
    ["a repaint of one second", { task: "repaint", caption: "x", source: "AAAA", from_s: 4, to_s: 5 }, 422, "bad_range"],
    ["an extension of 3 seconds", { task: "extend", caption: "x", source: "AAAA", add_s: 3 }, 422, "bad_range"],
    ["an extension of 200 seconds", { task: "extend", caption: "x", source: "AAAA", add_s: 200 }, 422, "bad_range"],
    ["an edit with no edit", { task: "edit", source: "AAAA" }, 422, "bad_request"],
    ["an edit with no source", { task: "edit", edit: { op: "fade" } }, 422, "bad_request"],
    ["a trim of half a second", { task: "edit", source: "AAAA", edit: { op: "trim", from_s: 1, to_s: 1.5 } }, 422, "bad_range"],
    ["a fade of 100 seconds", { task: "edit", source: "AAAA", edit: { op: "fade", seconds: 100 } }, 422, "bad_range"],
    ["a loudness of 0 LUFS", { task: "edit", source: "AAAA", edit: { op: "loudness", lufs: 0 } }, 422, "bad_range"],
    ["a source that is not base64", { task: "cover", caption: "x", source: "not base64 !!" }, 422, "bad_request"],
    ["a source that is not an m4a", { task: "cover", caption: "x", source: Buffer.from("this is plain text, not a song at all").toString("base64") }, 422, "bad_request"],
  ];
  for (const [name, body, status, code] of cases) {
    const response = await post(body);
    expect([name, response.status, (await response.json() as Err).code]).toEqual([name, status, code]);
  }
  // a message that says what to change
  expect(((await (await post({ ...song, duration_s: 9 })).json()) as Err).error).toContain("10 to 240 seconds");
  // a body that breaks the schema is a plain 400
  expect((await post({ ...song, task: "remix" })).status).toBe(400);
  expect((await post({ ...song, seed: -1 })).status).toBe(400);
  expect(requests).toHaveLength(0);
});

test("a source larger than 40 MB is 413, and a hash that is not the song's is refused", async () => {
  musicGen.useDeps(scripted());
  const huge = await post({ task: "cover", caption: "x", source: "A".repeat(56_000_000) });
  expect(huge.status).toBe(413);
  expect(await codeOf(huge)).toBe("too_large");
  const made = await makeSong();
  const wrong = await post({ task: "cover", caption: "jazz", source: made.base64, source_sha256: "0".repeat(64) });
  expect(wrong.status).toBe(422);
  expect(await wrong.json()).toMatchObject({ code: "bad_request", error: expect.stringContaining("source_sha256") });
  const right = await post({ task: "cover", caption: "jazz", source: made.base64, source_sha256: sha256Hex(made.bytes).toUpperCase(), timeout_ms: 5000 });
  expect(right.status).toBe(200);
});

// ---- the made-here ledger ----

test("a song this Stack made can be changed; any other song is refused source_not_made_here with the plain line", async () => {
  musicGen.useDeps(scripted());
  const made = await makeSong();
  expect(wasMadeHere(made.bytes)).toBe(true);
  expect(wasMadeHere(fakeM4a("a recording someone brought"))).toBe(false);
  const foreign = Buffer.from(fakeM4a("a recording someone brought")).toString("base64");
  for (const task of ["cover", "repaint", "extend", "edit"]) {
    const body: Record<string, unknown> = { task, caption: "x", source: foreign, from_s: 0, to_s: 10, edit: { op: "fade" } };
    const refused = await post(body);
    expect([task, refused.status]).toEqual([task, 422]);
    expect(await refused.json()).toMatchObject({ code: "source_not_made_here", error: "I can only change a song that was made here." });
  }
  const before = requests.length;
  const accepted = await post({ task: "cover", caption: "jazz piano", source: made.base64, strength: 0.7, timeout_ms: 5000 });
  expect(accepted.status).toBe(200);
  expect(requests).toHaveLength(before + 1);
  expect(requests.at(-1)).toMatchObject({ task: "cover", strength: 0.7, caption: "jazz piano" });
  expect(requests.at(-1)!.source).toContain("source.m4a");
  // the result of a change is itself made here, so a chain of changes works
  const second = await accepted.json() as { data: Array<{ url: string }> };
  const bytes = new Uint8Array(await (await get(second.data[0]!.url)).arrayBuffer());
  expect(wasMadeHere(bytes)).toBe(true);
  const repaint = await post({ task: "repaint", caption: "x", lyrics: "new words", source: Buffer.from(bytes).toString("base64"), from_s: 20, to_s: 40, timeout_ms: 5000 });
  expect(repaint.status).toBe(200);
  expect(requests.at(-1)).toMatchObject({ task: "repaint", from_s: 20, to_s: 40, lrc: true });
  const extend = await post({ task: "extend", caption: "x", source: made.base64, timeout_ms: 5000 });
  expect(extend.status).toBe(200);
  expect(requests.at(-1)).toMatchObject({ task: "extend", add_s: 20, at: "end" });
});

test("the ledger keeps a hash and a time, survives a restart of the module, and drops nothing it was given", () => {
  const bytes = fakeM4a("ledger");
  expect(recordMadeSong(bytes)).toBe(sha256Hex(bytes));
  const file = JSON.parse(readFileSync(join(dataDir, "music", "made-here.json"), "utf8")) as { songs: Array<[string, number]> };
  expect(file.songs.map((entry) => entry[0])).toEqual([sha256Hex(bytes)]);
  expect(JSON.stringify(file)).not.toContain("ledger");
  __resetMusicProvenanceForTests();
  expect(wasMadeHere(bytes)).toBe(true);
  expect(wasMadeHere(fakeM4a("other"))).toBe(false);
});

// ---- edits ----

test("an edit takes no generator admission, runs through the same chain as a song, and is itself made here", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let hold = false;
  musicGen.useDeps(scripted(async (request) => { if (request.op !== "edit" && hold) { hold = false; await gate; } return okReply(request); }));
  const made = await makeSong();
  hold = true;
  // a long song is running; an edit sent now waits for the worker and holds no admission of its own
  const longSong = post({ ...song, timeout_ms: 5000 });
  await Bun.sleep(30);
  expect(getGovernorStatus().loaded.map((item) => item.kind)).toEqual(["generator"]);
  const editing = post({ task: "edit", source: made.base64, edit: { op: "trim", from_s: 2, to_s: 30 }, timeout_ms: 5000 });
  await Bun.sleep(50);
  expect(requests.filter((request) => request.op === "edit")).toHaveLength(0);
  expect(getGovernorStatus().loaded).toHaveLength(1);
  release();
  const [songDone, editDone] = await Promise.all([longSong, editing]);
  expect(songDone.status).toBe(200);
  expect(editDone.status).toBe(200);
  expect(maxInside).toBe(1);
  expect(await editDone.json()).toMatchObject({ data: [{ task: "trim", model: "none", duration_s: 30 }] });
  const request = requests.find((entry) => entry.op === "edit")!;
  expect(request).toMatchObject({ op: "edit", task: "edit", edit: { op: "trim", from_s: 2, to_s: 30 } });
  expect(getGovernorStatus().loaded).toHaveLength(0);
});

test("an edit alone never touches the governor, even when no generator could be admitted", async () => {
  musicGen.useDeps(scripted());
  const made = await makeSong();
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 64 * GB, freeMemoryBytes: 60 * GB });
  await admit({ id: "chat", kind: "resident", requestedBytes: 40 * GB, pinned: true });
  const full = await post(song);
  expect(full.status).toBe(503);
  expect(await codeOf(full)).toBe("no_memory");
  const edited = await post({ task: "edit", source: made.base64, edit: { op: "loudness", lufs: -14 }, timeout_ms: 5000 });
  expect(edited.status).toBe(200);
  expect(requests.at(-1)!.edit).toEqual({ op: "loudness", lufs: -14 });
});

// ---- tiers, installs and memory ----

test("music is off on p16 and p32, quick only with 120 seconds on p64, and both qualities with 240 seconds on p128", async () => {
  musicGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p32", totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB });
  const off = await post(song);
  expect(off.status).toBe(503);
  expect(await off.json()).toMatchObject({ code: "not_available_on_this_computer", error: expect.stringContaining("64 GB of memory or more") });
  __setGovernorTuningForTestsOnly({ tier: "p16", totalMemoryBytes: 16 * GB, freeMemoryBytes: 10 * GB });
  expect((await post(song)).status).toBe(503);
  expect(tierAvailability("p64")).toMatchObject({ available: true });
  expect(tierAvailability("p32")).toMatchObject({ available: false, code: "not_available_on_this_computer" });
  expect(tierLimits("p16")).toBeNull();
  expect(tierLimits("p64")).toEqual({ max_seconds: 120, quality: ["quick"], default_quality: "quick" });
  expect(tierLimits("p128")).toEqual({ max_seconds: 240, quality: ["quick", "detailed"], default_quality: "detailed" });
  // p64
  __setGovernorTuningForTestsOnly({ tier: "p64", totalMemoryBytes: 64 * GB, freeMemoryBytes: 50 * GB });
  const long = await post({ ...song, duration_s: 121 });
  expect(long.status).toBe(422);
  expect(await long.json()).toMatchObject({ code: "bad_range", error: expect.stringContaining("10 to 120 seconds") });
  const detailed = await post({ ...song, quality: "detailed" });
  expect(detailed.status).toBe(422);
  expect(await detailed.json()).toMatchObject({ code: "bad_request", error: expect.stringContaining("quick") });
  const quick = await post({ ...song, duration_s: 120, timeout_ms: 5000 });
  expect(quick.status).toBe(200);
  expect(requests.at(-1)).toMatchObject({ lm: "acestep-5Hz-lm-0.6B", duration_s: 120 });
  // p128
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB });
  expect((await post({ ...song, duration_s: 240, timeout_ms: 5000 })).status).toBe(200);
  expect(requests.at(-1)).toMatchObject({ lm: "acestep-5Hz-lm-1.7B", duration_s: 240 });
  expect((await post({ ...song, quality: "quick", timeout_ms: 5000 })).status).toBe(200);
  expect(requests.at(-1)!.lm).toBe("acestep-5Hz-lm-0.6B");
  expect(MUSIC_MAX_SECONDS).toEqual({ p64: 120, p128: 240 });
});

test("not installed without the model, and refused with the numbers when a song cannot fit beside what is resident", async () => {
  musicGen.useDeps(scripted(okReply, { installed: () => false }));
  const missing = await post(song);
  expect(missing.status).toBe(503);
  expect(await codeOf(missing)).toBe("not_installed");
  musicGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p64", totalMemoryBytes: 64 * GB, freeMemoryBytes: 60 * GB });
  await admit({ id: "chat", kind: "resident", requestedBytes: 40 * GB, pinned: true });
  const full = await post(song);
  expect(full.status).toBe(503);
  expect(await full.json()).toMatchObject({ code: "no_memory", error: "Not enough free memory for music right now. Close other big jobs, or try again in a few minutes." });
  expect(memoryVerdict().ok).toBe(false);
  expect(MUSIC_PEAK_BYTES).toBe(33_000_000_000);
});

// ---- results ----

test("results are held about ten minutes and the six newest, and an expired one is gone", async () => {
  process.env.MUSIC_RESULT_KEEP = "2";
  const make = (n: number): MusicResultMeta => {
    const job = `job-00000000-0000-0000-0000-00000000000${n}`;
    const work = workDir(job); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "song.m4a"), "m");
    const meta: MusicResultMeta = { job, created: 1, task: "text2music", duration_s: 30, seed: n, model: "m", ms: 1, bytes: 1, mlx_peak_gb: null };
    commitResult(meta, work);
    utimesSync(join(resultsRoot(), job), new Date(Date.now() - (10 - n) * 1000), new Date(Date.now() - (10 - n) * 1000));
    return meta;
  };
  const metas = [1, 2, 3].map(make);
  expect(readdirSync(resultsRoot()).sort()).toEqual([metas[1]!.job, metas[2]!.job].sort());
  expect(readResult(metas[0]!.job)).toBeNull();
  expect(readResult(metas[2]!.job)).not.toBeNull();
  // ten minutes: a result older than that is not served, even before a sweep removes it
  expect(readResult(metas[2]!.job, Date.now() + 11 * 60_000)).toBeNull();
  expect(existsSync(join(resultsRoot(), metas[2]!.job))).toBe(false);
  process.env.MUSIC_RESULT_TTL_MS = "1";
  expect(sweepResults(Date.now() + 5000)).toBe(1);
  expect(deleteResult(metas[1]!.job)).toBe(false);
  expect(readResult("../../etc/passwd")).toBeNull();
  delete process.env.MUSIC_RESULT_KEEP;
  expect(Number(process.env.MUSIC_RESULT_KEEP ?? 6)).toBe(6);
});

test("an expired song answers 404 on the file route and on the status route", async () => {
  musicGen.useDeps(scripted());
  const { job } = await makeSong();
  process.env.MUSIC_RESULT_TTL_MS = "1";
  await Bun.sleep(20);
  expect((await get(`/v1/audio/music/${job}/file`)).status).toBe(404);
  expect((await get(`/v1/audio/music/${job}`)).status).toBe(404);
  expect(existsSync(join(resultsRoot(), job))).toBe(false);
});

test("a stashed song is taken once", () => {
  stashSong("t", { fields: { task: "text2music", caption: "p" }, source: null, historyKey: "music:text2music:60" });
  expect(unstashSong("t")?.fields.caption).toBe("p");
  expect(unstashSong("t")).toBeNull();
});

// ---- state, pins and plans ----

test("GET /stack/v1/music says what is installed, what a song may be and what to install", async () => {
  musicGen.useDeps(scripted());
  const status = await (await get("/stack/v1/music")).json() as { music: Record<string, any> };
  expect(status.music).toMatchObject({ available: true, tier: "p128", state: "needs-setup", code: null, reason: null, quality: ["quick", "detailed"], default_quality: "detailed" });
  expect(status.music.limits).toMatchObject({ min_seconds: 10, max_seconds: 240, default_seconds: 60, min_bpm: 30, max_bpm: 300, max_text_chars: 4000, max_source_mb: 40 });
  expect(status.music.tasks).toEqual(["text2music", "cover", "repaint", "extend", "edit"]);
  expect(status.music.install.models.map((model: { id: string }) => model.id)).toEqual([STACK_MUSIC_MODEL.id, STACK_MUSIC_LM_06.id]);
  expect(status.music.worker.idle_exit_seconds).toBe(300);
  expect(status.music.memory).toMatchObject({ peak_gb: 33 });
  const roles = await (await get("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string }; endpoints: string[] }> };
  const music = roles.roles.find((role) => role.id === "music")!;
  expect(music.endpoints).toEqual(["/v1/audio/music"]);
  expect(music.state.state).toBe("installed");
  __setGovernorTuningForTestsOnly({ tier: "p64", totalMemoryBytes: 64 * GB, freeMemoryBytes: 50 * GB });
  const p64 = await (await get("/stack/v1/music")).json() as { music: Record<string, any> };
  expect(p64.music).toMatchObject({ available: true, tier: "p64", quality: ["quick"], default_quality: "quick" });
  expect(p64.music.limits.max_seconds).toBe(120);
  __setGovernorTuningForTestsOnly({ tier: "p32" });
  const off = await (await get("/stack/v1/music")).json() as { music: Record<string, any> };
  expect(off.music).toMatchObject({ available: false, state: "off", code: "not_available_on_this_computer", quality: [], default_quality: null, tasks: [] });
  expect(off.music.limits.max_seconds).toBe(0);
});

test("the pins are exact: revisions, hashes, file lists that add up, MIT, a component for the second LM, and the engine pin and requirements are hashed", async () => {
  expect(STACK_MUSIC_MODEL).toMatchObject({ role: "music", engine: "music-gen", license: "MIT", revision: "19671f406d603126926c1b7e2adc169acbcade22", repo: "ACE-Step/Ace-Step1.5" });
  expect(STACK_MUSIC_LM_06).toMatchObject({ role: "music", engine: "music-gen", license: "MIT", revision: "148d8ea0225bdab342ee1ae3a354275ccd60ca80", repo: "ACE-Step/acestep-5Hz-lm-0.6B", component: "planning-lm-0.6b" });
  for (const pin of STACK_MUSIC_MODELS) {
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    const files = pin.download!.files!;
    expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBe(pin.download!.approx_bytes);
    for (const file of files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.find((file) => pin.download!.url.endsWith(`/${file.path}`))!.sha256).toBe(pin.download!.sha256);
    expect(STACK_MODELS).toContain(pin);
    expect(pin.download!.directory).toMatch(/^[^/]+$/);
  }
  const hashes = new Map(STACK_MUSIC_MODEL.download!.files!.map((file) => [file.path, file.sha256]));
  expect(hashes.get("acestep-v15-turbo/model.safetensors")).toBe("3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7");
  expect(hashes.get("acestep-5Hz-lm-1.7B/model.safetensors")).toBe("f161689da73e5ecefa28ff780d51c2d92a00f056d021d7933c779ed5c6cd7db8");
  expect(hashes.get("Qwen3-Embedding-0.6B/model.safetensors")).toBe("0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd");
  expect(hashes.get("vae/diffusion_pytorch_model.safetensors")).toBe("da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0");
  expect(hashes.get("acestep-v15-turbo/silence_latent.pt")).toBe("a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b");
  expect(STACK_MUSIC_LM_06.download!.sha256).toBe("5d92a60806e2e88c04de58ddc6dde93f2bc8f1336162b3ad5853886c9bcc6b82");
  // ACE-Step writes its own model code into the DiT folder; those two files, the README and .gitattributes are not pinned
  const paths = [...hashes.keys()];
  expect(paths.some((path) => path.endsWith(".py"))).toBe(false);
  expect(paths).not.toContain("README.md");
  expect(Math.round(STACK_MUSIC_MODEL.download!.approx_bytes / 1e8) / 10).toBe(10.1);
  expect(Math.round(STACK_MUSIC_LM_06.download!.approx_bytes / 1e7) / 100).toBe(1.37);
  const engine = ENGINE_BINARIES.find((pin) => pin.name === "music-gen")!;
  expect(engine).toMatchObject({ tag: "ca1e85f", platform: "darwin", arch: "arm64" });
  expect(engine.archive).toMatchObject({ url: "https://github.com/ACE-Step/ACE-Step-1.5/archive/ca1e85fe9430179831e6bc6be790c332190a3866.tar.gz", sha256: "b464c11f00af00e1e089a09f58a03962f803c080f116fd0517dbe5ec839706b3", approxBytes: 8_439_408 });
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === "music-gen")!.version).toBe(engine.tag);
  const text = await Bun.file(musicRequirementsFileFor("darwin", "arm64")!).text();
  expect(text).toContain("mlx==0.30.6");
  expect(text).toContain("torch==2.10.0");
  expect(text).toContain("mlx-lm==0.29.1");
  expect(text).toContain("imageio-ffmpeg==0.6.0");
  expect(text).toContain("--hash=sha256:");
  expect(text.match(/^[a-z0-9][a-z0-9._-]*==/gim)!.length).toBe(125);
  expect(musicRequirementsFileFor("linux", "x64")).toBeNull();
  const tier = (id: string) => PROFILE_TIERS.find((candidate) => candidate.id === id)!;
  expect(tier("p64").onDemand).toContain("music");
  expect(tier("p64").notAvailable).not.toContain("music");
  expect(tier("p64").notAvailable).toContain("video");
  expect(tier("p64").label).toContain("plus one image or music job at a time");
  expect(tier("p128").onDemand).toContain("music");
  for (const id of ["p16", "p32"]) { expect(tier(id).notAvailable).toContain("music"); expect(tier(id).onDemand).not.toContain("music"); }
});

test("the worker keeps the keep-warm, offline and memory settings the note measured", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/music/music_worker.py")).text();
  expect(source).toContain('os.environ.setdefault("HF_HUB_OFFLINE", "1")');
  expect(source).toContain('os.environ.setdefault("ACESTEP_MLX_VAE_CHUNK", "256")');
  expect(source).toContain("use_cot_lyrics=False");
  const service = await Bun.file(join(import.meta.dir, "../src/music/musicGen.ts")).text();
  expect(service).toContain('process.env.MUSIC_IDLE_MS ?? 5 * 60_000');
  for (const name of ["HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY", "ACESTEP_MLX_VAE_CHUNK", "MUSIC_MAX_SECONDS"]) expect(service).toContain(name);
});

test("the component is listed in the group music for p64 and p128, optional, with both pins and the music engine", () => {
  const unit = componentDefs().find((candidate) => candidate.group === "music")!;
  expect(unit).toMatchObject({ id: STACK_MUSIC_MODEL.id, label: "Music: ACE-Step 1.5", summary: "Makes and changes songs in chat", role: "music", tiers: ["p64", "p128"] });
  expect(unit.pins.map((pin) => pin.id)).toEqual([STACK_MUSIC_MODEL.id, STACK_MUSIC_LM_06.id]);
  expect(unit.envs.map((env) => env.name)).toEqual(["music-gen"]);
  const catalog = collectComponentsCatalog();
  expect(catalog.models.filter((pin) => pin.role === "music").map((pin) => pin.id)).toEqual([STACK_MUSIC_MODEL.id, STACK_MUSIC_LM_06.id]);
  expect(catalog.engines.some((pin) => pin.name === "music-gen")).toBe(true);
});

test("the disk plan carries the music rows for the engine and both models on p64 and p128, and none on p16 and p32", () => {
  const plan = (id: string) => buildDiskPlan(PROFILE_TIERS.find((tier) => tier.id === id)!);
  for (const id of ["p64", "p128"]) {
    const rows = plan(id).rows;
    const music = rows.find((row) => row.id === "music")!;
    expect(music).toMatchObject({ need: "optional", selectable: true, model_ids: [STACK_MUSIC_MODEL.id, STACK_MUSIC_LM_06.id], engines: ["engine:music", "engine:python"] });
    expect(music.download_bytes).toBe(STACK_MUSIC_MODELS.reduce((sum, pin) => sum + pin.download!.approx_bytes, 0));
    expect(plan(id).default_selected).not.toContain("music");
    const engine = rows.find((row) => row.id === "engine:music")!;
    expect(engine).toMatchObject({ kind: "engine", installed_bytes: 1_200_000_000, download_bytes: 800_000_000, basis: "estimate" });
  }
  for (const id of ["p16", "p32"]) expect(plan(id).rows.some((row) => row.id === "music" || row.id === "engine:music")).toBe(false);
});

test("the role state follows the service: not installed, installed, loaded, ready", async () => {
  const service = new MusicGenService(scripted());
  expect(musicRoleState(service).state).toBe("installed");
  await service.run({ fields: { task: "text2music", caption: "x", duration_s: 30 }, outputDir: join(tmpdir(), `music-state-${process.pid}`) }, { jobId: "job-s" });
  expect(musicRoleState(service).state).toBe("ready");
  expect(musicRoleState(service, Date.now() + 2 * 3_600_000).state).toBe("loaded");
  service.stop();
  const bare = new MusicGenService(scripted(okReply, { installed: () => false }));
  expect(musicRoleState(bare).state).toBe("notInstalled");
});

// ---- the checkpoints folder ----

test("the checkpoints folder links the pinned files, and what ACE-Step writes lands beside them, never in a pinned folder", () => {
  const root = mkdtempSync(join(tmpdir(), "music-ckpt-"));
  const model = join(root, "model"); const lm = join(root, "lm"); const into = join(root, "run", "ckpt");
  for (const [folder, file] of [["acestep-v15-turbo", "model.safetensors"], ["acestep-v15-turbo", "config.json"], ["acestep-5Hz-lm-1.7B", "model.safetensors"], ["Qwen3-Embedding-0.6B", "model.safetensors"], ["vae", "diffusion_pytorch_model.safetensors"]] as const) {
    mkdirSync(join(model, folder), { recursive: true }); writeFileSync(join(model, folder, file), `${folder}/${file}`);
  }
  writeFileSync(join(model, "config.json"), "root");
  mkdirSync(lm, { recursive: true }); writeFileSync(join(lm, "model.safetensors"), "lm06");
  // a stale earlier assembly is replaced
  mkdirSync(into, { recursive: true }); writeFileSync(join(into, "stale"), "x");
  expect(assembleCheckpointDir({ modelDir: model, lm06Dir: lm }, into)).toBe(into);
  expect(readdirSync(into).sort()).toEqual(["Qwen3-Embedding-0.6B", "acestep-5Hz-lm-0.6B", "acestep-5Hz-lm-1.7B", "acestep-v15-turbo", "config.json", "vae"]);
  expect(readFileSync(join(into, "acestep-5Hz-lm-0.6B", "model.safetensors"), "utf8")).toBe("lm06");
  expect(readFileSync(join(into, "vae", "diffusion_pytorch_model.safetensors"), "utf8")).toBe("vae/diffusion_pytorch_model.safetensors");
  expect(lstatSync(join(into, "acestep-v15-turbo")).isDirectory()).toBe(true);
  expect(lstatSync(join(into, "acestep-v15-turbo")).isSymbolicLink()).toBe(false);
  expect(lstatSync(join(into, "acestep-v15-turbo", "model.safetensors")).isSymbolicLink()).toBe(true);
  // ACE-Step copies its model code into the DiT folder: it lands in the assembled folder, not the pinned one
  writeFileSync(join(into, "acestep-v15-turbo", "modeling_acestep_v15_turbo.py"), "# synced");
  expect(existsSync(join(model, "acestep-v15-turbo", "modeling_acestep_v15_turbo.py"))).toBe(false);
  expect(readdirSync(join(model, "acestep-v15-turbo")).sort()).toEqual(["config.json", "model.safetensors"]);
  rmSync(root, { recursive: true, force: true });
  void symlinkSync;
});

// ---- the service and the line protocol ----

test("one worker serves songs one at a time, reports the stages, and exits after the idle window", async () => {
  process.env.MUSIC_IDLE_MS = "30";
  const service = new MusicGenService(scripted((request, emit) => { for (const stage of ["plan", "music", "mix", "save"] as const) emit({ id: request.id, event: "stage", stage, fraction: 1 }); return okReply(request); }));
  const stages: string[] = [];
  const input = (name: string) => ({ fields: { task: "text2music", caption: "x", duration_s: 30 }, outputDir: join(tmpdir(), `music-svc-${name}-${process.pid}`) });
  await Promise.all([service.run(input("a"), { jobId: "job-a", onStage: (stage) => stages.push(stage) }), service.run(input("b"), { jobId: "job-b" })]);
  expect(spawned).toBe(1);
  expect(maxInside).toBe(1);
  expect(stages.filter((stage, index) => stages.indexOf(stage) === index)).toEqual(["load", "plan", "music", "mix", "save"]);
  expect(service.status().state).toBe("idle");
  await Bun.sleep(100);
  expect(killed).toBe(1);
  expect(service.status().state).toBe("needs-setup");
  expect(musicGen.stopIfIdle()).toBe(false);
});

test("the first song builds the environment and says so; a failed build says what to check; no model is a 503 with no worker", async () => {
  const seen: string[] = [];
  const building = new MusicGenService(scripted(okReply, { ensureEnvironment: async (onProgress) => { onProgress("packages"); } }));
  await building.run({ fields: { task: "text2music", caption: "x", duration_s: 30 }, outputDir: join(tmpdir(), `music-env-${process.pid}`) }, { jobId: "job-1", onStage: (stage) => seen.push(stage) });
  expect(seen[0]).toBe("load");
  building.stop();
  const failing = new MusicGenService(scripted(okReply, { ensureEnvironment: async () => { throw new Error("uv exited 2: network unreachable"); } }));
  const error = await failing.run({ fields: { task: "text2music", caption: "x" }, outputDir: "/tmp/never" }, { jobId: "job-2" }).catch((caught) => caught);
  expect(error.message).toContain("internet connection");
  expect(error.code).toBe("setup_failed");
  const bare = new MusicGenService(scripted(okReply, { installed: () => false }));
  const missing = await bare.run({ fields: { task: "text2music", caption: "x" }, outputDir: "/tmp/never" }, { jobId: "job-3" }).catch((caught) => caught);
  expect(missing.code).toBe("model_missing");
  expect(spawned).toBe(1);
  expect(bare.status().state).toBe("not-installed");
});

function fakeChild() {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const err = new TransformStream<Uint8Array, Uint8Array>();
  const input: string[] = [];
  let end!: (code: number) => void;
  const exited = new Promise<number>((done) => { end = done; });
  const writer = out.writable.getWriter();
  const encode = (value: unknown) => writer.write(new TextEncoder().encode(`${typeof value === "string" ? value : JSON.stringify(value)}\n`));
  return { child: { stdin: { write: (data: string) => { input.push(data); }, flush: () => {} }, stdout: out.readable, stderr: err.readable, exited, kill: () => end(143) }, input, send: encode, end };
}

test("the line protocol: ready, stage events for this job only, one reply, a stop mid-song, and a deadline", async () => {
  const fake = fakeChild();
  const worker = workerHandle(fake.child as never);
  await fake.send({ ready: true });
  const events: string[] = [];
  const sending = worker.send({ id: "j1" } as WorkerRequest, { deadlineMs: 5000, onEvent: (event) => events.push(`${event.stage}:${event.fraction}`) });
  await Bun.sleep(10);
  expect(JSON.parse(fake.input[0]!).id).toBe("j1");
  await fake.send("log noise that is not json");
  await fake.send({ id: "other", event: "stage", stage: "mix", fraction: 0.9 });
  await fake.send({ id: "j1", event: "stage", stage: "plan", fraction: 0.4 });
  await fake.send({ id: "j1", ok: true, duration_s: 30, task: "text2music" });
  expect(await sending).toMatchObject({ ok: true, duration_s: 30 });
  expect(events).toEqual(["plan:0.4"]);
  const stopped = worker.send({ id: "j2" } as WorkerRequest, { deadlineMs: 5000, onEvent: () => {} });
  await Bun.sleep(10);
  fake.end(1);
  expect(await stopped).toMatchObject({ ok: false, code: "worker_stopped" });
  const slow = fakeChild();
  const timed = workerHandle(slow.child as never);
  await slow.send({ ready: true });
  expect(await timed.send({ id: "j3" } as WorkerRequest, { deadlineMs: 30, onEvent: () => {} })).toMatchObject({ ok: false, code: "timeout" });
});

// ---- progress and the ETA ----

test("the music stages weigh 1, label in plain words, and the ETA follows the medians kept per task and length", () => {
  __resetGenHistoryForTests();
  rmSync(join(dataDir, "gen-history.json"), { force: true });
  expect(MUSIC_STAGES.reduce((sum, stage) => sum + stage.weight, 0)).toBeCloseTo(1, 5);
  expect(MUSIC_STAGES.map((stage) => stage.label(null, null))).toEqual(["Getting ready", "Planning the song", "Making the music", "Mixing it down", "Saving"]);
  expect(musicHistoryKey("text2music", 45)).toBe("music:text2music:60");
  expect(musicHistoryKey("text2music", 240)).toBe("music:text2music:240");
  expect(musicHistoryKey("cover", undefined)).toBe("music:cover");
  let at = 0;
  const tracker = new GenTracker("music", "music:text2music:60", () => at);
  tracker.enter("plan", 0, 1000);
  // a 60 s song's built-in stage times (plan 16, music 1.4, mix 2.7, save 1) add up to about 21 s
  expect(tracker.snapshot().eta_seconds!).toBeGreaterThanOrEqual(20);
  expect(tracker.snapshot().eta_seconds!).toBeLessThanOrEqual(23);
  const seen: number[] = [];
  for (const [stage, n] of [["plan", 500], ["plan", 1000], ["music", 500], ["mix", 200], ["mix", 900], ["save", 0]] as Array<[string, number]>) { tracker.enter(stage, n, 1000); at += 2000; seen.push(tracker.snapshot().fraction); }
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.at(-1)!).toBeLessThan(1);
});

// ---- the real worker (bench lane, never in the gate) ----

const real = process.env.MUSIC_REAL === "1" && !!process.env.MUSIC_CKPT_DIR && existsSync(process.env.MUSIC_CKPT_DIR) && !!process.env.MUSIC_GEN_PYTHON;
test.skipIf(!real)("the real worker makes a short quick song and trims it (MUSIC_REAL=1)", async () => {
  const script = join(import.meta.dir, "../src/music/music_worker.py");
  const out = mkdtempSync(join(tmpdir(), "music-real-"));
  const child = Bun.spawn([process.env.MUSIC_GEN_PYTHON!, "-s", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: process.env.MUSIC_GEN_SRC ?? "", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", ACESTEP_MLX_VAE_CHUNK: "256", MUSIC_MAX_SECONDS: "120" } });
  const worker = workerHandle(child as never);
  const ffmpeg = process.env.MUSIC_FFMPEG ?? "ffmpeg";
  const base = { ckpt_dir: process.env.MUSIC_CKPT_DIR!, ffmpeg };
  const made = await worker.send({ id: "real-1", task: "text2music", caption: "calm piano", instrumental: true, duration_s: 10, seed: 3, lm: "acestep-5Hz-lm-0.6B", output: join(out, "a.m4a"), ...base } as WorkerRequest, { deadlineMs: 600_000, onEvent: () => {} });
  expect(made).toMatchObject({ ok: true });
  expect(existsSync(join(out, "a.m4a"))).toBe(true);
  const trimmed = await worker.send({ id: "real-2", op: "edit", task: "edit", source: join(out, "a.m4a"), edit: { op: "trim", from_s: 0, to_s: 5 }, output: join(out, "b.m4a"), ...base } as WorkerRequest, { deadlineMs: 120_000, onEvent: () => {} });
  expect(trimmed).toMatchObject({ ok: true });
  worker.kill();
  rmSync(out, { recursive: true, force: true });
}, 900_000);
