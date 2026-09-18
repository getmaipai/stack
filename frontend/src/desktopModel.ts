export type HealthSeverity = "critical" | "error" | "warning" | "ok";
export type RoleLine = { label: string; state: string; reason?: string | null };
export type TraySnapshot = { daemon: "running" | "down"; instance: string; state: "running" | "paused"; roles: RoleLine[]; memory: string; lastCheck: string };

const severityRank: Record<HealthSeverity, number> = { ok: 0, warning: 1, error: 2, critical: 3 };

export function worstHealth(severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce<HealthSeverity>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "ok");
}

export function roleLines(roles: RoleLine[]): string[] {
  return roles.map((role) => `${role.state === "ready" || role.state === "running" ? "●" : "○"} ${role.label} ${role.state}${role.reason ? ` · ${role.reason}` : ""}`);
}

export function trayMenuModel(state: "running" | "paused", roles: RoleLine[]): string[] {
  return ["marlow · " + (state === "paused" ? "Paused" : "Running"), ...roleLines(roles), "Open the Stack", state === "paused" ? "Resume" : "Pause everything", "Check my Stack", "Open Logs", "Quit the app (the Stack keeps running)"];
}

export function trayMenu(snapshot: TraySnapshot): string[] {
  if (snapshot.daemon === "down") return ["The Stack is not running · Start"];
  return [
    `${snapshot.instance} · ${snapshot.state === "paused" ? "Paused" : "Running"}`,
    ...roleLines(snapshot.roles),
    `Memory ${snapshot.memory}`,
    snapshot.lastCheck,
    "Open the Stack",
    snapshot.state === "paused" ? "Resume" : "Pause everything",
    "Check my Stack",
    "Open Logs",
    "Quit the app (the Stack keeps running)",
  ];
}
