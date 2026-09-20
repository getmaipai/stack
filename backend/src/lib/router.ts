// Role resolution: the `model` field is a role id or an installed model
// id; the state of a role is derived from the supervisor and never
// stored. `ready` is claimed only within READY_TTL_MS of a real request
// through the public route (the STACK-87 promise).
import { ROLE_IDS, READY_TTL_MS, type RoleId, type RoleState, type RoleStateRecord } from "@/roles";
import { identityHeaders } from "@/lib/identity";
import { getModel, isModelSelectable } from "@/lib/modelStore";
import { getRoleStatus, lastRealRequestAt, processRoleFor, selectedModel } from "@/lib/supervisor";

export interface RoleResolution { role: RoleId; modelId: string | null; }

export class UnknownRoleError extends Error {
  readonly modelField: string;
  constructor(modelField: string) {
    super(`Unknown role or model '${modelField}'. Choose one of: ${ROLE_IDS.join(", ")}`);
    this.name = "UnknownRoleError";
    this.modelField = modelField;
  }
}

export class UnverifiedModelError extends Error {
  readonly modelId: string;
  readonly missing: string[];
  constructor(modelId: string, missing: string[]) {
    super(`Model '${modelId}' is not selectable until its checksum and licence are verified.`);
    this.name = "UnverifiedModelError";
    this.modelId = modelId;
    this.missing = missing;
  }
}

export function resolveRole(modelField: string): RoleResolution {
  if (ROLE_IDS.includes(modelField as RoleId)) return { role: modelField as RoleId, modelId: null };
  const model = getModel(modelField);
  if (!model) throw new UnknownRoleError(modelField);
  if (!isModelSelectable(model)) throw new UnverifiedModelError(modelField, [
    ...(!model.sha256 ? ["sha256"] : []),
    ...(!model.licence ? ["licence"] : []),
    ...(!model.verifiedAt ? ["verifiedAt"] : []),
  ]);
  const role = model.roles[0];
  if (!role || !ROLE_IDS.includes(role)) throw new UnknownRoleError(modelField);
  return { role, modelId: model.id };
}

function flatState(role: RoleId): RoleState {
  const status = getRoleStatus(role);
  if (status.state === "loading") return "loaded";
  if (status.state === "busy") return "ready";
  if (status.state === "stopped") return "installed";
  if (status.state === "offline") return "offline";
  // A role the Stack does not spawn (wakeword, the speech roles before
  // STACK-94) is installed when a verified model for it is on disk.
  if (status.state === "notInstalled" && selectedModel(processRoleFor(role))) return "installed";
  return status.state;
}

export function resolveRoleState(role: RoleId): RoleStateRecord {
  const flat = flatState(role);
  const now = new Date().toISOString();
  if (flat === "ready") {
    const last = lastRealRequestAt(role);
    if (last === null || Date.now() - last > READY_TTL_MS) return { state: "loaded", since: now };
    return { state: "ready", since: now, checkedAt: new Date(last).toISOString() };
  }
  if (flat === "offline") return { state: "offline", since: now, reason: getRoleStatus(role).reason ?? "The engine is unavailable." };
  return { state: flat, since: now };
}

export function noEngineResponse(role: RoleId, reason?: string) {
  const state = resolveRoleState(role);
  return {
    status: 503 as const,
    body: { error: `No engine is ready for role '${role}'.`, role, state: state.state, offline_reason: reason ?? state.reason ?? `No engine is bound to ${role} on this machine.` },
    headers: identityHeaders(null),
  };
}
