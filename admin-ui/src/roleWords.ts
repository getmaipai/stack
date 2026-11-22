import type { Role } from "./api";

/** A feature is "working" when it can answer; "off" when it is not in use. Only a broken one is red. */
export type RoleGroup = "working" | "off" | "broken";
export function roleGroup(role: Role): RoleGroup {
  if (role.enabled === false) return "off";
  switch (role.state.state) {
    case "ready": case "loaded": case "installed": return "working";
    case "offline": return "broken";
    default: return "off";
  }
}
export function roleLine(role: Role, sheet = false): string {
  if (role.enabled === false) return "Turned off";
  switch (role.state.state) {
    case "ready": case "loaded": return role.model ? `Answering with ${role.model.id}` : "Working";
    case "installed": return "Ready. Starts when asked.";
    case "notInstalled": return "Not set up yet";
    default: return sheet ? "Not answering" : "Not answering. Tap for the reason.";
  }
}
