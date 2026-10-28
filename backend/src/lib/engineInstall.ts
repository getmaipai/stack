import { chmodSync, existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, type EngineArchive, type EngineBinaryPin } from "@/lib/engineCatalog";
import { extractArchive } from "@maipai/core/src/archive";
import { downloadUrl, type DownloadProgress } from "@/lib/download";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { readEngineManifest, removeEngineManifest, writeEngineManifest } from "@/lib/store/manifests";
import { listModels } from "@/lib/modelStore";
import { bumpStackGeneration } from "@/lib/stackGeneration";

export function engineDir(pin: EngineBinaryPin): string {
  return engineTagRoot(pin.name, pin.tag);
}

export function engineToolPath(pin: EngineBinaryPin, name: string): string {
  return join(engineDir(pin), pin.platform === "win32" ? `${name}.exe` : name);
}

export function engineBinaryPath(pin: EngineBinaryPin): string {
  return engineToolPath(pin, pin.tool ?? "llama-server");
}

/** Vendor Splash archives bundle a Python launcher; the native executable is
 * the install proof, while the Stack starts the bundled launcher. */
/** What the `current` link says should run: `none` before the first
 * activation, `unready` when the link names a build that never finished
 * installing (nothing may run in its place), or the binary path. */
export function currentEngineBinary(name: string, tool = name): { state: "none" } | { state: "unready"; tag: string } | { state: "ready"; path: string } {
  const current = engineCurrentPath(name);
  let tag: string;
  try { tag = readlinkSync(current); } catch { return { state: "none" }; }
  const target = resolve(current, "..", tag);
  if (!existsSync(join(target, ENGINE_READY_MARKER))) return { state: "unready", tag };
  return { state: "ready", path: join(target, process.platform === "win32" ? `${tool}.exe` : tool) };
}

/** The tag the `current` link names, or null before any link exists. */
export function currentEngineTag(name: string): string | null {
  try { return readlinkSync(engineCurrentPath(name)); } catch { return null; }
}

export function currentEngineBinaryPath(name: string, tool = name): string | null {
  const current = currentEngineBinary(name, tool);
  return current.state === "ready" ? current.path : null;
}

async function downloadArchive(pin: EngineBinaryPin, archive: EngineArchive, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal, completedBefore = 0, totalBytes = archive.approxBytes): Promise<void> {
  const destination = join(engineDir(pin), ".download.tmp");
  await downloadUrl(archive.url, destination, {
    expectedSha256: archive.sha256,
    expectedBytes: archive.approxBytes,
    onProgress: (progress) => onProgress({ ...progress, completedBytes: completedBefore + progress.completedBytes, totalBytes, itemId: archive.label, itemLabel: archive.label, itemCompletedBytes: progress.completedBytes, itemTotalBytes: archive.approxBytes }),
    signal,
  });
  if (archive.rawFileName) renameSync(destination, join(engineDir(pin), archive.rawFileName));
  else await extractArchive(destination, engineDir(pin));
  rmSync(destination, { force: true });
}

async function installEngine(
  pin: EngineBinaryPin,
  onProgress: (progress: DownloadProgress) => void = () => {},
  options: { activate?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const destination = engineDir(pin);
  const readyMarker = join(destination, ENGINE_READY_MARKER);
  if (existsSync(readyMarker)) return;
  mkdirSync(destination, { recursive: true });
  const archives = [pin.archive, ...(pin.extraArchives ?? [])];
  const totalBytes = archives.reduce((sum, archive) => sum + archive.approxBytes, 0);
  let completedBefore = 0;
  for (const archive of archives) {
    await downloadArchive(pin, archive, onProgress, options.signal, completedBefore, totalBytes);
    completedBefore += archive.approxBytes;
  }
  if (pin.platform !== "win32") chmodSync(engineBinaryPath(pin), 0o755);
  writeFileSync(readyMarker, new Date().toISOString());
  const { name, tag } = pin;
  writeEngineManifest({ kind: "engine", name, tag, assetUrl: pin.archive.url, sizeBytes: pin.archive.approxBytes, githubDigest: pin.archive.sha256, sha256: pin.archive.sha256, extractedAt: new Date().toISOString(), blobs: [] });
  if (options.activate === false) return;
  const current = engineCurrentPath(name);
  mkdirSync(resolve(current, ".."), { recursive: true, mode: 0o700 });
  try { unlinkSync(current); } catch { /* First install has no current link. */ }
  symlinkSync(tag, current);
  bumpStackGeneration(`engine ${name} installed at ${tag}`);
}

const engineInstalls = new Map<string, Promise<void>>();
export function ensureEngine(
  pin: EngineBinaryPin,
  onProgress: (progress: DownloadProgress) => void = () => {},
  options: { activate?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const key = `${pin.name}:${pin.tag}:${pin.archive.url}`;
  const existing = engineInstalls.get(key);
  if (existing) return existing;
  const install = installEngine(pin, onProgress, options).finally(() => engineInstalls.delete(key));
  engineInstalls.set(key, install);
  return install;
}

/** Before the tags became the upstream build tags, a shipped pin's
 * directory was named by its whole id suffix (`b10797-macos-arm64`).
 * A store from then is renamed once, and its `current` link relinked,
 * so an install never reads as missing or as "newer available" for the
 * build that is running. Returns what was moved. */
export function migrateLegacyEngineTags(): Array<{ name: string; from: string; to: string }> {
  const moved: Array<{ name: string; from: string; to: string }> = [];
  for (const pin of ENGINE_BINARIES) {
    const legacyTag = pin.id.startsWith(`${pin.name}-`) ? pin.id.slice(pin.name.length + 1) : null;
    if (!legacyTag || legacyTag === pin.tag) continue;
    const from = engineTagRoot(pin.name, legacyTag);
    const to = engineTagRoot(pin.name, pin.tag);
    if (!existsSync(from) || existsSync(to)) continue;
    renameSync(from, to);
    const manifest = readEngineManifest(pin.name, pin.tag);
    if (manifest) writeEngineManifest({ ...manifest, tag: pin.tag });
    const current = engineCurrentPath(pin.name);
    try { if (readlinkSync(current) === legacyTag) { unlinkSync(current); symlinkSync(pin.tag, current); } } catch { /* no link yet */ }
    moved.push({ name: pin.name, from: legacyTag, to: pin.tag });
  }
  return moved;
}

export function removeEngine(name: string, tag: string): boolean {
  const destination = engineTagRoot(name, tag);
  if (!existsSync(destination) && !readEngineManifest(name, tag)) return false;
  rmSync(destination, { recursive: true, force: true });
  removeEngineManifest(name, tag);
  const current = engineCurrentPath(name);
  try {
    if (resolve(current, "..", readlinkSync(current)) === resolve(destination)) rmSync(current, { force: true });
  } catch { /* Best effort for a concurrently removed link. */ }
  return true;
}

export function engineIsBound(name: string, _tag: string): boolean {
  return listModels().some((model) => model.engineRequirements.engine === name);
}
