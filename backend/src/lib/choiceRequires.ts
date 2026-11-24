// The readiness steps a category carries on the AI and models read (docs/dev/choices.md): installed, loaded, ready, judged from the role's
// own state. Pure: the caller passes the state and the offline reason; nothing here reads the supervisor or the stores.
// Also `requiresFor`: the engines and drafts a category's candidates need, likewise pure for testing.
import type { RoleState } from "@/roles";
import type { Candidate, RequiresEntry } from "@/lib/choicesSchema";

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

/** A part already shaped for a requires entry: the caller fills it with the same words the candidates use (statePlain in choices.ts). */
export type RequiresPart = Pick<RequiresEntry, "label" | "state" | "reason" | "size_bytes" | "can_install" | "can_uninstall">;

/**
 * What the category's candidates need to run: one `engine` entry per distinct engine a candidate runs on that is a part, and one `draft`
 * entry per companion a candidate names that is a part and is not itself a candidate of the category. `partOf(id)` answers with the part's
 * shaped facts or undefined when there is no such part; `companionsOf(candidateId)` lists the companion part ids. Sorted engine first,
 * then by id; each id appears once, an engine entry winning over a draft entry for the same id.
 */
export function requiresFor(candidates: Candidate[], partOf: (id: string) => RequiresPart | undefined, companionsOf: (candidateId: string) => string[]): RequiresEntry[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const engines = new Map<string, string[]>();
  const drafts = new Map<string, string[]>();
  const add = (into: Map<string, string[]>, id: string, candidateId: string): void => {
    const users = into.get(id) ?? [];
    if (!users.includes(candidateId)) users.push(candidateId);
    into.set(id, users);
  };
  for (const candidate of candidates) {
    if (candidate.engine && partOf(candidate.engine)) add(engines, candidate.engine, candidate.id);
    for (const companion of companionsOf(candidate.id)) {
      if (candidateIds.has(companion) || !partOf(companion)) continue;
      add(drafts, companion, candidate.id);
    }
  }
  const out: RequiresEntry[] = [];
  for (const [kind, groups] of [["engine", engines], ["draft", drafts]] as const) {
    for (const [id, needed_by] of groups) {
      if (kind === "draft" && engines.has(id)) continue;
      const part = partOf(id)!;
      out.push({ id, kind, ...part, needed_by });
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "engine" ? -1 : 1));
}
