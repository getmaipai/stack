// Every Stack setting, declared once (org SETTINGS.md) in the spec's
// StackSetting shape: a SettingsKey (home/spec) restricted to the Stack
// plus the value half. Home's generic renderer draws from
// `GET /stack/v1/settings`; values live in `meta`. A key marked
// `needs_restart` is held as pending until the next start. Per-engine
// keys and the per-role url bindings are part of the same declaration
// under their own sections.
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { defaultModelBudgetBytes, setGovernorMemorySettings } from "@/lib/governor";
import { setDownloadCapMbps } from "@/lib/download";
import { StackSetting } from "@maipai/spec/stack/ts/stack-setting.js";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { ENGINE_BINARIES } from "@/lib/engineCatalog";

export type SettingValue = number | boolean | string;

/** The declaration half of a StackSetting: everything but the values. */
export type SettingDeclaration = Omit<StackSetting, "in_effect" | "pending">;

export const SETTING_SECTIONS = [
  { id: "memory", label: "Memory" },
  { id: "updates", label: "Updates" },
  { id: "runtime", label: "Runtime" },
  { id: "engines.llama_server", label: "llama-server" },
  { id: "engines.chat", label: "Chat engine" },
  { id: "engines.embed", label: "Embeddings engine" },
  { id: "engines.vision", label: "Vision engine" },
  { id: "engines.stt", label: "Voice in engine" },
  { id: "engines.tts", label: "Voice out engine" },
] as const;

// A `url` binding: a server the person already runs, bound read-only to
// one role. Empty means no binding; the Stack then spawns its own engine
// for the role where it can.
export const URL_BINDING_ROLES = ["chat", "embed", "vision", "stt", "tts"] as const;
export type UrlBindingRole = typeof URL_BINDING_ROLES[number];

const stack = { scope: "device" as const, lives_in: "stack" as const, honoured_by: ["home", "bot"] as Array<"home" | "bot"> };

function urlBinding(role: UrlBindingRole, order: number): SettingDeclaration[] {
  return [
    { ...stack, key: `stack.engines.${role}.host_url`, selector: "text", default: "", label: "Server URL", help: `An OpenAI-shaped server you already run, used for ${role} instead of an engine the Stack starts. Leave empty to let the Stack manage the engine.`, section: { id: `engines.${role}`, order }, level: "advanced", needs_restart: true },
    { ...stack, key: `stack.engines.${role}.expected_version`, selector: "text", default: "", label: "Expected version", help: "Optional build string checked against the server's identity.", section: { id: `engines.${role}`, order: order + 10 }, level: "expert", needs_restart: true },
  ];
}

// Which roles the llama-server engine runs, and so which can choose where
// their layers live (STACK-EMBED-02). Declared once here; the launch, the
// fit plan and the settings page all read this one declaration.
export const GPU_LAYER_ROLES = ["chat", "embed", "vision"] as const;
export type GpuLayerRole = typeof GPU_LAYER_ROLES[number];
export type GpuLayers = "all" | 0;

function gpuLayersSetting(role: GpuLayerRole): SettingDeclaration {
  return { ...stack, key: `stack.engines.${role}.gpu_layers`, selector: "select", range: { options: [{ value: "all", label: "Graphics chip (fastest)" }, { value: "0", label: "Processor (uses system memory, not graphics memory)" }] }, default: "all", label: "Where this model runs", help: "Choose the graphics chip for speed. Choose the processor when the graphics memory is too small or busy: the model then loads into the computer's regular memory and answers a little slower.", section: { id: `engines.${role}`, order: 7 }, level: "advanced", needs_restart: true };
}

/** Where a role's llama-server layers live, as the person chose it:
 * every layer on the accelerator (the default), or none (the processor). */
export function gpuLayersFor(role: string, values: Record<string, SettingValue> = settingValues()): GpuLayers {
  return (GPU_LAYER_ROLES as readonly string[]).includes(role) && String(values[`stack.engines.${role}.gpu_layers`]) === "0" ? 0 : "all";
}

export const SETTINGS: SettingDeclaration[] = [
  { ...stack, key: "stack.memory.model_budget_bytes", selector: "number", range: { min: 0, max: defaultModelBudgetBytes() + 8 * 1_073_741_824 }, default: defaultModelBudgetBytes(), label: "Memory for models", help: "The maximum memory the Stack may use for loaded models. The rest stays available for the computer.", section: { id: "memory", order: 10 }, level: "basic", needs_restart: false },
  { ...stack, key: "stack.memory.low_water_pct", selector: "number", range: { min: 1, max: 99 }, default: 10, label: "Low memory percentage", help: "Warn when available memory falls below this percentage.", section: { id: "memory", order: 20 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.memory.low_water_floor_bytes", selector: "number", range: { min: 0, max: defaultModelBudgetBytes() }, default: 1_073_741_824, label: "Low memory floor", help: "Warn when available memory falls below this many bytes.", section: { id: "memory", order: 30 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.memory.sustained_polls", selector: "number", range: { min: 1, max: 20 }, default: 2, label: "Pressure confirmation polls", help: "How many low readings confirm memory pressure.", section: { id: "memory", order: 40 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.memory.watchdog", selector: "boolean", default: true, label: "Memory watchdog", help: "Watch the whole computer's memory, not only the Stack's own engines. When memory runs short the Stack waits before starting picture and video work, then stops it, and tells you what is using the memory. It never stops programs that are not the Stack's.", section: { id: "memory", order: 50 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.memory.reserve_gb", selector: "number", range: { min: 0, max: 256 }, default: 0, label: "Memory kept free", help: "Gigabytes of memory the watchdog keeps free for the rest of the computer before it starts picture or video work. Zero means automatic: the larger of 8 GB and 8 percent of the memory, never more than a quarter of it.", section: { id: "memory", order: 60 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.memory.reap_orphans", selector: "boolean", default: true, label: "Stop abandoned engines", help: "Stop an engine from this Stack's own engines folder that lost its parent program, has no one connected, and has been running 90 seconds or more. These hold gigabytes for nothing. Only the Stack's own engines are ever matched.", section: { id: "memory", order: 70 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.updates.enabled", selector: "boolean", default: false, label: "Check for updates", help: "Allow the Stack to read the Catalog's signed index when Home asks it to check. Nothing is downloaded or installed without an explicit action.", section: { id: "updates", order: 10 }, level: "basic", needs_restart: false },
  { ...stack, key: "stack.updates.model_host", selector: "text", default: "https://huggingface.co", label: "Model host", help: "Where model files are downloaded from: Hugging Face, or a mirror you run.", section: { id: "updates", order: 20 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.runtime.self_heal", selector: "boolean", default: true, label: "Restart engines that crash", help: "When a chat, embed, voice or speech engine stops on its own, the Stack restarts it by itself (2 seconds, then 10, 30 and 120 seconds), checks that it answers, and stops trying after 5 failures in 30 minutes. It waits while an install or update runs, or while the computer is low on memory.", section: { id: "runtime", order: 12 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.runtime.idle_unload_minutes", selector: "number", range: { min: 1, max: 1440 }, default: 30, label: "Unload after idle", help: "Minutes without a request before a resident engine is unloaded.", section: { id: "runtime", order: 10 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.runtime.idle_unload_on_battery_minutes", selector: "number", range: { min: 1, max: 1440 }, default: 10, label: "Unload after idle on battery", help: "The same limit while the computer runs on battery.", section: { id: "runtime", order: 20 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.runtime.keep_warm", selector: "boolean", default: true, label: "Keep models ready", help: "Load the chat, memory and voice models when the Stack starts and keep them in memory, so the first message is not slow. Costs the memory those models use all the time. Models that do not fit stay on-demand. On battery they still unload after the idle time.", section: { id: "runtime", order: 15 }, level: "basic", needs_restart: false },
  { ...stack, key: "stack.runtime.download_cap_mbps", selector: "number", range: { min: 0, max: 100_000 }, default: 0, label: "Download cap", help: "Maximum download speed in Mbps. Zero means no cap.", section: { id: "runtime", order: 30 }, level: "advanced", needs_restart: false },
  { ...stack, key: "stack.runtime.port", selector: "number", range: { min: 1, max: 65535 }, default: 8770, label: "Port", help: "The loopback port the Stack listens on after the next start.", section: { id: "runtime", order: 40 }, level: "expert", needs_restart: true },
  // The chat wire's engine (STACK-93, ENGINE-MLX-01): `auto` is the tier's
  // default (oMLX on Apple silicon at p64 and p128 once it and its model are
  // installed, llama-server everywhere else); a name picks that engine. All are
  // installed side by side; the switch is this setting plus a restart, and
  // rollback is `llama-server`.
  { ...stack, key: "stack.engines.chat.engine", selector: "select", range: { options: [{ value: "auto", label: "Automatic (the best engine this computer can run)" }, { value: "omlx", label: "oMLX (MLX, Apple silicon)" }, { value: "llama-server", label: "llama-server (GGUF, Metal)" }, { value: "mlx-serve", label: "mlx-serve (MLX, Apple silicon)" }] }, default: "auto", label: "Chat engine", help: "Which engine answers the chat roles after the next restart. Automatic uses oMLX on an Apple silicon Mac with 64 GB or more once oMLX and its model are installed, and llama-server otherwise. llama-server runs GGUF models everywhere and is the fallback if oMLX does not start.", section: { id: "engines.chat", order: 5 }, level: "advanced", needs_restart: true },
  { ...stack, key: "stack.engines.llama_server.context_length", selector: "number", range: { min: 0, max: 262_144 }, default: 0, label: "Context length", help: "Zero chooses the largest context that fits this computer and model; enter a positive value to set it explicitly.", section: { id: "engines.llama_server", order: 10 }, level: "advanced", needs_restart: true },
  { ...stack, key: "stack.engines.llama_server.slots", selector: "number", range: { min: 1, max: 16 }, default: 1, label: "Parallel slots", help: "How many requests the engine can serve concurrently.", section: { id: "engines.llama_server", order: 20 }, level: "advanced", needs_restart: true },
  { ...stack, key: "stack.engines.llama_server.threads", selector: "number", range: { min: 0, max: 256 }, default: 0, label: "CPU threads", help: "CPU threads used by the engine. Zero lets the engine choose.", section: { id: "engines.llama_server", order: 30 }, level: "expert", needs_restart: true },
  { ...stack, key: "stack.engines.llama_server.cache_ram_mb", selector: "number", range: { min: 0, max: 1_048_576 }, default: 0, label: "Cache RAM", help: "Optional cache reservation in megabytes.", section: { id: "engines.llama_server", order: 40 }, level: "expert", needs_restart: true },
  { ...stack, key: "stack.engines.llama_server.flash_attention", selector: "boolean", default: true, label: "Flash attention", help: "Use the faster attention implementation when supported.", section: { id: "engines.llama_server", order: 50 }, level: "advanced", needs_restart: true },
  ...GPU_LAYER_ROLES.map(gpuLayersSetting),
  ...urlBinding("chat", 10),
  ...urlBinding("embed", 10),
  ...urlBinding("vision", 10),
  ...urlBinding("stt", 10),
  ...urlBinding("tts", 10),
  // The voice engine (VOICE-STUDIO-01): one setting picks the engine behind
  // the tts role. `auto` is the tier's default (Chatterbox Turbo on 64 GB
  // and up, Pocket TTS below); an engine that is not installed or fails to
  // start falls back to Pocket TTS and says why on the role.
  { ...stack, key: "stack.voice.engine", selector: "select", range: { options: [{ value: "auto", label: "Best for this computer" }, { value: "chatterbox-turbo", label: "Chatterbox Turbo (expressive: laughs, sighs, coughs; needs about 5 GB)" }, { value: "pocket", label: "Pocket TTS (small and fast, no sound effects)" }] }, default: "auto", label: "Voice engine", help: "Which engine speaks after the next restart of the voice engine. Best for this computer picks Chatterbox Turbo where there is room for it and Pocket TTS elsewhere. If the chosen engine is missing or will not start, the voice stays on Pocket TTS.", section: { id: "engines.tts", order: 5 }, level: "basic", needs_restart: true },
  // Secret: encrypted at rest, never returned by the settings route, and
  // used by the Stack's own fetch of the gated cloning weights, never
  // handed to the engine (STACK-94c, 94d).
  { ...stack, key: "stack.engines.tts.hf_token", selector: "text", default: "", label: "Hugging Face token", help: "Lets voice cloning use the gated Pocket TTS weights. Stored encrypted; the Stack never shows it again.", section: { id: "engines.tts", order: 30 }, level: "advanced", needs_restart: true, secret: true },
  // Voice cloning (STACK-94d): with this on and a token set, the Stack
  // fetches the gated cloning weights once, before the engine's next
  // start; the engine itself runs offline always.
  { ...stack, key: "stack.engines.tts.voice_cloning", selector: "boolean", default: false, label: "Voice cloning", help: "Lets the voice engine speak in a voice from a recording (a family member's, a community voice). Needs a Hugging Face token and one download of the cloning weights; presets work without it.", section: { id: "engines.tts", order: 25 }, level: "advanced", needs_restart: true },
];

const byKey = new Map(SETTINGS.map((declaration) => [declaration.key, declaration]));

// The keys as the backend named them before the spec's StackSetting shape
// (58cae15 to the commit that added this). A row stored under one of them
// is renamed once at load so no stored value is orphaned (org: no data
// debt); the old row is deleted after the copy.
const RENAMED_KEYS: Record<string, string> = {
  modelBudgetBytes: "stack.memory.model_budget_bytes", systemLowWaterPct: "stack.memory.low_water_pct", systemLowWaterFloorBytes: "stack.memory.low_water_floor_bytes", systemSustainedPolls: "stack.memory.sustained_polls",
  updatesEnabled: "stack.updates.enabled", huggingFaceEndpoint: "stack.updates.model_host",
  idleUnloadMinutes: "stack.runtime.idle_unload_minutes", idleUnloadOnBatteryMinutes: "stack.runtime.idle_unload_on_battery_minutes", downloadCapMbps: "stack.runtime.download_cap_mbps", port: "stack.runtime.port",
  "engines.llama-server.contextLength": "stack.engines.llama_server.context_length", "engines.llama-server.slots": "stack.engines.llama_server.slots", "engines.llama-server.threads": "stack.engines.llama_server.threads", "engines.llama-server.cacheRamMb": "stack.engines.llama_server.cache_ram_mb", "engines.llama-server.flashAttention": "stack.engines.llama_server.flash_attention",
  ...Object.fromEntries(URL_BINDING_ROLES.flatMap((role) => [[`engines.${role}.hostUrl`, `stack.engines.${role}.host_url`], [`engines.${role}.expectedVersion`, `stack.engines.${role}.expected_version`]])),
};

export function migrateRenamedSettingKeys(): number {
  let moved = 0;
  for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
    for (const [oldState, newState] of [["inEffect", "in_effect"], ["pending", "pending"]] as const) {
      const from = `settings.${oldKey}.${oldState}`;
      const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, from)).get();
      if (!row) continue;
      const to = `settings.${newKey}.${newState}`;
      if (!db.select({ key: meta.key }).from(meta).where(eq(meta.key, to)).get()) db.insert(meta).values({ key: to, value: row.value }).run();
      db.delete(meta).where(eq(meta.key, from)).run();
      moved++;
    }
  }
  return moved;
}
migrateRenamedSettingKeys();

function metaKey(key: string, state: "in_effect" | "pending"): string { return `settings.${key}.${state}`; }
function read(key: string): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value ?? null; }
function write(key: string, value: unknown): void { db.insert(meta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } }).run(); }
/** What goes to disk: a secret's ciphertext, anything else as is. */
function stored(declaration: SettingDeclaration, value: SettingValue): SettingValue { return declaration.secret && typeof value === "string" && value !== "" ? encryptSecret(value) : value; }
/** What a reader outside the launch code sees of a secret: whether it is set. */
export const SECRET_SET = "set";
function redact(declaration: SettingDeclaration, value: SettingValue): SettingValue { return declaration.secret ? (typeof value === "string" && value !== "" ? SECRET_SET : "") : value; }
function clear(key: string): void { db.delete(meta).where(eq(meta.key, key)).run(); }

function decode(value: string | null, declaration: SettingDeclaration): SettingValue {
  if (value === null) return declaration.default as SettingValue;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = value; }
  // A secret is stored encrypted; a blob that no longer decrypts (a
  // changed key) reads as unset rather than as ciphertext.
  if (declaration.secret && typeof parsed === "string" && parsed !== "") { try { parsed = decryptSecret(parsed); } catch { parsed = ""; } }
  return typeof parsed === "number" || typeof parsed === "boolean" || typeof parsed === "string" ? parsed : declaration.default as SettingValue;
}

function valueSchema(declaration: SettingDeclaration): z.ZodTypeAny {
  const range = (declaration.range ?? {}) as { min?: number; max?: number; options?: Array<{ value: string }> };
  if (declaration.selector === "boolean") return z.boolean();
  if (declaration.selector === "number") return z.number().int().min(range.min ?? Number.MIN_SAFE_INTEGER).max(range.max ?? Number.MAX_SAFE_INTEGER);
  if (declaration.selector === "select") return z.string().refine((value) => range.options?.some((option) => option.value === value) ?? false, "Invalid setting option");
  return z.string();
}

/** The declarations with their values. A secret's value is redacted to
 * `set` or empty unless `reveal` is asked for, which only the code that
 * hands the value to an engine's environment does. */
export function readSettings(options: { reveal?: boolean } = {}): StackSetting[] {
  return SETTINGS.map((declaration) => {
    const pending = read(metaKey(declaration.key, "pending"));
    const inEffect = decode(read(metaKey(declaration.key, "in_effect")), declaration);
    const pendingValue = pending === null ? null : decode(pending, declaration);
    return StackSetting.parse({ ...declaration, in_effect: options.reveal ? inEffect : redact(declaration, inEffect), pending: pendingValue === null ? null : options.reveal ? pendingValue : redact(declaration, pendingValue) });
  });
}

export function settingValues(): Record<string, SettingValue> {
  return Object.fromEntries(readSettings({ reveal: true }).map((setting) => [setting.key, setting.in_effect as SettingValue]));
}

/** The values a spawned engine's launch reads: every key under its
 * section, with the prefix stripped (`context_length`, not
 * `stack.engines.llama_server.context_length`). */
export function engineSettingValues(section: string): Record<string, SettingValue> {
  const prefix = `stack.${section}.`;
  return Object.fromEntries(readSettings({ reveal: true }).filter((setting) => setting.key.startsWith(prefix)).map((setting) => [setting.key.slice(prefix.length), setting.in_effect as SettingValue]));
}

/** A chat engine with no pinned build for this machine cannot be chosen:
 * the value would apply at the restart and leave every chat-wire role
 * with no engine until someone flipped it back. */
function refuseUnservable(key: string, value: SettingValue): void {
  if (key !== "stack.engines.chat.engine") return;
  const declaration = byKey.get(key)!;
  // A value already in effect (a client writing every setting back, the
  // default on a machine with no chat pin at all) is not a change to refuse.
  if (value === decode(read(metaKey(key, "in_effect")), declaration)) return;
  // `auto` always resolves to an engine that can run; oMLX is a managed
  // environment (no archive pin), served on Apple silicon only.
  if (value === "auto") return;
  const servable = value === "omlx" ? process.platform === "darwin" && process.arch === "arm64" : ENGINE_BINARIES.some((pin) => pin.name === value && pin.platform === process.platform && pin.arch === process.arch);
  if (!servable) throw new Error(`${value} has no pinned build for ${process.platform} ${process.arch}; the chat engine stays as it is.`);
}
export function updateSettings(values: Record<string, unknown>): StackSetting[] {
  for (const key of Object.keys(values)) if (!byKey.has(key)) throw new Error(`Unknown Stack setting: ${key}`);
  // Every value is validated before any is written, so a bad second key
  // never leaves the first one half-applied.
  const validated = Object.entries(values).map(([key, raw]) => { const declaration = byKey.get(key)!; const value = valueSchema(declaration).parse(raw) as SettingValue; refuseUnservable(key, value); return { key, declaration, value }; });
  const changed: string[] = [];
  for (const { key, declaration, value } of validated) {
    // A client that reads the settings and writes them all back sends a
    // secret as its redaction, for the in-effect and the pending value
    // alike; that is "unchanged" and touches neither row.
    if (declaration.secret && value === SECRET_SET) continue;
    const inEffect = decode(read(metaKey(key, "in_effect")), declaration);
    if (declaration.needs_restart) {
      // Pending only: nothing running changed yet; applyPendingSettings bumps.
      if (value === inEffect) clear(metaKey(key, "pending"));
      else write(metaKey(key, "pending"), stored(declaration, value));
    } else if (value !== inEffect) { write(metaKey(key, "in_effect"), stored(declaration, value)); changed.push(key); }
  }
  if (changed.length > 0) bumpStackGeneration(`settings changed: ${changed.join(", ")}`);
  applySettingsToRuntime();
  return readSettings();
}

/** Promotes every pending value; called at start (after the service
 * manager restarted the process) and by `POST /stack/v1/settings/apply`. */
export function applyPendingSettings(): StackSetting[] {
  let applied = 0;
  for (const declaration of SETTINGS) {
    const pending = read(metaKey(declaration.key, "pending"));
    if (pending === null) continue;
    // The pending row is already in its stored form; it moves as is.
    write(metaKey(declaration.key, "in_effect"), JSON.parse(pending) as SettingValue);
    clear(metaKey(declaration.key, "pending"));
    applied++;
  }
  if (applied > 0) bumpStackGeneration(`${applied} pending setting(s) applied`);
  applySettingsToRuntime();
  return readSettings();
}

/** Pushes the live-applied values into the modules that consume them,
 * so neither the governor nor the downloader reads configuration itself. */
export function applySettingsToRuntime(): void {
  const values = settingValues();
  setGovernorMemorySettings({
    modelBudgetBytes: Number(values["stack.memory.model_budget_bytes"]),
    systemLowWaterPct: Number(values["stack.memory.low_water_pct"]) / 100,
    systemLowWaterFloorBytes: Number(values["stack.memory.low_water_floor_bytes"]),
    systemSustainedPolls: Number(values["stack.memory.sustained_polls"]),
  });
  setDownloadCapMbps(Number(values["stack.runtime.download_cap_mbps"]));
}

export function __resetSettingsForTests(): void {
  db.delete(meta).where(like(meta.key, "settings.%")).run();
  applySettingsToRuntime();
}
