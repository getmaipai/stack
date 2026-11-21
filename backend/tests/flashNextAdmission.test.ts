// The live refusals of Flash Next (128 GB Mac, 2026-11-21): the chat load was refused for 81 GB (the Metal budget counted as the
// footprint), the coding mode was refused by a stricter check than the governor's, and a refused load left chat with no engine.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPLASH_CHAT_PIN, SPLASH_PIN, ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT as MOE_DRAFT, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL as MOE, STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT as DRAFT, STACK_CHAT_QWEN38_FLASH_NEXT_MODEL as FLASH, STACK_CHAT_8B_MODEL } from "@/lib/modelCatalog";
import { clearModelsForTests, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { splashRoot } from "@/lib/splashStore";
import { homeModeView, initializeHomeMode } from "@/lib/homeMode";
import { setupHomeModeRuntime } from "@/lib/homeModeRuntime";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorDecisions, getGovernorStatus } from "@/lib/governor";
import { __setAppleChipForTests, __resetAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests } from "@/lib/health";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";
import { EngineDoesNotFitError, getProcess, getRoleStatus, loadModelForRole, resetSupervisorForTests, scriptedProcess, selectedModel, setCodingMachineFacts, setMachineTier, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { eq } from "drizzle-orm";

const GIB = 1_073_741_824;
// The live ledger: 137,438,953,472 bytes total, a 96,206,848,000 model budget, a 20 GiB working margin (p128).
const TOTAL = 137_438_953_472;
const BUDGET = 96_206_848_000;

function sparse(path: string, size: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); truncateSync(path, size); }
function installPin(pin: CatalogModelLike) {
  const modelPath = join(splashRoot(), "fixture", pin.id);
  if (pin.download?.files) for (const file of pin.download.files) sparse(join(modelPath, file.path), file.bytes); else sparse(modelPath, 1024);
  upsertModel({ id: pin.id, roles: [pin.role], source: "catalog", provenance: { repo: pin.repo }, revision: pin.revision!, sha256: pin.download!.sha256, licence: pin.license!, verifiedAt: new Date().toISOString(), sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, ...(pin.component ? { component: pin.component } : {}), ...(pin.launch ? { launch: pin.launch } : {}) } } as never);
}
function installEngine(pin: typeof SPLASH_PIN) {
  const root = engineDir(pin);
  mkdirSync(join(root, "engine"), { recursive: true }); writeFileSync(join(root, "engine", "splash"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "python", "bin"), { recursive: true }); writeFileSync(join(root, "python", "bin", "python3"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "install"), { recursive: true }); writeFileSync(join(root, "install", "launcher.py"), "");
  writeFileSync(join(root, ENGINE_READY_MARKER), "now");
}
const wipe = () => { db.delete(meta).where(eq(meta.key, "coding.home_mode.self_test")).run(); db.delete(meta).where(eq(meta.key, "coding.home_mode.failure")).run(); };
async function holdStayingResidents() {
  for (const [id, bytes] of [["embed", 192_725_904], ["stt", 1_987_805_184], ["tts", 3_378_089_080]] as const) await admit({ id, kind: "resident", requestedBytes: bytes, measuredPeakBytes: bytes });
}

beforeEach(() => {
  __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests(); wipe(); resetSupervisorForTests();
  setMachineTier("p128"); setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 5, chipName: "Apple M5 Max", memoryGb: 128, osVersion: "26.4" }); __setAppleChipForTests({ generation: 5, name: "Apple M5 Max" });
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: TOTAL, osMarginBytes: TOTAL - BUDGET, freeMemoryBytes: Math.floor(93.1 * GIB), tier: "p128" });
  installEngine(SPLASH_PIN); installEngine(SPLASH_CHAT_PIN);
});
afterEach(() => {
  setSupervisorFactoryForTests(null); setMachineTier(null); setCodingMachineFacts(null); __resetAppleChipForTests(); initializeHomeMode("normal"); wipe();
  Bun.spawnSync(["rm", "-rf", splashRoot(), join(engineDir(SPLASH_PIN), ".."), join(engineDir(SPLASH_CHAT_PIN), "..")]);
  clearModelsForTests(); __resetSettingsForTests(); __resetGovernorForTests();
});

test("refusal 3: with chat unloaded and 93.1 GiB free, the Flash Next chat load is admitted at its measured 74 GB, not refused for 81 GB", async () => {
  installPin(STACK_CHAT_8B_MODEL); installPin(FLASH); installPin(DRAFT);
  updateSettings({ "stack.engines.chat.model": FLASH.id }); applyPendingSettings();
  await holdStayingResidents();
  const started = getProcess("chat").catch((error: unknown) => error);
  const outcome = await started;
  // The Splash start is admitted (the fixture engine then exits and chat falls back, which is not the memory refusal under test).
  const decisions = getGovernorDecisions().filter((entry) => entry.model === "chat");
  expect(decisions.length).toBeGreaterThan(0);
  expect(decisions.every((entry) => entry.decision === "Admitted")).toBe(true);
  expect(outcome instanceof EngineDoesNotFitError).toBe(false);
  expect(String(outcome)).not.toMatch(/needs about 81/);
});

test("refusal 2: the coding mode accepts Flash Next with its measured 74 GB: the budget is the governor's own room, 90.6 GB with embed, stt and tts held", async () => {
  installPin(FLASH); installPin(DRAFT);
  await holdStayingResidents();
  await setupHomeModeRuntime("normal");
  const view = homeModeView();
  expect(view.memory.plan_bytes).toBe(74_000_000_000);
  const staying = 192_725_904 + 1_987_805_184 + 3_378_089_080;
  expect(view.memory.budget_bytes).toBe(BUDGET - staying);
  expect(view.checks.memory).toBe(true);
  expect(view.reason).toBeNull();
  expect(view.available).toBe(true);
});

test("a model with no measured peak keeps the stricter mode check: the 35B has none, Flash Next's 74 GB is the only measured peak", async () => {
  const { splashMeasuredPeakBytes } = await import("@/lib/splashStore");
  expect(splashMeasuredPeakBytes(MOE.id)).toBeNull();
  expect(splashMeasuredPeakBytes(FLASH.id)).toBe(74_000_000_000);
});

test("refusal 1: a refused load of a Splash-only chat model leaves the 35B serving, and the choice goes back to it", async () => {
  installPin(STACK_CHAT_8B_MODEL); installPin(MOE); installPin(MOE_DRAFT); installPin(FLASH); installPin(DRAFT);
  updateSettings({ "stack.engines.chat.model": MOE.id }); applyPendingSettings();
  const refusal = "The coding model needs about 81.0 GB to load, and this computer has 72.6 GB free after keeping 20.0 GB back. Chat and the other always-on models stay loaded.";
  const started: string[] = [];
  setSupervisorFactoryForTests(async (role) => {
    const model = selectedModel(role);
    started.push(`${role}:${model?.id}`);
    if (model?.id === FLASH.id) throw new EngineDoesNotFitError(refusal);
    return scriptedProcess(role, { modelId: model?.id ?? role });
  });
  const before = await getProcess("chat");
  expect(before.modelId).toBe(MOE.id);
  await expect(loadModelForRole("chat", FLASH.id)).rejects.toThrow(/needs about 81\.0 GB/);
  expect(selectedModel("chat")?.id).toBe(MOE.id);
  const after = await getProcess("chat");
  expect(after.modelId).toBe(MOE.id);
  expect(getRoleStatus("chat").state).not.toBe("installed");
  expect(started.filter((entry) => entry === `chat:${MOE.id}`).length).toBeGreaterThanOrEqual(2);
});
