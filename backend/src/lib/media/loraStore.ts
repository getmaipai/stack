// STACK-LORAS-01: the one LoRA store. Pictures and video used to keep a manifest
// each (data/images/loras and data/video/loras); now one manifest, data/loras/manifest.json,
// holds every record with a `media` field. The first read after an upgrade merges the two old
// manifests in, idempotently by id (a record already in the store wins; nothing is ever removed
// and no file is copied or moved: files stay where they were, `disk_id` null). The old manifests
// are left untouched as a backup. Both libraries (images/loras.ts, video/loras.ts) and the
// unified catalog (loraCatalog.ts) read and write through here.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import { diskStatus, loraRootPath } from "@/lib/disks";
import type { LoraMedia, LoraRecord } from "@/lib/media/loraLibrary";

export const loraStorePath = (): string => join(dataDir, "loras", "manifest.json");
/** The folder a media's files stay in on the main disk. */
export const legacyLoraDir = (media: LoraMedia): string => join(dataDir, media === "picture" ? "images" : "video", "loras");

function readJson(path: string): LoraRecord[] {
  try { const parsed = JSON.parse(readFileSync(path, "utf8")) as { loras?: LoraRecord[] }; return Array.isArray(parsed.loras) ? parsed.loras : []; } catch { return []; }
}
function writeJson(path: string, records: LoraRecord[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ loras: records }, null, 1), { mode: 0o600 });
  renameSync(temp, path);
}

let mergedFor: string | null = null;
export function __resetLoraStoreForTests(): void { mergedFor = null; }

/** Adds every record of the two old manifests the store does not have yet. Returns how many were added. Safe to run any number of times. */
export function mergeLegacyManifests(): number {
  const path = loraStorePath();
  const current = readJson(path);
  const known = new Set(current.map((record) => record.id));
  const added: LoraRecord[] = [];
  for (const media of ["picture", "video"] as const) {
    for (const record of readJson(join(legacyLoraDir(media), "manifest.json"))) {
      if (known.has(record.id)) continue;
      known.add(record.id);
      added.push({ ...record, media, disk_id: record.disk_id ?? null, status: record.status ?? "ready", removed_at: record.removed_at ?? null, trash_until: record.trash_until ?? null });
    }
  }
  if (added.length || !existsSync(path)) writeJson(path, [...current, ...added]);
  return added.length;
}

function ensureMerged(): void {
  const path = loraStorePath();
  if (mergedFor === path && existsSync(path)) return;
  mergeLegacyManifests();
  mergedFor = path;
}

export function readAllLoras(): LoraRecord[] { ensureMerged(); return readJson(loraStorePath()); }
export function writeAllLoras(records: LoraRecord[]): void { ensureMerged(); writeJson(loraStorePath(), records); }
export const readMediaLoras = (media: LoraMedia): LoraRecord[] => readAllLoras().filter((record) => (record.media ?? "picture") === media).map((record) => ({ ...record }));
/** Replaces one media's records and keeps the other's as they are. */
export function writeMediaLoras(media: LoraMedia, records: LoraRecord[]): void {
  const others = readAllLoras().filter((record) => (record.media ?? "picture") !== media);
  writeAllLoras([...others, ...records.map((record) => ({ ...record, media }))]);
}

/** Where a record's file is: its drive's `loras` folder, or its media's own folder on the main disk. */
export function loraFileOn(media: LoraMedia, id: string, diskId: string | null): string {
  const root = loraRootPath(diskId);
  return join(root ?? legacyLoraDir(media), `${id}.safetensors`);
}
/** A plain sentence when the record's drive is not plugged in, else null. */
export function loraDriveProblem(record: Pick<LoraRecord, "disk_id" | "name">): string | null {
  const diskId = record.disk_id ?? null;
  if (!diskId || diskId === "main") return null;
  const status = diskStatus(diskId);
  return status.connected ? null : `"${record.name}" is on ${status.label}, which is not connected. Plug it back in, or move the style to another drive.`;
}

/** The store hook a library takes: its media's records and file paths. */
export function loraStoreFor(media: LoraMedia) {
  return { media, read: () => readMediaLoras(media), write: (records: LoraRecord[]) => writeMediaLoras(media, records), fileOn: (id: string, diskId: string | null) => loraFileOn(media, id, diskId), driveProblem: loraDriveProblem };
}
