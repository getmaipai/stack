// "Installed X, available Y, last checked at T": the Catalog's signed
// index is the one source for what is available, read only when Home
// has switched update checks on and calls the check. Nothing is fetched
// from a Stack release; there are none. Where the Catalog does not yet
// publish an engine index, the engines half reports installed and last
// checked with available unknown (STACK-97).
import { eq, like } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { meta } from "@/db/schema";
import packageJson from "../../package.json";
import { emit } from "@/lib/events";
import { detectHardware } from "@/lib/hardware";
import { listModels, type CatalogModelLike } from "@/lib/modelStore";
import { proposeProfile } from "@/profiles";
import { settingValues } from "@/settings";
import { currentEngine } from "@/updates/engines";

export const MODEL_INDEX_URL = "https://github.com/getmaipai/catalog/releases/latest/download/model-index.json";
export const ENGINE_INDEX_URL = "https://github.com/getmaipai/catalog/releases/latest/download/engine-index.json";

const profileIds = ["p16", "p32", "p64", "p128"] as const;
export const ModelIndexEntrySchema = z.object({
  id: z.string(), role: z.string(), profile: z.enum(profileIds), quality: z.number().int().nonnegative(),
  repo: z.string().optional(), license: z.string().optional(), revision: z.string(), engine: z.string().optional(),
  download: z.object({
    url: z.string().url(), sha256: z.string().length(64), approx_bytes: z.number().int().nonnegative(),
    // A directory model (an MLX build): the files beside the weights, each pinned (STACK-93).
    directory: z.string().optional(), files: z.array(z.object({ path: z.string(), sha256: z.string().length(64), bytes: z.number().int().nonnegative() })).optional(),
  }),
});
export const ModelIndexSchema = z.object({ version: z.string(), models: z.array(ModelIndexEntrySchema) });
export type ModelIndexEntry = z.infer<typeof ModelIndexEntrySchema>;
export type ModelIndex = z.infer<typeof ModelIndexSchema>;

// The Catalog's engine index (catalog/engines/index.json, published as a
// signed envelope in the package index's shape by tools/src/engine-index.ts):
// one entry per name, upstream build tag, platform and arch.
export const EngineIndexEntrySchema = z.object({
  name: z.string(), tag: z.string().regex(/^b[0-9]+$/), platform: z.string(), arch: z.string(),
  url: z.string().url(), sha256: z.string().length(64), size: z.number().int().nonnegative(), licence: z.string().optional(),
  requires: z.array(z.string()).optional(), extra: z.array(z.object({ url: z.string().url(), sha256: z.string().length(64), size: z.number().int().nonnegative(), label: z.string().optional() })).optional(), notes: z.string().optional(),
});
const EngineIndexBodySchema = z.object({ version: z.string(), engines: z.array(EngineIndexEntrySchema) });
// The published document is the signed envelope; a bare body is accepted
// too (a local build, a fixture). Verifying the signature against the
// Catalog's release key is the Catalog's release-key item; until then
// the document is trusted the way the model index is: pinned URL, TLS.
export const EngineIndexSchema = z.union([
  z.object({ signed: EngineIndexBodySchema.extend({ type: z.literal("engine-index"), expires: z.string().datetime({ offset: true }), published: z.number().int().optional() }), signatures: z.array(z.object({ keyid: z.string(), sig: z.string() })) }).transform((envelope) => ({ version: envelope.signed.version, engines: envelope.signed.engines, expires: envelope.signed.expires, signed: true as const })),
  EngineIndexBodySchema.transform((body) => ({ ...body, expires: null, signed: false as const })),
]);
export type EngineIndexEntry = z.infer<typeof EngineIndexEntrySchema>;
export type EngineIndex = z.infer<typeof EngineIndexSchema>;

export type UpdateFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const key = (suffix: string) => `updates.${suffix}`;
const read = (suffix: string) => db.select({ value: meta.value }).from(meta).where(eq(meta.key, key(suffix))).get()?.value ?? null;
const write = (suffix: string, value: string) => db.insert(meta).values({ key: key(suffix), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();

export function updatesEnabled(): boolean { return settingValues()["stack.updates.enabled"] === true; }

export function conditionalHeaders(etag: string | null): Record<string, string> {
  return { "if-none-match": etag ?? "", "user-agent": `maipai-stack/${packageJson.version} (${process.platform}-${process.arch})` };
}

function readModelIndex(): ModelIndex | null { const value = read("modelIndex.body"); return value ? ModelIndexSchema.safeParse(JSON.parse(value)).data ?? null : null; }
function readEngineIndex(): EngineIndex | null {
  const value = read("engineIndex.body");
  const index = value ? EngineIndexSchema.safeParse(JSON.parse(value)).data ?? null : null;
  // A signed index past its expiry (or with an expiry that does not
  // parse) is no longer a claim about what is available.
  if (index?.expires && !(Date.parse(index.expires) >= Date.now())) return null;
  return index;
}

export function catalogModelForId(id: string): CatalogModelLike | null {
  const entry = readModelIndex()?.models.find((model) => model.id === id);
  return entry ? { ...entry, role: entry.role as CatalogModelLike["role"], sizing: { profile: entry.profile, quality: entry.quality } } : null;
}

async function fetchIndex(kind: "modelIndex" | "engineIndex", url: string, fetcher: UpdateFetcher): Promise<"updated" | "unchanged" | "missing"> {
  const response = await fetcher(url, { headers: conditionalHeaders(read(`${kind}.etag`)) });
  if (response.status === 304) { write(`${kind}.checked`, new Date().toISOString()); return "unchanged"; }
  if (response.status === 404) { write(`${kind}.checked`, new Date().toISOString()); return "missing"; }
  if (!response.ok) throw new Error(`Index check returned ${response.status}`);
  const body = await response.json();
  const parsed = kind === "modelIndex" ? ModelIndexSchema.safeParse(body) : EngineIndexSchema.safeParse(body);
  if (!parsed.success) throw new Error("The index did not match its declared shape.");
  // The document is stored as received (a signed envelope stays one) and
  // parsed again on every read, so its expiry is honoured later too.
  write(`${kind}.body`, JSON.stringify(body));
  write(`${kind}.checked`, new Date().toISOString());
  const etag = response.headers.get("etag"); if (etag) write(`${kind}.etag`, etag);
  return "updated";
}

export interface EngineUpdateState { name: string; installed: string | null; available: string | null; availableKnown: boolean; lastChecked: string | null; notes: string | null; }
export interface ModelUpdateState { id: string; installed: string; available: string | null; }
export interface UpdatesState { checksEnabled: boolean; engines: EngineUpdateState[]; models: { lastChecked: string | null; entries: ModelUpdateState[] }; }

function buildNumber(tag: string | null): number | null {
  const match = tag?.match(/^b(\d+)/);
  return match ? Number(match[1]) : null;
}

// Whether this machine has an NVIDIA device, recorded by the last check
// (the hardware probe is async; the index readers are not).
const NVIDIA_KEY = "hardware.nvidia";
function nvidiaAvailable(): boolean { return read(NVIDIA_KEY) === "true"; }

/** The newest index entry this machine can run (highest build number,
 * its requirements met), or null when the index has none or the build
 * installed is the same or newer. */
export function pendingEngineUpdate(name = "llama-server"): EngineIndexEntry | null {
  const entries = (readEngineIndex()?.engines ?? []).filter((candidate) => candidate.name === name && candidate.platform === process.platform && candidate.arch === process.arch && (!candidate.requires?.includes("nvidia") || nvidiaAvailable()));
  const newest = entries.sort((a, b) => (buildNumber(b.tag) ?? 0) - (buildNumber(a.tag) ?? 0))[0];
  if (!newest) return null;
  const installed = buildNumber(currentEngine(name));
  if (installed !== null && installed >= (buildNumber(newest.tag) ?? 0)) return null;
  return newest;
}

export function updatesState(): UpdatesState {
  const engineIndex = readEngineIndex();
  const pending = pendingEngineUpdate("llama-server");
  const engines: EngineUpdateState[] = [{
    name: "llama-server",
    installed: currentEngine("llama-server"),
    available: pending?.tag ?? null,
    availableKnown: engineIndex !== null,
    lastChecked: read("engineIndex.checked"),
    notes: pending?.notes ?? null,
  }];
  const index = readModelIndex();
  const entries: ModelUpdateState[] = listModels().map((model) => {
    const entry = index?.models.find((candidate) => candidate.id === model.id);
    return { id: model.id, installed: model.revision, available: entry && entry.revision !== model.revision ? entry.revision : null };
  });
  return { checksEnabled: updatesEnabled(), engines, models: { lastChecked: read("modelIndex.checked"), entries } };
}

/** Home's "check now": one conditional GET per index, an
 * `update.available` event only for something genuinely new. */
export async function checkCatalog(fetcher: UpdateFetcher = fetch): Promise<UpdatesState> {
  if (!updatesEnabled()) return updatesState();
  write(NVIDIA_KEY, String((await detectHardware()).cudaDevices.length > 0));
  const before = updatesState();
  await fetchIndex("modelIndex", MODEL_INDEX_URL, fetcher);
  await fetchIndex("engineIndex", ENGINE_INDEX_URL, fetcher);
  const after = updatesState();
  for (const engine of after.engines) {
    const previous = before.engines.find((candidate) => candidate.name === engine.name);
    if (engine.available && engine.available !== previous?.available) emit({ id: "update.available", data: { kind: "engine", name: engine.name, installed: engine.installed, available: engine.available } });
  }
  for (const model of after.models.entries) {
    const previous = before.models.entries.find((candidate) => candidate.id === model.id);
    if (model.available && model.available !== previous?.available) emit({ id: "update.available", data: { kind: "model", name: model.id, installed: model.installed, available: model.available } });
  }
  return after;
}

export type ModelRecommendation = ModelIndexEntry & { sentence: string };

/** The index entries that fit this machine's profile and add a role or a
 * better quality band: sizing data for Home's page, never an install. */
export function recommendationsFor(index: ModelIndex, profileId: string | null, installedQualities: Record<string, number> = {}): ModelRecommendation[] {
  if (!profileId) return [];
  const current = profileIds.indexOf(profileId as typeof profileIds[number]);
  return index.models
    .filter((model) => profileIds.indexOf(model.profile) <= current && (installedQualities[model.role] === undefined || model.quality > installedQualities[model.role]!))
    .map((model) => ({ ...model, sentence: installedQualities[model.role] === undefined ? `Add ${model.role} with quality band ${model.quality}.` : `Improve ${model.role} to quality band ${model.quality}.` }));
}

export async function modelRecommendations(): Promise<ModelRecommendation[]> {
  const profile = proposeProfile(await detectHardware());
  const installedQualities: Record<string, number> = {};
  for (const model of listModels()) {
    const sizing = model.engineRequirements.sizing;
    const quality = typeof sizing === "object" && sizing !== null && "quality" in sizing && typeof sizing.quality === "number" ? sizing.quality : 0;
    for (const role of model.roles) installedQualities[role] = Math.max(installedQualities[role] ?? 0, quality);
  }
  return recommendationsFor(readModelIndex() ?? { version: "", models: [] }, profile?.id ?? null, installedQualities);
}

export function __resetUpdatesForTests(): void { db.delete(meta).where(like(meta.key, "updates.%")).run(); }
