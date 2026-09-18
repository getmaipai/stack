import { and, eq, lt } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { detected } from "@/db/schema";
import { emit } from "@/lib/events";
import { raise } from "@/lib/health";
import { readEngineIdentity } from "@/lib/identity";
import { engineRoot, externalImportRoots } from "@/lib/store/layout";
import { importCandidate, scanImports } from "@/lib/store/importScan";
import { upsertModel } from "@/lib/modelStore";
import { ROLE_IDS, type RoleId } from "@/roles";
import { DETECTED_ENGINE_VERSION_FLOORS } from "@/lib/engineCatalog";

export const DETECTION_ADDRESSES = ["127.0.0.1", "::1"] as const;
export const DETECTION_PORTS = { ollama: 11434, "lm-studio": 1234, comfyui: 8188, "mlx-serve": 8080, omlx: 8000 } as const;
export const DETECTION_VERSION_FLOORS = DETECTED_ENGINE_VERSION_FLOORS;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type DetectedKind = "ollama" | "lm-studio" | "comfyui" | "mlx-serve" | "omlx" | "llama-server" | "folder";
export interface DetectedRecord { id: string; kind: DetectedKind; name: string; version: string; where: string; couldHold: RoleId[]; firstSeen: string; lastSeen: string; forgotten: boolean; adopted: boolean; target: string | null; }
interface Probe { kind: DetectedKind; name: string; version: string; where: string; couldHold: RoleId[]; }
const managedBindings = new Map<string, string>();
const LAST_SCAN_KEY = "detected.lastScan";

function json<T>(value: string, fallback: T): T { try { return JSON.parse(value) as T; } catch { return fallback; } }
function urlFor(address: string, port: number): string { return `http://${address.includes(":") ? `[${address}]` : address}:${port}`; }
function versionOf(value: unknown): string { return typeof value === "string" && value.trim() ? value.trim() : "detected"; }
function roles(value: string[]): RoleId[] { return value.filter((item): item is RoleId => ROLE_IDS.includes(item as RoleId)); }
function responseVersion(body: Record<string, unknown>, fallback = "detected"): string { return versionOf(body.version ?? body.build_info ?? body.build ?? fallback); }
async function getJson(fetcher: Fetcher, url: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(2_000) });
  const body = await response.json().catch(() => ({}));
  return { response, body: typeof body === "object" && body !== null ? body as Record<string, unknown> : {} };
}

async function probeAt(kind: Exclude<DetectedKind, "folder">, address: string, fetcher: Fetcher): Promise<Probe | null> {
  const port = kind === "llama-server" ? 8080 : DETECTION_PORTS[kind as keyof typeof DETECTION_PORTS];
  const where = urlFor(address, port);
  try {
    if (kind === "ollama") { const result = await getJson(fetcher, `${where}/api/version`); if (!result.response.ok) return null; return { kind, name: "Ollama", version: responseVersion(result.body), where, couldHold: ["chat", "embed"] }; }
    if (kind === "comfyui") { const result = await getJson(fetcher, `${where}/system_stats`); if (!result.response.ok) return null; return { kind, name: "ComfyUI", version: responseVersion(result.body), where, couldHold: ["image", "video"] }; }
    if (kind === "llama-server") { const identity = await readEngineIdentity(where, 2_000); if (!identity.healthy) return null; return { kind, name: "llama-server", version: identity.build ?? "detected", where, couldHold: ["chat", "coding", "judge", "router"] }; }
    const result = await getJson(fetcher, `${where}/v1/models`); if (!result.response.ok) return null;
    const label = kind === "lm-studio" ? "LM Studio" : kind === "mlx-serve" ? "mlx-serve" : "oMLX";
    const data = Array.isArray(result.body.data) ? result.body.data : [];
    const version = responseVersion(result.body, data.length ? "detected" : "detected");
    return { kind, name: label, version, where, couldHold: ["chat", "coding", "embed", "vision"] };
  } catch { return null; }
}

function folderProbes(): Probe[] {
  const roots = externalImportRoots();
  const definitions: Array<["ollama" | "mlx-serve" | "omlx" | "lm-studio", RoleId[]]> = [["ollama", ["chat", "embed"]], ["mlx-serve", ["chat", "image", "video"]], ["omlx", ["chat", "image"]], ["lm-studio", ["chat", "embed"]]];
  return definitions.filter(([source]) => roots[source] && existsSync(roots[source]!)).map(([source, couldHold]) => ({ kind: "folder" as const, name: `${source} model folder`, version: "local store", where: roots[source]!, couldHold }));
}

function toRecord(row: typeof detected.$inferSelect): DetectedRecord {
  return { id: row.id, kind: row.kind as DetectedKind, name: row.name, version: row.version, where: row.where, couldHold: json<RoleId[]>(row.couldHold, []), firstSeen: row.firstSeen, lastSeen: row.lastSeen, forgotten: row.forgotten === 1, adopted: row.adopted === 1, target: row.target };
}

function upsertProbe(probe: Probe, now: string): void {
  const id = `${probe.kind}:${probe.where}`;
  const existing = db.select().from(detected).where(eq(detected.id, id)).get();
  const changedVersion = existing && existing.version !== probe.version;
  db.insert(detected).values({ id, kind: probe.kind, name: probe.name, version: probe.version, where: probe.where, couldHold: JSON.stringify(probe.couldHold), firstSeen: existing?.firstSeen ?? now, lastSeen: now, forgotten: changedVersion ? 0 : existing?.forgotten ?? 0, adopted: existing?.adopted ?? 0, target: existing?.target ?? null }).onConflictDoUpdate({ target: detected.id, set: { kind: probe.kind, name: probe.name, version: probe.version, where: probe.where, couldHold: JSON.stringify(probe.couldHold), lastSeen: now, forgotten: changedVersion ? 0 : existing?.forgotten ?? 0 } }).run();
}

export function listDetected(includeForgotten = false): DetectedRecord[] {
  const rows = db.select().from(detected).all(); return (includeForgotten ? rows : rows.filter((row) => row.forgotten === 0)).map(toRecord);
}

export function lastScan(): string | null { return db.select({ value: meta.value }).from(meta).where(eq(meta.key, LAST_SCAN_KEY)).get()?.value ?? null; }
function recordScan(at: string): void { db.insert(meta).values({ key: LAST_SCAN_KEY, value: at }).onConflictDoUpdate({ target: meta.key, set: { value: at } }).run(); }
export function scanCounts(rows: DetectedRecord[] = listDetected()): { tools: number; modelFiles: number } {
  let installedTools = 0;
  try { installedTools = readdirSync(engineRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length; } catch { /* no installed engine directory yet */ }
  const modelFiles = scanImports().length;
  return { tools: rows.filter((row) => row.kind !== "folder").length + installedTools, modelFiles };
}

export async function detectAll(fetcher: Fetcher = fetch): Promise<DetectedRecord[]> {
  const probes: Probe[] = [];
  for (const address of DETECTION_ADDRESSES) for (const kind of ["ollama", "lm-studio", "comfyui", "mlx-serve", "omlx", "llama-server"] as const) { const probe = await probeAt(kind, address, fetcher); if (probe) probes.push(probe); }
  probes.push(...folderProbes());
  const now = new Date().toISOString(); for (const probe of probes) upsertProbe(probe, now);
  recordScan(now);
  db.delete(detected).where(lt(detected.lastSeen, new Date(Date.now() - RETENTION_MS).toISOString())).run();
  if (probes.length) emit({ id: "detected.changed", data: { count: probes.length } });
  return listDetected();
}

function numericVersion(value: string): number[] { return (value.match(/\d+/g) ?? []).map(Number); }
export function belowTestedVersion(kind: string, version: string): boolean { const actual = numericVersion(version); const floor = numericVersion(DETECTION_VERSION_FLOORS[kind] ?? "0"); for (let index = 0; index < Math.max(actual.length, floor.length); index++) { if ((actual[index] ?? 0) !== (floor[index] ?? 0)) return (actual[index] ?? 0) < (floor[index] ?? 0); } return false; }

async function reProbe(row: DetectedRecord): Promise<Probe | null> { if (row.kind === "folder") return { kind: "folder", name: row.name, version: row.version, where: row.where, couldHold: row.couldHold }; return probeAt(row.kind, new URL(row.where).hostname.replace(/^\[|\]$/g, ""), fetch); }

export function getManagedEngineUrl(role: string): string | null {
  const remembered = managedBindings.get(role); if (remembered) return remembered;
  const row = db.select().from(detected).where(and(eq(detected.adopted, 1), eq(detected.forgotten, 0))).all().find((item) => item.kind !== "folder" && json<string[]>(item.couldHold, []).includes(role));
  return row?.where ?? null;
}

export async function adoptDetected(id: string, selectedRoles: string[]): Promise<{ id: string; target: string; roles: RoleId[] }> {
  const row = listDetected(true).find((item) => item.id === id); if (!row) throw new Error("Unknown detected item.");
  const chosen = roles(selectedRoles); if (!chosen.length) throw new Error("Choose at least one role before adopting.");
  const probe = await reProbe(row); if (!probe) throw new Error("The detected host is no longer responding. Scan again.");
  if (probe.kind !== "folder" && belowTestedVersion(probe.kind, probe.version)) raise({ code: "host.belowTestedVersion", severity: "warning", title: `${probe.name} is below the tested version`, text: `${probe.name} ${probe.version} was detected below the tested floor ${DETECTION_VERSION_FLOORS[probe.kind]}.`, cause: "The detected host has not passed the Stack's tested version floor.", fix: { label: "Update the host", action: "update_detected_host" } });
  let target: string;
  if (probe.kind === "folder") {
    const source = row.name.toLowerCase().includes("ollama") ? "ollama" : row.name.toLowerCase().includes("lm-studio") ? "lm-studio" : row.name.toLowerCase().includes("omlx") ? "omlx" : "mlx-serve";
    const candidates = scanImports({ [source]: row.where } as never).slice(0, 20); const imported: string[] = [];
    for (const [index, candidate] of candidates.entries()) { const modelId = `imported-${id.replace(/[^a-z0-9]+/gi, "-")}-${index}`; const manifest = importCandidate(candidate, { id: modelId, roles: chosen, licence: "Imported local model" }); upsertModel({ id: modelId, roles: chosen, source: "huggingface", provenance: { source: candidate.source, path: candidate.path }, revision: manifest.revision ?? "import", sha256: candidate.digest, sizeBytes: candidate.sizeBytes, licence: "Imported local model", modelPath: manifest.blobs[0]?.path, installedAt: new Date().toISOString(), verifiedAt: new Date().toISOString() }); imported.push(modelId); }
    target = `models:${imported.join(",")}`;
  } else {
    target = `engine:${row.where}`; for (const role of chosen) managedBindings.set(role, row.where);
  }
  db.update(detected).set({ adopted: 1, forgotten: 0, target, version: probe.version, lastSeen: new Date().toISOString() }).where(eq(detected.id, id)).run(); emit({ id: "detected.changed", data: { id, adopted: true, target } });
  return { id, target, roles: chosen };
}

export function forgetDetected(id: string): boolean { const row = db.select().from(detected).where(eq(detected.id, id)).get(); if (!row) return false; for (const role of json<string[]>(row.couldHold, [])) if (managedBindings.get(role) === row.where) managedBindings.delete(role); db.update(detected).set({ forgotten: 1, adopted: 0, target: null }).where(eq(detected.id, id)).run(); emit({ id: "detected.changed", data: { id, forgotten: true } }); return true; }

export function startDetection(): () => void { let stopped = false; const run = () => { if (!stopped) void detectAll(); }; run(); const timer = setInterval(run, 60 * 60_000); (timer as unknown as { unref?: () => void }).unref?.(); return () => { stopped = true; clearInterval(timer); }; }

export function clearDetectedForTests(): void { db.delete(detected).run(); managedBindings.clear(); }
