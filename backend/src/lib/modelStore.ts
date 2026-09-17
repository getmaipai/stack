import { eq } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { models } from "@/db/schema";
import { downloadUrl, type DownloadOptions } from "@/lib/download";
import { modelsDir } from "@/lib/paths";
import type { RoleId } from "@/roles";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
}

export interface DownloadModelOptions {
  destination: string;
  download?: typeof downloadUrl;
  now?: () => string;
}

export interface CatalogModelLike {
  id: string;
  role: RoleId;
  license?: string;
  revision?: string;
  engine?: string;
  sizing?: unknown;
  download?: { url: string; sha256: string; approx_bytes: number };
}

export interface HuggingFaceModelInput {
  id: string;
  roles: RoleId[];
  repo: string;
  revision: string;
  url: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  licence?: string | null;
  engineRequirements?: Record<string, unknown>;
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
  };
}

export function getModel(id: string): ModelRecord | null {
  const row = db.select().from(models).where(eq(models.id, id)).get();
  return row ? toRecord(row) : null;
}

export function listModels(): ModelRecord[] {
  return db.select().from(models).all().map(toRecord);
}

export function isModelSelectable(record: ModelRecord | null): boolean {
  return !!record?.sha256 && !!record.licence && !!record.verifiedAt;
}

export function upsertModel(input: ModelRecordInput, now = new Date().toISOString()): ModelRecord {
  const existing = getModel(input.id);
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
    installedAt: input.installedAt ?? null,
    verifiedAt: input.verifiedAt ?? null,
    hostIdentity: input.hostIdentity ?? null,
    firstBootAt: existing?.firstBootAt ?? now,
    modelPath: input.modelPath ?? null,
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
    },
  }).run();
  return record;
}

export function registerCatalogModel(model: CatalogModelLike, now = new Date().toISOString()): ModelRecord {
  if (!model.revision && !model.download?.url) throw new Error(`Catalog model ${model.id} has no revision`);
  const revision = model.revision ?? new URL(model.download!.url).pathname.match(/\/resolve\/([^/]+)/)?.[1] ?? "catalog";
  return upsertModel({
    id: model.id,
    roles: [model.role],
    source: "catalog",
    provenance: { package: `model:${model.id}`, catalogId: model.id },
    revision,
    sha256: model.download?.sha256 ?? null,
    sizeBytes: model.download?.approx_bytes ?? null,
    licence: model.license ?? null,
    engineRequirements: { engine: model.engine ?? null, sizing: model.sizing ?? null },
  }, now);
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
  return installRegisteredModel(registered, {
    url: input.url,
    sha256: input.sha256 ?? "",
    approx_bytes: input.sizeBytes ?? 0,
  }, options);
}

async function installRegisteredModel(
  record: ModelRecord,
  download: { url: string; sha256: string; approx_bytes: number } | undefined,
  options: DownloadModelOptions,
): Promise<ModelRecord> {
  if (!download?.sha256 || !record.licence) return record;
  const destination = options.destination;
  mkdirSync(join(destination, ".."), { recursive: true });
  const downloader = options.download ?? downloadUrl;
  const downloadOptions: DownloadOptions = {
    expectedSha256: download.sha256,
    ...(download.approx_bytes > 0 ? { expectedBytes: download.approx_bytes } : {}),
  };
  await downloader(download.url, destination, downloadOptions);
  const now = options.now?.() ?? new Date().toISOString();
  const current = getModel(record.id) ?? record;
  return upsertModel({
    ...current,
    installedAt: now,
    verifiedAt: now,
    modelPath: destination,
  }, now);
}

export function clearModelsForTests(): void {
  sqlite.exec("DELETE FROM models");
}
