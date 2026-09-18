import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { hasOperator } from "@/lib/operator";
import { setUpdatesEnabled, updatesEnabled } from "@/updates/check";
import type { EngineSettingDeclaration, EngineSettingValue } from "@/settings/engineKeys";

export type StackSectionId = "general" | "updates" | "backups" | "network" | "channels" | "storage" | "maintenance" | "engines" | "hardware" | "diagnostics" | "reset";
export interface StackSection { id: StackSectionId; title: string; icon: string; order: number; itemId?: string; computer?: boolean; }
export interface StackSettingDeclaration extends EngineSettingDeclaration { section: StackSectionId; order: number; }

export const STACK_SETTING_SECTIONS: StackSection[] = [
  { id: "general", title: "General", icon: "Settings", order: 10 },
  { id: "updates", title: "Updates", icon: "RefreshCw", order: 20 },
  { id: "backups", title: "Backups", icon: "UploadCloud", order: 30, itemId: "STACK-11" },
  { id: "network", title: "Network and access", icon: "ShieldCheck", order: 40 },
  { id: "channels", title: "Alert channels", icon: "Bell", order: 50 },
  { id: "storage", title: "Storage", icon: "Database", order: 60 },
  { id: "maintenance", title: "Maintenance", icon: "Wrench", order: 70, itemId: "STACK-22" },
  { id: "engines", title: "Engines", icon: "Cpu", order: 80 },
  { id: "hardware", title: "Hardware", icon: "Monitor", order: 90, computer: true },
  { id: "diagnostics", title: "Diagnostics", icon: "FileText", order: 100, computer: true },
  { id: "reset", title: "Reset", icon: "RotateCcw", order: 110, computer: true },
];

export const STACK_SETTINGS: StackSettingDeclaration[] = [
  { key: "stackName", type: "text", default: "MaiPai Stack", label: "Name of this Stack", help: "The name shown in the Stack header and to local clients.", group: "Identity", disclosure: "basic", needsRestart: false, section: "general", order: 10 },
  { key: "theme", type: "enum", default: "system", label: "Theme", help: "Choose light, dark, or follow this computer.", group: "Appearance", disclosure: "basic", needsRestart: false, options: [{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], section: "general", order: 20 },
  { key: "updatesEnabled", type: "boolean", default: false, label: "Check for updates", help: "Allow the Stack to check its release manifests when you ask it to.", group: "Update checks", disclosure: "basic", needsRestart: false, section: "updates", order: 10 },
  { key: "lanAccess", type: "boolean", default: false, label: "LAN access", help: "Expose the Stack beyond this computer. A restart is required and operator sign-in remains required.", group: "Access", disclosure: "basic", needsRestart: true, section: "network", order: 10 },
  { key: "port", type: "number", default: 8787, label: "Stack port", help: "The local port used by the Stack after restart.", group: "Access", disclosure: "basic", needsRestart: true, range: { min: 1, max: 65535 }, section: "network", order: 20 },
  { key: "historyRetention", type: "number", default: 30, label: "History retention", help: "Days of local event history to retain.", group: "Storage", disclosure: "basic", needsRestart: false, range: { min: 1, max: 3650 }, section: "storage", order: 10 },
  { key: "logLevel", type: "enum", default: "info", label: "Log level", help: "How much diagnostic detail to keep in local logs.", group: "Diagnostics", disclosure: "basic", needsRestart: false, options: [{ value: "error", label: "Errors" }, { value: "warn", label: "Warnings" }, { value: "info", label: "Info" }, { value: "debug", label: "Debug" }], section: "diagnostics", order: 10 },
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
  return readStackConfig();
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
}
