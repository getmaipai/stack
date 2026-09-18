import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { engineManifestPath, ensureStoreLayout, modelManifestPath, storeRoot } from "@/lib/store/layout";
import { manifestReferenceCount, removeBlobIfUnreferenced } from "@/lib/store/blobs";

export interface StoreBlob {
  digest: string;
  sizeBytes: number;
  path: string;
  shared?: boolean;
}

export interface ModelManifest {
  kind: "model";
  id: string;
  source: string;
  sourcePath?: string;
  repo?: string;
  revision?: string;
  roles: string[];
  blobs: StoreBlob[];
  sizeBytes: number;
  createdAt: string;
  orphanedAt?: string;
}

export interface EngineManifest {
  kind: "engine";
  name: string;
  tag: string;
  assetUrl: string;
  sizeBytes: number;
  githubDigest?: string;
  sha256: string;
  extractedAt: string;
  blobs: StoreBlob[];
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function orphanPath(): string { return join(storeRoot, "orphans.json"); }
function readOrphans(): Record<string, number> {
  try { return JSON.parse(readFileSync(orphanPath(), "utf8")) as Record<string, number>; } catch { return {}; }
}
function writeOrphans(value: Record<string, number>): void { atomicJson(orphanPath(), value); }

export function writeModelManifest(manifest: ModelManifest): void {
  ensureStoreLayout();
  const orphans = readOrphans();
  for (const blob of manifest.blobs) delete orphans[blob.digest.toLowerCase()];
  writeOrphans(orphans);
  atomicJson(modelManifestPath(manifest.id), manifest);
}
export function readModelManifest(id: string): ModelManifest | null {
  const path = modelManifestPath(id);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as ModelManifest; } catch { return null; }
}
export function listModelManifests(root = dirname(modelManifestPath("placeholder"))): ModelManifest[] {
  ensureStoreLayout();
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(root, name), "utf8")) as ModelManifest]; } catch { return []; }
  });
}

export function removeModelManifest(id: string): StoreBlob[] {
  const manifest = readModelManifest(id);
  if (!manifest) return [];
  unlinkSync(modelManifestPath(id));
  const orphans = readOrphans();
  for (const blob of manifest.blobs) if (manifestReferenceCount(blob.digest) === 0) orphans[blob.digest.toLowerCase()] = Date.now();
  writeOrphans(orphans);
  return manifest.blobs;
}

export function pruneUnreferenced(now = Date.now(), graceMs = 60 * 60 * 1000): string[] {
  const orphans = readOrphans();
  const removed: string[] = [];
  for (const [digest, orphanedAt] of Object.entries(orphans)) {
    if (now - orphanedAt < graceMs) continue;
    if (removeBlobIfUnreferenced(digest)) removed.push(digest);
    delete orphans[digest];
  }
  writeOrphans(orphans);
  return removed;
}

export function writeEngineManifest(manifest: EngineManifest): void { atomicJson(engineManifestPath(manifest.name, manifest.tag), manifest); }
export function readEngineManifest(name: string, tag: string): EngineManifest | null {
  const path = engineManifestPath(name, tag);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as EngineManifest; } catch { return null; }
}
export function removeEngineManifest(name: string, tag: string): StoreBlob[] {
  const manifest = readEngineManifest(name, tag);
  if (!manifest) return [];
  unlinkSync(engineManifestPath(name, tag));
  for (const blob of manifest.blobs) removeBlobIfUnreferenced(blob.digest);
  return manifest.blobs;
}
