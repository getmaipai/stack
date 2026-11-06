import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir, modelsDir } from "@/lib/paths";
import { clearModelsForTests, upsertModel, listModels } from "@/lib/modelStore";
import { __setComponentUnitsForTests, componentDefs } from "@/lib/components";
import { planTidy, runTidy } from "@/lib/tidy";
import { runSweeps } from "@/lib/sweeps";
import { createJob, finishJob } from "@/lib/jobs";
import { STACK_MODELS, STACK_VIDEO_DETAILED_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_QWEN_MODELS } from "@/lib/modelCatalog";

afterEach(() => { __setComponentUnitsForTests(null); clearModelsForTests(); rmSync(modelsDir, { recursive: true, force: true }); mkdirSync(modelsDir, { recursive: true }); });

test("dry run defaults to no deletion and the public route lists candidates", async () => {
  const file = join(modelsDir, "abandoned", "model.bin.part"); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "123");
  utimesSync(file, new Date(Date.now() - 8 * 24 * 3600_000), new Date(Date.now() - 8 * 24 * 3600_000));
  const result = await runTidy();
  expect(result.dry_run).toBe(true); expect(result.removed).toHaveLength(0); expect(existsSync(file)).toBe(true);
  const response = await app.request("/stack/v1/tidy"); expect(response.status).toBe(200);
  expect((await response.json() as { items: Array<{ kind: string }> }).items.some((item) => item.kind === "partial_download")).toBe(true);
});

test("partial download cleanup waits seven days and the scheduled sweep calls tidy", async () => {
  const old = join(modelsDir, "old.bin.part"); const recent = join(modelsDir, "recent.bin.part");
  writeFileSync(old, "old"); writeFileSync(recent, "new");
  const date = new Date(Date.now() - 8 * 24 * 3600_000); utimesSync(old, date, date);
  const result = await runTidy(false);
  expect(result.removed.some((item) => item.id === old)).toBe(true); expect(existsSync(recent)).toBe(true);
  const sweepFile = join(modelsDir, "sweep.bin.part"); writeFileSync(sweepFile, "old"); utimesSync(sweepFile, date, date);
  await runSweeps("timer");
  expect(existsSync(sweepFile)).toBe(false);
});

test("the existing storage sweep awaits tidy and reports what it removed", async () => {
  const old = join(modelsDir, "storage-old.bin.part"); writeFileSync(old, "old");
  const date = new Date(Date.now() - 8 * 24 * 3600_000); utimesSync(old, date, date);
  const response = await app.request("/stack/v1/storage/sweep", { method: "POST" });
  expect(response.status).toBe(200);
  const body = await response.json() as { sweep: { per_sweep: Array<{ name: string; removed: number }> } };
  expect(body.sweep.per_sweep.find((entry) => entry.name === "tidy")?.removed).toBeGreaterThan(0);
  expect(existsSync(old)).toBe(false);
});

test("orphan folders are removed only when unreferenced, in-bounds, and not symlinks", async () => {
  const orphan = join(modelsDir, "untracked-model"); mkdirSync(orphan); writeFileSync(join(orphan, "weights.bin"), "x".repeat(8));
  const referenced = join(modelsDir, "recorded-model"); mkdirSync(referenced); writeFileSync(join(referenced, "weights.bin"), "keep");
  upsertModel({ id: "recorded-model", roles: ["video"], source: "catalog", provenance: {}, revision: "r1", modelPath: referenced, sizeBytes: 4 });
  const outside = mkdtempSync(join(tmpdir(), "tidy-outside-")); writeFileSync(join(outside, "keep"), "safe");
  symlinkSync(outside, join(modelsDir, "linked-model"));
  const date = new Date(Date.now() - 25 * 3600_000); utimesSync(orphan, date, date);
  const result = await runTidy(false);
  expect(result.removed.some((item) => item.id === orphan)).toBe(true);
  expect(existsSync(referenced)).toBe(true); expect(existsSync(join(outside, "keep"))).toBe(true);
  rmSync(outside, { recursive: true, force: true });
});

test("a record-referenced model directory is not listed as an orphan", async () => {
  const path = join(modelsDir, "kept-model"); mkdirSync(path); writeFileSync(join(path, "weights.bin"), "keep");
  upsertModel({ id: "kept-model", roles: ["video"], source: "catalog", provenance: {}, revision: "r1", modelPath: path, sizeBytes: 4 });
  const plan = await planTidy(); expect(plan.items.some((item) => item.id === path)).toBe(false);
});

test("LTX 2.3 is catalog-declared as superseded and stays blocked without a ready successor", async () => {
  __setComponentUnitsForTests(null);
  const response = await app.request("/stack/v1/components");
  const body = await response.json() as { components: Array<{ id: string; superseded_by: string[] }> };
  expect(body.components.find((item) => item.id === "ltx-2-3-distilled-mlx")?.superseded_by).toEqual(["ltx-2-5-q8-distilled-mlx"]);
  const model = join(modelsDir, "ltx-2-3-distilled-mlx", "weights.bin"); mkdirSync(join(model, ".."), { recursive: true }); writeFileSync(model, "old");
  upsertModel({ id: "ltx-2-3-distilled-mlx", roles: ["video"], source: "catalog", provenance: {}, revision: "r1", modelPath: model, sizeBytes: 3 });
  const plan = await planTidy(); const candidate = plan.items.find((item) => item.kind === "superseded");
  expect(candidate?.blocked).toContain("must be installed"); expect(existsSync(model)).toBe(true);
});

test("live model layout protects named folders and active installs; removes only an orphan and stale partial", async () => {
  const fixtureIds = ["muse-glimmer-30b-q4-k-xl", "muse-glimmer-30b-mmproj-q4-k-m", "qwen3.8-27b-dflash2-draft", "z-image-turbo-unet", "ernie-image-turbo-text-encoder", "flux2-klein-4b-transformer", "chatterbox-turbo-fp16-decoder", "pocket-tts-english-tokenizer", "image-tool-background-removal", "qwen3-1.7b-q8-0", "parakeet-tdt-0.6b-v2-int8", "soulx-singer-svc", "htdemucs", "ornith-1-5-122b-dflash2-draft"];
  const old = new Date(Date.now() - 10 * 24 * 3600_000);
  for (const id of fixtureIds) {
    const dir = join(modelsDir, id); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "weights.bin"), "keep"); utimesSync(dir, old, old);
    upsertModel({ id, roles: ["chat"], source: "catalog", provenance: {}, revision: "r1", modelPath: join(modelsDir, "hub", "model", id), sizeBytes: 4 });
  }
  const activeId = "ltx-2-5-q8-distilled-mlx"; const activeDir = join(modelsDir, activeId); mkdirSync(activeDir, { recursive: true });
  const part = join(activeDir, "weights.bin.part"); writeFileSync(part, "download"); utimesSync(part, old, old); utimesSync(activeDir, old, old);
  const activeJob = createJob({ kind: "component.install", input: { component: activeId, model: activeId } });
  const orphan = join(modelsDir, "made-up-household-orphan"); mkdirSync(orphan); writeFileSync(join(orphan, "file"), "orphan"); utimesSync(orphan, old, old);
  const stalePart = join(modelsDir, "abandoned.bin.part"); writeFileSync(stalePart, "old partial"); utimesSync(stalePart, old, old);
  const plan = await planTidy();
  expect(plan.items.filter((item) => item.kind === "orphan_folder").map((item) => item.id)).toEqual([orphan]);
  expect(plan.items.filter((item) => item.kind === "partial_download").map((item) => item.id)).toEqual([stalePart]);
  const result = await runTidy(false);
  expect(result.removed.map((item) => item.id).sort()).toEqual([orphan, stalePart].sort());
  expect(fixtureIds.every((id) => existsSync(join(modelsDir, id)))).toBe(true);
  expect(existsSync(part)).toBe(true); expect(existsSync(activeDir)).toBe(true);
  finishJob(activeJob.id, { ok: true });
});

test("every real catalog pin id is known by the tidy folder rule", async () => {
  const ids = [...STACK_MODELS, ...STACK_VIDEO_DETAILED_MODELS, ...STACK_VIDEO_LTX25_MODELS, ...STACK_VIDEO_LTX25_MAX_MODELS, ...STACK_IMAGE_KLEIN_MODELS, ...STACK_IMAGE_ZIMAGE_MODELS, ...STACK_IMAGE_ERNIE_MODELS, ...STACK_IMAGE_QWEN_MODELS, ...componentDefs().flatMap((unit) => unit.pins)].map((pin) => pin.id);
  for (const id of new Set(ids)) { mkdirSync(join(modelsDir, id), { recursive: true }); }
  const plan = await planTidy();
  expect(plan.items.filter((item) => item.kind === "orphan_folder").map((item) => item.id)).toEqual([]);
});
