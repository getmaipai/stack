// Which engine serves the coding role, and what Splash needs from the machine
// (CODE-STACK-01 S5a). Pure except for the failure memory, which a restart of the
// coding engine clears (the chat and voice engines' rule).
//
// The owner's decisions (2026-10-18): Splash serves coding on Apple silicon where it
// runs, llama-server everywhere else and as the fallback; the 64 GB tier uses Splash
// unmeasured, the governor refusing when it does not fit. Splash's own floor is an
// M3 or newer, macOS 26.4 or later and 36 GB of memory (the catalog entry and the
// ENGINE-SPLASH-01 row); the Stack adds the tier rule (p64 and p128, the tiers that
// bind a coding model at all).
import type { GovernorTier } from "@/lib/governor";
import type { CodingEngine } from "@/lib/engineCatalog";

export const CODING_ENGINE_SETTING = "stack.engines.coding.engine";
export const CODING_ENGINE_CHOICES = ["auto", "llama-server", "splash"] as const;
export type CodingEngineSetting = typeof CODING_ENGINE_CHOICES[number];
export const SPLASH_CACHE_GB_SETTING = "stack.engines.coding.splash_cache_gb";
export const SPLASH_CACHE_GB_DEFAULT = 8;

export const SPLASH_MIN_MEMORY_GB = 36;
export const SPLASH_MIN_CHIP_GENERATION = 3;
export const SPLASH_MIN_MACOS: readonly [number, number] = [26, 4];
export const SPLASH_TIERS: readonly GovernorTier[] = ["p64", "p128"];
/** Reasoning effort Splash applies to a request that sets none (the benchmark's setting: 10 of 10 at medium with a 2,000-token budget). */
export const SPLASH_REASONING_EFFORT = "medium";

/** What the machine says about itself, gathered once at the daemon's start. */
export interface SplashFacts {
  platform: string;
  arch: string;
  /** 5 for an M5 Max; null when the chip is unknown or not an Apple M chip. */
  chipGeneration: number | null;
  chipName: string | null;
  memoryGb: number;
  /** `sw_vers -productVersion`, e.g. "26.4" or "27.0.1". */
  osVersion: string | null;
  tier: GovernorTier | undefined | null;
}

/** [major, minor] of a macOS version string, or null when it cannot be read. */
export function macosVersion(osVersion: string | null | undefined): [number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?/.exec((osVersion ?? "").trim());
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

/** The plain reason Splash cannot run on this machine, or null when it can. */
export function splashUnsupportedReason(facts: SplashFacts): string | null {
  if (facts.platform !== "darwin" || facts.arch !== "arm64") return "Splash runs on Apple silicon Macs only.";
  if (facts.chipGeneration === null) return `The Stack could not tell which Apple chip this Mac has${facts.chipName ? ` (${facts.chipName})` : ""}, and Splash needs an M3 or newer.`;
  if (facts.chipGeneration < SPLASH_MIN_CHIP_GENERATION) return `Splash needs an M3 chip or newer; this Mac has an M${facts.chipGeneration}.`;
  if (facts.memoryGb + 0.5 < SPLASH_MIN_MEMORY_GB) return `Splash needs ${SPLASH_MIN_MEMORY_GB} GB of memory or more; this Mac has ${Math.round(facts.memoryGb)} GB.`;
  const macos = macosVersion(facts.osVersion);
  if (!macos) return `The Stack could not read this Mac's macOS version, and Splash needs macOS ${SPLASH_MIN_MACOS[0]}.${SPLASH_MIN_MACOS[1]} or later.`;
  if (macos[0] < SPLASH_MIN_MACOS[0] || (macos[0] === SPLASH_MIN_MACOS[0] && macos[1] < SPLASH_MIN_MACOS[1])) return `Splash needs macOS ${SPLASH_MIN_MACOS[0]}.${SPLASH_MIN_MACOS[1]} or later; this Mac runs ${facts.osVersion}.`;
  if (!facts.tier || !SPLASH_TIERS.includes(facts.tier)) return "Splash serves the coding role on computers with 64 GB of memory or more.";
  return null;
}

/** Whether Splash's draft model is worth having on this machine: Apple silicon, and not a chip known to be older than an M3. An unread chip counts as possible, so the disk plan the clients copy before a Stack exists (docs/disk-plan.json) is the same everywhere; the daemon reads the chip at its start, before any plan is built. */
export function splashDraftPossible(target: { platform: string; arch: string }, chip: { generation: number | null } | null): boolean {
  if (target.platform !== "darwin" || target.arch !== "arm64") return false;
  return chip === null || (chip.generation !== null && chip.generation >= SPLASH_MIN_CHIP_GENERATION);
}

/** The same for the first-run plan, which also needs a tier that binds the coding model. */
export function splashDraftWanted(target: { platform: string; arch: string }, tier: string, chip: { generation: number | null } | null): boolean {
  return (SPLASH_TIERS as readonly string[]).includes(tier) && splashDraftPossible(target, chip);
}

/** What the setting asks for; anything unknown is `auto`. */
export function requestedCodingEngine(setting: unknown): CodingEngineSetting {
  return setting === "llama-server" || setting === "splash" ? setting : "auto";
}

const failures = { count: 0, reason: "" };
/** A Splash start failed; coding stays on llama-server until the coding engine is restarted. */
export function markCodingEngineFailed(reason: string): void { failures.count++; failures.reason = reason; }
export function clearCodingEngineFailures(): void { failures.count = 0; failures.reason = ""; }
export function codingEngineFailure(): { count: number; reason: string } | null { return failures.count > 0 ? { ...failures } : null; }

export interface CodingEngineChoice {
  /** The engine the next start runs. */
  engine: CodingEngine;
  /** What the setting asked for. */
  requested: CodingEngineSetting;
  /** Why the engine is not the faster one though it was wanted (a plain sentence); null when nothing is amiss, including on a machine Splash never runs on. */
  reason: string | null;
}

export function resolveCodingEngine(options: { setting: unknown; facts: SplashFacts; splashInstalled: boolean; draftReady: boolean; modelReady: boolean }): CodingEngineChoice {
  const requested = requestedCodingEngine(options.setting);
  if (requested === "llama-server") return { engine: "llama-server", requested, reason: null };
  const unsupported = splashUnsupportedReason(options.facts);
  // On a Mac Splash cannot run on, `auto` is simply llama-server; an admin who forced Splash is told why it is not running.
  if (unsupported) return { engine: "llama-server", requested, reason: requested === "splash" ? `${unsupported} Coding uses llama-server.` : null };
  const failure = codingEngineFailure();
  if (failure) return { engine: "llama-server", requested, reason: `Splash did not start (${failure.reason}), so coding is using the slower engine, llama-server. Restart the coding engine to try Splash again.` };
  if (!options.splashInstalled) return { engine: "llama-server", requested, reason: "Splash, the faster coding engine, is not installed on this computer yet, so coding is using llama-server. Install it from Settings." };
  if (!options.modelReady || !options.draftReady) return { engine: "llama-server", requested, reason: "Splash's draft model is not installed on this computer yet, so coding is using llama-server. Install the coding model again from Settings to add it." };
  return { engine: "splash", requested, reason: null };
}

// ---- the memory estimate ------------------------------------------------------------

/** There is no `llama-fit-params` for Splash, so the governor's figure is an ESTIMATE, calibrated on the one real reading: the 27B UD-Q4_K_M with its draft ran at about 21 to 23 GB on the owner's Mac (2026-10-18, a 128 GB M5 Max). The weights and the draft are the bulk; the factor covers Splash's runtime buffers and its Neural Engine copy, and the per-token term its key and value cache (int8, a hybrid model with few global layers). Until a real run measures it on a 64 GB Mac, treat it as an estimate: after the post-load check the governor's reading of the whole process tree replaces it. */
export const SPLASH_OVERHEAD_FACTOR = 1.08;
export const SPLASH_KV_BYTES_PER_TOKEN = 8192;

export function splashFootprintEstimateBytes(input: { weightsBytes: number; draftBytes: number; contextTokens: number }): number {
  return Math.ceil((input.weightsBytes + input.draftBytes) * SPLASH_OVERHEAD_FACTOR) + Math.max(0, input.contextTokens) * SPLASH_KV_BYTES_PER_TOKEN;
}

// ---- the process environment ----------------------------------------------------------

/** The environment Splash starts with: the Stack's own folders for everything it writes, nothing that could send it online, nothing of the Stack's secrets. `HF_HUB_OFFLINE=1` is what the launcher's own `--offline` sets too; it is set here as well so the installer step cannot ask the Hub even if a flag were dropped. */
export function splashEnv(layout: { hubDir: string; homeDir: string; tmpDir: string }, inherited: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (key === "STACK_SECRETS_KEY" || key.startsWith("MAIPAI_SECRETS")) continue;
    // A token or an endpoint of the person's would be handed to a program that must not use the network; Python variables of the Stack's own run would change which code Splash imports.
    if (key === "HF_TOKEN" || key === "HUGGING_FACE_HUB_TOKEN" || key === "HF_ENDPOINT" || key === "SPLASH_API_KEY" || key.startsWith("PYTHON")) continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: layout.homeDir,
    TMPDIR: layout.tmpDir,
    HF_HOME: layout.homeDir,
    HF_HUB_CACHE: layout.hubDir,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    HF_HUB_DISABLE_PROGRESS_BARS: "1",
    DO_NOT_TRACK: "1",
    PYTHONUNBUFFERED: "1",
  };
}
