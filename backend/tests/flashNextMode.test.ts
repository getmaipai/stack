// Home's coding mode (the lease Max chat uses) loads Flash Next when it and its draft are installed, and Ornith as before when they are not.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_READY_MARKER, SPLASH_PIN } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT as DRAFT, STACK_CHAT_QWEN38_FLASH_NEXT_MODEL as FLASH, STACK_CODING_HEAVY_DRAFT_MODEL as ORNITH_DRAFT, STACK_CODING_HEAVY_MODEL as ORNITH } from "@/lib/modelCatalog";
import { clearModelsForTests, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { codingModeHeavy, splashRoot } from "@/lib/splashStore";
import { currentHomeMode, homeModeView, initializeHomeMode, switchHomeMode } from "@/lib/homeMode";
import { setupHomeModeRuntime } from "@/lib/homeModeRuntime";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __setAppleChipForTests, __resetAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests } from "@/lib/health";
import { __resetSettingsForTests } from "@/settings";
import { launchPlan, resetSupervisorForTests, scriptedProcess, selectedModel, selectableModels, setCodingMachineFacts, setMachineTier, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { eq } from "drizzle-orm";

const GIB = 1_073_741_824;

function sparse(path: string, size: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); truncateSync(path, size); }
function installPin(pin: CatalogModelLike) {
  const modelPath = join(splashRoot(), "fixture", pin.id);
  for (const file of pin.download!.files ?? []) sparse(join(modelPath, file.path), file.bytes);
  upsertModel({ id: pin.id, roles: [pin.role], source: "catalog", provenance: { repo: pin.repo }, revision: pin.revision!, sha256: pin.download!.sha256, licence: pin.license!, verifiedAt: new Date().toISOString(), sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, ...(pin.component ? { component: pin.component } : {}), ...(pin.launch ? { launch: pin.launch } : {}) } } as never);
}
function installSplashEngine() {
  const dir = engineDir(SPLASH_PIN);
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine", "splash"), "");
  writeFileSync(join(dir, ENGINE_READY_MARKER), "now");
}
const okClient = { baseUrl: "scripted://coding", health: async () => true, request: async () => ({ status: 200, body: { choices: [{ message: { content: "ready", tool_calls: [{ id: "1" }] } }] } }) };
const wipe = () => { db.delete(meta).where(eq(meta.key, "coding.home_mode.self_test")).run(); db.delete(meta).where(eq(meta.key, "coding.home_mode.failure")).run(); };

beforeEach(() => {
  __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests(); wipe();
  setMachineTier("p128"); setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 5, chipName: "Apple M5 Max", memoryGb: 128, osVersion: "26.4" }); __setAppleChipForTests({ generation: 5, name: "Apple M5 Max" });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GIB, freeMemoryBytes: 110 * GIB, tier: "p128" });
  installSplashEngine();
});
afterEach(() => {
  setSupervisorFactoryForTests(null); setMachineTier(null); setCodingMachineFacts(null); __resetAppleChipForTests(); initializeHomeMode("normal"); wipe();
  rmSync(join(engineDir(SPLASH_PIN), ".."), { recursive: true, force: true });
  rmSync(splashRoot(), { recursive: true, force: true });
  clearModelsForTests(); __resetSettingsForTests(); __resetGovernorForTests();
});

test("the mode's big model is Flash Next only when it and its draft are both installed; otherwise Ornith, as before", () => {
  expect(codingModeHeavy()).toEqual({ pin: ORNITH, draftPin: ORNITH_DRAFT });
  installPin(FLASH);
  expect(codingModeHeavy().pin.id).toBe(ORNITH.id);
  installPin(DRAFT);
  expect(codingModeHeavy()).toEqual({ pin: FLASH, draftPin: DRAFT });
  expect(FLASH.modeVerdict).toBe("offer_with_limits");
});

test("with Flash Next installed, the mode checks pass on its pieces and its own memory plan (about 74 GB at the pinned 32K), and a switch starts it for coding", async () => {
  installPin(FLASH); installPin(DRAFT);
  await setupHomeModeRuntime("normal");
  const view = homeModeView();
  expect(view.checks).toMatchObject({ pieces: true, bench: true, engine: true, hardware: true });
  expect(view.memory.plan_bytes).toBeGreaterThan(70_000_000_000);
  expect(view.memory.plan_bytes).toBeLessThan(80_000_000_000);
  const started: Array<[string, string | undefined]> = [];
  setSupervisorFactoryForTests(async (role, modelId) => { started.push([role, modelId]); return scriptedProcess(role, { modelId: modelId ?? role, client: okClient }); });
  await switchHomeMode("coding");
  expect(currentHomeMode()).toBe("coding");
  expect(started.find(([role]) => role === "coding")).toEqual(["coding", FLASH.id]);
  expect(started.some(([, id]) => id === ORNITH.id)).toBe(false);
  expect(selectedModel("coding")?.id).toBe(FLASH.id);
  expect(selectedModel("chat")?.id).toBe(FLASH.id);
  expect(selectableModels("chat")).toEqual([{ id: FLASH.id, name: FLASH.id }]);
});

test("without Flash Next installed, the mode loads Ornith exactly as before", async () => {
  installPin(ORNITH); installPin(ORNITH_DRAFT);
  await setupHomeModeRuntime("normal");
  expect(homeModeView().checks.pieces).toBe(true);
  const started: Array<[string, string | undefined]> = [];
  setSupervisorFactoryForTests(async (role, modelId) => { started.push([role, modelId]); return scriptedProcess(role, { modelId: modelId ?? role, client: okClient }); });
  await switchHomeMode("coding");
  expect(started.find(([role]) => role === "coding")).toEqual(["coding", ORNITH.id]);
  expect(selectedModel("coding")?.id).toBe(ORNITH.id);
});

test("a Flash Next that does not start returns to the residents and stays in Normal mode", async () => {
  installPin(FLASH); installPin(DRAFT);
  await setupHomeModeRuntime("normal");
  const started: string[] = [];
  setSupervisorFactoryForTests(async (role, modelId) => {
    started.push(role);
    if (role === "coding") throw new Error("Splash did not start.");
    return scriptedProcess(role, { modelId: modelId ?? role, client: okClient });
  });
  await expect(switchHomeMode("coding")).rejects.toMatchObject({ name: "HomeModeError" });
  expect(currentHomeMode()).toBe("normal");
  expect(started).toContain("chat");
  expect(selectedModel("coding")?.id).not.toBe(FLASH.id);
});

test("the coding launch keeps Flash Next's pinned 32K window, Ornith keeps the coding setting's window", async () => {
  installPin(FLASH); installPin(DRAFT); installPin(ORNITH); installPin(ORNITH_DRAFT);
  const { getModel } = await import("@/lib/modelStore");
  const plan = await launchPlan("coding", getModel(FLASH.id)!, 8812);
  expect(plan.contextLength).toBe(32_768);
  expect(plan.command[plan.command.indexOf("--max-context") + 1]).toBe("32768");
  expect(plan.command).toContain("--model-dir");
  const ornith = await launchPlan("coding", getModel(ORNITH.id)!, 8813);
  expect(ornith.contextLength).toBe(131_072);
});
