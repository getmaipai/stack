// Writing role settings as an admin action (ADMIN-04 and ADMIN-05): the
// settings route and the profile apply route both come through here, so a
// role change is validated, audited with its source, and a turned-off role's
// engine is unloaded, by one definition.
import { updateSettings } from "@/settings";
import { ROLE_IDS, ROLES } from "@/roles";
import { auditAction, type ActionSource } from "@/lib/adminActions";
import { roleDisabledReason } from "@/lib/roleSwitches";
import { unloadRole } from "@/lib/supervisor";

/** Stores the values (throws on an unknown key or invalid value), audits role changes, unloads engines of roles just turned off. Returns the settings after the change. */
export async function updateSettingsAudited(body: Record<string, unknown>, source: ActionSource, remote: string, action = "roles.update", extra: Record<string, string> = {}): Promise<ReturnType<typeof updateSettings>> {
  const before = new Map(ROLE_IDS.map((role) => [role, roleDisabledReason(role) === null]));
  const settings = updateSettings(body);
  const roleKeys = Object.keys(body).filter((key) => key.startsWith("stack.roles."));
  if (roleKeys.length > 0) auditAction(action, source, remote, { changes: roleKeys.map((key) => `${key}=${String(body[key])}`).join(","), ...extra });
  for (const role of ROLE_IDS) {
    const reason = roleDisabledReason(role);
    // judge and router share chat's process: turning them off must not unload chat.
    if (reason !== null && before.get(role) && !("sharesModelWith" in ROLES[role])) await unloadRole(role, reason, "route-engines-stop");
  }
  return settings;
}
