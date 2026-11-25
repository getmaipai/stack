import type { StackDrive, StackDriveFeature } from "@maipai/ui/src/stack/StackClient";
import { bytes } from "./format";

export interface DriveDetail { drive: StackDrive; usedBytes: number; features: { id: string; label: string; bytes: number }[] }
export function driveDetails(disks: StackDrive[], features: StackDriveFeature[]): DriveDetail[] {
  return disks.map((drive) => {
    const rows = features.filter((feature) => feature.drive_ids.includes(drive.id) || feature.drives.some((d) => d.id === drive.id));
    return { drive, usedBytes: Math.max(0, drive.total_bytes - drive.free_bytes), features: rows.map((f) => ({ id: f.feature_id, label: f.label, bytes: Math.round(f.bytes / Math.max(1, f.drive_ids.length)) })) };
  });
}
export function modelsHint(disks: StackDrive[] | null, features: StackDriveFeature[] | null): string | null {
  if (!disks || !features) return null;
  if (!disks.length) return "No drives are listed. Models on disk could not be counted.";
  const rows = driveDetails(disks, features);
  const carrying = rows.filter((r) => r.features.length > 0);
  const names = carrying.map((r) => r.drive.label);
  const location = names.length ? `On ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}.` : "No models are assigned to a drive.";
  const free = rows.map((r) => `${bytes(r.drive.free_bytes)} free`).join(". ");
  const count = features.length;
  const size = features.reduce((sum, feature) => sum + feature.bytes, 0);
  return `${location} ${free}. ${bytes(size)} total across ${count} ${count === 1 ? "model" : "models"}.`;
}
export function requestRate(points: { t: number; queue: number }[]): string | null {
  if (points.length < 2) return null;
  const seconds = Math.abs(points[points.length - 1]!.t - points[0]!.t);
  if (!seconds) return null;
  const peak = Math.max(...points.map((p) => p.queue));
  const mean = points.reduce((sum, p) => sum + p.queue, 0) / points.length;
  return `Peak queue ${peak}; average ${mean.toFixed(1)} waiting over the last hour.`;
}
