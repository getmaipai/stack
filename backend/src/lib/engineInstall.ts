import { chmodSync, existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENGINE_READY_MARKER, type EngineArchive, type EngineBinaryPin } from "@/lib/engineCatalog";
import { extractArchive } from "@/lib/archive";
import { downloadUrl } from "@/lib/download";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { readEngineManifest, removeEngineManifest, writeEngineManifest } from "@/lib/store/manifests";
import { listModels } from "@/lib/modelStore";

function engineNameTag(id: string): { name: string; tag: string } {
  const marker = id.indexOf("-b");
  return marker > 0 ? { name: id.slice(0, marker), tag: id.slice(marker + 1) } : { name: id, tag: "legacy" };
}

export function engineDir(id: string): string {
  const { name, tag } = engineNameTag(id);
  return engineTagRoot(name, tag);
}

export function engineBinaryPath(pin: EngineBinaryPin): string {
  return join(engineDir(pin.id), pin.platform === "win32" ? "llama-server.exe" : "llama-server");
}

async function downloadArchive(pin: EngineBinaryPin, archive: EngineArchive, onProgress: (completed: number, total: number, label: string) => void): Promise<void> {
  const destination = join(engineDir(pin.id), ".download.tmp");
  await downloadUrl(archive.url, destination, {
    expectedSha256: archive.sha256,
    expectedBytes: archive.approxBytes,
    onProgress: (progress) => onProgress(progress.completedBytes, progress.totalBytes, archive.label),
  });
  await extractArchive(destination, engineDir(pin.id));
  rmSync(destination, { force: true });
}

export async function ensureEngine(
  pin: EngineBinaryPin,
  onProgress: (completed: number, total: number, label: string) => void = () => {},
): Promise<void> {
  const destination = engineDir(pin.id);
  const readyMarker = join(destination, ENGINE_READY_MARKER);
  if (existsSync(readyMarker)) return;
  mkdirSync(destination, { recursive: true });
  await downloadArchive(pin, pin.archive, onProgress);
  for (const archive of pin.extraArchives ?? []) await downloadArchive(pin, archive, onProgress);
  if (pin.platform !== "win32") chmodSync(engineBinaryPath(pin), 0o755);
  writeFileSync(readyMarker, new Date().toISOString());
  const { name, tag } = engineNameTag(pin.id);
  const current = engineCurrentPath(name);
  mkdirSync(resolve(current, ".."), { recursive: true, mode: 0o700 });
  try { unlinkSync(current); } catch { /* First install has no current link. */ }
  symlinkSync(tag, current);
  writeEngineManifest({ kind: "engine", name, tag, assetUrl: pin.archive.url, sizeBytes: pin.archive.approxBytes, githubDigest: pin.archive.sha256, sha256: pin.archive.sha256, extractedAt: new Date().toISOString(), blobs: [] });
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
