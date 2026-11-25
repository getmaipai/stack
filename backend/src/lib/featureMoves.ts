import diskRowFeatures from "@/rows/diskRowFeatures.json";
import { CATEGORY_DEFS, defOf } from "@/lib/choiceCategories";
import { DISK_ROW } from "@/lib/components";
import { listModels } from "@/lib/modelStore";
import { unloadRole } from "@/lib/supervisor";
import { planModelMove, runModelMove, type MovePlan } from "@/lib/moveModels";

const featureOf = (modelId: string): string | null => { const row = DISK_ROW[modelId]; return row ? (diskRowFeatures as Record<string, string | null>)[row] ?? null : null; };

/** The installed models that belong to a feature, found through the disk rows (no per-feature code). */
export function modelIdsForFeature(featureId: string): string[] {
  if (!defOf(featureId)) throw new Error(`There is no feature called ${featureId}. Pick one from the Features list.`);
  return listModels().filter((model) => !!model.modelPath && featureOf(model.id) === featureId).map((model) => model.id);
}
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
