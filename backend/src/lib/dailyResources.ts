export type DailyResources = {
  date: string;
  chat_restarts_by_cause: Record<string, number>;
  engine_stops_by_cause: Record<string, number>;
  pauses: number;
  resumes: number;
  forced_resumes: number;
  paused_seconds: number;
  memory_actions: Record<string, number>;
  shrinks: number;
  restores: number;
  survivors_stopped: number;
  sweeps: { runs: number; freed_bytes: number };
  canary_restarts: number;
};

const restartCauses = new Set([
  "governor-runaway", "video-window-shrink", "video-window-restore", "memory-watchdog", "canary-request",
  "new-projector", "new-chat-engine", "repairs-restart-engine", "health-action", "model-load",
  "engine-swap-postload", "engine-update-postload", "rollback-restart", "tts-gated-weights",
]);

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function emptyDay(date: string): DailyResources {
  return { date, chat_restarts_by_cause: {}, engine_stops_by_cause: {}, pauses: 0, resumes: 0, forced_resumes: 0, paused_seconds: 0, memory_actions: {}, shrinks: 0, restores: 0, survivors_stopped: 0, sweeps: { runs: 0, freed_bytes: 0 }, canary_restarts: 0 };
}

export function dailyResources(lines: string[], days: number, now: Date): DailyResources[] {
  const output: DailyResources[] = [];
  const byDate = new Map<string, DailyResources>();
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = dayKey(date);
    const row = emptyDay(key);
    output.push(row);
    byDate.set(key, row);
  }
  for (const line of lines) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!event || typeof event !== "object" || typeof event.event !== "string") continue;
    const timestamp = event.at ?? event.time ?? event.timestamp;
    if (typeof timestamp !== "string" && typeof timestamp !== "number") continue;
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.getTime())) continue;
    const row = byDate.get(dayKey(parsed));
    if (!row) continue;
    const count = (record: Record<string, number>, key: unknown) => {
      if (typeof key === "string" && key.length > 0) record[key] = (record[key] ?? 0) + 1;
    };
    switch (event.event) {
      case "engine.retired":
        count(row.engine_stops_by_cause, event.cause);
        if (event.role === "chat" && typeof event.cause === "string" && isRestartCause(event.cause)) count(row.chat_restarts_by_cause, event.cause);
        break;
      case "isolation.paused": row.pauses++; break;
      case "isolation.resumed": row.resumes++; if (typeof event.paused_seconds === "number") row.paused_seconds += event.paused_seconds; break;
      case "isolation.resume_forced": row.forced_resumes++; if (typeof event.paused_seconds === "number") row.paused_seconds += event.paused_seconds; break;
      case "memory.action": count(row.memory_actions, event.action); break;
      case "chat.window": if (event.action === "shrink") row.shrinks++; else if (event.action === "restore") row.restores++; break;
      case "process.survivor": if (event.action === "SIGTERM" || event.action === "SIGKILL") row.survivors_stopped++; break;
      case "sweep.done": row.sweeps.runs++; if (typeof event.freed_bytes === "number") row.sweeps.freed_bytes += event.freed_bytes; break;
      case "engine.restart_requested_by_canary": row.canary_restarts++; break;
    }
  }
  return output;
}

function isRestartCause(cause: string): boolean {
  return restartCauses.has(cause) || cause.startsWith("route-engines-") || cause.startsWith("tier-reduced-");
}
