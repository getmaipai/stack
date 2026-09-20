import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { emit } from "@/lib/events";
import { MANIFEST_URLS, UpdateManifestSchema, type UpdateClass } from "@/updates/manifests";

const version = "0.1.0";
function key(kind: UpdateClass, suffix: string): string { return `updates.${kind}.${suffix}`; }
function read(kind: UpdateClass, suffix: string): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key(kind, suffix))).get()?.value ?? null; }
function write(kind: UpdateClass, suffix: string, value: string): void { db.insert(meta).values({ key: key(kind, suffix), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run(); }
function readEngineTarget(suffix: string): string | null { return read("engines", `target.${suffix}`); }
export function updatesEnabled(): boolean { return read("app", "enabled") === "true"; }
export function setUpdatesEnabled(enabled: boolean): void { write("app", "enabled", String(enabled)); }
export interface UpdateState { installed: string; available: string | null; notes: string | null; size: number | null; lastChecked: string | null; checksEnabled: boolean; skipped: boolean; }
export function state(kind: UpdateClass): UpdateState { return { installed: read(kind, "installed") ?? version, available: read(kind, "available"), notes: read(kind, "notes"), size: read(kind, "size") ? Number(read(kind, "size")) : null, lastChecked: read(kind, "checked"), checksEnabled: updatesEnabled(), skipped: read(kind, "skipped") === "true" }; }
export type UpdateFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export function conditionalHeaders(etag: string | null): Record<string, string> { return { "if-none-match": etag ?? "", "user-agent": `maipai-stack/${version} (${process.platform}-${process.arch})` }; }
export async function check(kind: UpdateClass, fetcher: UpdateFetcher = fetch): Promise<UpdateState> {
  if (!updatesEnabled()) return state(kind);
  const previouslyAvailable = read(kind, "available");
  const headers = conditionalHeaders(read(kind, "etag"));
  const response = await fetcher(MANIFEST_URLS[kind], { headers });
  if (response.status === 304) { write(kind, "checked", new Date().toISOString()); return state(kind); }
  if (!response.ok) throw new Error(`Update check returned ${response.status}`);
  const manifest = UpdateManifestSchema.parse(await response.json());
  const target = manifest.platforms[`${process.platform}-${process.arch}`] ?? manifest.platforms.default;
  write(kind, "available", manifest.version); write(kind, "notes", manifest.notes); write(kind, "checked", new Date().toISOString()); if (target) { write(kind, "size", String(target.size)); if (kind === "engines") { write(kind, "target.url", target.url); write(kind, "target.sha256", target.sha256); write(kind, "target.size", String(target.size)); } }
  const etag = response.headers.get("etag"); if (etag) write(kind, "etag", etag);
  // Only a genuinely new update: not the same version already announced
  // by an earlier check, so a nightly re-check of a known-available
  // update doesn't renotify every time. There is no reliable "installed"
  // value to compare against here (updates.<kind>.installed is never
  // written by anything today), so the first check ever always
  // announces whatever the manifest reports, same as opening the
  // Updates page for the first time would.
  if (manifest.version !== previouslyAvailable) {
    emit({ id: "update.available", data: { kind, version: manifest.version } });
  }
  return state(kind);
}
export function skip(kind: UpdateClass, skipped = true): void { write(kind, "skipped", String(skipped)); }
export interface EngineUpdateTarget { version: string; url: string; sha256: string; size: number; }
export function pendingEngineUpdate(): EngineUpdateTarget | null {
  const version = state("engines").available; const url = readEngineTarget("url"); const sha256 = readEngineTarget("sha256"); const size = readEngineTarget("size");
  return version && url && sha256 && size ? { version, url, sha256, size: Number(size) } : null;
}
