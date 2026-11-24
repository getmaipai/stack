// The readiness steps a category carries on the AI and models read (docs/dev/choices.md): installed, loaded, ready, judged from the role's
// own state. Pure: the caller passes the state and the offline reason; nothing here reads the supervisor or the stores.
import type { RoleState } from "@/roles";

export interface Step {
  id: "installed" | "loaded" | "ready";
  label: string;
  status: "done" | "current" | "waiting" | "failed";
  reason: string | null;
}

const STEP_LABELS: Record<Step["id"], string> = { installed: "Installed", loaded: "Loaded", ready: "Ready" };

/** The three steps in order for one role state. Only the failed step carries a reason; every other step's reason is null. */
export function stepsFromState(state: RoleState, reason: string | null): Step[] {
  const step = (id: Step["id"], status: Step["status"], stepReason: string | null): Step => ({ id, label: STEP_LABELS[id], status, reason: stepReason });
  switch (state) {
    case "notInstalled": return [step("installed", "current", null), step("loaded", "waiting", null), step("ready", "waiting", null)];
    case "installed": return [step("installed", "done", null), step("loaded", "current", null), step("ready", "waiting", null)];
    case "loaded": return [step("installed", "done", null), step("loaded", "done", null), step("ready", "current", null)];
    case "ready": return [step("installed", "done", null), step("loaded", "done", null), step("ready", "done", null)];
    case "offline": return [step("installed", "done", null), step("loaded", "failed", reason), step("ready", "waiting", null)];
  }
}
