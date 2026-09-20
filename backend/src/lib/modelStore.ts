import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { models } from "@/db/schema";
import { downloadUrl, DownloadVerificationError, sha256OfFile, type DownloadOptions } from "@/lib/download";
import { dataDir, modelsDir } from "@/lib/paths";
import { hfUrl } from "@/lib/hf";
import type { RoleId } from "@/roles";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { extractArchive } from "@maipai/core/src/archive";
import { z } from "zod";
import { emit } from "@/lib/events";
import { readModelManifest, removeModelManifest, writeModelManifest } from "@/lib/store/manifests";
import { readHfFile, writeHfFile } from "@/lib/store/hfCache";
import { raise } from "@/lib/health";
import { bumpStackGeneration } from "@/lib/stackGeneration";

export const ModelSourceSchema = z.enum(["catalog", "huggingface"]);

// This is intentionally a small boundary around the record. Catalog package
// manifests and Hugging Face metadata can grow without changing the DB shape.
export interface ModelRecord {
  id: string;
  roles: RoleId[];
  source: "catalog" | "huggingface";
  provenance: Record<string, unknown>;
  revision: string;
  sha256: string | null;
  sizeBytes: number | null;
  licence: string | null;
  engineRequirements: Record<string, unknown>;
  installedAt: string | null;
  verifiedAt: string | null;
  hostIdentity: Record<string, unknown> | null;
  firstBootAt: string;
  modelPath: string | null;
  measuredFootprintBytes: number | null;
  measuredContextLength: number | null;
}

export interface ModelRecordInput {
  id: string;
  roles: RoleId[];
  source: "catalog" | "huggingface";
  provenance: Record<string, unknown>;
  revision: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  licence?: string | null;
  engineRequirements?: Record<string, unknown>;
  installedAt?: string | null;
  verifiedAt?: string | null;
  hostIdentity?: Record<string, unknown> | null;
  modelPath?: string | null;
  measuredFootprintBytes?: number | null;
  measuredContextLength?: number | null;
}

export interface DownloadModelOptions {
  destination: string;
  download?: typeof downloadUrl;
  onProgress?: DownloadOptions["onProgress"];
  signal?: AbortSignal;
  now?: () => string;
}

export interface CatalogModelLike {
  id: string;
  role: RoleId;
  repo?: string;
  license?: string;
  revision?: string;
  engine?: string;
  sizing?: unknown;
  /** A piece the role's engine loads beside its model (the `stt` voice
   * activity detector), never a model a person selects. */
  component?: string;
  /** `archive`: the download is a tar or zip package extracted next to
   * itself; `modelPath` is the extracted directory. `hub_file`: the file
   * is placed in the Stack's Hugging Face hub cache at the record's
   * repo and revision under this path, where an engine that reads the
   * hub finds it; `modelPath` is that snapshot path. */
  download?: { url: string; sha256: string; approx_bytes: number; archive?: boolean; hub_file?: string };
  /** Recorded on the pin by a bench (STACK-74), with a sanitized hardware
   * line, never a hostname: the inventory prints these, and only these. */
  measured?: { footprintBytes: number; contextLength: number; hardware: string };
}

export interface HuggingFaceModelInput {
  id: string;
  roles: RoleId[];
  repo: string;
  revision: string;
  url?: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  licence?: string | null;
  engineRequirements?: Record<string, unknown>;
}

export class ProvenanceIncompleteError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Model provenance is incomplete: missing ${missing.join(", ")}.`);
    this.name = "ProvenanceIncompleteError";
    this.missing = missing;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: typeof models.$inferSelect): ModelRecord {
  return {
    id: row.id,
    roles: parseJson<RoleId[]>(row.roles, []),
    source: ModelSourceSchema.parse(row.source),
    provenance: parseJson<Record<string, unknown>>(row.provenance, {}),
    revision: row.revision,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    licence: row.licence,
    engineRequirements: parseJson<Record<string, unknown>>(row.engineRequirements, {}),
    installedAt: row.installedAt,
    verifiedAt: row.verifiedAt,
    hostIdentity: row.hostIdentity ? parseJson<Record<string, unknown>>(row.hostIdentity, {}) : null,
    firstBootAt: row.firstBootAt,
    modelPath: row.modelPath,
    measuredFootprintBytes: row.measuredFootprintBytes,
    measuredContextLength: row.measuredContextLength,
  };
}

export function getModel(id: string): ModelRecord | null {
  const row = db.select().from(models).where(eq(models.id, id)).get();
  return row ? toRecord(row) : null;
}

export function listModels(): ModelRecord[] {
  return db.select().from(models).all().map(toRecord);
}

/** Reconcile old records that predate recorded file sizes without treating a
 * missing file as a zero-byte model.  The value is persisted once. */
export function reconcileModelSize(record: ModelRecord): ModelRecord {
  if (record.sizeBytes !== null || !record.modelPath) return record;
  try {
    const sizeBytes = statSync(record.modelPath).size;
    db.update(models).set({ sizeBytes }).where(eq(models.id, record.id)).run();
    return { ...record, sizeBytes };
  } catch {
    return record;
  }
}

export function recordMeasuredFootprint(id: string, footprintBytes: number, contextLength: number): void {
  db.update(models).set({ measuredFootprintBytes: footprintBytes, measuredContextLength: contextLength }).where(eq(models.id, id)).run();
}

export function isModelSelectable(record: ModelRecord | null): boolean {
  return !!record?.sha256 && !!record.licence && !!record.verifiedAt;
}

export function upsertModel(input: ModelRecordInput, now = new Date().toISOString()): ModelRecord {
  const existing = getModel(input.id);
  const carries = (field: keyof ModelRecordInput): boolean => Object.prototype.hasOwnProperty.call(input, field);
  const record: ModelRecord = {
    id: input.id,
    roles: input.roles,
    source: input.source,
    provenance: input.provenance,
    revision: input.revision,
    sha256: input.sha256 ?? null,
    sizeBytes: input.sizeBytes ?? null,
    licence: input.licence ?? null,
    engineRequirements: input.engineRequirements ?? {},
    installedAt: carries("installedAt") ? input.installedAt ?? null : existing?.installedAt ?? null,
    verifiedAt: carries("verifiedAt") ? input.verifiedAt ?? null : existing?.verifiedAt ?? null,
    hostIdentity: input.hostIdentity ?? null,
    firstBootAt: existing?.firstBootAt ?? now,
    modelPath: carries("modelPath") ? input.modelPath ?? null : existing?.modelPath ?? null,
    measuredFootprintBytes: carries("measuredFootprintBytes") ? input.measuredFootprintBytes ?? null : existing?.measuredFootprintBytes ?? null,
    measuredContextLength: carries("measuredContextLength") ? input.measuredContextLength ?? null : existing?.measuredContextLength ?? null,
  };
  db.insert(models).values({
    id: record.id,
    roles: json(record.roles),
    source: record.source,
    provenance: json(record.provenance),
    revision: record.revision,
    sha256: record.sha256,
    sizeBytes: record.sizeBytes,
    licence: record.licence,
    engineRequirements: json(record.engineRequirements),
    installedAt: record.installedAt,
    verifiedAt: record.verifiedAt,
    hostIdentity: record.hostIdentity ? json(record.hostIdentity) : null,
    firstBootAt: record.firstBootAt,
    modelPath: record.modelPath,
    measuredFootprintBytes: record.measuredFootprintBytes,
    measuredContextLength: record.measuredContextLength,
  }).onConflictDoUpdate({
    target: models.id,
    set: {
      roles: json(record.roles),
      source: record.source,
      provenance: json(record.provenance),
      revision: record.revision,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      licence: record.licence,
      engineRequirements: json(record.engineRequirements),
      installedAt: record.installedAt,
      verifiedAt: record.verifiedAt,
      hostIdentity: record.hostIdentity ? json(record.hostIdentity) : null,
      modelPath: record.modelPath,
      measuredFootprintBytes: record.measuredFootprintBytes,
      measuredContextLength: record.measuredContextLength,
    },
  }).run();
  return record;
}

export function registerCatalogModel(model: CatalogModelLike, now = new Date().toISOString()): ModelRecord {
  if (!model.revision && !model.download?.url) throw new Error(`Catalog model ${model.id} has no revision`);
  const revision = model.revision ?? new URL(model.download!.url).pathname.match(/\/resolve\/([^/]+)/)?.[1] ?? "catalog";
  const provenance: Record<string, unknown> = { package: `model:${model.id}`, catalogId: model.id };
  if (model.repo) provenance.repo = model.repo;
  return upsertModel({
    id: model.id,
    roles: [model.role],
    source: "catalog",
    provenance,
    revision,
    sha256: model.download?.sha256 ?? null,
    sizeBytes: model.download?.approx_bytes ?? null,
    licence: model.license ?? null,
    engineRequirements: { engine: model.engine ?? null, sizing: model.sizing ?? null, ...(model.component ? { component: model.component } : {}) },
  }, now);
}

/** `sherpa-onnx-moonshine-tiny-en-int8.tar.bz2` extracts to
 * `sherpa-onnx-moonshine-tiny-en-int8/`, so the identity headers name
 * the package the way upstream does. */
export function packageDirectoryName(archivePath: string): string {
  const name = basename(archivePath);
  const stripped = name.replace(/\.(tar\.(gz|bz2|xz)|tgz|tar|zip)$/i, "");
  // An archive whose name has no extension to strip still extracts
  // beside itself, never over itself.
  return stripped === name ? `${name}.extracted` : stripped;
}

/** A record that is a component of a role's engine, not a model. */
export function isComponent(record: ModelRecord): boolean {
  return typeof record.engineRequirements.component === "string";
}

export async function installCatalogModel(model: CatalogModelLike, options: DownloadModelOptions): Promise<ModelRecord> {
  const registered = registerCatalogModel(model, options.now?.() ?? new Date().toISOString());
  return installRegisteredModel(registered, model.download, options);
}

export async function installHuggingFaceModel(input: HuggingFaceModelInput, options: DownloadModelOptions): Promise<ModelRecord> {
  const registered = upsertModel({
    id: input.id,
    roles: input.roles,
    source: "huggingface",
    provenance: { repo: input.repo, revision: input.revision },
    revision: input.revision,
    sha256: input.sha256 ?? null,
    sizeBytes: input.sizeBytes ?? null,
    licence: input.licence ?? null,
    engineRequirements: input.engineRequirements,
  }, options.now?.() ?? new Date().toISOString());
  const installed = await installRegisteredModel(registered, {
    url: input.url ?? hfUrl(`${input.repo}/resolve/${input.revision}/${basename(options.destination)}`),
    sha256: input.sha256 ?? "",
    approx_bytes: input.sizeBytes ?? 0,
  }, options);
  const cached = writeHfFile({ repo: input.repo, revision: input.revision, filePath: basename(options.destination), sourcePath: options.destination, digest: installed.sha256 ?? undefined });
  return upsertModel({ ...installed, modelPath: cached.path }, new Date().toISOString());
}

async function installRegisteredModel(
  record: ModelRecord,
  download: NonNullable<CatalogModelLike["download"]> | undefined,
  options: DownloadModelOptions,
): Promise<ModelRecord> {
  const missing = [
    ...(!download?.sha256 || !record.sha256 ? ["sha256"] : []),
    ...(!record.licence ? ["licence"] : []),
  ];
  if (missing.length > 0) throw new ProvenanceIncompleteError(missing);
  const verifiedDownload = download!;
  const destination = options.destination;
  const hubRepo = typeof record.provenance.repo === "string" ? record.provenance.repo : null;
  if (verifiedDownload.hub_file && !hubRepo) throw new Error(`Model ${record.id} names a hub file but no repository.`);
  // A hub file already in the cache at the pinned digest is the install;
  // nothing is fetched twice.
  const cachedHubFile = verifiedDownload.hub_file && hubRepo ? readHfFile(hubRepo, record.revision, verifiedDownload.hub_file) : null;
  const alreadyCached = cachedHubFile?.digest === verifiedDownload.sha256.toLowerCase();
  mkdirSync(join(destination, ".."), { recursive: true });
  const downloader = options.download ?? downloadUrl;
  if (!alreadyCached) {
    if (existsSync(destination)) {
      const actual = await sha256OfFile(destination);
      if (actual !== verifiedDownload.sha256.toLowerCase()) rmSync(destination, { force: true });
    }
    const downloadOptions: DownloadOptions = {
      expectedSha256: verifiedDownload.sha256,
      onProgress: options.onProgress,
      signal: options.signal,
    };
    await downloader(verifiedDownload.url, destination, downloadOptions);
  }
  const actual = alreadyCached ? cachedHubFile!.digest : await sha256OfFile(destination);
  if (actual !== verifiedDownload.sha256.toLowerCase()) {
    rmSync(destination, { force: true });
    raise({ code: "stored-blob-checksum-mismatch", severity: "error", title: "A model checksum did not match", text: `The downloaded bytes for ${record.id} failed verification.`, cause: "The file digest differed from its recorded SHA-256.", fix: { label: "Download again", action: "retry_download" } });
    throw new DownloadVerificationError(`Model failed checksum verification`);
  }
  // A package extracts beside its archive into a directory named after
  // it; the archive stays so a re-install verifies instead of fetching.
  let modelPath = destination;
  if (verifiedDownload.archive) {
    modelPath = join(dirname(destination), packageDirectoryName(destination));
    rmSync(modelPath, { recursive: true, force: true });
    await extractArchive(destination, modelPath);
  } else if (verifiedDownload.hub_file) {
    // Moved into the hub cache, held once; the snapshot path is the model path.
    modelPath = alreadyCached ? cachedHubFile!.path : writeHfFile({ repo: hubRepo!, revision: record.revision, filePath: verifiedDownload.hub_file, sourcePath: destination, digest: actual, move: true }).path;
  }
  const now = options.now?.() ?? new Date().toISOString();
  const current = getModel(record.id) ?? record;
  const installed = upsertModel({
    ...current,
    installedAt: now,
    verifiedAt: now,
    modelPath,
  }, now);
  // The blob the manifest names is the file that is really there: the
  // archive beside a package, the hub blob for a hub file.
  const blobPath = verifiedDownload.hub_file ? modelPath : destination;
  const blobSize = statSync(blobPath).size;
  writeModelManifest({
    kind: "model",
    id: installed.id,
    source: installed.source,
    sourcePath: blobPath,
    repo: typeof installed.provenance.repo === "string" ? installed.provenance.repo : undefined,
    revision: installed.revision,
    roles: installed.roles,
    blobs: [{ digest: installed.sha256 ?? actual, sizeBytes: blobSize, path: blobPath }],
    sizeBytes: blobSize,
    createdAt: installed.installedAt ?? now,
  });
  emit({ id: "model.installed", data: { model: installed.id, path: installed.modelPath } });
  bumpStackGeneration(`model ${installed.id} installed`);
  return installed;
}

export function removeModel(id: string): boolean {
  const model = getModel(id);
  if (!model) return false;
  // A package is a directory beside its archive; both go, the manifest
  // last so a failure here leaves the record findable.
  const archive = readModelManifest(id)?.blobs[0]?.path;
  if (model.modelPath && model.modelPath.startsWith(modelsDir) && existsSync(model.modelPath)) rmSync(model.modelPath, { recursive: true, force: true });
  if (archive && archive.startsWith(modelsDir) && archive !== model.modelPath && existsSync(archive)) rmSync(archive, { force: true });
  removeModelManifest(id);
  db.delete(models).where(eq(models.id, id)).run();
  emit({ id: "model.installed", data: { model: id, removed: true } });
  bumpStackGeneration(`model ${id} removed`);
  return true;
}

/** The one place a test may empty the models table: only a scratch data
 * directory, under the OS temp dir or the suite's own `backend/data-test/`
 * (issue #7), never a real one. */
export function isScratchDataDir(dir: string): boolean {
  const real = realpathSync(dir);
  const scratch = resolve(import.meta.dir, "..", "..", "data-test");
  const within = (root: string) => real === root || real.startsWith(root + sep);
  return within(realpathSync(tmpdir())) || within(existsSync(scratch) ? realpathSync(scratch) : scratch);
}

export function clearModelsForTests(): void {
  if (!isScratchDataDir(dataDir)) {
    throw new Error("clearModelsForTests refused: data dir is not a scratch directory (the OS temp dir or backend/data-test/)");
  }
  for (const model of listModels()) removeModelManifest(model.id);
  sqlite.exec("DELETE FROM models");
}
