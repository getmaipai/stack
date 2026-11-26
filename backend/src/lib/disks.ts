import { and, eq, ne } from "drizzle-orm";
import { existsSync, mkdirSync, accessSync, constants, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { db } from "@/db";
import { disks, models } from "@/db/schema";
import { dataDir, modelsDir } from "@/lib/paths";
import { readDiskSpace } from "@/lib/diskState";

export const MAIN_DISK_ID = "main";
export interface DiskView { id: string; label: string; root_path: string; connected: boolean; free_bytes: number; total_bytes: number; removable: boolean }
const within = (path: string, root: string): boolean => { const rel = relative(resolve(root), resolve(path)); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };
function diskRows() { return db.select().from(disks).all(); }
export async function listDisks(): Promise<DiskView[]> {
  const rows = diskRows();
  const additional = await Promise.all(rows.map(async (row) => {
    let connected = false; try { connected = statSync(row.rootPath).isDirectory(); } catch { /* unplugged */ }
    let free_bytes = 0, total_bytes = 0;
    if (connected) { try { const result = await readDiskSpace(row.rootPath); free_bytes = result.free; total_bytes = result.total; } catch { /* unknown capacity */ } }
    return { id: row.id, label: row.label, root_path: row.rootPath, connected, free_bytes, total_bytes, removable: !!row.removable };
  }));
  let mainSpace = { free: 0, total: 0 }; try { mainSpace = await readDiskSpace(dataDir); } catch { /* unavailable capacity */ }
  return [{ id: MAIN_DISK_ID, label: "This computer", root_path: dataDir, connected: true, free_bytes: mainSpace.free, total_bytes: mainSpace.total, removable: false }, ...additional];
}
export function addDisk(input: { label: string; rootPath: string; removable: boolean }): DiskView {
  const label = input.label.trim(); if (!label) throw new Error("Give this drive a name, then try again.");
  if (!isAbsolute(input.rootPath)) throw new Error("Choose an absolute folder path for this drive.");
  const rootPath = resolve(input.rootPath); let info;
  try { info = statSync(rootPath); accessSync(rootPath, constants.W_OK); } catch { throw new Error("Choose an existing folder you can write to, then try again."); }
  if (!info.isDirectory()) throw new Error("Choose a folder, not a file, for this drive.");
  if (within(rootPath, dataDir)) throw new Error("Choose a folder outside the Stack data folder.");
  for (const row of diskRows()) if (within(rootPath, row.rootPath) || within(row.rootPath, rootPath)) throw new Error("Choose a folder that does not overlap another drive's folder.");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "drive";
  let id = slug, n = 2; const used = new Set(diskRows().map((row) => row.id)); while (used.has(id) || id === MAIN_DISK_ID) id = `${slug}-${n++}`;
  mkdirSync(join(rootPath, "maipai-models"), { recursive: true });
  db.insert(disks).values({ id, label, rootPath, removable: input.removable ? 1 : 0, createdAt: new Date().toISOString() }).run();
  return { id, label, root_path: rootPath, connected: true, free_bytes: 0, total_bytes: 0, removable: input.removable };
}
export function removeDisk(id: string): void {
  if (id === MAIN_DISK_ID) throw new Error("This computer's drive cannot be removed.");
  const row = db.select().from(disks).where(eq(disks.id, id)).get(); if (!row) throw new Error(`Drive ${id} was not found.`);
  const count = db.select().from(models).where(eq(models.diskId, id)).all().length;
  if (count) throw new Error(`${count === 1 ? "1 model is" : `${count} models are`} on ${row.label}. Move ${count === 1 ? "it" : "them"} to another drive before removing this one.`);
  const loraCount = loraCountOnDisk(id);
  if (loraCount) throw new Error(`${loraCount === 1 ? "1 style is" : `${loraCount} styles are`} on ${row.label}. Move ${loraCount === 1 ? "it" : "them"} to another drive before removing this one.`);
  db.delete(disks).where(eq(disks.id, id)).run();
}
/** How many LoRAs (styles) keep their file on a drive; read from the unified store directly so this file does not import the LoRA code. */
function loraCountOnDisk(id: string): number {
  try { const parsed = JSON.parse(readFileSync(join(dataDir, "loras", "manifest.json"), "utf8")) as { loras?: Array<{ disk_id?: string | null }> }; return (parsed.loras ?? []).filter((record) => record.disk_id === id).length; } catch { return 0; }
}
export class DriveNotConnectedError extends Error { readonly kind = "drive_not_connected"; constructor(readonly diskId: string, readonly label: string) { super(`${label} is not connected. Plug it back in or choose another drive.`); this.name = "DriveNotConnectedError"; } }
export function modelsRootFor(diskId: string | null): string {
  if (!diskId || diskId === MAIN_DISK_ID) return modelsDir;
  const row = db.select().from(disks).where(eq(disks.id, diskId)).get();
  if (!row) throw new DriveNotConnectedError(diskId, diskId);
  try { if (!statSync(row.rootPath).isDirectory()) throw new Error(); } catch { throw new DriveNotConnectedError(diskId, row.label); }
  return join(row.rootPath, "maipai-models");
}
export function diskIdOfPath(path: string): string | null {
  const matches = diskRows().filter((row) => within(path, join(row.rootPath, "maipai-models"))).sort((a,b) => b.rootPath.length-a.rootPath.length);
  if (matches.length) return matches[0]!.id;
  return within(path, modelsDir) ? null : null;
}
export function isManagedModelPath(path: string): boolean {
  if (within(path, modelsDir)) return true;
  return diskRows().some((row) => within(path, join(row.rootPath, "maipai-models")));
}
export function diskStatus(diskId: string | null): { connected: boolean; label: string } {
  if (!diskId || diskId === MAIN_DISK_ID) return { connected: true, label: "This computer" };
  const row = db.select().from(disks).where(eq(disks.id, diskId)).get();
  if (!row) return { connected: false, label: diskId };
  try { return { connected: statSync(row.rootPath).isDirectory(), label: row.label }; } catch { return { connected: false, label: row.label }; }
}
export function connectedModelRoots(): string[] { return diskRows().flatMap((row) => { try { return statSync(row.rootPath).isDirectory() ? [join(row.rootPath, "maipai-models")] : []; } catch { return []; } }); }
export function modelRootForPath(path: string): string | null { return [modelsDir, ...diskRows().map((row) => join(row.rootPath, "maipai-models"))].filter((root) => within(path, root)).sort((a, b) => b.length - a.length)[0] ?? null; }

/** STACK-LORAS-01: where LoRA files live on a drive (`<drive>/loras`). Null for the Stack's own data directory, whose LoRAs stay in their media's own folders (data/images/loras, data/video/loras). Throws `DriveNotConnectedError` for a drive that is unknown or unplugged, so an install or move never writes to a missing drive. */
export function loraRootFor(diskId: string | null | undefined): string | null {
  if (!diskId || diskId === MAIN_DISK_ID) return null;
  const row = db.select().from(disks).where(eq(disks.id, diskId)).get();
  if (!row) throw new DriveNotConnectedError(diskId, diskId);
  try { if (!statSync(row.rootPath).isDirectory()) throw new Error(); } catch { throw new DriveNotConnectedError(diskId, row.label); }
  return join(row.rootPath, "loras");
}
/** Where a LoRA's file would be on a drive, without checking the drive is plugged in (a reader decides what a missing drive means). Null for the main disk. */
export function loraRootPath(diskId: string | null | undefined): string | null {
  if (!diskId || diskId === MAIN_DISK_ID) return null;
  const row = db.select().from(disks).where(eq(disks.id, diskId)).get();
  return row ? join(row.rootPath, "loras") : join("/nonexistent-drive", diskId, "loras");
}
