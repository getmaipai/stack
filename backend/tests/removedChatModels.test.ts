// The owner removed the Muse Glimmer 30B chat family and the Qwen3 1.7B chat
// models from the Stack (2026-11-17). An install that still holds their
// files and records must boot: the parts are gone from the list and the
// plans, and nothing the household chose or installed is touched.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { buildDiskPlan } from "@/lib/diskPlan";
import { PART_DEFS } from "@/lib/partDefs";
import { listParts } from "@/lib/partsList";
import { stackParts } from "@/lib/parts";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, upsertModel } from "@/lib/modelStore";
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS } from "@/profiles";
import { resolveLadder } from "@/lib/tiers";
import { resetSupervisorForTests, selectedModel, setMachineTier } from "@/lib/supervisor";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

const REMOVED = ["muse-glimmer-30b-q4-k-xl", "muse-glimmer-30b-q4-k-m", "muse-glimmer-30b-mlx-4bit", "muse-glimmer-30b-mmproj-q4-k-m", "qwen3-1.7b-q8-0", "qwen3-1.7b-mlx-4bit"];
const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "e".repeat(64), licence: "Apache-2.0", verifiedAt: "2026-10-18T00:00:00.000Z" };

beforeEach(() => { clearModelsForTests(); __resetSettingsForTests(); });
afterEach(() => { resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); setMachineTier(undefined); });

test("the removed ids are in no part, pin, profile binding, tier slot or plan", async () => {
  expect(PART_DEFS.filter((def) => REMOVED.includes(def.id))).toEqual([]);
  expect(STACK_MODELS.filter((pin) => REMOVED.includes(pin.id))).toEqual([]);
  expect(stackParts().filter((part) => REMOVED.includes(part.id))).toEqual([]);
  expect((await listParts({ audience: "adult" })).parts.filter((row) => REMOVED.includes(row.id))).toEqual([]);
  for (const tier of PROFILE_TIERS) {
    expect(Object.values(PROFILE_MODEL_BINDINGS[tier.id] ?? {}).filter((id) => REMOVED.includes(id))).toEqual([]);
    expect(buildDiskPlan(tier).rows.flatMap((row) => row.model_ids).filter((id) => REMOVED.includes(id))).toEqual([]);
    for (const row of resolveLadder("chat", tier.id, 100 * 1024 ** 3)) expect(REMOVED).not.toContain(row.resolved?.model ?? "");
  }
});

test("every profile still has a recommended Standard chat model, the Qwen3 8B below 128 GB and the 35B at 128 GB (owner lineup 2026-11-25), and the plans carry it", () => {
  for (const tier of PROFILE_TIERS) {
    expect(PROFILE_MODEL_BINDINGS[tier.id]?.chat).toBe("qwen3-8b-instruct-q4-k-m");
    expect(resolveLadder("chat", tier.id, 100 * 1024 ** 3)[0]?.resolved?.model).toBe(tier.id === "p128" ? "qwen3-6-35b-a3b-huihui-abliterated-q4-k-m" : "qwen3-8b-instruct-q4-k-m");
  }
});

test("an install that still has the old records boots: they stay, a stored choice of one still resolves, and the lists skip them", async () => {
  setMachineTier("p64");
  for (const id of REMOVED) upsertModel({ id, roles: ["chat"], ...verified, modelPath: `/tmp/never-opened/${id}.gguf`, engineRequirements: { engine: "llama-server" } });
  // The household's own choice survives: a stored chat model that names an old record still selects it.
  updateSettings({ "stack.engines.chat.model": "muse-glimmer-30b-q4-k-xl" });
  applyPendingSettings();
  expect(selectedModel("chat")?.id).toBe("muse-glimmer-30b-q4-k-xl");
  for (const id of REMOVED) expect(getModel(id)).not.toBeNull();
  const parts = (await listParts({ audience: "adult" })).parts;
  expect(parts.filter((row) => REMOVED.includes(row.id))).toEqual([]);
  expect((await app.request("/stack/v1/parts?audience=adult")).status).toBe(200);
  expect((await app.request("/stack/v1/models")).status).toBe(200);
  expect((await app.request("/stack/v1/install-plan")).status).toBe(200);
  // A part order that still names a removed part is accepted and skipped, never refused.
  const put = await app.request("/stack/v1/parts/choices", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat: { order: ["muse-glimmer-30b-q4-k-xl", "qwen3-8b-instruct-q4-k-m"], off: [] } }) });
  expect(put.status).toBe(200);
});
