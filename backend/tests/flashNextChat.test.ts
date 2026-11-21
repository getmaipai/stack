// The Huihui Qwen3.8 Flash Next 177B abliterated chat model (the optional Max chat model, run alone by Splash): its split GGUF
// installs as one directory model of three pinned parts, adopts verified files already in place, launches from the first part,
// budgets only the weights Splash keeps in memory, and sits on the Max tier without ever being recommended.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SPLASH_CHAT_PIN } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { SPLASH_LOCAL_CHAT_MODELS, STACK_CHAT_8B_MODEL, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL as MOE, STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT as DRAFT, STACK_CHAT_QWEN38_FLASH_NEXT_MODEL as FLASH, STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, installCatalogModel, removeModel, upsertModel, type CatalogModelLike } from "@/lib/modelStore";
import { buildInstallPlan, splashChatInstallModels } from "@/lib/installPlan";
import { buildDiskPlan } from "@/lib/diskPlan";
import { PROFILE_MODEL_BINDINGS, PROFILE_TIERS } from "@/profiles";
import { resolveLadder, tierCandidateLists, TIER_CANDIDATES } from "@/lib/tiers";
import { splashFootprintEstimateBytes } from "@/lib/splash";
import { releaseSplashLayoutFor, splashLocalModelFor, splashPreparedNotePath, splashResidentWeightsBytes, splashRoot } from "@/lib/splashStore";
import { modelsDir } from "@/lib/paths";
import { resetSupervisorForTests, setCodingMachineFacts, setMachineTier, splashLaunchPlan } from "@/lib/supervisor";
import { __setAppleChipForTests } from "@/lib/hardware";
import { __resetHealthForTests } from "@/lib/health";
import { __resetSettingsForTests } from "@/settings";
import { initializeHomeMode } from "@/lib/homeMode";
import type { HardwareInfo } from "@/lib/hardware";

const GB = 1_000_000_000;
const GIB = 1_073_741_824;
const hw = (gb: number): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: gb, cpuCount: 8, isAppleSilicon: true, unifiedMemoryGb: gb, cudaDevices: [], freeDiskBytes: 2_000_000_000_000, osVersion: "26.4" } as HardwareInfo);

function sparse(path: string, size: number) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, ""); truncateSync(path, size); }
function installPin(pin: CatalogModelLike) {
  const modelPath = join(splashRoot(), "fixture", pin.id);
  if (pin.download?.files) for (const file of pin.download.files) sparse(join(modelPath, file.path), file.bytes);
  else sparse(modelPath, 1024);
  upsertModel({ id: pin.id, roles: [pin.role], source: "catalog", provenance: { repo: pin.repo }, revision: pin.revision!, sha256: pin.download!.sha256, licence: pin.license!, verifiedAt: new Date().toISOString(), sizeBytes: pin.download!.approx_bytes, modelPath, engineRequirements: { engine: pin.engine, ...(pin.component ? { component: pin.component } : {}), ...(pin.launch ? { launch: pin.launch } : {}) } } as never);
  return modelPath;
}
function installSplashEngine() {
  const root = engineDir(SPLASH_CHAT_PIN);
  mkdirSync(join(root, "engine"), { recursive: true }); writeFileSync(join(root, "engine", "splash"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "python", "bin"), { recursive: true }); writeFileSync(join(root, "python", "bin", "python3"), "#!/bin/sh\nexit 0\n");
  mkdirSync(join(root, "install"), { recursive: true }); writeFileSync(join(root, "install", "launcher.py"), "");
  writeFileSync(join(root, ".engine-ready"), "ok");
}
beforeEach(() => {
  clearModelsForTests(); __resetSettingsForTests(); __resetHealthForTests(); resetSupervisorForTests(); initializeHomeMode("normal");
  setMachineTier("p128"); setCodingMachineFacts({ platform: "darwin", arch: "arm64", chipGeneration: 5, chipName: "Apple M5 Max", memoryGb: 128, osVersion: "26.4" }); __setAppleChipForTests({ generation: 5, name: "Apple M5 Max" });
});
afterEach(() => {
  resetSupervisorForTests(); clearModelsForTests(); __resetSettingsForTests(); setMachineTier(null); setCodingMachineFacts(null);
  Bun.spawnSync(["rm", "-rf", splashRoot(), join(engineDir(SPLASH_CHAT_PIN), "..")]);
});

test("the pins are complete: one revision, three pinned parts that add up to the model's size, the first part as the pin's file, a draft with both files", () => {
  for (const pin of [FLASH, DRAFT]) {
    expect(STACK_MODELS).toContain(pin);
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.engine).toBe("splash");
    expect(JSON.stringify(pin)).not.toMatch(/TODO|TBD|FIXME/i);
    for (const file of pin.download!.files!) { expect(file.sha256).toMatch(/^[0-9a-f]{64}$/); expect(file.bytes).toBeGreaterThan(0); }
  }
  expect(FLASH.license).toBe("qwen-community-1.0");
  expect(FLASH.companions).toEqual([DRAFT.id]);
  expect(FLASH.launch).toEqual({ contextLength: 32_768 });
  const parts = FLASH.download!.files!;
  expect(parts.map((part) => part.path)).toEqual([1, 2, 3].map((n) => `unsloth-UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-0000${n}-of-00003.gguf`));
  expect(parts.map((part) => part.bytes)).toEqual([10_946_624, 49_835_229_856, 43_836_407_744]);
  expect(FLASH.download!.approx_bytes).toBe(93_682_584_224);
  expect(FLASH.download!.url).toBe(`https://huggingface.co/huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF/resolve/${FLASH.revision}/${parts[0]!.path}`);
  expect(FLASH.download!.sha256).toBe(parts[0]!.sha256);
  expect(DRAFT.download!.files!.map((file) => file.path)).toEqual(["config.json", "model.safetensors"]);
  expect(DRAFT.download!.sha256).toBe(DRAFT.download!.files!.find((file) => file.path === "model.safetensors")!.sha256);
  expect(DRAFT.license).toBe("Apache-2.0");
});

// A split model is the existing directory model with several pinned files: tiny stand-in parts exercise the real install path.
const parts = [Buffer.from("part one ".repeat(30)), Buffer.from("part two ".repeat(50)), Buffer.from("part three ".repeat(40))];
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const tiny = (id: string): CatalogModelLike => {
  const files = parts.map((data, index) => ({ path: `folder/Test-0000${index + 1}-of-00003.gguf`, sha256: sha(data), bytes: data.length }));
  return { ...FLASH, id, download: { url: `https://huggingface.co/o/r/resolve/${FLASH.revision}/${files[0]!.path}`, sha256: files[0]!.sha256, approx_bytes: files.reduce((sum, file) => sum + file.bytes, 0), directory: "Test-Split", files } };
};
const byName = (url: string) => parts[Number(new URL(url).pathname.match(/Test-0000(\d)-of/)![1]) - 1]!;

test("a split model installs as one record: every part is fetched, verified against its own hash and placed in the model's directory; a wrong byte in any part is refused", async () => {
  const fetched: string[] = [];
  const downloader = (corrupt?: number) => async (url: string, destination: string) => {
    fetched.push(url.split("/").pop()!);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, corrupt !== undefined && url.includes(`Test-0000${corrupt}-of`) ? Buffer.from("tampered") : byName(url));
  };
  const pin = tiny("split-bad");
  await expect(installCatalogModel(pin, { destination: join(modelsDir, pin.id, "Test-00001-of-00003.gguf"), download: downloader(3) })).rejects.toThrow(/checksum/);
  expect(getModel(pin.id)?.verifiedAt ?? null).toBeNull();
  const good = tiny("split-good");
  const installed = await installCatalogModel(good, { destination: join(modelsDir, good.id, "Test-00001-of-00003.gguf"), download: downloader() });
  expect(installed.modelPath).toBe(join(modelsDir, good.id, "Test-Split"));
  for (const [index, data] of parts.entries()) expect(readFileSync(join(installed.modelPath!, `folder/Test-0000${index + 1}-of-00003.gguf`)).equals(data)).toBe(true);
  for (const id of ["split-bad", "split-good", "split-adopt"]) { removeModel(id); rmSync(join(modelsDir, id), { recursive: true, force: true }); }
});

test("files already in place at the pinned hashes are adopted: nothing is downloaded again", async () => {
  const pin = tiny("split-adopt");
  const directory = join(modelsDir, pin.id, "Test-Split");
  for (const [index, data] of parts.entries()) { mkdirSync(join(directory, "folder"), { recursive: true }); writeFileSync(join(directory, `folder/Test-0000${index + 1}-of-00003.gguf`), data); }
  const installed = await installCatalogModel(pin, { destination: join(modelsDir, pin.id, "Test-00001-of-00003.gguf"), download: async () => { throw new Error("the downloader must not be called"); } });
  expect(installed.verifiedAt).toBeTruthy();
  expect(installed.modelPath).toBe(directory);
  removeModel(pin.id); rmSync(join(modelsDir, pin.id), { recursive: true, force: true });
});

test("Splash is given the first part (it reads the others beside it) and the draft folder; the context is the pinned 32K and the budget starts from the weights Splash keeps in memory", () => {
  const target = installPin(FLASH); const draft = installPin(DRAFT); installPin(STACK_CHAT_8B_MODEL); installSplashEngine();
  const local = splashLocalModelFor(FLASH.id)!;
  expect(local.modelDir).toBe(join(target, FLASH.download!.files![0]!.path));
  expect(local.draftDir).toBe(draft);
  expect(local.model).toBe(FLASH.repo!);
  expect(splashLocalModelFor(STACK_CHAT_8B_MODEL.id)).toBeNull();
  const args = splashLaunchPlan(getModel(FLASH.id)!, 8812, 32_768, "splash-chat").command;
  expect(args[args.indexOf("--model-dir") + 1]).toBe(local.modelDir);
  expect(args[args.indexOf("--draft-model") + 1]).toBe(draft);
  expect(args[args.indexOf("--max-context") + 1]).toBe("32768");
  expect(args).not.toContain("--revision");
  // 94 GB of parts, 27 GB of them on the SSD: the resident figure and the estimate sit near the measured 70 to 74 GB, never near 100 GB.
  expect(splashResidentWeightsBytes(FLASH.id, FLASH.download!.approx_bytes)).toBe(FLASH.download!.approx_bytes - 27 * GB);
  expect(splashResidentWeightsBytes(MOE.id, MOE.download!.approx_bytes)).toBe(MOE.download!.approx_bytes);
  const estimate = splashFootprintEstimateBytes({ weightsBytes: splashResidentWeightsBytes(FLASH.id, FLASH.download!.approx_bytes), draftBytes: DRAFT.download!.approx_bytes, contextTokens: 32_768 });
  expect(estimate).toBeGreaterThanOrEqual(70 * GB);
  expect(estimate).toBeLessThanOrEqual(80 * GB);
  // The Metal budget (whole GiB) is the estimate plus the 12 GB headroom setting: above the measured 74 GB peak, below the 100 GiB the trial ran with.
  const capGib = Number(args[args.indexOf("--max-memory") + 1]!.replace("G", ""));
  expect(capGib * GIB).toBeGreaterThanOrEqual(estimate);
  expect(capGib).toBeGreaterThanOrEqual(80);
  expect(capGib).toBeLessThanOrEqual(100);
});

test("removing it or its draft releases its own prepared folder and note, and the 35B's stays", () => {
  mkdirSync(splashRoot(), { recursive: true });
  for (const id of [MOE.id, FLASH.id]) writeFileSync(splashPreparedNotePath(id), "{}");
  expect(splashPreparedNotePath(FLASH.id)).not.toBe(splashPreparedNotePath(MOE.id));
  releaseSplashLayoutFor(DRAFT.id);
  expect(existsSync(splashPreparedNotePath(FLASH.id))).toBe(false);
  expect(existsSync(splashPreparedNotePath(MOE.id))).toBe(true);
  releaseSplashLayoutFor(FLASH.id);
  expect(existsSync(splashPreparedNotePath(MOE.id))).toBe(true);
});

test("it is optional: offered on p128 only, in its own disk row, never in a tier plan or a default binding", () => {
  expect(SPLASH_LOCAL_CHAT_MODELS.map((entry) => entry.pin.id)).toEqual([MOE.id, FLASH.id]);
  expect(splashChatInstallModels([], "p128").map((model) => model.id)).toEqual([MOE.id, "qwen3-6-35b-a3b-huihui-abliterated-dflash2-draft", FLASH.id, DRAFT.id]);
  expect(splashChatInstallModels([], "p64").map((model) => model.id)).not.toContain(FLASH.id);
  const flash = splashChatInstallModels([], "p128").filter((model) => model.id === FLASH.id || model.id === DRAFT.id);
  expect(flash[0]).toMatchObject({ removable: true, engine: "splash", approx_bytes: 93_682_584_224 });
  expect(flash[1]).toMatchObject({ removable: true, component: "draft", approx_bytes: 1_206_140_008 });
  for (const gb of [16, 32, 64, 128]) expect(buildInstallPlan(hw(gb)).models.map((model) => model.id)).not.toContain(FLASH.id);
  expect(Object.values(PROFILE_MODEL_BINDINGS).flatMap((bound) => Object.values(bound ?? {}))).not.toContain(FLASH.id);
  const row = (id: string) => buildDiskPlan(PROFILE_TIERS.find((tier) => tier.id === id)!).rows.find((item) => item.id === "chat-splash-qwen38-flash-next");
  expect(row("p128")).toMatchObject({ need: "optional", model_ids: [FLASH.id, DRAFT.id], download_bytes: 93_682_584_224 + 1_206_140_008 });
  for (const id of ["p16", "p32", "p64"]) expect(row(id)).toBeUndefined();
});

test("it is a Max chat candidate and never the recommendation: not at Standard, not at Boost, and not at Max while a smaller Max model fits", () => {
  const candidate = TIER_CANDIDATES.find((item) => item.id === FLASH.id)!;
  expect(candidate).toMatchObject({ category: "chat", profiles: ["p128"], tiers: ["max"] });
  expect(candidate.peaks.every((peak) => peak.status === "measured" && peak.peakBytes >= 74 * GB && peak.peakBytes <= 75 * GB)).toBe(true);
  const maxOrder = TIER_CANDIDATES.filter((item) => item.category === "chat" && item.tiers.includes("max")).map((item) => item.id);
  expect(maxOrder.at(-1)).toBe(FLASH.id);
  for (const profile of ["p16", "p32", "p64", "p128"] as const) for (let gb = 1; gb <= 200; gb += 1) {
    const models = resolveLadder("chat", profile, gb * GB).map((row) => row.resolved?.model);
    expect(models).not.toContain(FLASH.id);
  }
  const lists = tierCandidateLists("chat", "p128", 100 * GB);
  expect(lists.find((level) => level.tier === "max")!.candidates.map((item) => item.id)).toContain(FLASH.id);
  expect(lists.find((level) => level.tier === "standard")!.candidates.find((item) => item.id === FLASH.id)!.fits).toBe(false);
  for (const level of lists) expect(level.recommended).not.toBe(FLASH.id);
  expect(tierCandidateLists("chat", "p64", 60 * GB)[0]!.candidates.map((item) => item.id)).not.toContain(FLASH.id);
});
