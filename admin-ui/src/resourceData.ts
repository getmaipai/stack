// Pure helpers for the Resources screen: no React, so the unit test can load them.
// Data comes only from GET /stack/v1/resources/{history,summary} (ADMIN-02).

export type Range = "1h" | "24h" | "7d";
export const RANGES: { id: Range; label: string }[] = [{ id: "1h", label: "1 hour" }, { id: "24h", label: "24 hours" }, { id: "7d", label: "7 days" }];

export interface Point {
  t: number; n: number; total: number; avail: number; wired: number; compressed: number; swap: number; pressure: number;
  used: number; used_max: number; stack: number; stack_max: number; other: number; procs: Record<string, number>; roles?: Record<string, number>;
  cpu: number | null; cpu_max: number | null; stack_cpu: number | null; stack_cpu_max: number | null;
  gpu: number | null; disk: number | null; tps: Record<string, number> | null; queue: number;
}
export interface History { range: Range; step_seconds: number; points: Point[]; roles: { id: string; color_key: string }[]; engine_roles?: { id: string; color_key: string }[] }
export type MarkerKind = "loaded" | "unloaded" | "restart" | "mode" | "problem";
export interface Marker { t: number; kind: MarkerKind; role: string; text: string }
export interface EngineRow {
  role: string; label: string; serves: string[]; state: "running" | "idle" | "loading" | "queued"; engine: string | null; pid: number | null;
  model_id: string | null; model_bytes: number | null; memory_bytes: number; peak_bytes_24h: number | null; mean_bytes_24h: number | null;
  started_at: string | null; uptime_seconds: number | null; restarts_24h: number; restarts_7d: number; last_used_at: string | null; idle_seconds: number | null;
  residency: "resident" | "jit"; memory_class: string; keep_warm_minutes: number | null; idle_ttl_seconds: number | null; pinned: boolean; priority: number;
  active_requests: number; queue_position: number | null; tokens_per_second: number | null;
}
export interface Engines { sampled_at: string | null; budget: { total_bytes: number; cap_bytes: number; loaded_bytes: number }; engines: EngineRow[] }
export interface Summary {
  sampled_at: string | null; current: Point | null;
  last_hour: { memory_used_peak_bytes: number; memory_used_mean_bytes: number; cpu_peak: number | null; cpu_mean: number | null; queue_peak: number; samples: number };
  roles: { id: string; color_key: string; current_bytes: number; peak_bytes: number; mean_bytes: number }[];
}

/** The kit has five chart colors (--chart-1 to --chart-5) and the Stack hands out series-1 to series-8; slots 6 to 8 reuse kit tokens that are not chart colors. */
// Ordered so neighbors differ in lightness; the kit's chart palette is mostly neutral, so the legend names every slice too.
const SLOTS = ["var(--chart-1)", "var(--chart-4)", "var(--primary)", "var(--chart-3)", "var(--chart-2)", "var(--chart-5)", "var(--muted-foreground)", "var(--destructive)"];
export function seriesColor(colorKey: string): string {
  const n = Number(/^series-(\d+)$/.exec(colorKey)?.[1]);
  return SLOTS[Number.isInteger(n) && n >= 1 ? (n - 1) % SLOTS.length : 0] ?? "var(--chart-1)";
}

export function pressureWord(level: number | undefined): { word: string; kind: "online" | "degraded" | "offline" } {
  if (level === undefined) return { word: "Unknown", kind: "degraded" };
  if (level >= 4) return { word: "Critical", kind: "offline" };
  if (level >= 2) return { word: "Getting tight", kind: "degraded" };
  return { word: "Comfortable", kind: "online" };
}

export interface Segment { id: string; label: string; bytes: number; color: string; percent: number }
/** Memory budget bar: each engine process, other programs, then free. Percentages sum to at most 100. */
export function budgetSegments(summary: Summary): Segment[] {
  const cur = summary.current;
  if (!cur || cur.total <= 0) return [];
  // Short-lived helpers (ps, sw_vers) are under 1 percent of the machine; they share one "Smaller processes" slice.
  const live = summary.roles.filter((r) => r.current_bytes > 0);
  const big = live.filter((r) => r.current_bytes / cur.total >= 0.01);
  const small = live.filter((r) => r.current_bytes / cur.total < 0.01).reduce((n, r) => n + r.current_bytes, 0);
  const raw: Omit<Segment, "percent">[] = [
    ...big.map((r) => ({ id: r.id, label: r.id, bytes: r.current_bytes, color: seriesColor(r.color_key) })),
    ...(small > 0 ? [{ id: "small", label: "Smaller processes", bytes: small, color: "var(--chart-3)" }] : []),
    { id: "other", label: "Other programs", bytes: Math.max(0, cur.other), color: "var(--muted-foreground)" },
    { id: "free", label: "Free", bytes: Math.max(0, cur.avail), color: "var(--muted)" },
  ];
  let left = 100;
  return raw.map((s) => {
    const percent = Math.min(left, (s.bytes / cur.total) * 100);
    left -= percent;
    return { ...s, percent };
  });
}

const GB = 1024 ** 3;
/** The few engine processes worth their own band in the chart: the biggest by peak, at most six and at least 1 percent of the machine at their peak. */
export function chartRoles(h: History, max = 6): { id: string; color_key: string }[] {
  const total = h.points.reduce((m, p) => Math.max(m, p.total), 0);
  const peak = (id: string) => h.points.reduce((m, p) => Math.max(m, p.procs[id] ?? 0), 0);
  return h.roles.map((r) => ({ r, peak: peak(r.id) })).filter((x) => total > 0 && x.peak / total >= 0.01).sort((x, y) => y.peak - x.peak).slice(0, max).map((x) => x.r);
}
/** Rows for the stacked memory chart, in GB: one key per kept process, and "other" for every other program and small process. */
export function memoryRows(h: History, keep: { id: string }[] = chartRoles(h)): Record<string, number>[] {
  return h.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    let named = 0;
    for (const r of keep) { const v = p.procs[r.id] ?? 0; row[r.id] = v / GB; named += v; }
    row.other = Math.max(0, p.used - named) / GB;
    return row;
  });
}
/** Rows for the single-line charts. A null reading stays null so the line has a gap, not a fake zero. */
export function lineRows(h: History): { t: number; cpu: number | null; swap: number; queue: number; tps: number | null }[] {
  return h.points.map((p) => ({
    t: p.t, cpu: p.cpu, swap: p.swap / GB, queue: p.queue,
    tps: p.tps ? Object.values(p.tps).reduce((a, b) => a + b, 0) : null,
  }));
}
export function hasValues(rows: { [k: string]: number | null }[], key: string): boolean {
  return rows.some((r) => r[key] !== null && r[key] !== undefined);
}
export function timeLabel(t: number, range: Range): string {
  const d = new Date(t);
  return range === "7d" ? d.toLocaleDateString(undefined, { weekday: "short", hour: "numeric" }) : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}


// ---- Detail screen (2026-11-21): where memory goes, in plain words ----

const GBYTES = 1024 ** 3;

/** Fixed order (busiest features first), so a feature keeps its color on every chart and bar. The kit's chart tokens include a near-black and a dark grey that vanish on a dark page, so the six base colors are the cyan, the blue and the mid and light greys, plus two shades mixed toward the text color; features past the sixth reuse them lightened. The legend names every slice too. */
const ROLE_ORDER = ["chat", "coding", "image", "tts", "stt", "embed", "helper", "video", "music", "vision", "judge", "router", "rerank", "wakeword"];
const ROLE_SLOTS = ["var(--chart-1)", "var(--primary)", "color-mix(in oklab, var(--chart-1) 45%, var(--foreground))", "var(--chart-2)", "color-mix(in oklab, var(--primary) 45%, var(--foreground))", "var(--chart-3)"];
export function roleColor(role: string): string {
  const i = ROLE_ORDER.indexOf(role);
  const n = i >= 0 ? i : ROLE_ORDER.length + [...role].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 12;
  const base = ROLE_SLOTS[n % ROLE_SLOTS.length]!;
  return n < ROLE_SLOTS.length ? base : `color-mix(in oklab, ${base} ${n < 2 * ROLE_SLOTS.length ? 60 : 38}%, var(--card))`;
}

const PURPOSE: Record<string, string> = {
  chat: "answers questions and holds conversations", coding: "helps write code, and is loaded only while someone is coding",
  judge: "checks requests and answers for safety", router: "decides which feature should handle a request",
  embed: "turns text into numbers so search and memory can find related things", rerank: "sorts search results so the best come first",
  vision: "reads pictures", stt: "turns speech into text", tts: "turns text into speech", wakeword: "listens for the wake word",
  image: "draws pictures", video: "makes video clips", music: "makes music", helper: "is the assistant on this page",
};
export function purposeOf(role: string): string { return PURPOSE[role] ?? "is one of the Stack's features"; }

export function stateWord(state: EngineRow["state"]): string {
  return state === "running" ? "Working" : state === "idle" ? "Idle" : state === "loading" ? "Loading" : "Queued";
}
export function stateKind(state: EngineRow["state"]): "online" | "degraded" | "maintenance" { return state === "running" ? "online" : state === "queued" ? "degraded" : "maintenance"; }

export function minutesWord(minutes: number): string { return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`; }

/** One plain sentence or two: what the feature is for, which model it holds, and why it stays in memory. `size` formats bytes. */
export function whyLine(row: EngineRow, modelName: string | null, size: (n: number) => string): string {
  const parts: string[] = [];
  const model = modelName ?? row.model_id;
  parts.push(`${row.label} ${purposeOf(row.role)}.`);
  if (model) parts.push(`It holds ${model}${row.model_bytes ? `, a ${size(row.model_bytes)} file` : ""}.`);
  if (row.model_bytes && row.memory_bytes > row.model_bytes * 1.15) parts.push("It uses more than the file because working space and the conversation cache sit on top of the model.");
  if (row.pinned) parts.push("It is pinned, so it stays in memory.");
  else if (row.residency === "resident") parts.push("It stays loaded so answers start at once.");
  else if (row.idle_ttl_seconds) parts.push(`It loads when asked and unloads after ${minutesWord(Math.max(1, Math.round(row.idle_ttl_seconds / 60)))} without use.`);
  else if (row.keep_warm_minutes) parts.push(`It loads when asked and stays ready for ${minutesWord(row.keep_warm_minutes)} after the last use.`);
  else parts.push("It loads when asked and unloads when idle.");
  if (row.state === "queued") parts.push("It is waiting for enough free memory.");
  if (row.serves.length) parts.push(`The same process also answers for ${row.serves.join(" and ")}.`);
  if (row.priority !== 100) parts.push(`Its priority is ${row.priority} (100 is the default).`);
  return parts.join(" ");
}

export interface BarSegment { id: string; label: string; detail: string | null; bytes: number; color: string; percent: number; kind: "role" | "other" | "free" }
/** The memory bar: each running feature, then everything else in use, then free; percentages are of the whole computer and sum to at most 100. */
export function nowSegments(current: Point | null, engines: EngineRow[], modelName: (id: string | null) => string | null = () => null): BarSegment[] {
  if (!current || current.total <= 0) return [];
  const live = engines.filter((e) => e.memory_bytes > 0).sort((a, b) => b.memory_bytes - a.memory_bytes);
  const named = live.reduce((n, e) => n + e.memory_bytes, 0);
  const raw: Omit<BarSegment, "percent">[] = [
    ...live.map((e) => ({ id: e.role, label: e.label, detail: modelName(e.model_id), bytes: e.memory_bytes, color: roleColor(e.role), kind: "role" as const })),
    { id: "other", label: "Other apps and the system", detail: null, bytes: Math.max(0, current.used - named), color: "var(--muted-foreground)", kind: "other" },
    { id: "free", label: "Free", detail: null, bytes: Math.max(0, current.avail), color: "var(--muted)", kind: "free" },
  ];
  let left = 100;
  return raw.map((s) => { const percent = Math.min(left, (s.bytes / current.total) * 100); left -= percent; return { ...s, percent }; });
}

/** The roles worth a band in the stacked history: biggest by peak, at most six, at least 1 percent of the computer. */
export function historyRoles(h: History, max = 6): string[] {
  const total = h.points.reduce((m, p) => Math.max(m, p.total), 0);
  const ids = (h.engine_roles ?? []).map((r) => r.id);
  const peak = (id: string) => h.points.reduce((m, p) => Math.max(m, p.roles?.[id] ?? 0), 0);
  return ids.map((id) => ({ id, peak: peak(id) })).filter((x) => total > 0 && x.peak / total >= 0.01).sort((a, b) => b.peak - a.peak).slice(0, max).map((x) => x.id);
}
/** Rows for the stacked history by feature, in GB, with "other" for the rest of what is in use. */
export function roleHistoryRows(h: History, keep: string[]): Record<string, number>[] {
  return h.points.map((p) => {
    const row: Record<string, number> = { t: p.t };
    let named = 0;
    for (const id of keep) { const v = p.roles?.[id] ?? 0; row[id] = v / GBYTES; named += v; }
    row.other = Math.max(0, p.used - named) / GBYTES;
    return row;
  });
}
export function hasRoleHistory(h: History): boolean { return h.points.some((p) => p.roles && Object.keys(p.roles).length > 0); }
/** Rows for the load chart: whole-computer CPU, GPU where measured, and tokens per second. Nulls stay gaps. */
export function loadRows(h: History): { t: number; cpu: number | null; gpu: number | null }[] { return h.points.map((p) => ({ t: p.t, cpu: p.cpu, gpu: p.gpu })); }

export const MARKER_WORDS: Record<MarkerKind, { word: string; color: string }> = {
  loaded: { word: "Loaded", color: "var(--status-ok)" }, unloaded: { word: "Unloaded", color: "var(--muted-foreground)" },
  restart: { word: "Restarted", color: "var(--status-warning)" }, mode: { word: "Mode switch", color: "var(--primary)" }, problem: { word: "Problem", color: "var(--status-error)" },
};
/** Markers inside the chart's time span, newest last, at most `max` (the newest). */
export function visibleMarkers(markers: Marker[], from: number, to: number, max = 40): Marker[] {
  return markers.filter((m) => m.t >= from && m.t <= to).slice(-max);
}

export type SortKey = "memory" | "peak" | "uptime" | "restarts" | "name";
export const SORTS: { id: SortKey; label: string }[] = [{ id: "memory", label: "Memory now" }, { id: "peak", label: "Peak" }, { id: "uptime", label: "Uptime" }, { id: "restarts", label: "Restarts" }, { id: "name", label: "Name" }];
/** Sorted copy: biggest or longest first, except by name; ties break by name so the order never jumps. */
export function sortEngines(rows: EngineRow[], key: SortKey, desc = true): EngineRow[] {
  const value = (r: EngineRow): number | string => key === "memory" ? r.memory_bytes : key === "peak" ? r.peak_bytes_24h ?? -1 : key === "uptime" ? r.uptime_seconds ?? -1 : key === "restarts" ? r.restarts_24h : r.label;
  const dir = key === "name" ? (desc ? 1 : -1) : (desc ? -1 : 1);
  return [...rows].sort((a, b) => { const x = value(a), y = value(b); const c = typeof x === "string" ? x.localeCompare(String(y)) : (x as number) - (y as number); return c * dir || a.label.localeCompare(b.label); });
}

/** The short version of whyLine for a table row: what it is for, and why it stays in memory. */
export function shortWhy(row: EngineRow): string {
  const purpose = `${row.label} ${purposeOf(row.role)}.`;
  const stay = row.pinned ? "Pinned in memory." : row.residency === "resident" ? "Stays loaded so answers start at once." : "Loads when asked, unloads when idle.";
  return `${purpose} ${stay}`;
}
