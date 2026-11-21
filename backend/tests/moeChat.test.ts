// The Huihui Qwen3.6-35B-A3B abliterated chat model (optional model): pins, install order and the prepare step,
// selection by setting, the launch, removal cleanup and the memory budget.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPLASH_CHAT_PIN } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { STACK_CHAT_8B_MODEL, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT as DRAFT, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL as MOE, STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, removeModel, upsertModel } from "@/lib/modelStore";
import { buildInstallPlan, splashChatInstallModels } from "@/lib/installPlan";
import { buildDiskPlan } from "@/lib/diskPlan";
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS } from "@/profiles";
import { resolveLadder, TIER_CANDIDATES } from "@/lib/tiers";
import { splashFootprintEstimateBytes, splashChatMemoryPlan } from "@/lib/splash";
import { prepareSplashModel, splashModelsDir, splashPreparedCurrent, splashPreparedNotePath, splashRoot, type PrepareRunner } from "@/lib/splashStore";
import { chatEngine, resetSupervisorForTests, selectedModel, setCodingMachineFacts, setMachineTier, splashLaunchPlan } from "@/lib/supervisor";
import { __setAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests } from "@/lib/health";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";
import { initializeHomeMode } from "@/lib/homeMode";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_000_000_000;
const hw = (gb: number, over: Partial<HardwareInfo> = {}): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 2_000_000_000_000, osVersion: "test", ...over });

function sparse(path: string, size: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); truncateSync(path, size); }
function installPin(pin: typeof MOE | typeof DRAFT | typeof STACK_CHAT_8B_MODEL) {
  const modelPath = join(splashRoot(), "fixture", pin.id);
  if (pin.download?.files) for (const file of pin.download.files) sparse(join(modelPath, file.path), file.bytes);
  else sparse(modelPath, 1024);
  upsertModel({ id: pin.id, roles: [pin.role], source: "catalog", provenance: { repo: pin.repo }, revision: pin.revision!, sha256: pin.download!.sha256, licence: "Apache-2.0", verifiedAt: new Date().toISOString(), sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, launch: pin.launch, sampling: pin.sampling } });
  return modelPath;
}
function installSplashEngine() {
  const root = engineDir(SPLASH_CHAT_PIN);
  mkdirSync(join(root, "engine"), { recursive: true }); writeFileSync(join(root, "engine", "splash"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "python", "bin"), { recursive: true }); writeFileSync(join(root, "python", "bin", "python3"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "install"), { recursive: true }); writeFileSync(join(root, "install", "launcher.py"), "");
  writeFileSync(join(root, ".engine-ready"), "ok");
  return root;
}
beforeEach(() => {
  clearModelsForTests(); __resetSettingsForTests(); __resetHealthForTests(); resetSupervisorForTests(); initializeHomeMode("normal");
  setMachineTier("p64"); setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 3, chipName: "Apple M3", memoryGb: 64, osVersion: "26.4" }); __setAppleChipForTests({ generation: 3, name: "Apple M3" });
});
afterEach(() => {
  resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); setMachineTier(null); setCodingMachineFacts(null);
  Bun.spawnSync(["rm", "-rf", splashRoot(), join(engineDir(SPLASH_CHAT_PIN), "..")]);
});

test("pins are complete: revision, sha256, size and licence on the target, and every file of the draft", () => {
  for (const pin of [MOE, DRAFT]) {
    expect(STACK_MODELS).toContain(pin);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.approx_bytes).toBeGreaterThan(0);
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.engine).toBe("splash");
    expect(JSON.stringify(pin)).not.toMatch(/TODO|TBD|FIXME/i);
  }
  expect(MOE.download!.url).toContain(`/resolve/${MOE.revision}/`);
  expect(MOE.companions).toEqual([DRAFT.id]);
  expect(DRAFT.download!.files!.map((file) => file.path)).toEqual(["config.json", "model.safetensors"]);
  for (const file of DRAFT.download!.files!) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
  expect(DRAFT.download!.sha256).toBe(DRAFT.download!.files!.find((file) => file.path === "model.safetensors")!.sha256);
});

test("install order: the optional part list is the target then its draft, and no tier plan or default binding carries either", () => {
  expect(splashChatInstallModels().map((model) => model.id)).toEqual([MOE.id, DRAFT.id]);
  for (const gb of [16, 32, 64, 128]) expect(buildInstallPlan(hw(gb)).models.map((model) => model.id)).not.toContain(MOE.id);
  expect(Object.values(PROFILE_MODEL_BINDINGS).flatMap((bound) => Object.values(bound ?? {}))).not.toContain(MOE.id);
  for (const profile of ["p64", "p128"] as const) expect(resolveLadder("chat", profile, 100 * GB).map((row) => row.resolved?.model)).not.toContain(MOE.id);
  // The disk plan offers it as an optional row on p64 and p128 only.
  const row = (id: string) => buildDiskPlan(PROFILE_TIERS.find((tier) => tier.id === id)!).rows.find((item) => item.id === "chat-splash-qwen36-abliterated");
  expect(row("p64")).toMatchObject({ need: "optional", model_ids: [MOE.id, DRAFT.id] });
  expect(row("p32")).toBeUndefined();
});

test("selecting it: a stored choice of the 35B makes auto pick Splash and serve it; before it is installed, and for every other choice, chat stays on llama-server", () => {
  installPin(STACK_CHAT_8B_MODEL); installSplashEngine();
  expect(chatEngine()).toBe("llama-server");
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_8B_MODEL.id);
  installPin(MOE); installPin(DRAFT);
  expect(chatEngine()).toBe("llama-server");
  updateSettings({ "stack.engines.chat.model": MOE.id }); applyPendingSettings();
  expect(chatEngine()).toBe("splash");
  expect(selectedModel("chat")?.id).toBe(MOE.id);
  // Setting it back: clear the model choice and the 8B on llama-server serves again.
  updateSettings({ "stack.engines.chat.model": "" }); applyPendingSettings();
  expect(chatEngine()).toBe("llama-server");
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_8B_MODEL.id);
});

test("the dense 27B stays selectable: choosing it by setting keeps auto on llama-server", () => {
  installPin(STACK_CHAT_8B_MODEL); installPin(MOE); installPin(DRAFT); installSplashEngine();
  upsertModel({ id: STACK_CHAT_QWEN38_UNCENSORED_MODEL.id, roles: ["chat"], source: "catalog", provenance: { repo: "x" }, revision: STACK_CHAT_QWEN38_UNCENSORED_MODEL.revision!, sha256: STACK_CHAT_QWEN38_UNCENSORED_MODEL.download!.sha256, licence: "Apache-2.0", verifiedAt: new Date().toISOString(), sizeBytes: 1, modelPath: join(splashRoot(), "dense.gguf"), engineRequirements: { engine: "llama-server" } });
  writeFileSync(join(splashRoot(), "dense.gguf"), "");
  updateSettings({ "stack.engines.chat.model": STACK_CHAT_QWEN38_UNCENSORED_MODEL.id }); applyPendingSettings();
  expect(chatEngine()).toBe("llama-server");
  expect(selectedModel("chat")?.id).toBe(STACK_CHAT_QWEN38_UNCENSORED_MODEL.id);
});

test("launch args for this id: Splash prepares from the verified GGUF and the draft folder, with the dense chat launch's flags", () => {
  const target = installPin(MOE); const draft = installPin(DRAFT); installSplashEngine();
  const args = splashLaunchPlan(getModel(MOE.id)!, 8812, 32_768, "splash-chat").command;
  expect(args[args.indexOf("--model-dir") + 1]).toBe(target);
  expect(args[args.indexOf("--draft-model") + 1]).toBe(draft);
  expect(args).not.toContain("--revision");
  for (const flag of ["--offline", "--served-model-name", "--thinking-token-budget", "--max-context", "--max-memory", "--idle-release", "--max-cache-disk"]) expect(args).toContain(flag);
});

const okRunner = (calls: string[][], prepared: string): PrepareRunner => async (command) => { calls.push(command); mkdirSync(prepared, { recursive: true }); return { code: 0, out: `${prepared}\n`, err: "" }; };

test("prepare runs once after both files verify, writes a note, is skipped while the pins match, and runs again when a pin changes", async () => {
  installPin(MOE); installPin(DRAFT); installSplashEngine();
  const prepared = join(splashModelsDir(), ".resolved", "abc");
  const calls: string[][] = [];
  expect(await prepareSplashModel(okRunner(calls, prepared))).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.join(" ")).toContain("prepare_local_model");
  expect(splashPreparedCurrent()).toBe(true);
  await prepareSplashModel(okRunner(calls, prepared));
  expect(calls).toHaveLength(1);
  const note = JSON.parse(readFileSync(splashPreparedNotePath(), "utf8"));
  writeFileSync(splashPreparedNotePath(), JSON.stringify({ ...note, draft: "older-revision:00" }));
  expect(splashPreparedCurrent()).toBe(false);
  await prepareSplashModel(okRunner(calls, prepared));
  expect(calls).toHaveLength(2);
});

test("prepare refuses, in plain words, an unverified draft and a Splash failure, and waits for a missing engine", async () => {
  installPin(MOE);
  await expect(prepareSplashModel(okRunner([], "/x"))).rejects.toThrow(/DFlash2 draft/);
  installPin(DRAFT);
  expect(await prepareSplashModel(okRunner([], "/x"))).toBe(false);
  installSplashEngine();
  await expect(prepareSplashModel(async () => ({ code: 1, out: "", err: "cannot prepare: bad draft" }))).rejects.toThrow(/could not prepare the chat model: cannot prepare: bad draft/);
  expect(existsSync(splashPreparedNotePath())).toBe(false);
});

test("removal cleans the prepared folder and the note", async () => {
  installPin(MOE); installPin(DRAFT); installSplashEngine();
  const prepared = join(splashModelsDir(), ".resolved", "abc");
  await prepareSplashModel(okRunner([], prepared));
  expect(existsSync(prepared)).toBe(true);
  removeModel(MOE.id);
  expect(existsSync(prepared)).toBe(false);
  expect(existsSync(splashPreparedNotePath())).toBe(false);
});

test("governor budget: the tier peak is the measured 23 GB, and the launch budget covers the 21 to 23 GB footprint at 32k context", () => {
  const candidate = TIER_CANDIDATES.find((item) => item.id === MOE.id)!;
  expect(candidate.tiers).toEqual([]);
  expect(candidate.peaks.every((peak) => peak.status === "measured" && peak.peakBytes === 23 * GB)).toBe(true);
  const estimate = splashFootprintEstimateBytes({ weightsBytes: MOE.download!.approx_bytes, draftBytes: DRAFT.download!.approx_bytes, contextTokens: 32_768 });
  expect(estimate).toBeGreaterThanOrEqual(21 * GB);
  expect(estimate).toBeLessThanOrEqual(25 * GB);
  // With the measured footprint recorded, the Metal cap is the larger of the two plus headroom, rounded up to a whole GiB.
  const plan = splashChatMemoryPlan({ estimateBytes: estimate, measuredBytes: 23 * GB, headroomBytes: 2 * GB });
  expect(plan.capBytes).toBeGreaterThanOrEqual(estimate + 2 * GB);
  expect(plan.capBytes).toBeLessThan(30 * GB);
});
