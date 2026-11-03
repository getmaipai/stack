// TIER-ROUTES-01: the Stack swaps chat itself when the Max window needs the room. The governor tells this file when a Max window starts
// draining or opens (Reduced only when the job still would not fit the computer's real memory after idle models are given back, MAX-LIVE-01) and when it closes; chat goes to Reduced then and comes back,
// through the same control Home's POST /stack/v1/tiers/reduced uses, so the two never fight: Home may still call the route, but is not required to.
import { setMaxWindowHook, type MaxWindowChange } from "@/lib/governor";
import { controlReducedChat, isReducedChat, reducedChatCapMs } from "@/lib/reducedChatLease";

const WAITING_RETRY_MS = 5_000;
let wanted = false;
let owned = false; // this file entered Reduced (Home or an admin may have entered it first; that is not ours to leave)
let chain: Promise<void> = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | null = null;
let retryOverrideMs: number | null = null;
let renewOverrideMs: number | null = null;

function arm(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; step(); }, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
}
function disarm(): void { if (timer) clearTimeout(timer); timer = null; }

/** One swap at a time (the in-flight guard): every change queues behind the one running. The step re-reads `wanted`, so a close that arrives mid-enter leaves right after. */
function step(): void {
  chain = chain.then(async () => {
    if (wanted) {
      const wasReduced = isReducedChat();
      const result = await controlReducedChat(true, "max-window");
      if (!wanted) return; // closed while entering: the queued close step leaves
      if (result.status === 200) { if (!wasReduced) owned = true; if (owned) arm(renewOverrideMs ?? Math.max(1_000, Math.floor(reducedChatCapMs() / 2))); }
      else if (result.status === 202) arm(retryOverrideMs ?? WAITING_RETRY_MS); // a chat turn is running: try again between turns
    } else if (owned) {
      const result = await controlReducedChat(false, "max-window");
      if (result.status === 200) owned = false;
      else if (result.status === 202) arm(retryOverrideMs ?? WAITING_RETRY_MS);
      else owned = false; // the lease cap or the self-heal owns a swap that failed
    }
  }).catch(() => {});
}

export function onMaxWindowChange(change: MaxWindowChange): void {
  if (change.state === "closed") { wanted = false; disarm(); step(); return; }
  if (!change.needsReduced || wanted) return;
  wanted = true;
  step();
}

/** Called once at start (daemon.ts); safe to call again. */
export function wireMaxWindowReduced(): void { setMaxWindowHook(onMaxWindowChange); }
export function unwireMaxWindowReduced(): void { setMaxWindowHook(null); }
/** Resolves when every queued swap has finished (tests). */
export function maxWindowReducedIdle(): Promise<void> { return chain; }
export function __resetMaxWindowReducedForTests(options?: { retryMs?: number; renewMs?: number }): void {
  disarm(); wanted = false; owned = false; chain = Promise.resolve();
  retryOverrideMs = options?.retryMs ?? null; renewOverrideMs = options?.renewMs ?? null;
}
