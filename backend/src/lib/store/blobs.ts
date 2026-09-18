import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureStoreLayout, modelManifestRoot, storeRoot } from "@/lib/store/layout";

export const genericBlobRoot = join(storeRoot, "blobs");

export function sha256OfPath(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function linkOrCopy(source: string, destination: string): "hardlink" | "symlink" | "copy" {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) return "copy";
  try {
    linkSync(source, destination);
    return "hardlink";
  } catch { /* Cross-device or a filesystem without hard links. */ }
  try {
    symlinkSync(source, destination);
    return "symlink";
  } catch { /* A restricted filesystem may not allow symlinks. */ }
  copyFileSync(source, destination);
  return "copy";
}

export function blobPath(digest: string): string {
  ensureStoreLayout();
  return join(genericBlobRoot, digest.toLowerCase());
}

export function putBlob(source: string, digest = sha256OfPath(source)): { path: string; digest: string; sizeBytes: number } {
  const target = blobPath(digest);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) copyFileSync(source, target);
  return { path: target, digest: digest.toLowerCase(), sizeBytes: statSync(target).size };
}

function manifestFiles(dir = modelManifestRoot): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? manifestFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

export function manifestReferenceCount(digest: string): number {
  let count = 0;
  for (const path of manifestFiles()) {
    try {
      const text = readFileSync(path, "utf8");
      if (text.includes(digest.toLowerCase())) count += 1;
    } catch { /* A concurrently replaced manifest is retried by the next sweep. */ }
  }
  return count;
}

export function removeBlobIfUnreferenced(digest: string): boolean {
  if (manifestReferenceCount(digest) > 0) return false;
  const path = blobPath(digest);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function appendBlobReferenceLog(digest: string, manifest: string): void {
  ensureStoreLayout();
  appendFileSync(join(storeRoot, "references.log"), `${new Date().toISOString()} ${digest} ${manifest}\n`, { mode: 0o600 });
}
