// MEDIA-STACK-01: where the media service may read and write. Home reads the
// library folders, so Home declares them (PUT /stack/v1/media/roots); every
// path a job names is checked against the declaration here, once, before any
// tool sees it: absolute, no `..` segment, symlinks resolved, inside a
// declared root. The Stack's own data directory is never a root (it holds
// the database and the secrets key) except the job folders under it, which
// the service owns and which are always readable.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { dataDir } from "@/lib/paths";

export class MediaPathError extends Error {
  constructor(readonly code: "path_invalid" | "path_outside_roots" | "path_not_found" | "no_roots" | "root_refused", message: string) { super(message); }
}

export function mediaDir(): string { return join(dataDir, "media"); }
export function jobsDir(): string { return join(mediaDir(), "jobs"); }
export function archivesDir(): string { return join(mediaDir(), "archives"); }
function rootsFile(): string { return join(mediaDir(), "roots.json"); }

export interface MediaRoots { read: string[]; write: string[]; }
let roots: MediaRoots | null = null;

function real(path: string): string { try { return realpathSync(path); } catch { return path; } }
export function isInside(child: string, root: string): boolean { return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep); }

function cleanAbsolute(path: unknown, what: string): string {
  if (typeof path !== "string" || path.length === 0) throw new MediaPathError("path_invalid", `${what} must be a full path. Send the path of the file as Home stores it.`);
  if (path.includes("\0")) throw new MediaPathError("path_invalid", `${what} is not a valid path.`);
  if (!isAbsolute(path)) throw new MediaPathError("path_invalid", `${what} must be a full path starting with /. Send the path of the file as Home stores it.`);
  if (path.split(/[\\/]/).includes("..")) throw new MediaPathError("path_invalid", `${what} may not contain "..". Send the full path without it.`);
  return normalize(path);
}

/** Loads the declaration saved by the last PUT, so a Stack restart before Home reconnects keeps the rules. */
export function getRoots(): MediaRoots {
  if (roots) return roots;
  try {
    const parsed = JSON.parse(readFileSync(rootsFile(), "utf8")) as Partial<MediaRoots>;
    roots = { read: Array.isArray(parsed.read) ? parsed.read.filter((entry) => typeof entry === "string") : [], write: Array.isArray(parsed.write) ? parsed.write.filter((entry) => typeof entry === "string") : [] };
  } catch { roots = { read: [], write: [] }; }
  return roots;
}

/** Replaces the declaration. Each root must exist as a folder, and may not be `/` or hold or sit inside the Stack's data directory. */
export function setRoots(next: { read: string[]; write?: string[] }): MediaRoots {
  const own = real(dataDir);
  const check = (entry: string): string => {
    const clean = cleanAbsolute(entry, `The folder ${JSON.stringify(entry)}`);
    if (!existsSync(clean) || !statSync(clean).isDirectory()) throw new MediaPathError("path_not_found", `The folder ${clean} does not exist on this computer. Declare a folder that exists.`);
    const resolved = real(clean);
    if (resolved === sep || isInside(own, resolved) || (isInside(resolved, own) && !isInside(resolved, real(jobsDir())))) throw new MediaPathError("root_refused", `The folder ${resolved} cannot be a media folder: it is, holds or sits inside the Stack's own data folder.`);
    return resolved;
  };
  const read = [...new Set(next.read.map(check))];
  const write = [...new Set((next.write ?? []).map(check))];
  roots = { read, write };
  mkdirSync(mediaDir(), { recursive: true, mode: 0o700 });
  const temp = `${rootsFile()}.tmp`;
  writeFileSync(temp, JSON.stringify(roots), { mode: 0o600 });
  renameSync(temp, rootsFile());
  return roots;
}

export function __resetRootsForTests(): void { roots = null; rmSync(rootsFile(), { force: true }); }

function readRoots(): string[] {
  mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  return [...getRoots().read, ...getRoots().write, real(jobsDir())];
}

/** A file or folder the service may read: declared, existing, symlinks resolved. */
export function resolveReadable(path: unknown, what = "The path", kind: "file" | "dir" | "any" = "file"): string {
  const clean = cleanAbsolute(path, what);
  const allowed = readRoots();
  if (getRoots().read.length === 0 && getRoots().write.length === 0 && !isInside(real(clean), real(jobsDir()))) throw new MediaPathError("no_roots", "Home has not told the Stack which media folders it may read yet. Home declares them when it connects; try again in a moment.");
  if (!existsSync(clean)) throw new MediaPathError("path_not_found", `${what} ${clean} does not exist on this computer. Check that the library folder is mounted.`);
  const resolved = real(clean);
  if (!allowed.some((root) => isInside(resolved, root))) throw new MediaPathError("path_outside_roots", `${what} ${clean} is outside the media folders Home declared. The Stack only reads inside them.`);
  const info = statSync(resolved);
  if (kind === "file" && !info.isFile()) throw new MediaPathError("path_invalid", `${what} ${clean} is not a file.`);
  if (kind === "dir" && !info.isDirectory()) throw new MediaPathError("path_invalid", `${what} ${clean} is not a folder.`);
  return resolved;
}

/** A folder the service may write into (created when missing): inside a declared write root or the job folders. */
export function resolveWritableDir(path: unknown, what = "The output folder"): string {
  const clean = cleanAbsolute(path, what);
  let existing = clean; const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  const resolved = join(real(existing), ...rest);
  mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  const allowed = [...getRoots().write, real(jobsDir())];
  if (!allowed.some((root) => isInside(resolved, root))) throw new MediaPathError("path_outside_roots", `${what} ${clean} is outside the folders Home declared for writing. Declare it as a write folder first.`);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** A plain file name for an output: no separators, no leading dot, no control characters. */
export function safeName(name: unknown, fallback: string): string {
  if (typeof name !== "string" || name.length === 0) return fallback;
  if (/[\\/\0]/.test(name) || name.startsWith(".") || name.length > 200) throw new MediaPathError("path_invalid", `The file name ${JSON.stringify(name)} is not allowed. Use a plain name without slashes.`);
  return name;
}

/** The folder one job writes into; Home reads the result from here, then releases it. */
export function jobDir(id: string): string {
  const dir = join(jobsDir(), id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function releaseJobDir(id: string): boolean {
  const dir = join(jobsDir(), id.replace(/[^a-zA-Z0-9_-]/g, "_"));
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
/** Removes job folders nobody released within `maxAgeMs` (a crashed Home): called when the Stack starts. */
export function sweepJobDirs(maxAgeMs = 7 * 24 * 3600_000, now = Date.now()): number {
  let removed = 0;
  try {
    for (const entry of readdirSync(jobsDir())) {
      const dir = join(jobsDir(), entry);
      try { if (now - statSync(dir).mtimeMs > maxAgeMs) { rmSync(dir, { recursive: true, force: true }); removed += 1; } } catch { /* gone */ }
    }
  } catch { /* none yet */ }
  return removed;
}
