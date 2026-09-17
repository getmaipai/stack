import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READY_MARKER, type EngineArchive, type EngineBinaryPin } from "@/lib/engineCatalog";
import { extractArchive } from "@/lib/archive";
import { downloadUrl } from "@/lib/download";
import { dataDir } from "@/lib/paths";

export function engineDir(id: string): string {
  return join(process.env.STACK_DATA_DIR ?? dataDir, "engines", id);
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
}
