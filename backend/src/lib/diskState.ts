import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { diskLevel, diskLines } from "@maipai/spec/stack/ts/disk-levels.js";
import { modelsDir, dataDir } from "@/lib/paths";
import { engineRoot } from "@/lib/store/layout";
import { selectedModel } from "@/lib/supervisor";
import { ROLE_IDS } from "@/roles";
import { getModel } from "@/lib/modelStore";
import { STACK_MODELS, STACK_IMAGE_H3_MODELS, STACK_IMAGE_H3_ID, STACK_VIDEO_H3_MODELS, STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_MODEL_ID, STACK_VIDEO_TOKENIZER_ID } from "@/lib/modelCatalog";
import { H3_LAYOUT } from "@/images/h3Layout";
import { detectHardware } from "@maipai/core/src/hardware";

export interface MissingModelFiles { role: string; model: string; missing_paths: string[]; }
/** Files the selected role model actually reads, following its pinned install layout. */
export function missingModelFiles(): MissingModelFiles[] {
  const result: MissingModelFiles[] = [];
  for (const role of ROLE_IDS) {
    const model = selectedModel(role);
    if (!model) continue;
    let required: string[];
    if (role === "video" && process.env.MAIPAI_H3_VIDEO_HOME && model.id === STACK_VIDEO_H3_MODEL_ID) {
      const home = process.env.MAIPAI_H3_VIDEO_HOME;
      const models = join(home, "models/minimax_h3");
      required = [join(home, "node/scripts/generate_staged.py"), join(home, ".venv/bin/python"), join(models, "upstream/FL2VA"), join(models, "qwen/8-bit"), join(models, "transformers/8-bit")];
    } else {
      const pin = [...STACK_MODELS, ...STACK_IMAGE_H3_MODELS, ...STACK_VIDEO_H3_MODELS].find((candidate) => candidate.id === model.id);
      if (pin && model.id === STACK_IMAGE_H3_ID) {
        required = H3_LAYOUT.map((entry) => getModel(entry.id)?.modelPath ?? "");
      } else if (role === "video" && model.id === STACK_VIDEO_MODEL_ID) {
        const tokenizer = getModel(STACK_VIDEO_TOKENIZER_ID);
        required = [model.modelPath ? join(model.modelPath, "model.safetensors") : "", tokenizer?.modelPath ? join(tokenizer.modelPath, "tokenizer.json") : ""];
      } else if (model.modelPath) {
        const download = pin?.download;
        required = download?.files?.length ? download.files.map((file) => join(model.modelPath!, file.path)) : [model.modelPath];
      } else required = [];
    }
    const missing = required.filter((path) => !existsSync(path));
    if (missing.length) result.push({ role, model: model.id, missing_paths: missing });
  }
  return result;
}

export type DiskLevel = "normal" | "warn" | "critical";
export interface DiskVolume { path: string; free_bytes: number; total_bytes: number; level: DiskLevel; warn_bytes: number; critical_bytes: number; }
type Reader = (path: string) => Promise<{ free: number; total: number; device?: number }> | { free: number; total: number; device?: number };
const GB = 1_000_000_000;
const REFUSAL = "There is not enough room left on this computer for that. Free up space in Settings, then try again.";
const levels = new Map<string, DiskLevel>();
let volumes: DiskVolume[] = [];
let sampledAt = 0;
const realReader: Reader = async (path) => { const s = await detectHardware({ diskPath: path }); return { free: s.freeDiskBytes ?? 0, total: s.totalDiskBytes ?? 0, device: Number(statSync(path).dev) }; };
const safeReader: Reader = process.env.MAIPAI_TEST_NO_PORTS ? () => ({ free: 500_000_000_000, total: 1_000_000_000_000, device: 1 }) : realReader;
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
