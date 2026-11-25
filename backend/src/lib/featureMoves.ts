import diskRowFeatures from "@/rows/diskRowFeatures.json";
import { CATEGORY_DEFS, defOf } from "@/lib/choiceCategories";
import { DISK_ROW } from "@/lib/components";
import { existsSync } from "node:fs";
import { listModels } from "@/lib/modelStore";
import { diskStatus } from "@/lib/disks";
import { unloadRole } from "@/lib/supervisor";
import { planModelMove, runModelMove, type MovePlan } from "@/lib/moveModels";

export const featureOf = (modelId: string): string | null => { const row = DISK_ROW[modelId]; return row ? (diskRowFeatures as Record<string, string | null>)[row] ?? null : null; };

/** The installed models that belong to a feature, found through the disk rows (no per-feature code). */
export function modelIdsForFeature(featureId: string): string[] {
  if (!defOf(featureId)) throw new Error(`There is no feature called ${featureId}. Pick one from the Features list.`);
  return installedModels(featureId).map((model) => model.id);
}
/** A model counts as installed only when its files are on disk: a catalog entry that was never downloaded keeps a planned path but has nothing to move. */
const installedModels = (featureId: string) => listModels().filter((model) => !!model.modelPath && existsSync(model.modelPath) && featureOf(model.id) === featureId);
export const featureIds = (): string[] => CATEGORY_DEFS.map((def) => def.id);

export interface BatchPlan { model_ids: string[]; plans: Array<MovePlan & { model_id: string }>; bytes: number }
export async function planBatch(modelIds: string[], toDiskId: string): Promise<BatchPlan> {
  if (!modelIds.length) throw new Error("There are no installed files to move for that choice.");
  const plans: BatchPlan["plans"] = [];
  for (const id of modelIds) plans.push({ model_id: id, ...await planModelMove(id, toDiskId) });
  return { model_ids: modelIds, plans, bytes: plans.reduce((n, plan) => n + plan.bytes, 0) };
}

let running: AbortController | null = null;
export const moveBatchRunning = (): boolean => running !== null;
export function cancelBatch(): boolean { if (!running) return false; running.abort(); return true; }

/** Moves each model in turn. The feature's engine is unloaded before the copy and again before the switch so it never reads a half-moved file; the next request starts it on the new copy. */
export function startBatch(modelIds: string[], toDiskId: string, roles: string[], deps: { run?: typeof runModelMove; unload?: (role: string) => Promise<unknown> } = {}): Promise<void> {
  if (running) throw new Error("Another move is running. Wait for it to finish.");
  const controller = running = new AbortController();
  const run = deps.run ?? runModelMove, unload = deps.unload ?? ((role: string) => unloadRole(role as never, "Moving files to another drive.", "maintenance-restart"));
  const unloadAll = async () => { for (const role of roles) await unload(role).catch(() => undefined); };
  return (async () => {
    try {
      await unloadAll();
      for (const id of modelIds) await run(id, toDiskId, { signal: controller.signal, hooks: { afterVerify: unloadAll, afterSwitch: unloadAll } });
    } finally { running = null; }
  })();
}
export const rolesForFeature = (featureId: string): string[] => { const role = defOf(featureId)?.role; return role ? [role] : []; };

export interface FeatureLocation { feature_id: string; label: string; bytes: number; drive_ids: string[]; drives: Array<{ id: string; label: string; connected: boolean }> }
/** Where each feature's installed files are. A feature with no installed files is left out. */
export function featureLocations(): FeatureLocation[] {
  const out: FeatureLocation[] = [];
  for (const def of CATEGORY_DEFS) {
    const models = installedModels(def.id);
    if (!models.length) continue;
    const ids = [...new Set(models.map((model) => model.diskId ?? "main"))];
    out.push({ feature_id: def.id, label: def.label, bytes: models.reduce((n, model) => n + (model.sizeBytes ?? 0), 0), drive_ids: ids, drives: ids.map((id) => { const d = diskStatus(id === "main" ? null : id); return { id, label: d.label, connected: d.connected }; }) });
  }
  return out;
}
