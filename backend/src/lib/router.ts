import { ROLES, ROLE_IDS, READY_TTL_MS, type RoleId, type RoleState, type RoleStateRecord } from "@/roles";
import { identityHeaders, installedEngineForMachine } from "@/lib/identity";
import { getModel, isModelSelectable } from "@/lib/modelStore";
import { getChatEngineStatus, lastRealRequestAt, scriptedEnginesEnabled } from "@/lib/supervisor";
import { getSetupPlan } from "@/lib/setupPlan";

export interface RoleResolution {
  role: RoleId;
  state: RoleState;
  binding: null;
}

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

  constructor(modelId: string, missing = ["sha256", "licence", "verifiedAt"]) {
    super(`Model '${modelId}' is not selectable until its checksum and licence are verified.`);
    this.name = "UnverifiedModelError";
    this.modelId = modelId;
    this.missing = missing;
  }
}

// The truthful, stamped state for a role, computed from the flat state.
// `since` is the moment we first observed the current state; `checkedAt` is
// stamped only on `ready` (from the supervisor's last real request);
// `reason` is set only on `offline`. For chat, a `ready` whose last real
// request is older than an hour degrades to `loaded`.
function resolveChatRoleState(): RoleState {
  const flat = getChatEngineStatus().state;
  if (flat === "loading") return "loaded";
  if (flat === "stopped" || flat === "offline") return "offline";
  if (flat === "busy") return "ready";
  return flat;
}

export function resolveRoleState(role: RoleId): RoleStateRecord {
  const flat = role === "chat" ? resolveChatRoleState() : resolveRole(role).state;
  const now = new Date().toISOString();
  if (flat === "ready") {
    const last = lastRealRequestAt();
    const fresh = role !== "chat" || last === null || Date.now() - last <= READY_TTL_MS;
    if (!fresh) return { state: "loaded", since: now };
    return { state: "ready", since: now, checkedAt: last !== null ? new Date(last).toISOString() : now };
  }
  if (flat === "offline") {
    return { state: "offline", since: now, reason: getChatEngineStatus().reason ?? "The engine is unavailable." };
  }
  return { state: flat, since: now };
}

export function resolveRole(modelField: string): RoleResolution {
  if (!ROLE_IDS.includes(modelField as RoleId)) {
    const model = getModel(modelField);
    if (!model) throw new UnknownRoleError(modelField);
    if (!isModelSelectable(model)) throw new UnverifiedModelError(modelField, [
      ...(!model.sha256 ? ["sha256"] : []),
      ...(!model.licence ? ["licence"] : []),
      ...(!model.verifiedAt ? ["verifiedAt"] : []),
    ]);
    const role = model.roles[0];
    if (!role || !ROLE_IDS.includes(role)) throw new UnknownRoleError(modelField);
    return { role, state: role === "chat" ? resolveChatRoleState() : installedEngineForMachine() ? "installed" : "notInstalled", binding: null };
  }
  const state = scriptedEnginesEnabled()
    ? getSetupPlan().plan && !["chat", "stt", "tts"].includes(modelField)
      ? "notInstalled"
      : "ready"
    : modelField === "chat"
      ? resolveChatRoleState()
      : installedEngineForMachine()
        ? "installed"
        : "notInstalled";
  return {
    role: modelField as RoleId,
    state,
    binding: null,
  };
}

export function roleDescription(role: RoleId): string {
  return ROLES[role].description;
}

export function noEngineResponse(role: RoleId) {
  const state = resolveRoleState(role);
  return {
    status: 503 as const,
    body: {
      error: `No engine is bound to role '${role}'.`,
      role,
      state: state.state,
      offline_reason: "Engine binding is not implemented yet.",
    },
    headers: identityHeaders(null),
  };
}
