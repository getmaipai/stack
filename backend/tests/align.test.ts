import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { dataDir } from "@/lib/paths";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ALIGN_JOB_KIND, __alignStashHasForTests, registerAlignJobs, stashAlign } from "@/align/jobs";
import { align, alignWorkerEnv, handle, scrubLyrics, type AlignDeps, type AlignRequest, type AlignResult } from "@/align/align";
import { __resetMusicProvenanceForTests, recordMadeSong, sha256Hex, wasMadeHere } from "@/music/provenance";
import { PRIVACY_ROWS } from "@/lib/privacy";
import { removeWorkerDir, startLeakyWorker, waitForWorkerRequest, waitForWorkerTreeGone, waitForWorkerPids } from "./helpers/leakyWorker";

const GB = 1_073_741_824;
const LYRICS = "Zebra quokka\n\nMarmalade dreams, tonight";
const made = (n: string) => { const b = new TextEncoder().encode(`0000ftypM4A align-${n}`); recordMadeSong(b); return b; };
const ok = (r: AlignRequest): AlignResult => ({ words: [{ t: 0.5, end: 0.9, text: "Zebra" }, { t: 1, end: 1.4, text: "quokka" }, { t: 2, end: 2.5, text: "Marmalade" }], aligned_words: 3, total_words: 5, line_starts: [0, -1, 2], ms: 12 });
function deps(run: (r: AlignRequest) => AlignResult | Promise<AlignResult>): AlignDeps { return { supported: () => true, installed: () => true, ensure: async () => {}, runtime: () => ({ modelPath: "m", modelHash: "h", ffmpeg: "f" }), spawn: async () => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (r, stage) => { stage("loading", .1); stage("aligning", .4); return run(r); } }) }; }
const body = (b: Uint8Array, extra: Record<string, unknown> = {}) => ({ source: Buffer.from(b).toString("base64"), source_sha256: sha256Hex(b), lyrics: LYRICS, ...extra });
const post = (b: any) => app.request("/v1/audio/align", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const get = (p: string) => app.request(p);
const logText = () => { const p = join(dataDir, "logs", "stack.log"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
beforeEach(() => { __resetJobsForTests(); __resetGovernorForTests(); __resetMusicProvenanceForTests(); rmSync(join(dataDir, "tmp", "music"), { recursive: true, force: true }); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" }); registerAlignJobs(); });
afterEach(() => { align.useDeps(null); });

test("a good request returns timed words, the counts and the line starts", async () => {
  const b = made("good"); let seen: AlignRequest | null = null; align.useDeps(deps((r) => { seen = r; return ok(r); }));
  const r = await post(body(b)); expect(r.status).toBe(200); const j = await r.json() as any;
  expect(j.data.words).toEqual([{ t: 0.5, end: 0.9, text: "Zebra" }, { t: 1, end: 1.4, text: "quokka" }, { t: 2, end: 2.5, text: "Marmalade" }]);
  expect([j.data.aligned_words, j.data.total_words, j.data.line_starts]).toEqual([3, 5, [0, -1, 2]]);
  expect(seen!.lyrics).toBe(LYRICS); expect(seen!.maxSeconds).toBe(240);
  expect((await (await get(`/v1/audio/align/${j.job}`)).json() as any).data.aligned_words).toBe(3);
});
test("a source not made here is refused", async () => { align.useDeps(deps(ok)); const b = new TextEncoder().encode("0000ftypM4A not-recorded"); const r = await post(body(b)); expect(r.status).toBe(422); expect(((await r.json()) as any).code).toBe("source_not_made_here"); });
test("a wrong source hash is refused", async () => { const b = made("hash"); align.useDeps(deps(ok)); const r = await post(body(b, { source_sha256: "0".repeat(64) })); expect(r.status).toBe(422); expect(((await r.json()) as any).code).toBe("bad_request"); });
test("lyrics are required and capped at 8000 characters", async () => {
  const b = made("lyrics"); align.useDeps(deps(ok));
  expect((await post(body(b, { lyrics: "" }))).status).toBe(400);
  expect((await post(body(b, { lyrics: "a".repeat(8001) }))).status).toBe(400);
  expect((await post(body(b, { lyrics: "a".repeat(8000) }))).status).toBe(200);
});
test("an oversized source is refused with 413", async () => { align.useDeps(deps(ok)); const big = new Uint8Array(40 * 1024 * 1024 + 1); big.set(new TextEncoder().encode("0000ftypM4A"), 0); const r = await post(body(big)); expect(r.status).toBe(413); });
test("bytes that are not an m4a are refused for made_here", async () => { align.useDeps(deps(ok)); const junk = new TextEncoder().encode("this is not audio at all"); expect((await post(body(junk))).status).toBe(422); });
test("an owned file is timed without the ledger", async () => {
  const b = new TextEncoder().encode("ID3-owned-align-not-made-here"); align.useDeps(deps(ok));
  const r = await post(body(b, { origin: "owned_file" })); expect(r.status).toBe(200); expect(wasMadeHere(b)).toBe(false);
  const junk = new TextEncoder().encode("this is not audio at all"); expect((await post(body(junk, { origin: "owned_file" }))).status).toBe(422);
});
test("the model not being installed is a plain 503 with the next step", async () => {
  const b = made("noinstall"); align.useDeps({ ...deps(ok), installed: () => false });
  const r = await post(body(b)); expect(r.status).toBe(503); const j = await r.json() as any; expect(j.code).toBe("not_installed"); expect(j.error).toContain("Engines page");
});
test("an unsupported computer is refused", async () => { const b = made("unsup"); align.useDeps({ ...deps(ok), supported: () => false }); const r = await post(body(b)); expect(r.status).toBe(503); expect(((await r.json()) as any).code).toBe("unsupported"); });
test("a worker death is a plain failure", async () => {
  const b = made("death"); align.useDeps({ ...deps(ok), spawn: async () => ({ exited: Promise.resolve(1), kill: () => {}, send: async () => { throw new Error("The alignment worker stopped before finishing. Try again."); } }) });
  const r = await post(body(b)); expect(r.status).toBe(500); expect(((await r.json()) as any).error).toContain("stopped before finishing");
});
test("a fifth waiting job is refused with queue_full", async () => {
  align.useDeps({ ...deps(ok), spawn: async () => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: (_r, _s, signal) => new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(new Error("Cancelled.")), { once: true })) }) });
  const codes: number[] = []; for (let i = 0; i < 5; i++) { const r = await post(body(made(`q${i}`), { timeout_ms: 1 })); codes.push(r.status); }
  expect(codes.slice(0, 4)).toEqual([202, 202, 202, 202]); expect(codes[4]).toBe(429);
});
test("cancel stops an active alignment and forgets its stash", async () => {
  const b = made("cancel");
  align.useDeps({ ...deps(ok), spawn: async () => ({ exited: new Promise<number>(() => {}), kill: () => {}, send: async (_r, _s, signal) => new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(new Error("Cancelled.")), { once: true })) }) });
  const r = await post(body(b, { timeout_ms: 1 })); expect(r.status).toBe(202); const job = (await r.json() as any).job;
  const c = await app.request(`/v1/audio/align/${job}`, { method: "DELETE" }); expect(c.status).toBe(200); expect(((await c.json()) as any).state).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const state = await get(`/stack/v1/jobs/${job}`); expect(state.status).toBe(200);
  expect((await app.request("/v1/audio/align/job-nope", { method: "DELETE" })).status).toBe(404);
});
test("cancel stops the align worker and its child process", async () => {
  process.env.MAIPAI_TEST_NO_PORTS = "1"; let dir = ""; const b = made("tree");
  align.useDeps({ ...deps(ok), spawn: async () => { const started = startLeakyWorker(handle as any); dir = started.dir; return started.worker as any; } });
  try {
    const response = await post(body(b, { timeout_ms: 1 })); const job = (await response.json() as any).job;
    for (let i = 0; i < 500 && !dir; i++) await Bun.sleep(20);
    const pids = await waitForWorkerPids(join(dir, "pids")); await waitForWorkerRequest(join(dir, "accepted"));
    await app.request(`/v1/audio/align/${job}`, { method: "DELETE" });
    expect(await waitForWorkerTreeGone(pids)).toBe(true);
  } finally { if (dir) removeWorkerDir(dir); }
}, 30_000);
test("the stash holds a source until the job takes it", () => { stashAlign("t1", new Uint8Array([1]), "x"); expect(__alignStashHasForTests("t1")).toBe(true); });
test("the worker env has no inherited network credentials and points TORCH_HOME at the engine root", () => {
  process.env.HF_TOKEN = "test-token"; process.env.HTTPS_PROXY = "http://proxy.invalid";
  const env = alignWorkerEnv(); expect(env.HF_TOKEN).toBeUndefined(); expect(env.HTTPS_PROXY).toBeUndefined(); expect(env.HF_HUB_OFFLINE).toBe("1"); expect(env.TORCH_HOME).toContain(join("align", "1.0.0", "torch-home"));
  delete process.env.HF_TOKEN; delete process.env.HTTPS_PROXY;
});
test("no lyric word reaches a log line, an error message or a job record (rule 6a)", async () => {
  const b = made("privacy"); align.useDeps(deps(ok));
  const good = await post(body(b)); expect(good.status).toBe(200);
  const fail = made("privacy-fail"); align.useDeps(deps(() => { throw new Error("the aligner choked on Marmalade and zebra"); }));
  const r = await post(body(fail)); expect(r.status).toBe(500); const j = await r.json() as any;
  expect(j.error.toLowerCase()).not.toMatch(/marmalade|zebra|quokka|dreams|tonight/);
  const state = JSON.stringify(await (await get(`/stack/v1/jobs/${j.job}`)).json()); expect(state.toLowerCase()).not.toMatch(/marmalade|zebra|quokka|dreams|tonight/);
  const log = logText(); expect(log).toContain("align.done"); expect(log).toContain("\"words\":3");
  expect(log.toLowerCase()).not.toMatch(/marmalade|zebra|quokka|dreams|tonight/);
  expect(ALIGN_JOB_KIND).toBe("align_generation");
});
test("scrubLyrics blanks every lyric word, any case, and leaves other text", () => {
  expect(scrubLyrics("bad ZEBRA near Marmalade, ok", LYRICS)).toBe("bad … near …, ok");
  expect(scrubLyrics("The worker stopped.", "to be or not")).toBe("The worker stopped.");
});
test("the privacy declaration names the align model host", () => {
  const row = PRIVACY_ROWS.find((r) => r.id === "align-model")!; expect(row.hosts).toEqual(["dl.fbaipublicfiles.com"]); expect(row.when).toContain("offline");
});
