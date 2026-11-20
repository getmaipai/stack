import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { diskLevel, diskLines } from "@maipai/spec/stack/ts/disk-levels.js";
import { modelsDir, dataDir } from "@/lib/paths";
import { engineRoot } from "@/lib/store/layout";
import { detectHardware } from "@maipai/core/src/hardware";

export type DiskLevel = "normal" | "warn" | "critical";
export interface DiskVolume { path: string; free_bytes: number; total_bytes: number; level: DiskLevel; warn_bytes: number; critical_bytes: number; }
type Reader = (path: string) => Promise<{ free: number; total: number; device?: number }> | { free: number; total: number; device?: number };
const GB = 1_000_000_000;
const REFUSAL = "There is not enough room left on this computer for that. Free up space in Settings, then try again.";
const levels = new Map<string, DiskLevel>();
let volumes: DiskVolume[] = [];
let sampledAt = 0;
const realReader: Reader = async (path) => { const s = await detectHardware({ diskPath: path }); return { free: s.freeDiskBytes ?? 0, total: s.totalDiskBytes ?? 0, device: Number(statSync(path).dev) }; };
const safeReader: Reader = process.env.NODE_ENV === "test" ? () => ({ free: 500_000_000_000, total: 1_000_000_000_000, device: 1 }) : realReader;
let reader: Reader = safeReader;
const paths = () => [modelsDir, engineRoot, join(dataDir, "jobs")];
let runtimeConfig = { warn_free_gb: 0, critical_free_gb: 0 };
export function setDiskConfig(config: { warn_free_gb: number; critical_free_gb: number }): void { runtimeConfig = { ...config }; sampledAt = 0; }
export function getDiskConfig(): { warn_free_gb: number; critical_free_gb: number } { return { ...runtimeConfig }; }
function sample(force = false): Promise<void> {
  if (sampling) return sampling;
  sampling = doSample(force).finally(() => { sampling = null; });
  return sampling;
}
let sampling: Promise<void> | null = null;
async function doSample(force = false): Promise<void> {
  if (!force && Date.now() - sampledAt < 60_000) return;
  sampledAt = Date.now();
  const seen = new Set<number>(); const next: DiskVolume[] = [];
  for (const path of paths()) {
    try {
      let probe = path; while (true) { try { statSync(probe); break; } catch { probe = resolve(probe, ".."); } }
      const stats = await reader(probe); if (stats.device !== undefined && seen.has(stats.device)) continue;
      if (stats.device !== undefined) seen.add(stats.device);
      const previous = levels.get(resolve(path)) ?? "normal";
      const level = diskLevel(stats.free, stats.total, previous, { warnFreeGb: runtimeConfig.warn_free_gb, criticalFreeGb: runtimeConfig.critical_free_gb });
      levels.set(resolve(path), level);
      const lines = diskLines(stats.total, { warnFreeGb: runtimeConfig.warn_free_gb, criticalFreeGb: runtimeConfig.critical_free_gb });
      next.push({ path, free_bytes: stats.free, total_bytes: stats.total, level, warn_bytes: lines.warnBytes, critical_bytes: lines.criticalBytes });
    } catch { /* An unavailable storage folder is omitted until it can be sampled. */ }
  }
  volumes = next;
}
export async function diskLevelNow(): Promise<DiskLevel> { await sample(); return volumes.reduce<DiskLevel>((worst, v) => v.level === "critical" || (v.level === "warn" && worst === "normal") ? v.level : worst, "normal"); }
export async function latestDisk(): Promise<{ level: DiskLevel; volumes: DiskVolume[] }> { await sample(); return { level: await diskLevelNow(), volumes: volumes.map((v) => ({ ...v })) }; }
export interface DiskRefusal { kind: "disk"; reason: string }
export class DiskRefusalError extends Error implements DiskRefusal { readonly kind = "disk" as const; readonly reason: string; constructor(reason: string) { super(reason); this.reason = reason; this.name = "DiskRefusalError"; } }
export async function lowDiskRefusal(): Promise<DiskRefusal | null> { return await diskLevelNow() === "critical" ? { kind: "disk", reason: REFUSAL } : null; }
export async function diskAdmission(needBytes: number, path?: string): Promise<{ ok: true } | { ok: false; kind: "disk"; reason: string }> {
  await sample(); const candidates = path ? volumes.filter((v) => resolve(v.path) === resolve(path)) : volumes;
  const criticalBytes = runtimeConfig.critical_free_gb * GB;
  if (candidates.some((v) => v.free_bytes - Math.max(0, needBytes) < (criticalBytes || v.critical_bytes))) return { ok: false, kind: "disk", reason: REFUSAL };
  return { ok: true };
}
export function __setDiskReaderForTests(next: Reader | null): void { reader = next ?? safeReader; volumes = []; levels.clear(); sampledAt = 0; sampling = null; runtimeConfig = { warn_free_gb: 0, critical_free_gb: 0 }; }
export async function __sampleDiskForTests(): Promise<void> { await sample(true); }
