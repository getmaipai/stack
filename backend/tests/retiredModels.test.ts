// The Ornith 1.5 122B coding model and its draft were retired on 2026-11-21 (owner decision). An upgrade must leave a Stack that still has
// their files, records, a saved choice and Splash's hardlinked layout cleanly started, with the disk freed only through Tidy.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { dataDir, modelsDir } from "@/lib/paths";
import { clearModelsForTests, getModel, installCatalogModel, listModels, registerCatalogModel, upsertModel } from "@/lib/modelStore";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { componentDefs } from "@/lib/components";
import { planTidy, runTidy } from "@/lib/tidy";
import { retireModels } from "@/lib/retireModels";
import { RETIRED_MODELS, isRetiredModelId } from "@/lib/retiredModels";
import { selectedModel, selectableModels, setMachineTier } from "@/lib/supervisor";
import { splashHubDir } from "@/lib/splashStore";
import { writeModelManifest } from "@/lib/store/manifests";
import { __resetSettingsForTests, settingValues, updateSettings } from "@/settings";

const MODEL = "ornith-1-5-122b-mlx-4bit";
const DRAFT = "ornith-1-5-122b-dflash2-draft";
const LONG_AGO = new Date(Date.now() - 10 * 24 * 3600_000);

beforeEach(() => { setMachineTier("p128"); });
afterEach(() => { setMachineTier(null); __resetSettingsForTests(); clearModelsForTests(); rmSync(modelsDir, { recursive: true, force: true }); mkdirSync(modelsDir, { recursive: true }); rmSync(join(dataDir, "splash"), { recursive: true, force: true }); });

/** Small fake directories standing in for the 65 GB model (a sparse 30 GB file proves the size limit for unknown folders does not apply) and its draft. */
function leftOver(): { model: string; draft: string; weights: string } {
  const model = join(modelsDir, MODEL); const draft = join(modelsDir, DRAFT);
  const weights = join(model, "Ornith-1.5-122B-MLX-4bit", "model-00001-of-00014.safetensors");
  mkdirSync(join(model, "Ornith-1.5-122B-MLX-4bit"), { recursive: true }); writeFileSync(weights, ""); truncateSync(weights, 30_000_000_000);
  mkdirSync(join(draft, "Ornith-1.5-122B-DFlash2"), { recursive: true }); writeFileSync(join(draft, "Ornith-1.5-122B-DFlash2", "model.safetensors"), "draft");
  utimesSync(model, LONG_AGO, LONG_AGO); utimesSync(draft, LONG_AGO, LONG_AGO);
  return { model, draft, weights };
}
function leftOverRecords(paths: { model: string; draft: string }): void {
  for (const [id, path] of [[MODEL, paths.model], [DRAFT, paths.draft]] as const) {
    upsertModel({ id, roles: ["coding"], source: "catalog", provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: path, sizeBytes: 5 });
    writeModelManifest({ id, kind: "model", roles: ["coding"], blobs: [{ digest: "a".repeat(64), path, sizeBytes: 5 }], sizeBytes: 5, createdAt: new Date().toISOString() } as never);
  }
}

test("the catalog, the part rows and every tier table no longer carry Ornith, and nothing can install it", async () => {
  expect(STACK_MODELS.filter((pin) => isRetiredModelId(pin.id) || pin.id.startsWith("ornith"))).toEqual([]);
  expect(componentDefs().flatMap((unit) => unit.pins).filter((pin) => isRetiredModelId(pin.id))).toEqual([]);
  expect(RETIRED_MODELS.map((model) => model.id).sort()).toEqual([DRAFT, MODEL].sort());
  const pin = { ...STACK_MODELS.find((candidate) => candidate.role === "coding")!, id: MODEL };
  expect(() => registerCatalogModel(pin)).toThrow(/retired/);
  await expect(installCatalogModel(pin, { destination: join(modelsDir, MODEL, "m.gguf"), download: async () => { throw new Error("must not fetch"); } })).rejects.toThrow(/retired/);
  expect(getModel(MODEL)).toBeNull();
});

test("a leftover Ornith directory and its draft are listed by Tidy as orphans and removed by it, past the usual size limit, with no model record left", async () => {
  const { model, draft } = leftOver();
  const plan = await planTidy();
  expect(plan.items.filter((item) => item.kind === "orphan_folder").map((item) => item.id).sort()).toEqual([draft, model].sort());
  const route = await app.request("/stack/v1/components/tidy");
  expect(route.status).toBe(200);
  expect((await route.json() as { items: Array<{ id: string; kind: string }> }).items.filter((item) => item.kind === "orphan_folder").map((item) => item.id).sort()).toEqual([draft, model].sort());
  // Dry run removes nothing.
  expect((await runTidy()).removed).toHaveLength(0); expect(existsSync(model)).toBe(true);
  const removed = await app.request("/stack/v1/components/tidy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dry_run: false }) });
  expect((await removed.json() as { removed: Array<{ id: string }> }).removed.map((item) => item.id).sort()).toEqual([draft, model].sort());
  expect(existsSync(model)).toBe(false); expect(existsSync(draft)).toBe(false);
});

test("a stale record, manifest and saved choice naming Ornith do not protect it: start-up retires them with a plain notice, and the Stack falls back to its own models", async () => {
  const paths = leftOver(); leftOverRecords(paths);
  updateSettings({ "stack.engines.chat.model": MODEL });
  // Before the start-up step: the record is not selectable for coding on any tier, and the saved choice falls back.
  expect(selectableModels("coding").map(({ id }) => id)).not.toContain(MODEL);
  expect(selectedModel("coding")?.id ?? null).not.toBe(MODEL);
  expect(selectedModel("chat")?.id ?? null).not.toBe(MODEL);
  // Splash's hardlinked layout of the model keeps the disk full unless it goes too.
  const hub = join(splashHubDir(), "models--ezoushen--ornith-1.5-122b-mlx-4bit"); mkdirSync(join(hub, "blobs"), { recursive: true });
  linkSync(join(paths.draft, "Ornith-1.5-122B-DFlash2", "model.safetensors"), join(hub, "blobs", "a".repeat(64)));
  const started = performance.now();
  const result = retireModels();
  expect(performance.now() - started).toBeLessThan(500);
  expect(result.records.sort()).toEqual([DRAFT, MODEL].sort());
  expect(result.settings).toEqual(["stack.engines.chat.model"]);
  expect(result.layouts).toEqual([MODEL]);
  expect(result.notices.some((notice) => notice.includes("stack.engines.chat.model") && notice.includes("default model"))).toBe(true);
  expect(settingValues()["stack.engines.chat.model"]).toBe("");
  expect(listModels().map((record) => record.id)).not.toContain(MODEL);
  expect(existsSync(hub)).toBe(false);
  // The folders are now plain orphans for Tidy, which removes them.
  const plan = await planTidy();
  expect(plan.items.filter((item) => item.kind === "orphan_folder").map((item) => item.id).sort()).toEqual([paths.draft, paths.model].sort());
  expect(plan.items.every((item) => item.blocked === null)).toBe(true);
  const result2 = await runTidy(false);
  expect(result2.removed).toHaveLength(2);
  expect(existsSync(paths.model)).toBe(false); expect(existsSync(paths.draft)).toBe(false);
  // Running it again, and on a Stack that never had the model, is a no-op.
  expect(retireModels()).toEqual({ records: [], settings: [], layouts: [], notices: [] });
});
