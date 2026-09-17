import { ROLES, ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { identityHeaders, installedEngineForMachine } from "@/lib/identity";
import { getModel, isModelSelectable } from "@/lib/modelStore";
import { getChatEngineStatus, scriptedEnginesEnabled } from "@/lib/supervisor";
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
    return { role, state: role === "chat" ? getChatEngineStatus().state : installedEngineForMachine() ? "installed" : "notInstalled", binding: null };
  }
  const state = scriptedEnginesEnabled()
    ? getSetupPlan().plan && !["chat", "stt", "tts"].includes(modelField)
      ? "notInstalled"
      : "ready"
    : modelField === "chat"
      ? getChatEngineStatus().state
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
  const resolution = resolveRole(role);
  return {
    status: 503 as const,
    body: {
      error: `No engine is bound to role '${role}'.`,
      role,
      state: resolution.state,
      offline_reason: "Engine binding is not implemented yet.",
    },
    headers: identityHeaders(null),
  };
}
