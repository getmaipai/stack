import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { hasOperator } from "@/lib/operator";
import { setUpdatesEnabled, updatesEnabled } from "@/updates/check";
import { defaultModelBudgetBytes, setGovernorMemorySettings } from "@/lib/governor";
import type { EngineSettingDeclaration, EngineSettingValue } from "@/settings/engineKeys";

export type StackSectionId = "general" | "memory" | "updates" | "backups" | "network" | "channels" | "alerts" | "storage" | "maintenance" | "engines" | "hardware" | "diagnostics" | "reset";
export interface StackSection { id: StackSectionId; title: string; icon: string; order: number; itemId?: string; computer?: boolean; }
export interface StackSettingDeclaration extends EngineSettingDeclaration { section: StackSectionId; order: number; }

export const STACK_SETTING_SECTIONS: StackSection[] = [
  { id: "general", title: "General", icon: "Settings", order: 10 },
  { id: "memory", title: "Memory", icon: "Gauge", order: 15 },
  { id: "updates", title: "Updates", icon: "RefreshCw", order: 20 },
  { id: "backups", title: "Backups", icon: "UploadCloud", order: 30, itemId: "STACK-11" },
  { id: "network", title: "Network and access", icon: "ShieldCheck", order: 40 },
  { id: "channels", title: "Alert channels", icon: "Bell", order: 50 },
  { id: "alerts", title: "Alerts", icon: "BellRing", order: 55 },
  { id: "storage", title: "Storage", icon: "Database", order: 60 },
  { id: "maintenance", title: "Maintenance", icon: "Wrench", order: 70, itemId: "STACK-22" },
  { id: "engines", title: "Engines", icon: "Cpu", order: 80 },
  { id: "hardware", title: "Hardware", icon: "Monitor", order: 90, computer: true },
  { id: "diagnostics", title: "Diagnostics", icon: "FileText", order: 100, computer: true },
  { id: "reset", title: "Reset", icon: "RotateCcw", order: 110, computer: true },
];

export const STACK_SETTINGS: StackSettingDeclaration[] = [
  { key: "modelBudgetBytes", type: "number", default: defaultModelBudgetBytes(), label: "Memory for models", help: "The maximum memory the Stack may use for loaded models. The rest stays available for your Mac.", group: "Model budget", disclosure: "basic", needsRestart: false, range: { min: 0, max: defaultModelBudgetBytes() + 8 * 1_073_741_824 }, section: "memory", order: 10 },
  { key: "systemLowWaterPct", type: "number", default: 10, label: "Low memory percentage", help: "Warn when available memory falls below this percentage.", group: "Pressure watermarks", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 99 }, section: "memory", order: 20 },
  { key: "systemLowWaterFloorBytes", type: "number", default: 1_073_741_824, label: "Low memory floor", help: "Warn when available memory falls below this many bytes.", group: "Pressure watermarks", disclosure: "advanced", needsRestart: false, range: { min: 0, max: defaultModelBudgetBytes() }, section: "memory", order: 30 },
  { key: "systemSustainedPolls", type: "number", default: 2, label: "Pressure confirmation polls", help: "How many low readings confirm memory pressure.", group: "Pressure watermarks", disclosure: "advanced", needsRestart: false, range: { min: 1, max: 10 }, section: "memory", order: 40 },
  { key: "stackName", type: "text", default: "MaiPai Stack", label: "Name of this Stack", help: "The name shown in the Stack header and to local clients.", group: "Identity", disclosure: "basic", needsRestart: false, section: "general", order: 10 },
  { key: "theme", type: "enum", default: "system", label: "Theme", help: "Choose light, dark, or follow this computer.", group: "Appearance", disclosure: "basic", needsRestart: false, options: [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], section: "general", order: 20 },
  { key: "updatesEnabled", type: "boolean", default: false, label: "Check for updates", help: "Allow the Stack to check its release manifests when you ask it to.", group: "Update checks", disclosure: "basic", needsRestart: false, section: "updates", order: 10 },
  { key: "alertModel", type: "boolean", default: true, label: "Tell me when a model finishes installing", help: "Show a native notification when a model is ready.", group: "Notifications", disclosure: "basic", needsRestart: false, section: "alerts", order: 10 },
  { key: "alertUpdate", type: "boolean", default: true, label: "Tell me when an update is ready", help: "Show a native notification for an update.", group: "Notifications", disclosure: "basic", needsRestart: false, section: "alerts", order: 20 },
  { key: "alertCheck", type: "boolean", default: true, label: "Tell me when a check fails", help: "Show a native notification when a check needs attention.", group: "Notifications", disclosure: "basic", needsRestart: false, section: "alerts", order: 30 },
  { key: "alertHealth", type: "boolean", default: true, label: "Tell me when something needs attention", help: "Show a native notification for important health changes.", group: "Notifications", disclosure: "basic", needsRestart: false, section: "alerts", order: 40 },
  { key: "alertRunState", type: "boolean", default: false, label: "Tell me when the Stack is paused or resumed", help: "Show notifications when another app changes run state.", group: "Notifications", disclosure: "basic", needsRestart: false, section: "alerts", order: 50 },
  { key: "lanAccess", type: "boolean", default: false, label: "LAN access", help: "Expose the Stack beyond this computer. A restart is required and operator sign-in remains required.", group: "Access", disclosure: "basic", needsRestart: true, section: "network", order: 10 },
  { key: "port", type: "number", default: 8787, label: "Stack port", help: "The local port used by the Stack after restart.", group: "Access", disclosure: "basic", needsRestart: true, range: { min: 1, max: 65535 }, section: "network", order: 20 },
  { key: "historyRetention", type: "number", default: 30, label: "History retention", help: "Days of local event history to retain.", group: "Storage", disclosure: "basic", needsRestart: false, range: { min: 1, max: 3650 }, section: "storage", order: 10 },
  { key: "maintenanceStart", type: "text", default: "02:00", label: "Maintenance starts", help: "Local time when quiet maintenance may begin.", group: "Maintenance window", disclosure: "basic", needsRestart: false, section: "maintenance", order: 10 },
  { key: "maintenanceEnd", type: "text", default: "05:00", label: "Maintenance ends", help: "Local time when quiet maintenance stops.", group: "Maintenance window", disclosure: "basic", needsRestart: false, section: "maintenance", order: 20 },
  { key: "downloadCapMbps", type: "number", default: 0, label: "Download cap", help: "Maximum download speed in Mbps. Zero means no cap.", group: "Maintenance window", disclosure: "basic", needsRestart: false, range: { min: 0, max: 10000 }, section: "maintenance", order: 30 },
  { key: "logLevel", type: "enum", default: "info", label: "Log level", help: "How much diagnostic detail to keep in local logs.", group: "Diagnostics", disclosure: "basic", needsRestart: false, options: [{ value: "error", label: "Errors" }, { value: "warn", label: "Warnings" }, { value: "info", label: "Info" }, { value: "debug", label: "Debug" }], section: "diagnostics", order: 10 },
  { key: "huggingFaceEndpoint", type: "text", default: "https://huggingface.co", label: "Hugging Face endpoint", help: "Where Hugging Face model downloads come from. Point it at a mirror you run or trust to keep model traffic off the public internet.", group: "Storage", disclosure: "advanced", needsRestart: false, section: "storage", order: 20 },
];

function metaKey(key: string, state: "inEffect" | "pending"): string { return `settings.stack.${key}.${state}`; }
function read(key: string): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value ?? null; }
function write(key: string, value: unknown): void { db.insert(meta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } }).run(); }
function clear(key: string): void { db.delete(meta).where(eq(meta.key, key)).run(); }
function decode(value: string | null, declaration: EngineSettingDeclaration): number | boolean | string { if (value === null) return declaration.default; try { return JSON.parse(value) as number | boolean | string; } catch { return declaration.default; } }
function valueSchema(declaration: EngineSettingDeclaration): z.ZodTypeAny {
  if (declaration.type === "boolean") return z.boolean();
  if (declaration.type === "number") return z.number().int().min(declaration.range?.min ?? Number.MIN_SAFE_INTEGER).max(declaration.range?.max ?? Number.MAX_SAFE_INTEGER);
  if (declaration.type === "enum") return z.string().refine((value) => declaration.options?.some((option) => option.value === value) ?? false, "Invalid setting option");
  return z.string();
}

function inEffect(declaration: EngineSettingDeclaration): number | boolean | string {
  if (declaration.key === "updatesEnabled") return updatesEnabled();
  return decode(read(metaKey(declaration.key, "inEffect")), declaration);
}

export function readStackConfig(): EngineSettingValue[] {
  return STACK_SETTINGS.map((declaration) => ({ ...declaration, inEffect: inEffect(declaration), pending: read(metaKey(declaration.key, "pending")) === null ? null : decode(read(metaKey(declaration.key, "pending")), declaration) }));
}

export function updateStackConfig(values: Record<string, unknown>): EngineSettingValue[] {
  const allowed = new Set(STACK_SETTINGS.map((declaration) => declaration.key));
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`Unknown Stack setting: ${key}`);
  for (const declaration of STACK_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(values, declaration.key)) continue;
    const value = valueSchema(declaration).parse(values[declaration.key]);
    if (declaration.key === "updatesEnabled") setUpdatesEnabled(value as boolean);
    else if (declaration.needsRestart) {
      if (declaration.key === "lanAccess" && value === true && !hasOperator()) throw new Error("Set the operator password before opening the Stack to the LAN.");
      if (value === inEffect(declaration)) clear(metaKey(declaration.key, "pending"));
      else write(metaKey(declaration.key, "pending"), value);
    } else write(metaKey(declaration.key, "inEffect"), value);
  }
  const settings = readStackConfig();
  setGovernorMemorySettings(Object.fromEntries(settings.filter((setting) => ["modelBudgetBytes", "systemLowWaterPct", "systemLowWaterFloorBytes", "systemSustainedPolls"].includes(setting.key)).map((setting) => [setting.key, setting.key === "systemLowWaterPct" ? Number(setting.inEffect) / 100 : Number(setting.inEffect)])));
  return settings;
}

export function activateStackConfig(): void {
  for (const declaration of STACK_SETTINGS) {
    const pending = read(metaKey(declaration.key, "pending"));
    if (pending === null) continue;
    write(metaKey(declaration.key, "inEffect"), decode(pending, declaration));
    clear(metaKey(declaration.key, "pending"));
  }
}

export function stackSettingValues(): Record<string, number | boolean | string> {
  return Object.fromEntries(readStackConfig().map((setting) => [setting.key, setting.inEffect]));
}

export function __resetStackSettingsForTests(): void {
  for (const declaration of STACK_SETTINGS) { clear(metaKey(declaration.key, "inEffect")); clear(metaKey(declaration.key, "pending")); }
  setGovernorMemorySettings({ modelBudgetBytes: defaultModelBudgetBytes(), systemLowWaterPct: 0.1, systemLowWaterFloorBytes: 1_073_741_824, systemSustainedPolls: 2 });
}
