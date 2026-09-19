import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";

export type EngineKind = "llama-server" | "managed";
export type EngineSettingType = "number" | "boolean" | "text" | "enum";
export type Disclosure = "basic" | "advanced" | "developer";
export interface SettingOption { value: string; label: string; }

export interface EngineSettingDeclaration {
  key: string;
  type: EngineSettingType;
  default: number | boolean | string;
  group?: string;
  options?: SettingOption[];
  label: string;
  help: string;
  disclosure: Disclosure;
  needsRestart: boolean;
  range?: { min?: number; max?: number };
  section?: string;
  order?: number;
}

export const ENGINE_SETTINGS: Record<EngineKind, EngineSettingDeclaration[]> = {
  "llama-server": [
    { key: "contextLength", type: "number", default: 4096, label: "Context length", help: "How much conversation the engine can hold at once.", group: "Memory and context", disclosure: "advanced", needsRestart: true, range: { min: 128, max: 131072 } },
    { key: "slots", type: "number", default: 1, label: "Parallel slots", help: "How many requests the engine can serve concurrently.", group: "Performance", disclosure: "advanced", needsRestart: true, range: { min: 1, max: 128 } },
    { key: "threads", type: "number", default: 0, label: "CPU threads", help: "CPU threads used by the engine. Zero lets the engine choose.", group: "Host", disclosure: "developer", needsRestart: true, range: { min: 0, max: 256 } },
    { key: "cacheRamMb", type: "number", default: 0, label: "Cache RAM", help: "Optional cache reservation in megabytes.", group: "Memory and context", disclosure: "developer", needsRestart: true, range: { min: 0, max: 1_048_576 } },
    { key: "flashAttention", type: "boolean", default: true, label: "Flash attention", help: "Use the faster attention implementation when supported.", group: "Performance", disclosure: "advanced", needsRestart: true },
  ],
  managed: [
    { key: "hostUrl", type: "text", default: "", label: "Host URL", help: "The local or remote managed engine endpoint.", group: "Host", disclosure: "basic", needsRestart: true },
    { key: "expectedVersion", type: "text", default: "", label: "Expected version", help: "Optional build string used when checking a managed host.", group: "Host", disclosure: "advanced", needsRestart: true },
  ],
};

const valueSchema = (declaration: EngineSettingDeclaration): z.ZodTypeAny => {
  if (declaration.type === "boolean") return z.boolean();
  if (declaration.type === "text") return z.string();
  if (declaration.type === "enum") return z.string().refine((value) => declaration.options?.some((option) => option.value === value) ?? false, "Invalid setting option");
  return z.number().int().min(declaration.range?.min ?? Number.MIN_SAFE_INTEGER).max(declaration.range?.max ?? Number.MAX_SAFE_INTEGER);
};

function metaKey(name: string, key: string, state: "pending" | "inEffect"): string { return `engines.${name}.config.${state}.${key}`; }
function read(key: string): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value ?? null; }
function write(key: string, value: unknown): void { db.insert(meta).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } }).run(); }
function decode(value: string | null, declaration: EngineSettingDeclaration): unknown { if (value === null) return declaration.default; try { return JSON.parse(value); } catch { return declaration.default; } }

export interface EngineSettingValue extends EngineSettingDeclaration { inEffect: number | boolean | string | string[]; pending: number | boolean | string | string[] | null; }

export function declarationsFor(name: string, kind: EngineKind = name === "llama-server" ? "llama-server" : "managed"): EngineSettingDeclaration[] {
  return ENGINE_SETTINGS[kind].map((entry) => ({ ...entry, key: entry.key }));
}

export function readEngineConfig(name: string, kind?: EngineKind): EngineSettingValue[] {
  return declarationsFor(name, kind).map((declaration) => ({
    ...declaration,
    inEffect: decode(read(metaKey(name, declaration.key, "inEffect")), declaration) as EngineSettingValue["inEffect"],
    pending: read(metaKey(name, declaration.key, "pending")) === null ? null : decode(read(metaKey(name, declaration.key, "pending")), declaration) as EngineSettingValue["pending"],
  }));
}

export function validateEngineConfig(name: string, values: Record<string, unknown>, kind?: EngineKind): Record<string, unknown> {
  const declarations = declarationsFor(name, kind);
  const allowed = new Set(declarations.map((declaration) => declaration.key));
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`Unknown engine setting: ${key}`);
  const validated: Record<string, unknown> = {};
  for (const declaration of declarations) if (keyPresent(values, declaration.key)) validated[declaration.key] = valueSchema(declaration).parse(values[declaration.key]);
  return validated;
}

function keyPresent(values: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(values, key); }

export function updateEngineConfig(name: string, values: Record<string, unknown>, kind?: EngineKind): EngineSettingValue[] {
  const declarations = declarationsFor(name, kind);
  const validated = validateEngineConfig(name, values, kind);
  for (const declaration of declarations) if (keyPresent(validated, declaration.key)) {
    if (declaration.needsRestart) write(metaKey(name, declaration.key, "pending"), validated[declaration.key]);
    else write(metaKey(name, declaration.key, "inEffect"), validated[declaration.key]);
  }
  return readEngineConfig(name, kind);
}

export function activateEngineConfig(name: string, kind?: EngineKind): EngineSettingValue[] {
  const declarations = declarationsFor(name, kind);
  for (const declaration of declarations) {
    const pending = read(metaKey(name, declaration.key, "pending"));
    if (pending !== null) {
      write(metaKey(name, declaration.key, "inEffect"), decode(pending, declaration));
      db.delete(meta).where(eq(meta.key, metaKey(name, declaration.key, "pending"))).run();
    }
  }
  return readEngineConfig(name, kind);
}

export function settingValues(name: string, kind?: EngineKind): Record<string, number | boolean | string | string[]> {
  return Object.fromEntries(readEngineConfig(name, kind).map((entry) => [entry.key, entry.inEffect]));
}

export function __resetEngineSettingsForTests(): void {
  db.delete(meta).where(like(meta.key, "engines.%")).run();
}
