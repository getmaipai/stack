import { ROLES, ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { identityHeaders, installedEngineForMachine } from "@/lib/identity";

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

export function resolveRole(modelField: string): RoleResolution {
  if (!ROLE_IDS.includes(modelField as RoleId)) throw new UnknownRoleError(modelField);
  return {
    role: modelField as RoleId,
    state: installedEngineForMachine() ? "installed" : "notInstalled",
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
