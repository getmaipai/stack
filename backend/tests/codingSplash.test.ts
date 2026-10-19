// CODE-STACK-01 S5a: Splash is the coding engine on Apple silicon with 36 GB or more
// (an M3 chip or newer, macOS 26.4 or later, the 64 and 128 GB tiers), with llama-server
// as the fallback. Every test here is scripted: no model is loaded, no Splash runs, and
// the 16 GB and 3.8 GB files the pins name are sparse files that take no disk.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "@/app";
import { ENGINE_CODING_WIRES, engineServesWire } from "@/lib/codingWire";
import { codingServerArgs, splashArgs } from "@/lib/engineArgs";
import { CODING_ENGINES, ENGINE_BINARIES, ENGINE_READY_MARKER, ENGINE_ROLE, engineRole, SPLASH_PIN, selectEngineBinary } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";
import { __resetEventsForTests } from "@/lib/events";
import { __resetGovernorForTests } from "@/lib/governor";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetAppleChipForTests, __setAppleChipForTests, parseAppleChip, type HardwareInfo } from "@/lib/hardware";
import { buildInstallPlan, plannedPinsFor } from "@/lib/installPlan";
import { QWEN38_27B_DRAFT_REPO, STACK_CODING_DRAFT_MODEL, STACK_CODING_MODEL, STACK_MODELS } from "@/lib/modelCatalog";
import { clearModelsForTests, getModel, installCatalogModel, removeModel, upsertModel } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { PROFILE_TIERS } from "@/profiles";
import { clearCodingEngineFailures, codingEngineFailure, markCodingEngineFailed, macosVersion, requestedCodingEngine, resolveCodingEngine, SPLASH_KV_BYTES_PER_TOKEN, SPLASH_OVERHEAD_FACTOR, splashDraftPossible, splashDraftWanted, splashEnv, splashFootprintEstimateBytes, splashUnsupportedReason, type SplashFacts } from "@/lib/splash";
import { layOutSplashCache, releaseSplashLayoutFor, splashHomeDir, splashHubDir, splashRoot, splashTmpDir, SplashLayoutError } from "@/lib/splashStore";
import { activeCodingChoice, codingEngineStatus, EngineDoesNotFitError, EngineUnavailableError, getRoleStatus, recycleRole, resetSupervisorForTests, scriptedProcess, selectableModels, selectedModel, ServedNameClient, setCodingMachineFacts, setMachineTier, splashLaunchPlan, startCodingWithFallbackForTests, engineInstalledFor, verifySplashServes, type EngineClient } from "@/lib/supervisor";
import { applyPendingSettings, __resetSettingsForTests, updateSettings } from "@/settings";
import { EngineIndexSchema } from "@/updates/catalog";

const GB = 1_073_741_824;
const onMac = process.platform === "darwin" && process.arch === "arm64";
const macTest = onMac ? test : test.skip;

/** The owner's Mac: an M5 Max with 128 GB on macOS 27. */
const m5: Omit<SplashFacts, "tier"> = { platform: "darwin", arch: "arm64", chipGeneration: 5, chipName: "Apple M5 Max", memoryGb: 128, osVersion: "27.0.1" };
const facts = (overrides: Partial<SplashFacts> = {}): SplashFacts => ({ ...m5, tier: "p128", ...overrides });

function sparse(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
  truncateSync(path, bytes);
}

/** The coding model and Splash's draft as the installer leaves them: verified records pointing at files of the pinned sizes. */
function installCodingRecords(options: { model?: boolean; draft?: boolean } = {}): { modelPath: string; draftDir: string } {
  const now = new Date().toISOString();
  const model = STACK_CODING_MODEL;
  const draft = STACK_CODING_DRAFT_MODEL;
  const modelPath = join(modelsDir, "imports", model.id, model.download!.sha256);
  const draftDir = join(modelsDir, draft.id, draft.download!.directory!);
  if (options.model !== false) {
    sparse(modelPath, model.download!.approx_bytes);
    upsertModel({ id: model.id, roles: ["coding"], source: "catalog", provenance: { repo: model.repo }, revision: model.revision!, sha256: model.download!.sha256, sizeBytes: model.download!.approx_bytes, licence: "Apache-2.0", installedAt: now, verifiedAt: now, modelPath, engineRequirements: { engine: "llama-server" } });
  }
  if (options.draft !== false) {
    for (const file of draft.download!.files!) sparse(join(draftDir, file.path), file.bytes);
    upsertModel({ id: draft.id, roles: ["coding"], source: "catalog", provenance: { repo: draft.repo }, revision: draft.revision!, sha256: draft.download!.sha256, sizeBytes: draft.download!.approx_bytes, licence: "Apache-2.0", installedAt: now, verifiedAt: now, modelPath: draftDir, engineRequirements: { engine: "splash", component: "draft" } });
  }
  return { modelPath, draftDir };
}

function installSplashEngine(): string {
  const dir = engineDir(SPLASH_PIN);
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine", "splash"), "");
  writeFileSync(join(dir, ENGINE_READY_MARKER), "now");
  return dir;
}

beforeEach(() => {
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests();
  clearCodingEngineFailures();
  setMachineTier("p128");
});
afterEach(() => {
  setMachineTier(null); setCodingMachineFacts(null); resetSupervisorForTests(); clearCodingEngineFailures(); __resetAppleChipForTests();
  rmSync(join(engineDir(SPLASH_PIN), ".."), { recursive: true, force: true });
  rmSync(splashRoot(), { recursive: true, force: true });
  rmSync(join(modelsDir, "imports"), { recursive: true, force: true });
  rmSync(join(modelsDir, STACK_CODING_DRAFT_MODEL.id), { recursive: true, force: true });
  clearModelsForTests(); __resetSettingsForTests();
});

// ---- what the machine needs ---------------------------------------------------------

test("Splash runs on an M3 or newer with 36 GB or more, macOS 26.4 or later, on the 64 and 128 GB tiers, and says plainly why not otherwise", () => {
  expect(splashUnsupportedReason(facts())).toBeNull();
  expect(splashUnsupportedReason(facts({ tier: "p64", memoryGb: 64, chipGeneration: 3, chipName: "Apple M3 Pro", osVersion: "26.4" }))).toBeNull();
  expect(splashUnsupportedReason(facts({ chipGeneration: 2, chipName: "Apple M2 Ultra" }))).toBe("Splash needs an M3 chip or newer; this Mac has an M2.");
  expect(splashUnsupportedReason(facts({ chipGeneration: 1 }))).toContain("M1");
  expect(splashUnsupportedReason(facts({ chipGeneration: null, chipName: null }))).toContain("could not tell which Apple chip");
  expect(splashUnsupportedReason(facts({ memoryGb: 32 }))).toBe("Splash needs 36 GB of memory or more; this Mac has 32 GB.");
  expect(splashUnsupportedReason(facts({ memoryGb: 36 }))).toBeNull();
  expect(splashUnsupportedReason(facts({ osVersion: "26.3.1" }))).toBe("Splash needs macOS 26.4 or later; this Mac runs 26.3.1.");
  expect(splashUnsupportedReason(facts({ osVersion: "15.6" }))).toContain("macOS 26.4");
  expect(splashUnsupportedReason(facts({ osVersion: "26.10" }))).toBeNull();
  expect(splashUnsupportedReason(facts({ osVersion: null }))).toContain("could not read this Mac's macOS version");
  expect(splashUnsupportedReason(facts({ platform: "linux", arch: "x64" }))).toBe("Splash runs on Apple silicon Macs only.");
  expect(splashUnsupportedReason(facts({ platform: "darwin", arch: "x64" }))).toBe("Splash runs on Apple silicon Macs only.");
  for (const tier of ["p16", "p32", undefined, null] as const) expect(splashUnsupportedReason(facts({ tier }))).toBe("Splash serves the coding role on computers with 64 GB of memory or more.");
});

test("the macOS version and the Apple chip are read from what the system says", () => {
  expect(macosVersion("26.4")).toEqual([26, 4]);
  expect(macosVersion("27.0.1")).toEqual([27, 0]);
  expect(macosVersion("26")).toEqual([26, 0]);
  expect(macosVersion("test")).toBeNull();
  expect(macosVersion(undefined)).toBeNull();
  expect(parseAppleChip("Apple M5 Max\n")).toEqual({ name: "Apple M5 Max", generation: 5 });
  expect(parseAppleChip("Apple M3")).toEqual({ name: "Apple M3", generation: 3 });
  expect(parseAppleChip("Apple M12 Ultra")?.generation).toBe(12);
  expect(parseAppleChip("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz")).toEqual({ name: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz", generation: null });
  expect(parseAppleChip("")).toBeNull();
  expect(parseAppleChip(null)).toBeNull();
});

test("the setting asks for auto, llama-server or splash; anything else is auto", () => {
  expect(requestedCodingEngine("splash")).toBe("splash");
  expect(requestedCodingEngine("llama-server")).toBe("llama-server");
  expect(requestedCodingEngine("auto")).toBe("auto");
  expect(requestedCodingEngine("omlx")).toBe("auto");
  expect(requestedCodingEngine(undefined)).toBe("auto");
});

const ready = { splashInstalled: true, draftReady: true, modelReady: true };

test("the choice: Splash when the machine qualifies and it is installed with its draft, llama-server otherwise, and the reason said only when Splash was wanted", () => {
  expect(resolveCodingEngine({ setting: "auto", facts: facts(), ...ready })).toEqual({ engine: "splash", requested: "auto", reason: null });
  expect(resolveCodingEngine({ setting: "splash", facts: facts(), ...ready })).toEqual({ engine: "splash", requested: "splash", reason: null });
  // The admin forces the slower engine: no reason, nothing is amiss.
  expect(resolveCodingEngine({ setting: "llama-server", facts: facts(), ...ready })).toEqual({ engine: "llama-server", requested: "llama-server", reason: null });
  // A Mac Splash never runs on: `auto` is just llama-server and says nothing; a forced Splash is told why it is not running.
  expect(resolveCodingEngine({ setting: "auto", facts: facts({ chipGeneration: 2 }), ...ready })).toEqual({ engine: "llama-server", requested: "auto", reason: null });
  expect(resolveCodingEngine({ setting: "splash", facts: facts({ chipGeneration: 2 }), ...ready }).reason).toBe("Splash needs an M3 chip or newer; this Mac has an M2. Coding uses llama-server.");
  // A qualifying Mac without the engine or its draft says what to install.
  expect(resolveCodingEngine({ setting: "auto", facts: facts(), ...ready, splashInstalled: false }).reason).toContain("not installed on this computer yet");
  expect(resolveCodingEngine({ setting: "auto", facts: facts(), ...ready, draftReady: false })).toMatchObject({ engine: "llama-server", reason: expect.stringContaining("draft model is not installed") });
  expect(resolveCodingEngine({ setting: "auto", facts: facts(), ...ready, modelReady: false }).engine).toBe("llama-server");
});

test("a failed Splash start keeps coding on llama-server, in plain words, until the coding engine is restarted", () => {
  expect(codingEngineFailure()).toBeNull();
  markCodingEngineFailed("Engine exited before becoming healthy (code 3).");
  expect(codingEngineFailure()).toEqual({ count: 1, reason: "Engine exited before becoming healthy (code 3)." });
  const choice = resolveCodingEngine({ setting: "auto", facts: facts(), ...ready });
  expect(choice.engine).toBe("llama-server");
  expect(choice.reason).toBe("Splash did not start (Engine exited before becoming healthy (code 3).), so coding is using the slower engine, llama-server. Restart the coding engine to try Splash again.");
  clearCodingEngineFailures();
  expect(resolveCodingEngine({ setting: "auto", facts: facts(), ...ready }).engine).toBe("splash");
});

test("the first-run plan brings the draft only where Splash can run: Apple silicon on a coding tier, not a chip known to be older than an M3", () => {
  const mac = { platform: "darwin", arch: "arm64" };
  expect(splashDraftPossible(mac, null)).toBe(true);
  expect(splashDraftPossible(mac, { generation: 5 })).toBe(true);
  expect(splashDraftPossible(mac, { generation: 3 })).toBe(true);
  expect(splashDraftPossible(mac, { generation: 2 })).toBe(false);
  expect(splashDraftPossible(mac, { generation: null })).toBe(false);
  expect(splashDraftPossible({ platform: "linux", arch: "x64" }, null)).toBe(false);
  expect(splashDraftWanted(mac, "p64", null)).toBe(true);
  expect(splashDraftWanted(mac, "p128", { generation: 4 })).toBe(true);
  expect(splashDraftWanted(mac, "p32", null)).toBe(false);
  expect(splashDraftWanted(mac, "p16", null)).toBe(false);
  const hardware = (overrides: Partial<HardwareInfo>): HardwareInfo => ({ platform: "darwin", arch: "arm64", totalRamGb: 64, cpuCount: 10, isAppleSilicon: true, unifiedMemoryGb: 64, cudaDevices: [], freeDiskBytes: 900 * GB, osVersion: "27.0.1", ...overrides });
  const ids = (plan: ReturnType<typeof buildInstallPlan>) => plan.models.filter((model) => model.role === "coding").map((model) => model.id);
  __setAppleChipForTests({ name: "Apple M5 Max", generation: 5 });
  expect(ids(buildInstallPlan(hardware({})))).toEqual(["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft"]);
  __setAppleChipForTests({ name: "Apple M2 Max", generation: 2 });
  expect(ids(buildInstallPlan(hardware({})))).toEqual(["qwen3.8-27b-ud-q4-k-m"]);
  __setAppleChipForTests(null);
  // Off Apple silicon the model is planned (llama-server runs it) but its Splash draft is not.
  expect(ids(buildInstallPlan(hardware({ platform: "linux", arch: "x64", isAppleSilicon: false })))).toEqual(["qwen3.8-27b-ud-q4-k-m"]);
  for (const tier of PROFILE_TIERS) expect(plannedPinsFor(tier).some(({ pin }) => pin.id === "qwen3.8-27b-dflash2-draft")).toBe(tier.id === "p64" || tier.id === "p128");
});

// ---- the pins -------------------------------------------------------------------------

test("the draft is a pinned component of the coding model: a directory of two verified files at one commit, Apache-2.0, read only by Splash", () => {
  const draft = STACK_CODING_DRAFT_MODEL;
  expect(draft).toMatchObject({ id: "qwen3.8-27b-dflash2-draft", role: "coding", component: "draft", engine: "splash", repo: QWEN38_27B_DRAFT_REPO, license: "Apache-2.0", revision: "015e795645c74b1a0eeef3b570031fb62e769bc5" });
  expect(draft.revision).toMatch(/^[0-9a-f]{40}$/);
  expect(draft.download!.url).toBe("https://huggingface.co/incoai/Qwen3.8-27B-DFlash2/resolve/015e795645c74b1a0eeef3b570031fb62e769bc5/model.safetensors");
  expect(draft.download!.files).toEqual([
    { path: "config.json", sha256: "873e3556509b0da06e29654ba00d4944888d4b5e8a33afde25f7eb27d321e980", bytes: 1_239 },
    { path: "model.safetensors", sha256: "67fc76d68dc5a9415511a4f394ef744d67510cd20e93b37cc2cc7d28e4bab65c", bytes: 3_848_817_896 },
  ]);
  // The URL's file is the weights and its sha256 and size are the weights' own.
  const weights = draft.download!.files!.find((file) => file.path === "model.safetensors")!;
  expect(draft.download!.sha256).toBe(weights.sha256);
  expect(draft.download!.approx_bytes).toBe(weights.bytes);
  for (const file of draft.download!.files!) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  // The coding model names it, so the two install and remove together; no other pin names it.
  expect(STACK_CODING_MODEL.companions).toEqual([draft.id]);
  expect(STACK_MODELS.filter((pin) => pin.companions).map((pin) => pin.id)).toEqual([STACK_CODING_MODEL.id]);
  expect(STACK_MODELS.filter((pin) => pin.id === draft.id)).toHaveLength(1);
  // A component is never selected as a model.
  expect(draft.component).toBe("draft");
});

test("Splash is a pinned engine build for macOS on Apple silicon, found by name, serving the coding role", () => {
  expect(SPLASH_PIN).toMatchObject({ id: "splash-1.3.2-macos-arm64", name: "splash", tag: "1.3.2", platform: "darwin", arch: "arm64", tool: "engine/splash", requiresNvidia: false, verified: true });
  expect(SPLASH_PIN.archive).toEqual({ label: "Splash (macOS arm64)", url: "https://github.com/incoai/splash/releases/download/1.3.2/splash-1.3.2-arm64-macos26.tar.gz", sha256: "c3deb1dd971461ffafcf6b82c318789d6698b22aa865e490a11a0ed943686c0b", approxBytes: 74_590_927 });
  expect(ENGINE_BINARIES).toContain(SPLASH_PIN);
  expect(ENGINE_ROLE.splash).toBe("coding");
  expect(engineRole("splash")).toBe("coding");
  // An unknown engine still defaults to chat, as before.
  expect(engineRole("nothing-we-know")).toBe("chat");
  expect(CODING_ENGINES).toEqual(["llama-server", "splash"]);
  const hardware = (platform: string, arch: string) => ({ platform, arch, totalRamGb: 64, cpuCount: 8, isAppleSilicon: platform === "darwin", unifiedMemoryGb: 64, cudaDevices: [], osVersion: "27.0" } as never);
  expect(selectEngineBinary(hardware("darwin", "arm64"), "splash")).toBe(SPLASH_PIN);
  expect(selectEngineBinary(hardware("linux", "x64"), "splash")).toBeNull();
  expect(selectEngineBinary(hardware("darwin", "x64"), "splash")).toBeNull();
});

test("the engine index's Splash entry (a version tag, not a build number) parses, and a malformed tag is still refused", () => {
  const entry = { name: "splash", tag: "1.3.2", platform: "darwin", arch: "arm64", url: SPLASH_PIN.archive.url, sha256: SPLASH_PIN.archive.sha256, size: SPLASH_PIN.archive.approxBytes, licence: "Apache-2.0" };
  const llama = { name: "llama-server", tag: "b10797", platform: "darwin", arch: "arm64", url: "https://github.com/ggml-org/llama.cpp/releases/download/b10797/x.tar.gz", sha256: "a".repeat(64), size: 1 };
  expect(EngineIndexSchema.safeParse({ version: "2026-10-18", engines: [llama, entry] }).success).toBe(true);
  // uv and ComfyUI were already in the Catalog's index with version tags.
  expect(EngineIndexSchema.safeParse({ version: "x", engines: [{ ...entry, name: "uv", tag: "0.12.17" }, { ...entry, name: "comfyui", tag: "v0.36.0" }] }).success).toBe(true);
  expect(EngineIndexSchema.safeParse({ version: "x", engines: [{ ...entry, tag: "latest" }] }).success).toBe(false);
  expect(EngineIndexSchema.safeParse({ version: "x", engines: [{ ...entry, tag: "1.3.2; rm -rf" }] }).success).toBe(false);
});

// ---- the launch -------------------------------------------------------------------------

test("the Splash launch is exactly this argument list (flags checked against Splash 1.3.2 serve --help)", () => {
  expect(splashArgs({ model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502", port: 8801, servedModelName: "qwen3.8-27b-ud-q4-k-m", thinkingBudgetTokens: 2000, contextLength: 131_072, cacheGb: 8 })).toEqual([
    "serve",
    "--model", "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M",
    "--revision", "4ca720788d1e01f1bff70c033e0d0028fd02e502",
    "--offline",
    "--host", "127.0.0.1",
    "--port", "8801",
    "--language-only",
    "--served-model-name", "qwen3.8-27b-ud-q4-k-m",
    "--announce-served-name",
    "--default-reasoning-effort", "medium",
    "--thinking-token-budget", "2000",
    "--max-context", "131072",
    "--max-cache-disk", "8G",
    "--idle-release", "off",
    "--no-webui",
  ]);
});

test("the Splash launch is offline and loopback only, has no API key, bounds its disk cache, and turns it off at 0", () => {
  const base = { model: "o/r:Q", revision: "r".repeat(40), port: 1, servedModelName: "m", thinkingBudgetTokens: 0, contextLength: 32_768 };
  const args = splashArgs({ ...base, cacheGb: 3 });
  expect(args).toContain("--offline");
  expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
  expect(args).not.toContain("--api-key");
  expect(args).not.toContain("--persistent-cache");
  expect(args).not.toContain("--draft-model");
  expect(args.slice(args.indexOf("--max-cache-disk"), args.indexOf("--max-cache-disk") + 2)).toEqual(["--max-cache-disk", "3G"]);
  expect(args.slice(args.indexOf("--thinking-token-budget"), args.indexOf("--thinking-token-budget") + 2)).toEqual(["--thinking-token-budget", "0"]);
  expect(splashArgs({ ...base, cacheGb: 0 }).slice(-5, -3)).toEqual(["--max-cache-disk", "0"]);
});

test("the llama-server coding launch is untouched by the Splash one", () => {
  expect(codingServerArgs({ modelPath: "/m/q.gguf", port: 8801, contextLength: 131_072, slots: 2, thinkingBudgetTokens: 2000, alias: "qwen3.8-27b-ud-q4-k-m" })).toEqual([
    "--model", "/m/q.gguf", "--alias", "qwen3.8-27b-ud-q4-k-m", "--port", "8801", "--host", "127.0.0.1", "-c", "131072", "-fa", "on", "-ngl", "all",
    "--reasoning", "on", "--reasoning-budget", "2000", "-ub", "1024", "--no-webui", "--metrics", "--jinja", "--parallel", "2", "--kv-unified", "-ctk", "q8_0", "-ctv", "q8_0", "--offline",
  ]);
});

test("Splash's environment: the Stack's own folders, offline switches on, nothing of the Stack's secrets or the person's tokens or Python", () => {
  const layout = { hubDir: "/data/splash/hub", homeDir: "/data/splash/home", tmpDir: "/data/splash/tmp" };
  const env = splashEnv(layout, { PATH: "/usr/bin", LANG: "en_US.UTF-8", HOME: "/Users/someone", HF_TOKEN: "hf_secret", HUGGING_FACE_HUB_TOKEN: "hf_secret2", HF_ENDPOINT: "https://mirror.example.com", SPLASH_API_KEY: "k", STACK_SECRETS_KEY: "s", MAIPAI_SECRETS_FILE: "f", PYTHONPATH: "/evil", PYTHONHOME: "/evil", PYTHONSTARTUP: "/evil", TMPDIR: "/var/folders/x" });
  expect(env).toEqual({
    PATH: "/usr/bin", LANG: "en_US.UTF-8",
    HOME: "/data/splash/home", TMPDIR: "/data/splash/tmp", HF_HOME: "/data/splash/home", HF_HUB_CACHE: "/data/splash/hub",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", DO_NOT_TRACK: "1", PYTHONUNBUFFERED: "1",
  });
});

test("the memory estimate for Splash is the weights and the draft with an overhead factor, plus a key-value term per token, calibrated on the one real reading", () => {
  const weights = STACK_CODING_MODEL.download!.approx_bytes;
  const draft = STACK_CODING_DRAFT_MODEL.download!.approx_bytes;
  const estimate = splashFootprintEstimateBytes({ weightsBytes: weights, draftBytes: draft, contextTokens: 131_072 });
  expect(estimate).toBe(Math.ceil((weights + draft) * SPLASH_OVERHEAD_FACTOR) + 131_072 * SPLASH_KV_BYTES_PER_TOKEN);
  expect(estimate).toBe(23_012_060_594);
  // The real run read about 21 to 23 GB (2026-10-18): the estimate sits at the top of that band, not below it.
  expect(estimate / 1e9).toBeGreaterThanOrEqual(21);
  expect(estimate / 1e9).toBeLessThanOrEqual(23.5);
  // A smaller window needs less.
  expect(splashFootprintEstimateBytes({ weightsBytes: weights, draftBytes: draft, contextTokens: 32_768 })).toBeLessThan(estimate);
  expect(splashFootprintEstimateBytes({ weightsBytes: weights, draftBytes: draft, contextTokens: -5 })).toBe(Math.ceil((weights + draft) * SPLASH_OVERHEAD_FACTOR));
});

test("Splash serves the three coding wires (a smoke test on the real engine; the contract suite is still owed)", () => {
  expect(ENGINE_CODING_WIRES.splash).toEqual({ messages: true, count_tokens: true, responses: true });
  for (const wire of ["messages", "count_tokens", "responses"] as const) expect(engineServesWire("splash", wire)).toBe(true);
  expect(engineServesWire("some-other-engine", "messages")).toBe(false);
});

test("the two new settings are declared once, with the Stack's defaults, and read through the settings route", async () => {
  const body = await (await app.request("/stack/v1/settings")).json() as { settings: Array<{ key: string; in_effect: unknown; level: string; needs_restart: boolean; section: { id: string }; range?: { options?: Array<{ value: string }> } }> };
  const row = (key: string) => body.settings.find((setting) => setting.key === key)!;
  expect(row("stack.engines.coding.engine")).toMatchObject({ in_effect: "auto", level: "advanced", needs_restart: true, section: { id: "engines.coding" } });
  expect(row("stack.engines.coding.engine").range?.options?.map((option) => option.value)).toEqual(["auto", "splash", "llama-server"]);
  expect(row("stack.engines.coding.splash_cache_gb")).toMatchObject({ in_effect: 8, level: "expert", needs_restart: true, section: { id: "engines.coding" } });
  expect(() => updateSettings({ "stack.engines.coding.engine": "omlx" })).toThrow();
  expect(() => updateSettings({ "stack.engines.coding.splash_cache_gb": -1 })).toThrow();
});

// ---- the engine in effect, from the machine and what is installed -------------------------

macTest("the engine in effect follows the machine, the tier and what is installed, and an admin can force the slower one", () => {
  setCodingMachineFacts(m5);
  installSplashEngine();
  installCodingRecords();
  expect(activeCodingChoice()).toEqual({ engine: "splash", requested: "auto", reason: null });
  // The tier: p64 uses Splash too; p32 and p16 never.
  setMachineTier("p64");
  expect(activeCodingChoice().engine).toBe("splash");
  setMachineTier("p32");
  expect(activeCodingChoice()).toEqual({ engine: "llama-server", requested: "auto", reason: null });
  setMachineTier("p128");
  // Hardware: an M2, 32 GB and an old macOS are refused, each with its own sentence for a forced Splash.
  for (const [override, sentence] of [[{ chipGeneration: 2, chipName: "Apple M2 Max" }, "M3 chip or newer"], [{ memoryGb: 32 }, "36 GB of memory or more"], [{ osVersion: "26.3" }, "macOS 26.4 or later"]] as const) {
    setCodingMachineFacts({ ...m5, ...override });
    expect(activeCodingChoice()).toEqual({ engine: "llama-server", requested: "auto", reason: null });
    updateSettings({ "stack.engines.coding.engine": "splash" }); applyPendingSettings();
    expect(activeCodingChoice().engine).toBe("llama-server");
    expect(activeCodingChoice().reason).toContain(sentence);
    updateSettings({ "stack.engines.coding.engine": "auto" }); applyPendingSettings();
  }
  // No facts at all (the daemon has not read the machine): Splash is refused, never guessed.
  setCodingMachineFacts(null);
  expect(activeCodingChoice().engine).toBe("llama-server");
  // The forced engine setting.
  setCodingMachineFacts(m5);
  updateSettings({ "stack.engines.coding.engine": "llama-server" }); applyPendingSettings();
  expect(activeCodingChoice()).toEqual({ engine: "llama-server", requested: "llama-server", reason: null });
});

macTest("without the engine, or without its draft, the engine in effect is llama-server and the reason says what to install", () => {
  setCodingMachineFacts(m5);
  installCodingRecords();
  expect(activeCodingChoice().reason).toContain("Splash, the faster coding engine, is not installed");
  expect(activeCodingChoice().engine).toBe("llama-server");
  installSplashEngine();
  expect(activeCodingChoice().engine).toBe("splash");
  removeModel(STACK_CODING_DRAFT_MODEL.id);
  expect(activeCodingChoice().engine).toBe("llama-server");
  expect(activeCodingChoice().reason).toContain("draft model is not installed");
  installCodingRecords({ model: false });
  expect(activeCodingChoice().engine).toBe("splash");
});

macTest("the coding model serves both engines: it is still the selected model when Splash runs, and the draft is never a model anyone selects", () => {
  setCodingMachineFacts(m5);
  installSplashEngine();
  installCodingRecords();
  expect(activeCodingChoice().engine).toBe("splash");
  expect(selectedModel("coding")?.id).toBe("qwen3.8-27b-ud-q4-k-m");
  expect(selectableModels("coding").map((entry) => entry.id)).toEqual(["qwen3.8-27b-ud-q4-k-m"]);
  expect(engineInstalledFor("coding")).toBe(true);
  updateSettings({ "stack.engines.coding.engine": "llama-server" }); applyPendingSettings();
  expect(selectedModel("coding")?.id).toBe("qwen3.8-27b-ud-q4-k-m");
});

// ---- providing the files ---------------------------------------------------------------------

test("the Stack lays Splash's hub cache out by hardlink from its pinned files, in the hub's own layout, and Splash never needs the network", () => {
  const { modelPath, draftDir } = installCodingRecords();
  const layout = layOutSplashCache(getModel);
  const model = STACK_CODING_MODEL;
  const draft = STACK_CODING_DRAFT_MODEL;
  expect(layout).toMatchObject({ hubDir: splashHubDir(), homeDir: splashHomeDir(), tmpDir: splashTmpDir(), model: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", revision: "4ca720788d1e01f1bff70c033e0d0028fd02e502" });
  expect(splashHubDir().startsWith(splashRoot())).toBe(true);
  // The target: blob named by its sha256 (what the hub calls an LFS file, so Splash does not hash it again), snapshot link, refs/main.
  const targetFolder = join(splashHubDir(), "models--unsloth--Qwen3.8-27B-GGUF");
  const blob = join(targetFolder, "blobs", model.download!.sha256);
  expect(statSync(blob).ino).toBe(statSync(modelPath).ino);
  expect(lstatSync(blob).isSymbolicLink()).toBe(false);
  expect(statSync(modelPath).nlink).toBe(2);
  const snapshot = join(targetFolder, "snapshots", model.revision!, "Qwen3.8-27B-UD-Q4_K_M.gguf");
  expect(readlinkSync(snapshot)).toBe(`../../blobs/${model.download!.sha256}`);
  expect(statSync(snapshot).size).toBe(model.download!.approx_bytes);
  expect(readFileSync(join(targetFolder, "refs", "main"), "utf8")).toBe(model.revision!);
  // The draft: both files, and refs/main, which is how Splash finds the draft it pairs with the model.
  const draftFolder = join(splashHubDir(), "models--incoai--Qwen3.8-27B-DFlash2");
  for (const file of draft.download!.files!) {
    expect(statSync(join(draftFolder, "blobs", file.sha256)).ino).toBe(statSync(join(draftDir, file.path)).ino);
    expect(readlinkSync(join(draftFolder, "snapshots", draft.revision!, file.path))).toBe(`../../blobs/${file.sha256}`);
  }
  expect(readFileSync(join(draftFolder, "refs", "main"), "utf8")).toBe(draft.revision!);
  expect(layout.placed).toHaveLength(3);
  expect(layout.placed.every((entry) => entry.how === "hardlink")).toBe(true);
  // Never a copy: the data directory holds the model once.
  expect(readdirSync(join(targetFolder, "blobs"))).toEqual([model.download!.sha256]);
});

test("laying the cache out again changes nothing, replaces a stale or foreign link, drops files of an earlier pin, and empties the temporary folder", () => {
  const { modelPath } = installCodingRecords();
  layOutSplashCache(getModel);
  const targetFolder = join(splashHubDir(), "models--unsloth--Qwen3.8-27B-GGUF");
  const blob = join(targetFolder, "blobs", STACK_CODING_MODEL.download!.sha256);
  const inode = statSync(blob).ino;
  // An earlier pin's snapshot and blob, a file in the temporary folder, and a blob that is not the pinned file.
  mkdirSync(join(targetFolder, "snapshots", "0".repeat(40)), { recursive: true });
  writeFileSync(join(targetFolder, "blobs", "e".repeat(64)), "old");
  writeFileSync(join(splashTmpDir(), "kv-page-1"), "x");
  rmSync(blob);
  writeFileSync(blob, "not the pinned file");
  const again = layOutSplashCache(getModel);
  // The foreign file was replaced by a hardlink of the pinned file (the same inode as before).
  expect(statSync(blob).ino).toBe(statSync(modelPath).ino);
  expect(statSync(blob).ino).toBe(inode);
  expect(readdirSync(join(targetFolder, "snapshots"))).toEqual([STACK_CODING_MODEL.revision!]);
  expect(readdirSync(join(targetFolder, "blobs"))).toEqual([STACK_CODING_MODEL.download!.sha256]);
  expect(readdirSync(splashTmpDir())).toEqual([]);
  expect(again.placed.every((entry) => entry.how === "hardlink")).toBe(true);
});

test("a pin that is missing, differs or has a file of the wrong size is refused in plain words and nothing is laid out", () => {
  const refuses = (pattern: RegExp) => { expect(() => layOutSplashCache(getModel)).toThrow(SplashLayoutError); expect(() => layOutSplashCache(getModel)).toThrow(pattern); expect(existsSync(splashHubDir())).toBe(false); };
  // Nothing installed.
  refuses(/coding model \(qwen3\.8-27b-ud-q4-k-m\) is not installed and verified.*Install the coding model from Settings/);
  // The model but no draft.
  installCodingRecords({ draft: false });
  refuses(/draft model \(qwen3\.8-27b-dflash2-draft, 3\.8 GB\) is not installed, so the coding model runs on llama-server.*Install the coding model again from Settings/);
  // A draft of another commit.
  installCodingRecords();
  upsertModel({ ...getModel(STACK_CODING_DRAFT_MODEL.id)!, revision: "f".repeat(40) });
  refuses(/draft model on this computer is not the pinned qwen3\.8-27b-dflash2-draft/);
  installCodingRecords();
  // A draft file of the wrong size.
  truncateSync(join(getModel(STACK_CODING_DRAFT_MODEL.id)!.modelPath!, "config.json"), 12);
  refuses(/draft file config\.json is missing or the wrong size/);
  installCodingRecords();
  // A model file that is not the verified size, and a model record that is not the pinned bytes.
  truncateSync(getModel(STACK_CODING_MODEL.id)!.modelPath!, 1_000);
  refuses(/coding model file is 1000 bytes but the pin says 16464440224/);
  installCodingRecords();
  upsertModel({ ...getModel(STACK_CODING_MODEL.id)!, sha256: "0".repeat(64) });
  refuses(/not the pinned qwen3\.8-27b-ud-q4-k-m \(revision 4ca72078\)/);
  // A record that was never verified.
  installCodingRecords();
  upsertModel({ ...getModel(STACK_CODING_MODEL.id)!, verifiedAt: null });
  refuses(/not installed and verified/);
});

test("removing the coding model or its draft removes the layout, so the disk is freed; removing anything else leaves it", () => {
  const { modelPath } = installCodingRecords();
  layOutSplashCache(getModel);
  expect(statSync(modelPath).nlink).toBe(2);
  upsertModel({ id: "chat-a", roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/chat.gguf" });
  removeModel("chat-a");
  expect(existsSync(splashHubDir())).toBe(true);
  releaseSplashLayoutFor("some-other-id");
  expect(existsSync(splashHubDir())).toBe(true);
  expect(removeModel(STACK_CODING_DRAFT_MODEL.id)).toBe(true);
  expect(existsSync(splashRoot())).toBe(false);
  // The model's own file is still the model's: removing the layout never removes the pinned file.
  expect(existsSync(modelPath)).toBe(true);
  expect(statSync(modelPath).nlink).toBe(1);
  // With the draft gone, the next launch refuses instead of laying out half of it.
  expect(() => layOutSplashCache(getModel)).toThrow(SplashLayoutError);
});

test("the draft installs through the Stack's own downloader and every file is checked against its pinned hash; a wrong byte is refused", async () => {
  const files = { "config.json": Buffer.from('{"architectures":["DFlash2DraftModel"]}'), "model.safetensors": Buffer.from("draft weights ".repeat(40)) };
  const sha = (name: keyof typeof files) => createHash("sha256").update(files[name]).digest("hex");
  const pin = {
    ...STACK_CODING_DRAFT_MODEL, id: "draft-test",
    download: { url: "https://huggingface.co/incoai/Qwen3.8-27B-DFlash2/resolve/015e795645c74b1a0eeef3b570031fb62e769bc5/model.safetensors", sha256: sha("model.safetensors"), approx_bytes: files["model.safetensors"].length, directory: "Qwen3.8-27B-DFlash2", files: (Object.keys(files) as Array<keyof typeof files>).map((name) => ({ path: name, sha256: sha(name), bytes: files[name].length })) },
  };
  const fetched: string[] = [];
  const downloader = (corrupt?: string) => async (url: string, destination: string) => {
    const name = new URL(url).pathname.split("/").pop()! as keyof typeof files;
    fetched.push(name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, name === corrupt ? Buffer.from("tampered") : files[name]);
  };
  // A corrupt config.json is refused after it downloads, never trusted because the weights were right.
  await expect(installCatalogModel(pin, { destination: join(modelsDir, pin.id, "model.safetensors"), download: downloader("config.json") })).rejects.toThrow(/checksum/);
  expect(listHealth().some((item) => item.code === "stored-blob-checksum-mismatch" && /config\.json/.test(item.text))).toBe(true);
  expect(getModel(pin.id)?.verifiedAt ?? null).toBeNull();
  // Corrupt weights are refused first.
  await expect(installCatalogModel({ ...pin, id: "draft-test-2" }, { destination: join(modelsDir, "draft-test-2", "model.safetensors"), download: downloader("model.safetensors") })).rejects.toThrow(/checksum/);
  // The right bytes install, both files placed in the model's directory, which is its path.
  const installed = await installCatalogModel({ ...pin, id: "draft-test-3" }, { destination: join(modelsDir, "draft-test-3", "model.safetensors"), download: downloader() });
  expect(installed.modelPath).toBe(join(modelsDir, "draft-test-3", "Qwen3.8-27B-DFlash2"));
  expect(readFileSync(join(installed.modelPath!, "config.json")).equals(files["config.json"])).toBe(true);
  expect(readFileSync(join(installed.modelPath!, "model.safetensors")).equals(files["model.safetensors"])).toBe(true);
  expect(installed.engineRequirements).toMatchObject({ engine: "splash", component: "draft" });
  for (const id of ["draft-test", "draft-test-2", "draft-test-3"]) { removeModel(id); rmSync(join(modelsDir, id), { recursive: true, force: true }); }
});

// ---- the launch plan ------------------------------------------------------------------------

macTest("the launch plan runs the bundled Python with the launcher, lays the cache out first, and sets the exact environment", () => {
  setCodingMachineFacts(m5);
  const root = installSplashEngine();
  installCodingRecords();
  process.env.HF_TOKEN = "hf_must_not_reach_splash";
  try {
    updateSettings({ "stack.engines.coding.splash_cache_gb": 3, "stack.engines.coding.thinking_budget_ceiling": 1500 }); applyPendingSettings();
    const model = selectedModel("coding")!;
    const plan = splashLaunchPlan(model, 8812, 131_072);
    expect(plan).toMatchObject({ engine: "splash", build: "1.3.2", kind: "spawned", stdin: "ignore", contextLength: 131_072, slots: 2, contextScope: "total across slots", healthPath: "/ready", tree: true, imageInput: false, identity: { build: "splash-1.3.2", model: STACK_CODING_MODEL.download!.sha256 } });
    expect(plan.command).toEqual([
      join(root, "python", "bin", "python3"), "-u", join(root, "install", "launcher.py"),
      "serve", "--model", "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", "--revision", "4ca720788d1e01f1bff70c033e0d0028fd02e502", "--offline", "--host", "127.0.0.1", "--port", "8812",
      "--language-only", "--served-model-name", "qwen3.8-27b-ud-q4-k-m", "--announce-served-name", "--default-reasoning-effort", "medium", "--thinking-token-budget", "1500",
      "--max-context", "131072", "--max-cache-disk", "3G", "--idle-release", "off", "--no-webui",
    ]);
    expect(plan.env).toMatchObject({ HOME: splashHomeDir(), TMPDIR: splashTmpDir(), HF_HOME: splashHomeDir(), HF_HUB_CACHE: splashHubDir(), HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", DO_NOT_TRACK: "1", HF_HUB_DISABLE_TELEMETRY: "1" });
    expect(plan.env).not.toHaveProperty("HF_TOKEN");
    expect(Object.keys(plan.env!).some((key) => key.startsWith("PYTHON") && key !== "PYTHONUNBUFFERED")).toBe(false);
    // The files were laid out by the launch.
    expect(existsSync(join(splashHubDir(), "models--unsloth--Qwen3.8-27B-GGUF", "refs", "main"))).toBe(true);
    // The identity the Stack vouches for is the file it linked, so the identity check passes without asking Splash.
    expect(plan.identity?.model).toBe(STACK_CODING_MODEL.download!.sha256);
  } finally { delete process.env.HF_TOKEN; }
});

macTest("a launch with a pin missing is a plain refusal the fallback can act on, and a missing engine is one too", () => {
  setCodingMachineFacts(m5);
  installSplashEngine();
  installCodingRecords({ draft: false });
  const model = getModel(STACK_CODING_MODEL.id)!;
  expect(() => splashLaunchPlan(model, 8812, 131_072)).toThrow(EngineUnavailableError);
  expect(() => splashLaunchPlan(model, 8812, 131_072)).toThrow(/draft model .* is not installed, so the coding model runs on llama-server/);
  rmSync(join(engineDir(SPLASH_PIN), ENGINE_READY_MARKER));
  expect(() => splashLaunchPlan(model, 8812, 131_072)).toThrow("No installed Splash build is available for this machine.");
});

test("Splash is only ever asked for the one name it serves: every request is renamed, and Splash's 404 for `coding` cannot happen", async () => {
  const seen: Array<{ path: string; body: Record<string, unknown>; stream: boolean }> = [];
  const inner: EngineClient = {
    baseUrl: "http://127.0.0.1:1",
    request: async (path, body) => { seen.push({ path, body, stream: false }); return { status: 200, body: {} }; },
    stream: async (path, body) => { seen.push({ path, body, stream: true }); return new Response(""); },
    health: async () => true,
  };
  const client = new ServedNameClient(inner, "qwen3.8-27b-ud-q4-k-m");
  await client.request("/v1/chat/completions", { model: "coding", messages: [] });
  await client.request("/v1/messages/count_tokens", { messages: [] });
  await client.stream("/v1/responses", { model: "whatever-the-client-sent", input: "hi" });
  expect(seen.map((entry) => [entry.path, entry.body.model, entry.stream])).toEqual([["/v1/chat/completions", "qwen3.8-27b-ud-q4-k-m", false], ["/v1/messages/count_tokens", "qwen3.8-27b-ud-q4-k-m", false], ["/v1/responses", "qwen3.8-27b-ud-q4-k-m", true]]);
  expect(client.baseUrl).toBe("http://127.0.0.1:1");
  expect(await client.health()).toBe(true);
});

test("the readiness identity check: the engine on the port lists the served name and calls itself Splash, or the start fails in plain words", async () => {
  const server = (models: unknown, status = 200) => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new URL(request.url).pathname === "/v1/models" ? Response.json(models, { status }) : new Response("no", { status: 404 }) });
  const good = server({ data: [{ id: "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M", owned_by: "splash" }, { id: "qwen3.8-27b-ud-q4-k-m", owned_by: "splash" }] });
  const other = server({ data: [{ id: "something-else", owned_by: "splash" }] });
  const imposter = server({ data: [{ id: "qwen3.8-27b-ud-q4-k-m", owned_by: "llamacpp" }] });
  const broken = server({ error: "no" }, 500);
  try {
    await verifySplashServes(`http://127.0.0.1:${good.port}`, "qwen3.8-27b-ud-q4-k-m");
    await expect(verifySplashServes(`http://127.0.0.1:${other.port}`, "qwen3.8-27b-ud-q4-k-m")).rejects.toThrow(/does not serve qwen3\.8-27b-ud-q4-k-m \(it lists something-else\), so coding is not using it/);
    await expect(verifySplashServes(`http://127.0.0.1:${imposter.port}`, "qwen3.8-27b-ud-q4-k-m")).rejects.toThrow(/did not identify itself as Splash \(it says llamacpp\)/);
    await expect(verifySplashServes(`http://127.0.0.1:${broken.port}`, "qwen3.8-27b-ud-q4-k-m")).rejects.toThrow(/lists nothing/);
    await expect(verifySplashServes("http://127.0.0.1:9", "qwen3.8-27b-ud-q4-k-m")).rejects.toThrow(EngineUnavailableError);
  } finally { for (const s of [good, other, imposter, broken]) s.stop(true); }
});

// ---- the fallback -------------------------------------------------------------------------

function qualifyingMac(): void { setCodingMachineFacts(m5); installSplashEngine(); installCodingRecords(); }
const codingWarning = () => listHealth().find((item) => item.code === "coding.engine-fallback");

macTest("a Splash start that fails sends the same request to llama-server, raises a warning in plain words, and keeps coding there until the engine is restarted", async () => {
  qualifyingMac();
  const engines: string[] = [];
  const start = async (role: string) => {
    engines.push(activeCodingChoice().engine);
    if (engines.length === 1) throw new EngineUnavailableError("Engine exited before becoming healthy (code 3): cannot start: the model could not be assembled");
    return scriptedProcess(role as "coding");
  };
  const started = await startCodingWithFallbackForTests(undefined, start);
  expect(started.role).toBe("coding");
  // Splash was tried, then llama-server for the same request.
  expect(engines).toEqual(["splash", "llama-server"]);
  const warning = codingWarning()!;
  expect(warning).toMatchObject({ severity: "warning", title: "Splash did not start; coding is on llama-server" });
  expect(warning.text).toBe("Engine exited before becoming healthy (code 3): cannot start: the model could not be assembled. Coding is using the slower engine, llama-server, until the coding engine is restarted. Restart the coding engine to try Splash again.");
  expect(warning.fix).toMatchObject({ action: "restart_engine" });
  // It stays on llama-server, and the role list says which engine and why.
  expect(codingEngineFailure()?.reason).toContain("could not be assembled");
  expect(activeCodingChoice()).toMatchObject({ engine: "llama-server", requested: "auto" });
  expect(codingEngineStatus()).toMatchObject({ engine: "llama-server", engine_requested: "auto" });
  expect(codingEngineStatus().engine_reason).toContain("so coding is using the slower engine, llama-server");
  // A second start does not try Splash again, and does not clear the warning.
  engines.length = 0;
  await startCodingWithFallbackForTests(undefined, async (role) => { engines.push(activeCodingChoice().engine); return scriptedProcess(role as "coding"); });
  expect(engines).toEqual(["llama-server"]);
  expect(codingWarning()).toBeDefined();
  // A restart of the coding engine clears the memory: Splash is tried again, and a start that works clears the warning.
  await recycleRole("coding");
  expect(activeCodingChoice().engine).toBe("splash");
  engines.length = 0;
  await startCodingWithFallbackForTests(undefined, async (role) => { engines.push(activeCodingChoice().engine); return scriptedProcess(role as "coding"); });
  expect(engines).toEqual(["splash"]);
  expect(codingWarning()).toBeUndefined();
});

macTest("a refusal for memory goes to llama-server for that request only: Splash is not held against, and the warning says to free memory", async () => {
  qualifyingMac();
  const engines: string[] = [];
  await startCodingWithFallbackForTests(undefined, async (role) => {
    engines.push(activeCodingChoice().engine);
    if (engines.length === 1) throw new EngineDoesNotFitError("The coding model needs about 21.4 GB to load, and this computer has 9.0 GB free after keeping 12.0 GB back.");
    return scriptedProcess(role as "coding");
  });
  expect(engines).toEqual(["splash", "llama-server"]);
  expect(codingWarning()!.text).toContain("Coding is using the slower engine, llama-server, for this request. Wait for the picture, video or song job to finish, or close a large app.");
  expect(codingEngineFailure()).toBeNull();
  expect(activeCodingChoice().engine).toBe("splash");
});

macTest("when llama-server cannot start either, the error the person sees is llama-server's, and the forced engine does not leak into the next start", async () => {
  qualifyingMac();
  let calls = 0;
  await expect(startCodingWithFallbackForTests(undefined, async () => { calls++; throw new EngineUnavailableError(calls === 1 ? "splash broke" : "No installed llama-server build is available for this machine."); })).rejects.toThrow("No installed llama-server build is available for this machine.");
  expect(calls).toBe(2);
  // Splash is marked failed; the forced llama-server was only for that call.
  expect(activeCodingChoice().reason).toContain("splash broke");
  clearCodingEngineFailures();
  expect(activeCodingChoice().engine).toBe("splash");
});

macTest("an admin who forced Splash on a Mac that cannot run it gets one warning saying why; `auto` on such a Mac says nothing", async () => {
  setCodingMachineFacts({ ...m5, chipGeneration: 2, chipName: "Apple M2 Max" });
  installSplashEngine();
  installCodingRecords();
  const engines: string[] = [];
  const start = async (role: string) => { engines.push(activeCodingChoice().engine); return scriptedProcess(role as "coding"); };
  await startCodingWithFallbackForTests(undefined, start);
  expect(engines).toEqual(["llama-server"]);
  expect(codingWarning()).toBeUndefined();
  updateSettings({ "stack.engines.coding.engine": "splash" }); applyPendingSettings();
  await startCodingWithFallbackForTests(undefined, start);
  expect(codingWarning()).toMatchObject({ severity: "warning", title: "Splash is not running; coding is on llama-server" });
  expect(codingWarning()!.text).toBe("Splash needs an M3 chip or newer; this Mac has an M2. Coding uses llama-server.");
  // The admin changes the setting back: the warning clears at the next start.
  updateSettings({ "stack.engines.coding.engine": "auto" }); applyPendingSettings();
  await startCodingWithFallbackForTests(undefined, start);
  expect(codingWarning()).toBeUndefined();
});

macTest("the role list says which engine serves coding while the engine is not loaded, and the role's own state is unchanged", async () => {
  qualifyingMac();
  expect(codingEngineStatus()).toMatchObject({ state: "installed", engine: "splash", engine_requested: "auto", engine_reason: null });
  expect(getRoleStatus("coding").state).toBe("installed");
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; coding?: { engine: string; engine_requested: string; engine_reason: string | null } }> };
  expect(body.roles.find((role) => role.id === "coding")!.coding).toMatchObject({ engine: "splash", engine_requested: "auto", engine_reason: null });
});
