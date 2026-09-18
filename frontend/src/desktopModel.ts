export type HealthSeverity = "critical" | "error" | "warning" | "ok";
export type RoleLine = { label: string; state: string; reason?: string | null };

const severityRank: Record<HealthSeverity, number> = { ok: 0, warning: 1, error: 2, critical: 3 };

export function worstHealth(severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce<HealthSeverity>((worst, current) => severityRank[current] > severityRank[worst] ? current : worst, "ok");
}

export function roleLines(roles: RoleLine[]): string[] {
  return roles.map((role) => `${role.label}: ${role.state}${role.reason ? ` · ${role.reason}` : ""}`);
}

export function trayMenuModel(state: "running" | "paused", roles: RoleLine[]): string[] {
  return [...roleLines(roles), "Open the Stack", state === "paused" ? "Resume" : "Pause everything", "Quit the app (the Stack keeps running)"];
}
