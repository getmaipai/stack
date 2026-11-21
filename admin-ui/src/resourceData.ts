// Pure helpers for the Resources screen: no React, so the unit test can load them.
// Data comes only from GET /stack/v1/resources/{history,summary} (ADMIN-02).

export type Range = "1h" | "24h" | "7d";
export const RANGES: { id: Range; label: string }[] = [{ id: "1h", label: "1 hour" }, { id: "24h", label: "24 hours" }, { id: "7d", label: "7 days" }];

export interface Point {
  t: number; n: number; total: number; avail: number; wired: number; compressed: number; swap: number; pressure: number;
  used: number; used_max: number; stack: number; stack_max: number; other: number; procs: Record<string, number>;
  cpu: number | null; cpu_max: number | null; stack_cpu: number | null; stack_cpu_max: number | null;
  gpu: number | null; disk: number | null; tps: Record<string, number> | null; queue: number;
}
export interface History { range: Range; step_seconds: number; points: Point[]; roles: { id: string; color_key: string }[] }
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
