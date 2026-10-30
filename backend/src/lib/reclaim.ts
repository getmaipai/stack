// MEM-SPACE-03/04: "make space now" for the Performance page. Lists and unloads only what this Stack loaded itself and nothing is using: idle
// jit roles, the idle picture worker (after its 2 minute grace) and finished burst workers, in the governor's eviction order. It never touches
// reserved chat, a busy item, or any process the Stack does not own, and it reports counts and bytes only (no app or person names).
import { beginEvicting, cancelEvicting, forgetLoadedItem, reclaimableItems, unloadImagePool, type ReclaimItem } from "@/lib/governor";

export interface ReclaimDeps {
  busy: (id: string) => boolean;
  unload: (id: string) => Promise<boolean>;
  now?: () => number;
}

async function defaultDeps(): Promise<ReclaimDeps> {
  const supervisor = await import("@/lib/supervisor");
  return {
    busy: (id) => { try { return supervisor.getRoleStatus(id as Parameters<typeof supervisor.getRoleStatus>[0]).state === "busy"; } catch { return false; } },
    unload: (id) => (id === "image-pool" ? unloadImagePool() : supervisor.unloadJitForGovernor(id)),
  };
}

export async function listReclaimable(deps?: ReclaimDeps): Promise<{ items: ReclaimItem[]; total_bytes: number; held_for_grace_bytes: number }> {
  const d = deps ?? await defaultDeps();
  const { items, heldForGraceBytes } = reclaimableItems(d.busy, d.now?.());
  return { items, total_bytes: items.reduce((sum, item) => sum + item.bytes, 0), held_for_grace_bytes: heldForGraceBytes };
}

let running = false;
/** Unloads the listed items one at a time. A second call while one runs unloads nothing. An item that declines (it became busy) stays loaded and is not counted. */
export async function runReclaim(deps?: ReclaimDeps): Promise<{ unloaded: number; freed_bytes: number }> {
  if (running) return { unloaded: 0, freed_bytes: 0 };
  running = true;
  try {
    const d = deps ?? await defaultDeps();
    let unloaded = 0, freed = 0;
    for (const item of reclaimableItems(d.busy, d.now?.()).items) {
      if (d.busy(item.id)) continue;
      if (!beginEvicting(item.id)) continue;
      let ok = false;
      try { ok = await d.unload(item.id); } catch { ok = false; }
      if (!ok) { cancelEvicting(item.id); continue; }
      forgetLoadedItem(item.id);
      unloaded++;
      freed += item.bytes;
    }
    return { unloaded, freed_bytes: freed };
  } finally { running = false; }
}
