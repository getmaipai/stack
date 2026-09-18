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

export type DesktopEvent = { id: string; durable: boolean; data?: Record<string, unknown> };
export type AlertPreferences = { model: boolean; update: boolean; check: boolean; health: boolean; runState: boolean };
export type DesktopNotification = { title: string; target: string };
export function notificationsFor(events: DesktopEvent[], preferences: AlertPreferences): DesktopNotification[] {
  return events.filter((event) => event.durable).flatMap((event) => {
    if (event.id === "model.installed" && preferences.model) return [{ title: "A model finished installing", target: `/models/${String(event.data?.modelId ?? "")}` }];
    if ((event.id === "update.applied" || event.id === "update.available") && preferences.update) return [{ title: "A Stack update is ready", target: "/settings/updates" }];
    if (event.id === "check.done" && event.data?.ok === false && preferences.check) return [{ title: "The Stack check needs attention", target: "/alerts" }];
    if ((event.id === "health.changed" || event.id === "repair") && preferences.health) return [{ title: "The Stack needs attention", target: "/alerts" }];
    if (event.id === "run.state" && preferences.runState && event.data?.source !== "app") return [{ title: `The Stack is ${String(event.data?.state ?? "changed")}`, target: "/alerts" }];
    return [];
  });
}
