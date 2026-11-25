import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const roots: string[] = [];
process.env.STACK_DATA_DIR ??= join(import.meta.dir, "../../../data-test", `run-${process.pid}`);
process.env.HOME = mkdtempSync(join(tmpdir(), "cache-guard-home-"));
roots.push(process.env.HOME);
let planCaches: typeof import("@/lib/cacheGuard").planCaches;
let runCacheGuard: typeof import("@/lib/cacheGuard").runCacheGuard;
let clearOutsideCache: typeof import("@/lib/cacheGuard").clearOutsideCache;
let modelsDir: string;
let __resetJobsForTests: typeof import("@/lib/jobs").__resetJobsForTests;
let submitJob: typeof import("@/lib/jobs").submitJob;
let updateJob: typeof import("@/lib/jobs").updateJob;
let db: typeof import("@/db").db;
let models: typeof import("@/db/schema").models;
let meta: typeof import("@/db/schema").meta;
let runSweeps: typeof import("@/lib/sweeps").runSweeps;

function temp(label: string): string { const path = mkdtempSync(join(tmpdir(), `cache-guard-${label}-`)); roots.push(path); return path; }
const set = (key: string, value: unknown) => { db.insert(meta).values({ key: `settings.${key}.in_effect`, value: JSON.stringify(value) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } }).run(); };

describe("cache guard", () => {
  let previous: string | undefined;
  beforeEach(async () => { await import("@/app"); ({ planCaches, runCacheGuard, clearOutsideCache } = await import("@/lib/cacheGuard")); ({ modelsDir } = await import("@/lib/paths")); ({ __resetJobsForTests, submitJob, updateJob } = await import("@/lib/jobs")); ({ db } = await import("@/db")); ({ models, meta } = await import("@/db/schema")); ({ runSweeps } = await import("@/lib/sweeps")); });
  afterEach(() => { for (const path of roots.splice(1)) rmSync(path, { recursive: true, force: true }); __resetJobsForTests(); });

  test("tmp age and active jobs control cleanup", async () => {
    set("stack.storage.cache_guard_enabled", true); set("stack.storage.tmp_hours", 6);
    const fresh = join(process.env.STACK_DATA_DIR!, "tmp", `fresh-${crypto.randomUUID()}`), old = join(process.env.STACK_DATA_DIR!, "tmp", `old-${crypto.randomUUID()}`);
    mkdirSync(fresh, { recursive: true }); mkdirSync(old, { recursive: true }); writeFileSync(join(fresh, "x"), "fresh"); writeFileSync(join(old, "x"), "old");
    const then = Date.now() - 8 * 3600_000; utimesSync(old, then / 1000, then / 1000); utimesSync(join(old, "x"), then / 1000, then / 1000);
    const planned = await planCaches();
    expect(planned.owned.some(x => x.path === fresh)).toBe(false);
    expect(planned.owned.some(x => x.path === old)).toBe(true);
    const submitted = submitJob({ caller: "test", kind: "test", role: "chat", input: {} });
    if (!("refused" in submitted)) { updateJob(submitted.job.id, { state: "running" }); expect((await planCaches()).owned.filter(x => x.kind === "tmp_leftover")).toHaveLength(0); }
  });

  test("orphan model folder follows tidy grace", async () => {
    const folder = join(modelsDir, `cache-guard-orphan-${crypto.randomUUID()}`); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "weight"), "x");
    set("stack.storage.tidy_grace_hours", 24); const now = Date.now();
    expect((await runSweeps("storage")).per_sweep.some(x => x.name === "tidy")).toBe(true);
    const old = now - 48 * 3600_000; utimesSync(folder, old / 1000, old / 1000);
    await runSweeps("storage"); expect(existsSync(folder)).toBe(false);
  });

  test("only dangling links are unlinked; live outside targets survive", async () => {
    const outside = temp("target"), live = join(modelsDir, `live-link-${crypto.randomUUID()}`), dangling = join(modelsDir, `dangling-link-${crypto.randomUUID()}`); mkdirSync(modelsDir, { recursive: true }); writeFileSync(join(outside, "keep"), "safe");
    symlinkSync(outside, live); symlinkSync(join(outside, "missing"), dangling);
    await runCacheGuard(); expect(existsSync(live)).toBe(true); expect(existsSync(join(outside, "keep"))).toBe(true); expect(existsSync(dangling)).toBe(false);
  });

  test("referenced model paths are protected", async () => {
    const path = join(process.env.STACK_DATA_DIR!, "tmp", `reference-${crypto.randomUUID()}`); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "f"), "keep");
    db.insert(models).values({ id: "cache-ref", modelPath: path, roles: "[]", source: "catalog", provenance: "{}", revision: "x", sha256: "x", licence: "x", engineRequirements: "{}", firstBootAt: new Date().toISOString() }).run();
    const result = await runCacheGuard(Date.now() + 48 * 3600_000); expect(existsSync(path)).toBe(true);
  });

  test("outside clear preserves tokens and refuses unlisted path", async () => {
    const home = temp("outside-home"); process.env.HOME = home;
    const outside = join(home, ".cache", "huggingface"); mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "token"), "t"); writeFileSync(join(outside, "stored_tokens"), "s"); writeFileSync(join(outside, "blob"), "b");
    await expect(clearOutsideCache("/not/in/plan")).rejects.toThrow();
    const cleared = await clearOutsideCache(outside);
    expect(cleared.kept).toContain(join(outside, "token")); expect(cleared.kept).toContain(join(outside, "stored_tokens")); expect(existsSync(join(outside, "blob"))).toBe(false);
  });

  test("unreadable cache entries and removal failures become problems", async () => {
    const unreadable = join(process.env.STACK_DATA_DIR!, "tmp", `unreadable-${crypto.randomUUID()}`); mkdirSync(unreadable, { recursive: true }); writeFileSync(join(unreadable, "f"), "x"); chmodSync(unreadable, 0);
    const planned = await planCaches(Date.now() + 48 * 3600_000); expect(planned.owned.some(item => item.path === unreadable)).toBe(true);
    chmodSync(unreadable, 0o700);
    const result = await runCacheGuard(Date.now() + 48 * 3600_000); expect(result.problems.length).toBeGreaterThan(0);
  });

  test("a live referenced tmp path is not removed", async () => {
    const path = join(process.env.STACK_DATA_DIR!, "tmp", `model-ref-${crypto.randomUUID()}`); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "f"), "x");
    db.insert(models).values({ id: `cache-ref-${crypto.randomUUID()}`, modelPath: path, roles: "[]", source: "catalog", provenance: "{}", revision: "x", sha256: "x", licence: "x", engineRequirements: "{}", firstBootAt: new Date().toISOString() }).run();
    const plan = await planCaches(Date.now() + 48 * 3600_000); expect(plan.owned.some(item => item.path === path)).toBe(true);
    const result = await runCacheGuard(Date.now() + 48 * 3600_000); expect(existsSync(path)).toBe(true); expect(result.problems.some(text => text.includes("references"))).toBe(true);
  });

  test("outside cache clear keeps top level settings files", async () => {
    const outside = join(process.env.HOME!, ".cache", "huggingface"); mkdirSync(outside, { recursive: true }); writeFileSync(join(outside, "settings.json"), "{}" );
    const cleared = await clearOutsideCache(outside); expect(cleared.kept).toContain(join(outside, "settings.json"));
  });

  test("setting off leaves paths untouched", async () => {
    set("stack.storage.cache_guard_enabled", false); const path = join(process.env.STACK_DATA_DIR!, "tmp", `safe-${crypto.randomUUID()}`); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "f"), "keep");
    await runCacheGuard(); expect(existsSync(path)).toBe(true);
  });
});
