// Plain words for the Modes screen: what the Stack's coding mode is doing, and each role's state.
export interface ModeView {
  mode: "normal" | "coding"; target: "normal" | "coding"; state: "stable" | "waiting" | "switching" | "failed";
  reason: string | null; available: boolean;
  checks: { engine: boolean; pieces: boolean; hardware: boolean; memory: boolean; bench: boolean };
  self_test: { passed_at: string | null; stale: boolean };
  memory: { plan_bytes: number; budget_bytes: number };
}
export const modeName = (m: "normal" | "coding") => (m === "coding" ? "Max coding" : "Normal");
export function modeHeadline(v: ModeView): string {
  if (v.state === "switching") return `Switching to ${modeName(v.target)}. This takes a few minutes while the large model loads.`;
  if (v.state === "waiting") return `Waiting to switch to ${modeName(v.target)} until the work in progress finishes.`;
  if (v.state === "failed") return `The switch to ${modeName(v.target)} did not finish. The Stack is still in ${modeName(v.mode)} mode.`;
  return `${modeName(v.mode)} mode is on.`;
}
export const modeBusy = (v: ModeView) => v.state === "switching" || v.state === "waiting";
export const failureText = (v: ModeView) => v.state === "failed" ? (v.reason ?? "The Stack did not say why. Try again, and check the log if it keeps failing.") : null;
export function roleWord(state: string): string {
  return state === "ready" ? "On and ready" : state === "loaded" ? "Starting" : state === "installed" ? "Installed, not running" : state === "notInstalled" ? "Not installed" : "Off";
}
export const roleTone = (state: string) => (state === "ready" ? "ok" : state === "loaded" ? "warn" : state === "offline" ? "bad" : "muted") as "ok" | "warn" | "bad" | "muted";
