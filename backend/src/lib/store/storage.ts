import { existsSync, readdirSync, realpathSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { modelManifestRoot } from "@/lib/store/layout";
import { listModelManifests } from "@/lib/store/manifests";
import { raise, resolve as resolveHealth } from "@/lib/health";

export interface StorageReport {
  totalBytes: number;
  byCategory: { models: number; engines: number; logs: number; backups: number; other: number };
  models: { byAbility: Record<string, number>; sharedBytes: number };
  freeDiskBytes: number;
  updatedAt: string;
}

let cached: { root: string; expiresAt: number; report: StorageReport } | null = null;

function physicalKey(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}`;
  } catch { return realpathSync(path); }
}

function filesUnder(root: string, skip: (path: string) => boolean = () => false): Array<{ path: string; size: number; key: string }> {
  if (!existsSync(root)) return [];
  const result: Array<{ path: string; size: number; key: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip(path)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        try { result.push({ path, size: statSync(path).size, key: physicalKey(path) }); } catch { /* Files disappearing during accounting are omitted. */ }
      }
    }
  };
  walk(root);
  return result;
}

function sumUnique(files: Array<{ size: number; key: string }>): number {
  const seen = new Set<string>();
  return files.reduce((sum, file) => seen.has(file.key) ? sum : (seen.add(file.key), sum + file.size), 0);
}

function abilityFor(role: string): string {
  if (["chat", "coding", "judge", "router"].includes(role)) return "chat";
  if (["stt", "tts", "wakeword"].includes(role)) return "voice";
  if (role === "image" || role === "vision") return "images";
  if (role === "video") return "video";
  if (role === "music") return "music";
  return "other";
}

export function storageAccounting(root = dataDir): StorageReport {
  if (cached && cached.root === root && cached.expiresAt > Date.now()) return cached.report;
  const categoryRoots = {
    models: join(root, "models"), engines: join(root, "engines"), logs: join(root, "logs"), backups: join(root, "backups"), other: root,
  };
  const manifestRoot = join(root, "models", "manifests");
  const modelFiles = filesUnder(categoryRoots.models, (path) => path === manifestRoot || path.startsWith(`${manifestRoot}/`));
  const engines = filesUnder(categoryRoots.engines);
  const logs = filesUnder(categoryRoots.logs);
  const backups = filesUnder(categoryRoots.backups);
  const ignored = new Set([...modelFiles, ...engines, ...logs, ...backups].map((file) => file.key));
  const other = filesUnder(categoryRoots.other, (path) => path === categoryRoots.models || path.startsWith(`${categoryRoots.models}/`) || path === categoryRoots.engines || path.startsWith(`${categoryRoots.engines}/`) || path === categoryRoots.logs || path.startsWith(`${categoryRoots.logs}/`) || path === categoryRoots.backups || path.startsWith(`${categoryRoots.backups}/`)).filter((file) => !ignored.has(file.key));
  const byCategory = { models: sumUnique(modelFiles), engines: sumUnique(engines), logs: sumUnique(logs), backups: sumUnique(backups), other: sumUnique(other) };
  const byAbility: Record<string, number> = { chat: 0, voice: 0, images: 0, video: 0, music: 0, other: 0 };
  let sharedBytes = 0;
  for (const manifest of listModelManifests(manifestRoot)) {
    const abilities = [...new Set(manifest.roles.map(abilityFor))];
    for (const blob of manifest.blobs) {
      const bytes = blob.sizeBytes;
      for (const ability of abilities) byAbility[ability] = (byAbility[ability] ?? 0) + bytes;
      if (blob.shared) sharedBytes += bytes;
    }
  }
  const freeDiskBytes = (() => { try { const stat = statfsSync(root); return stat.bavail * stat.bsize; } catch { return 0; } })();
  if (freeDiskBytes > 0 && freeDiskBytes < 10 * 1_073_741_824) raise({ code: "disk-under-reserve", severity: "warning", title: "Disk space is running low", text: "The Stack is below its 10 GB free-space reserve.", cause: "The filesystem reported less than the Stack's reserve.", fix: { label: "Remove stored data", action: "free_disk" } }); else resolveHealth("disk-under-reserve");
  const report = { totalBytes: Object.values(byCategory).reduce((sum, value) => sum + value, 0), byCategory, models: { byAbility, sharedBytes }, freeDiskBytes, updatedAt: new Date().toISOString() };
  cached = { root, expiresAt: Date.now() + 30_000, report };
  return report;
}

export function invalidateStorageAccounting(): void { cached = null; }
