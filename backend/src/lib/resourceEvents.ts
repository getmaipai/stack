// Timeline markers for the Resources screen: model loaded, unloaded, restarted, a
// mode switch, a problem. Fed by the existing event feed (no second source), kept in
// one small newline-JSON file beside the resource history, 30 days and at most 3000
// lines. Plain sentences only: the admin page prints them as written.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import { subscribe } from "@/lib/events";
import type { EventEnvelope } from "@/events";
import { ROLES, type RoleId } from "@/roles";

export type MarkerKind = "loaded" | "unloaded" | "restart" | "mode" | "problem";
export interface Marker { t: number; kind: MarkerKind; role: string; text: string }

const DAY = 86_400_000;
const KEEP_MS = 30 * DAY;
const MAX_LINES = 3000;
/** A start this soon after a stop or a failure of the same engine is a restart. */
const RESTART_WINDOW_MS = 2 * 60_000;

const labelOf = (role: string): string => (ROLES as Record<string, { label: string } | undefined>)[role]?.label ?? role;
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

export class ResourceEvents {
  private lastStop = new Map<string, number>();
  private lastMode = 0;
  private lines = -1;
  constructor(private path: string, private now: () => number = Date.now) {}

  private write(marker: Marker): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(marker)}\n`);
      if (this.lines >= 0) this.lines++;
      if (this.lines > MAX_LINES + 200) this.trim();
    } catch { /* a marker must never disturb the feed */ }
  }

  read(): Marker[] {
    let text = "";
    try { text = readFileSync(this.path, "utf8"); } catch { return []; }
    const out: Marker[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const m = JSON.parse(line) as Marker; if (typeof m.t === "number" && typeof m.kind === "string") out.push(m); } catch { /* a damaged line is skipped */ }
    }
    return out;
  }

  /** Drops what is older than 30 days and keeps the newest 3000. */
  trim(): void {
    if (!existsSync(this.path)) { this.lines = 0; return; }
    const cutoff = this.now() - KEEP_MS;
    const kept = this.read().filter((m) => m.t >= cutoff).slice(-MAX_LINES);
    try { writeFileSync(this.path, kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length ? "\n" : "")); } catch { /* keep going */ }
    this.lines = kept.length;
  }

  query(sinceMs: number): Marker[] {
    const from = this.now() - sinceMs;
    return this.read().filter((m) => m.t >= from).sort((a, b) => a.t - b.t);
  }

  /** Restarts per role since `sinceMs` ago. */
  restarts(sinceMs: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of this.query(sinceMs)) if (m.kind === "restart") out[m.role] = (out[m.role] ?? 0) + 1;
    return out;
  }

  /** Turns one feed event into at most one marker. */
  handle(event: EventEnvelope): void {
    const t = this.now();
    const data = event.data as Record<string, unknown>;
    if (event.id === "role.state") {
      const cause = typeof data.cause === "string" ? data.cause : null;
      if ((cause === "mode_change" || cause === "tier_reduced") && t - this.lastMode > 5000) {
        this.lastMode = t;
        this.write({ t, kind: "mode", role: String(data.role ?? ""), text: cause === "mode_change" ? "The home mode changed, so the chat engines were switched." : "Chat moved to its reduced size to make room." });
      }
      return;
    }
    if (event.id !== "engine.state") return;
    const role = String(data.engine ?? "");
    const state = String(data.state ?? "");
    const reason = typeof data.reason === "string" && data.reason ? data.reason : null;
    const name = labelOf(role as RoleId);
    if (state === "stopped" || state === "offline") this.lastStop.set(role, t);
    if (state === "loading") {
      const stopped = this.lastStop.get(role);
      if (stopped !== undefined && t - stopped <= RESTART_WINDOW_MS) { this.lastStop.delete(role); this.write({ t, kind: "restart", role, text: `The ${name} engine restarted.` }); }
    } else if (state === "ready") this.write({ t, kind: "loaded", role, text: `The ${name} engine finished loading.` });
    else if (state === "installed") this.write({ t, kind: "unloaded", role, text: sentence(reason ?? `The ${name} engine was unloaded`) });
    else if (state === "stopped") this.write({ t, kind: "unloaded", role, text: sentence(reason ?? `The ${name} engine was stopped`) });
    else if (state === "offline") this.write({ t, kind: "problem", role, text: sentence(reason ?? `The ${name} engine went offline`) });
  }
}

let instance: ResourceEvents | null = null;
export function resourceEvents(): ResourceEvents { return instance ??= new ResourceEvents(join(dataDir, "resource-history-events.ndjson")); }
export function __setResourceEventsForTests(next: ResourceEvents | null): void { instance = next; }

/** Listens to the event feed and keeps the markers. Returns the stop function. */
export function startResourceEvents(): () => void {
  const events = resourceEvents();
  events.trim();
  return subscribe((event) => events.handle(event));
}
