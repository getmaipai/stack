// Every Stack setting, declared once (org SETTINGS.md). Home's generic
// renderer draws from `GET /stack/v1/settings`; values live in `meta`.
// A key marked `needsRestart` is held as pending until the next start.
// Per-engine keys and the per-role url bindings are part of the same
// declaration under their own sections.
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { defaultModelBudgetBytes, setGovernorMemorySettings } from "@/lib/governor";
import { setDownloadCapMbps } from "@/lib/download";

export type SettingType = "number" | "boolean" | "text" | "enum";
export type Disclosure = "basic" | "advanced" | "developer";
export type SettingValue = number | boolean | string;
export interface SettingOption { value: string; label: string; }

export interface SettingDeclaration {
  key: string;
  type: SettingType;
  default: SettingValue;
  label: string;
  help: string;
  disclosure: Disclosure;
  needsRestart: boolean;
  section: string;
  order: number;
  range?: { min?: number; max?: number };
  options?: SettingOption[];
}

export interface SettingRecord extends SettingDeclaration {
  inEffect: SettingValue;
  pending: SettingValue | null;
}

export const SETTING_SECTIONS = [
  { id: "memory", label: "Memory" },
  { id: "updates", label: "Updates" },
  { id: "runtime", label: "Runtime" },
  { id: "engines.llama-server", label: "llama-server" },
  { id: "engines.chat", label: "Chat engine" },
  { id: "engines.embed", label: "Embeddings engine" },
  { id: "engines.stt", label: "Voice in engine" },
  { id: "engines.tts", label: "Voice out engine" },
] as const;

// A `url` binding: a server the person already runs, bound read-only to
// one role. Empty means no binding; the Stack then spawns its own engine
// for the role where it can.
export const URL_BINDING_ROLES = ["chat", "embed", "stt", "tts"] as const;
export type UrlBindingRole = typeof URL_BINDING_ROLES[number];

function urlBinding(role: UrlBindingRole, order: number): SettingDeclaration[] {
  return [
    { key: `engines.${role}.hostUrl`, type: "text", default: "", label: "Server URL", help: `An OpenAI-shaped server you already run, used for ${role} instead of an engine the Stack starts. Leave empty to let the Stack manage the engine.`, disclosure: "advanced", needsRestart: true, section: `engines.${role}`, order },
    { key: `engines.${role}.expectedVersion`, type: "text", default: "", label: "Expected version", help: "Optional build string checked against the server's identity.", disclosure: "developer", needsRestart: true, section: `engines.${role}`, order: order + 10 },
  ];
}

export const SETTINGS: SettingDeclaration[] = [
  { key: "modelBudgetBytes", type: "number", default: defaultModelBudgetBytes(), label: "Memory for models", help: "The maximum memory the Stack may use for loaded models. The rest stays available for the computer.", disclosure: "basic", needsRestart: false, range: { min: 0, max: defaultModelBudgetBytes() + 8 * 1_073_741_824 }, section: "memory", order: 10 },
  { key: "systemLowWaterPct", type: "number", default: 10, label: "Low memory percentage", help: "Warn when available memory falls below this percentage.", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 99 }, section: "memory", order: 20 },
  { key: "systemLowWaterFloorBytes", type: "number", default: 1_073_741_824, label: "Low memory floor", help: "Warn when available memory falls below this many bytes.", disclosure: "advanced", needsRestart: false, range: { min: 0, max: defaultModelBudgetBytes() }, section: "memory", order: 30 },
  { key: "systemSustainedPolls", type: "number", default: 2, label: "Pressure confirmation polls", help: "How many low readings confirm memory pressure.", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 20 }, section: "memory", order: 40 },
  { key: "updatesEnabled", type: "boolean", default: false, label: "Check for updates", help: "Allow the Stack to read the Catalog's signed index when Home asks it to check. Nothing is downloaded or installed without an explicit action.", disclosure: "basic", needsRestart: false, section: "updates", order: 10 },
  { key: "huggingFaceEndpoint", type: "text", default: "https://huggingface.co", label: "Model host", help: "Where model files are downloaded from: Hugging Face, or a mirror you run.", disclosure: "advanced", needsRestart: false, section: "updates", order: 20 },
  { key: "idleUnloadMinutes", type: "number", default: 30, label: "Unload after idle", help: "Minutes without a request before a resident engine is unloaded.", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 1440 }, section: "runtime", order: 10 },
  { key: "idleUnloadOnBatteryMinutes", type: "number", default: 10, label: "Unload after idle on battery", help: "The same limit while the computer runs on battery.", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 1440 }, section: "runtime", order: 20 },
  { key: "downloadCapMbps", type: "number", default: 0, label: "Download cap", help: "Maximum download speed in Mbps. Zero means no cap.", disclosure: "advanced", needsRestart: false, range: { min: 0, max: 100_000 }, section: "runtime", order: 30 },
  { key: "port", type: "number", default: 8770, label: "Port", help: "The loopback port the Stack listens on after the next start.", disclosure: "developer", needsRestart: true, range: { min: 1, max: 65535 }, section: "runtime", order: 40 },
  { key: "engines.llama-server.contextLength", type: "number", default: 4096, label: "Context length", help: "How much conversation the engine can hold at once.", disclosure: "advanced", needsRestart: true, range: { min: 512, max: 262_144 }, section: "engines.llama-server", order: 10 },
  { key: "engines.llama-server.slots", type: "number", default: 1, label: "Parallel slots", help: "How many requests the engine can serve concurrently.", disclosure: "advanced", needsRestart: true, range: { min: 1, max: 16 }, section: "engines.llama-server", order: 20 },
  { key: "engines.llama-server.threads", type: "number", default: 0, label: "CPU threads", help: "CPU threads used by the engine. Zero lets the engine choose.", disclosure: "developer", needsRestart: true, range: { min: 0, max: 256 }, section: "engines.llama-server", order: 30 },
  { key: "engines.llama-server.cacheRamMb", type: "number", default: 0, label: "Cache RAM", help: "Optional cache reservation in megabytes.", disclosure: "developer", needsRestart: true, range: { min: 0, max: 1_048_576 }, section: "engines.llama-server", order: 40 },
  { key: "engines.llama-server.flashAttention", type: "boolean", default: true, label: "Flash attention", help: "Use the faster attention implementation when supported.", disclosure: "advanced", needsRestart: true, section: "engines.llama-server", order: 50 },
  ...urlBinding("chat", 10),
  ...urlBinding("embed", 10),
  ...urlBinding("stt", 10),
  ...urlBinding("tts", 10),
];

const byKey = new Map(SETTINGS.map((declaration) => [declaration.key, declaration]));

function metaKey(key: string, state: "inEffect" | "pending"): string { return `settings.${key}.${state}`; }
function read(key: string): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value ?? null; }
function write(key: string, value: unknown): void { db.insert(meta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } }).run(); }
function clear(key: string): void { db.delete(meta).where(eq(meta.key, key)).run(); }

function decode(value: string | null, declaration: SettingDeclaration): SettingValue {
  if (value === null) return declaration.default;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  return typeof parsed === "number" || typeof parsed === "boolean" || typeof parsed === "string" ? parsed : declaration.default;
}

function valueSchema(declaration: SettingDeclaration): z.ZodTypeAny {
  if (declaration.type === "boolean") return z.boolean();
  if (declaration.type === "number") return z.number().int().min(declaration.range?.min ?? Number.MIN_SAFE_INTEGER).max(declaration.range?.max ?? Number.MAX_SAFE_INTEGER);
  if (declaration.type === "enum") return z.string().refine((value) => declaration.options?.some((option) => option.value === value) ?? false, "Invalid setting option");
  return z.string();
}

export function readSettings(): SettingRecord[] {
  return SETTINGS.map((declaration) => {
    const pending = read(metaKey(declaration.key, "pending"));
    return { ...declaration, inEffect: decode(read(metaKey(declaration.key, "inEffect")), declaration), pending: pending === null ? null : decode(pending, declaration) };
  });
}

export function settingValues(): Record<string, SettingValue> {
  return Object.fromEntries(readSettings().map((setting) => [setting.key, setting.inEffect]));
}

/** The values a spawned engine's launch reads: every key under its
 * section, with the section prefix stripped (`contextLength`, not
 * `engines.llama-server.contextLength`). */
export function engineSettingValues(section: string): Record<string, SettingValue> {
  const prefix = `${section}.`;
  return Object.fromEntries(readSettings().filter((setting) => setting.key.startsWith(prefix)).map((setting) => [setting.key.slice(prefix.length), setting.inEffect]));
}

export function updateSettings(values: Record<string, unknown>): SettingRecord[] {
  for (const key of Object.keys(values)) if (!byKey.has(key)) throw new Error(`Unknown Stack setting: ${key}`);
  for (const [key, raw] of Object.entries(values)) {
    const declaration = byKey.get(key)!;
    const value = valueSchema(declaration).parse(raw) as SettingValue;
    if (declaration.needsRestart) {
      if (value === decode(read(metaKey(key, "inEffect")), declaration)) clear(metaKey(key, "pending"));
      else write(metaKey(key, "pending"), value);
    } else write(metaKey(key, "inEffect"), value);
  }
  applySettingsToRuntime();
  return readSettings();
}

/** Promotes every pending value; called at start (after the service
 * manager restarted the process) and by `POST /stack/v1/settings/apply`. */
export function applyPendingSettings(): SettingRecord[] {
  for (const declaration of SETTINGS) {
    const pending = read(metaKey(declaration.key, "pending"));
    if (pending === null) continue;
    write(metaKey(declaration.key, "inEffect"), decode(pending, declaration));
    clear(metaKey(declaration.key, "pending"));
  }
  applySettingsToRuntime();
  return readSettings();
}

/** Pushes the live-applied values into the modules that consume them,
 * so neither the governor nor the downloader reads configuration itself. */
export function applySettingsToRuntime(): void {
  const values = settingValues();
  setGovernorMemorySettings({
    modelBudgetBytes: Number(values.modelBudgetBytes),
    systemLowWaterPct: Number(values.systemLowWaterPct) / 100,
    systemLowWaterFloorBytes: Number(values.systemLowWaterFloorBytes),
    systemSustainedPolls: Number(values.systemSustainedPolls),
  });
  setDownloadCapMbps(Number(values.downloadCapMbps));
}

export function __resetSettingsForTests(): void {
  db.delete(meta).where(like(meta.key, "settings.%")).run();
  applySettingsToRuntime();
}
