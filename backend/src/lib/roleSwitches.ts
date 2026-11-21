// Which roles the person turned off and the order they are served in
// (ADMIN-04). The declarations live once in settings.ts
// (`stack.roles.<role>.enabled` and `.priority`); settings.ts pushes the
// in-effect values here, so the governor, the supervisor and the roles
// route read one place and none of them imports the settings module.
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";

/** Default order: the order the roles are declared in, ten apart so a person can slot one between two. */
export function defaultRolePriority(role: RoleId): number { return (ROLE_IDS.indexOf(role) + 1) * 10; }
export const ROLE_PRIORITY_MIN = 1;
export const ROLE_PRIORITY_MAX = 1000;

const disabled = new Set<string>();
const priorities = new Map<string, number>();

export function setRoleSwitches(next: { disabled: Iterable<string>; priority: Record<string, number> }): void {
  disabled.clear();
  for (const role of next.disabled) disabled.add(role);
  priorities.clear();
  for (const [role, value] of Object.entries(next.priority)) priorities.set(role, value);
}

const isRole = (id: string | undefined): id is RoleId => id !== undefined && (ROLE_IDS as readonly string[]).includes(id);

export function isRoleDisabled(role: string | undefined): boolean { return isRole(role) && disabled.has(role); }

/** Lower is served first. A name that is not a role (a one-off helper such as the picture reader) goes after every role. */
export function rolePriorityOf(role: string | undefined): number {
  if (!isRole(role)) return ROLE_PRIORITY_MAX + 1;
  return priorities.get(role) ?? defaultRolePriority(role);
}

/** The plain sentence a turned-off role gives, or null while it is on. */
export function roleDisabledReason(role: string | undefined): string | null {
  if (!isRole(role) || !disabled.has(role)) return null;
  return `${ROLES[role].label} is turned off. Turn it on under Features in the admin page (setting stack.roles.${role}.enabled) to use it.`;
}

export function __resetRoleSwitchesForTests(): void { disabled.clear(); priorities.clear(); }
