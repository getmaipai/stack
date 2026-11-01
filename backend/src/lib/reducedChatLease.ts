// TIER-REDUCED-ROUTE: the control behind POST /stack/v1/tiers/reduced. Home puts chat in Reduced while a Max job runs and renews the
// request while it still needs it. If Home stops renewing (it crashed), the Stack leaves Reduced by itself after the cap.
import { getReducedChatState } from "@/lib/reducedChat";
import { enterReducedChat, leaveReducedChat } from "@/lib/supervisor";

type Swap = { ok: true; swapMs: number } | { ok: false; waiting: true } | { ok: false; reason: string };
export type ReducedControlResult =
  | { status: 200; body: { ok: true; swap_ms: number; reduced: boolean } }
  | { status: 202; body: { ok: false; waiting: true; reduced: boolean } }
  | { status: 409 | 503; body: { ok: false; reason: string; reduced: boolean } };
type Deps = { enter: () => Promise<Swap>; leave: () => Promise<Swap> };

export const DEFAULT_REDUCED_CAP_MS = 30 * 60_000;
const RETRY_MS = 15_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let capOverrideMs: number | null = null;
let retryOverrideMs: number | null = null;
let deps: Deps = { enter: enterReducedChat, leave: leaveReducedChat };

export const isReducedChat = (): boolean => getReducedChatState() === "reduced";
/** STACK_REDUCED_CHAT_CAP_MS overrides the 30 minute default. */
export function reducedChatCapMs(): number {
  if (capOverrideMs !== null) return capOverrideMs;
  const configured = Number(process.env.STACK_REDUCED_CHAT_CAP_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REDUCED_CAP_MS;
}

function clearLease(): void { if (timer) clearTimeout(timer); timer = null; }
function armLease(delayMs = reducedChatCapMs()): void {
  clearLease();
  timer = setTimeout(expire, delayMs);
  (timer as unknown as { unref?: () => void }).unref?.();
}
async function expire(): Promise<void> {
  timer = null;
  if (!isReducedChat()) return;
  let result: Swap | null = null;
  try { result = await deps.leave(); } catch { /* retried below */ }
  if (isReducedChat() && !(result && result.ok)) armLease(retryOverrideMs ?? RETRY_MS); // a chat turn is running, or the swap failed: try again
}

export async function controlReducedChat(on: boolean): Promise<ReducedControlResult> {
  const state = getReducedChatState();
  if (on && state === "reduced") { armLease(); return { status: 200, body: { ok: true, swap_ms: 0, reduced: true } }; }
  if (!on && state === "off") { clearLease(); return { status: 200, body: { ok: true, swap_ms: 0, reduced: false } }; }
  let result: Swap;
  try { result = await (on ? deps.enter() : deps.leave()); } catch {
    return { status: 503, body: { ok: false, reason: "Chat could not change its size just now. Try again in a moment.", reduced: isReducedChat() } };
  }
  const reduced = isReducedChat();
  if (reduced) armLease(); else clearLease();
  if (result.ok) return { status: 200, body: { ok: true, swap_ms: result.swapMs, reduced } };
  if ("waiting" in result) return { status: 202, body: { ok: false, waiting: true, reduced } };
  return { status: result.reason.startsWith("Chat could not") ? 503 : 409, body: { ok: false, reason: result.reason, reduced } };
}

export function __setReducedLeaseForTests(options: { capMs?: number | null; retryMs?: number | null; deps?: Deps | null } | null): void {
  clearLease();
  capOverrideMs = options?.capMs ?? null;
  retryOverrideMs = options?.retryMs ?? null;
  deps = options?.deps ?? { enter: enterReducedChat, leave: leaveReducedChat };
}
