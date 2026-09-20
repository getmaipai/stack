import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { putBlob, sha256OfPath } from "@/lib/store/blobs";
import { hfBlobsRoot, hfRefsRoot, hfRepoRoot, hfRepoName, hfSnapshotsRoot } from "@/lib/store/layout";

export interface HfFileInput {
  repo: string;
  revision: string;
  filePath: string;
  sourcePath?: string;
  bytes?: Uint8Array;
  digest?: string;
  /** Move the source into the blob store instead of copying it, so a
   * large download is held once (the source must be under data/). */
  move?: boolean;
}

export interface HfCachedFile {
  repo: string;
  revision: string;
  filePath: string;
  path: string;
  digest: string;
  sizeBytes: number;
}

function writeBytes(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes);
}

export function writeHfFile(input: HfFileInput): HfCachedFile {
  if (!input.sourcePath && !input.bytes) throw new Error("writeHfFile needs sourcePath or bytes");
  const digest = input.digest?.toLowerCase() ?? (input.sourcePath ? sha256OfPath(input.sourcePath) : requireDigest(input.bytes!));
  const blob = join(hfBlobsRoot(input.repo), digest);
  if (!existsSync(blob)) {
    if (input.sourcePath) {
      mkdirSync(dirname(blob), { recursive: true, mode: 0o700 });
      if (input.move) renameSync(input.sourcePath, blob);
      else writeBytes(blob, readFileSync(input.sourcePath));
    } else writeBytes(blob, input.bytes!);
  } else if (input.move && input.sourcePath && existsSync(input.sourcePath)) {
    // The blob is already held (a snapshot link was removed and the file
    // fetched again): the source is the duplicate, never kept beside it.
    rmSync(input.sourcePath, { force: true });
  }
  const snapshotPath = join(hfSnapshotsRoot(input.repo), input.revision, input.filePath);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  if (!existsSync(snapshotPath)) symlinkSync(relative(dirname(snapshotPath), blob), snapshotPath);
  const ref = join(hfRefsRoot(input.repo), "main");
  mkdirSync(dirname(ref), { recursive: true, mode: 0o700 });
  writeFileSync(ref, input.revision);
  return { repo: input.repo, revision: input.revision, filePath: input.filePath, path: snapshotPath, digest, sizeBytes: statSync(blob).size };
}

function requireDigest(bytes: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256");
  digest.update(bytes);
  return digest.digest("hex");
}

export function readHfFile(repo: string, revision: string, filePath: string): HfCachedFile | null {
  const path = join(hfSnapshotsRoot(repo), revision, filePath);
  if (!existsSync(path)) return null;
  const real = Bun.file(path);
  const digest = sha256OfPath(path);
  return { repo, revision, filePath, path, digest, sizeBytes: real.size };
}

export function scanHfCache(root: string): HfCachedFile[] {
  if (!existsSync(root)) return [];
  const results: HfCachedFile[] = [];
  for (const repoName of readdirSync(root)) {
    if (!repoName.startsWith("models--")) continue;
    const repoRoot = join(root, repoName);
    const revisionsRoot = join(repoRoot, "snapshots");
    if (!existsSync(revisionsRoot)) continue;
    const repo = repoName.slice("models--".length).replaceAll("--", "/");
    for (const revision of readdirSync(revisionsRoot)) {
      const revisionRoot = join(revisionsRoot, revision);
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() || entry.isSymbolicLink()) {
            const filePath = relative(revisionRoot, path);
            results.push({ repo, revision, filePath, path, digest: sha256OfPath(path), sizeBytes: statSync(path).size });
          }
        }
      };
      walk(revisionRoot);
    }
  }
  return results;
}

export function isHfRepoName(value: string): boolean { return value.startsWith("models--") && value === hfRepoName(value.slice(8).replaceAll("--", "/")); }
