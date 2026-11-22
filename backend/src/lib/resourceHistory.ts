// Resource history for the admin page: a bounded, file-based ring fed by the
// existing 5 s memory watchdog sample (no second poller). Plain newline JSON
// under <data>/resource-history/, one segment file per time bucket:
//   raw-<hour>.ndjson  5 s samples, kept 24 h
//   min-<day>.ndjson   1 minute means (plus maxima), kept 7 d
//   hr-<day>.ndjson    1 hour means (plus maxima), kept 30 d
// Older raw and minute segments are folded into the next tier by mean, then
// deleted. The whole directory is capped (50 MB by default), oldest first.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, fstatSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { dataDir, modelsDir } from "@/lib/paths";
import { engineRoot } from "@/lib/store/layout";
import { folderBytes } from "@/lib/sweeps";
import { getGovernorStatus } from "@/lib/governor";
import { startResourceEvents } from "@/lib/resourceEvents";
import { memoryWatchdog, onMemorySample } from "@/lib/memoryWatchdog";
import type { SystemSample } from "@/lib/memory/system";

const SEC = 1000, HOUR = 3_600_000, DAY = 86_400_000;
export const RAW_KEEP_MS = DAY;
export const MINUTE_KEEP_MS = 7 * DAY;
export const HOUR_KEEP_MS = 30 * DAY;
export const MAX_POINTS = 600;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export type Range = "1h" | "24h" | "7d" | "30d";
export const RANGE_MS: Record<Range, number> = { "1h": HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };
const STEPS = [5, 10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** One sample, or a mean of `n` samples. `*_max` fields keep the peak of memory and CPU. */
export interface Point {
  t: number; n: number;
  total: number; avail: number; wired: number; compressed: number; swap: number;
  pressure: number;
  used: number; used_max: number;
  stack: number; stack_max: number; other: number;
  procs: Record<string, number>;
  /** Bytes by engine role (chat, tts, ...): the role's process and its children. Absent on points recorded before 2026-11-21. */
  roles?: Record<string, number>;
  cpu: number | null; cpu_max: number | null;
  stack_cpu: number | null; stack_cpu_max: number | null;
  gpu: number | null;
  disk: number | null;
  tps: Record<string, number> | null;
  queue: number;
}

const NUM = ["total", "avail", "wired", "compressed", "swap", "used", "stack", "other", "queue"] as const;
const NULLABLE = ["cpu", "stack_cpu", "gpu", "disk"] as const;
const mean = (sum: number, n: number): number => (n > 0 ? sum / n : 0);

/** Mean of points weighted by their sample counts; maxima by max; pressure by worst. */
export function aggregate(points: Point[], t: number): Point {
  const n = points.reduce((s, p) => s + p.n, 0);
  const out = { t, n, pressure: 1, used_max: 0, stack_max: 0, cpu_max: null, stack_cpu_max: null, procs: {}, tps: null } as unknown as Point;
  for (const key of NUM) out[key] = mean(points.reduce((s, p) => s + p[key] * p.n, 0), n);
  for (const key of NULLABLE) {
    const have = points.filter((p) => p[key] !== null);
    const w = have.reduce((s, p) => s + p.n, 0);
    out[key] = have.length ? mean(have.reduce((s, p) => s + (p[key] as number) * p.n, 0), w) : null;
  }
  for (const p of points) {
    out.pressure = Math.max(out.pressure, p.pressure);
    out.used_max = Math.max(out.used_max, p.used_max);
    out.stack_max = Math.max(out.stack_max, p.stack_max);
    if (p.cpu_max !== null) out.cpu_max = Math.max(out.cpu_max ?? 0, p.cpu_max);
    if (p.stack_cpu_max !== null) out.stack_cpu_max = Math.max(out.stack_cpu_max ?? 0, p.stack_cpu_max);
  }
  const names = new Set(points.flatMap((p) => Object.keys(p.procs)));
  for (const name of names) out.procs[name] = mean(points.reduce((s, p) => s + (p.procs[name] ?? 0) * p.n, 0), n);
  const roleNames = new Set(points.flatMap((p) => Object.keys(p.roles ?? {})));
  if (roleNames.size) { out.roles = {}; for (const name of roleNames) out.roles[name] = mean(points.reduce((s, p) => s + (p.roles?.[name] ?? 0) * p.n, 0), n); }
  const tpsNames = new Set(points.flatMap((p) => Object.keys(p.tps ?? {})));
  if (tpsNames.size) {
    out.tps = {};
    for (const name of tpsNames) {
      const have = points.filter((p) => p.tps && name in p.tps);
      out.tps[name] = mean(have.reduce((s, p) => s + p.tps![name]! * p.n, 0), have.reduce((s, p) => s + p.n, 0));
    }
  }
  return out;
}

function bin(points: Point[], stepMs: number): Point[] {
  const groups = new Map<number, Point[]>();
  for (const p of points) { const key = Math.floor(p.t / stepMs) * stepMs; const g = groups.get(key); if (g) g.push(p); else groups.set(key, [p]); }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([t, g]) => aggregate(g, t));
}

/** The smallest step that keeps a range at or under the point cap; an explicit step only ever grows to fit. */
export function chooseStep(range: Range, requested: number | "auto" = "auto"): number {
  const need = RANGE_MS[range] / SEC / MAX_POINTS;
  const floor = requested === "auto" ? 0 : Math.max(5, requested);
  return STEPS.find((s) => s >= need && s >= floor) ?? STEPS[STEPS.length - 1]!;
}

type Tier = "raw" | "min" | "hr";
const SPAN: Record<Tier, number> = { raw: HOUR, min: DAY, hr: DAY };
interface Segment { name: string; tier: Tier; idx: number; start: number; end: number; path: string; size: number; }

export interface ResourceHistoryOptions { dir: string; now?: () => number; maxBytes?: number; }

export class ResourceHistory {
  private dir: string;
  private now: () => number;
  private maxBytes: number;
  private checked = new Set<string>();
  private lastMaintain = 0;
  private latest: Point | null = null;

  constructor(options: ResourceHistoryOptions) {
    this.dir = options.dir;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private segments(): Segment[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { return []; }
    const out: Segment[] = [];
    for (const name of names) {
      const m = /^(raw|min|hr)-(\d+)\.ndjson$/.exec(name);
      if (!m) continue;
      const tier = m[1] as Tier; const idx = Number(m[2]);
      const path = join(this.dir, name);
      let size = 0; try { size = statSync(path).size; } catch { continue; }
      out.push({ name, tier, idx, start: idx * SPAN[tier], end: (idx + 1) * SPAN[tier], path, size });
    }
    return out;
  }

  private read(path: string): Point[] {
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { return []; }
    const points: Point[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const p = JSON.parse(line) as Point; if (p && typeof p.t === "number" && typeof p.n === "number" && p.procs) points.push(p); } catch { /* a truncated or damaged line is skipped */ }
    }
    return points;
  }

  /** A crash can leave a half line with no newline; the next append must not glue onto it. */
  private appendLines(tier: Tier, idx: number, points: Point[]): void {
    if (points.length === 0) return;
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${tier}-${idx}.ndjson`);
    let prefix = "";
    if (!this.checked.has(path)) {
      this.checked.add(path);
      if (existsSync(path)) {
        const fd = openSync(path, "r");
        try { const size = fstatSync(fd).size; if (size > 0) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); if (b[0] !== 10) prefix = "\n"; } } finally { closeSync(fd); }
      }
    }
    appendFileSync(path, prefix + points.map((p) => JSON.stringify(p)).join("\n") + "\n");
  }

  /** Stores one raw sample. Housekeeping runs at most once a minute. */
  record(point: Point): void {
    if (!this.latest || point.t >= this.latest.t) this.latest = point;
    this.appendLines("raw", Math.floor(point.t / HOUR), [point]);
    const now = this.now();
    if (now - this.lastMaintain >= 60_000) this.maintain();
  }

  /** Folds aged segments into the next tier, drops expired ones, then enforces the size cap. */
  maintain(): void {
    const now = this.now();
    this.lastMaintain = now;
    for (const seg of this.segments()) {
      if (seg.tier === "raw" && seg.end <= now - RAW_KEEP_MS) {
        const byDay = new Map<number, Point[]>();
        for (const p of bin(this.read(seg.path), 60_000)) { const d = Math.floor(p.t / DAY); const g = byDay.get(d); if (g) g.push(p); else byDay.set(d, [p]); }
        for (const [d, list] of byDay) this.appendLines("min", d, list);
        rmSync(seg.path, { force: true }); this.checked.delete(seg.path);
      } else if (seg.tier === "min" && seg.end <= now - MINUTE_KEEP_MS) {
        this.appendLines("hr", seg.idx, bin(this.read(seg.path), HOUR));
        rmSync(seg.path, { force: true }); this.checked.delete(seg.path);
      } else if (seg.tier === "hr" && seg.end <= now - HOUR_KEEP_MS) {
        rmSync(seg.path, { force: true }); this.checked.delete(seg.path);
      }
    }
    this.enforceCap();
  }

  /** Drops the oldest segments until the directory fits; the newest segment always stays. */
  enforceCap(): void {
    const segs = this.segments().sort((a, b) => a.start - b.start || SPAN[b.tier] - SPAN[a.tier]);
    let total = segs.reduce((s, x) => s + x.size, 0);
    while (total > this.maxBytes && segs.length > 1) {
      const gone = segs.shift()!;
      rmSync(gone.path, { force: true }); this.checked.delete(gone.path);
      total -= gone.size;
    }
  }

  totalBytes(): number { return this.segments().reduce((s, x) => s + x.size, 0); }

  /** Points in [from, to], finest tier winning where tiers overlap (a crash between fold and delete). */
  private collect(from: number, to: number): Point[] {
    const raw: Point[] = [], min: Point[] = [], hr: Point[] = [];
    for (const seg of this.segments()) {
      if (seg.end < from || seg.start > to) continue;
      const list = seg.tier === "raw" ? raw : seg.tier === "min" ? min : hr;
      for (const p of this.read(seg.path)) if (p.t >= from && p.t <= to) list.push(p);
    }
    const rawMinutes = new Set(raw.map((p) => Math.floor(p.t / 60_000)));
    const minFiltered = min.filter((p) => !rawMinutes.has(Math.floor(p.t / 60_000)));
    const covered = new Set([...raw, ...minFiltered].map((p) => Math.floor(p.t / HOUR)));
    const hrFiltered = hr.filter((p) => !covered.has(Math.floor(p.t / HOUR)));
    return [...hrFiltered, ...minFiltered, ...raw].sort((a, b) => a.t - b.t);
  }

  query(range: Range, requestedStep: number | "auto" = "auto"): { range: Range; step_seconds: number; points: Point[]; roles: Array<{ id: string; color_key: string }>; engine_roles: Array<{ id: string; color_key: string }> } {
    const now = this.now();
    const step = chooseStep(range, requestedStep);
    const points = bin(this.collect(now - RANGE_MS[range], now), step * SEC).slice(-MAX_POINTS);
    const names = [...new Set(points.flatMap((p) => Object.keys(p.procs)))].sort();
    const engineNames = [...new Set(points.flatMap((p) => Object.keys(p.roles ?? {})))].sort();
    return { range, step_seconds: step, points, roles: names.map((id) => ({ id, color_key: colorKey(id) })), engine_roles: engineNames.map((id) => ({ id, color_key: colorKey(id) })) };
  }

  private statsCache: { at: number; value: Record<string, { peak: number; mean: number }> } | null = null;
  /** Memory by engine role over the last 24 h: the peak of each role's bucket maxima is not kept, so the peak is the largest bucket mean; cached for 30 s because it reads a day of samples. */
  roleStats(): Record<string, { peak: number; mean: number }> {
    const now = this.now();
    if (this.statsCache && now - this.statsCache.at < 30_000) return this.statsCache.value;
    const pts = bin(this.collect(now - DAY, now), 60_000);
    const names = new Set(pts.flatMap((p) => Object.keys(p.roles ?? {})));
    const total = pts.reduce((s, p) => s + p.n, 0);
    const value: Record<string, { peak: number; mean: number }> = {};
    for (const name of names) value[name] = { peak: pts.reduce((m, p) => Math.max(m, p.roles?.[name] ?? 0), 0), mean: mean(pts.reduce((s, p) => s + (p.roles?.[name] ?? 0) * p.n, 0), total) };
    this.statsCache = { at: now, value };
    return value;
  }

  /** Current numbers plus last-hour peak and mean, per role and overall. */
  summary(): { sampled_at: string | null; current: Point | null; last_hour: { memory_used_peak_bytes: number; memory_used_mean_bytes: number; cpu_peak: number | null; cpu_mean: number | null; queue_peak: number; samples: number }; roles: Array<{ id: string; color_key: string; current_bytes: number; peak_bytes: number; mean_bytes: number }> } {
    const now = this.now();
    const pts = this.collect(now - HOUR, now);
    const current = this.latest ?? pts[pts.length - 1] ?? null;
    const n = pts.reduce((s, p) => s + p.n, 0);
    const cpuPts = pts.filter((p) => p.cpu !== null);
    const cpuN = cpuPts.reduce((s, p) => s + p.n, 0);
    const names = [...new Set([...pts.flatMap((p) => Object.keys(p.procs)), ...Object.keys(current?.procs ?? {})])].sort();
    return {
      sampled_at: current ? new Date(current.t).toISOString() : null,
      current,
      last_hour: {
        memory_used_peak_bytes: pts.reduce((m, p) => Math.max(m, p.used_max), 0),
        memory_used_mean_bytes: mean(pts.reduce((s, p) => s + p.used * p.n, 0), n),
        cpu_peak: cpuPts.length ? cpuPts.reduce((m, p) => Math.max(m, p.cpu_max ?? p.cpu!), 0) : null,
        cpu_mean: cpuPts.length ? mean(cpuPts.reduce((s, p) => s + p.cpu! * p.n, 0), cpuN) : null,
        queue_peak: pts.reduce((m, p) => Math.max(m, p.queue), 0),
        samples: n,
      },
      roles: names.map((id) => ({
        id, color_key: colorKey(id), current_bytes: current?.procs[id] ?? 0,
        peak_bytes: pts.reduce((m, p) => Math.max(m, p.procs[id] ?? 0), 0),
        mean_bytes: mean(pts.reduce((s, p) => s + (p.procs[id] ?? 0) * p.n, 0), n),
      })),
    };
  }
}

/** A stable palette slot per name, so a role keeps its color across queries. */
export function colorKey(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `series-${(h % 8) + 1}`;
}

// ---- Building a point from a watchdog sample -------------------------------

export interface CollectorDeps {
  now?: () => number;
  /** Cumulative idle and total CPU ticks for the whole machine. */
  cpuTimes?: () => { idle: number; total: number };
  /** The Stack's own CPU seconds so far and the core count. */
  ownCpuSeconds?: () => number;
  coreCount?: () => number;
  view?: (rolePids: Array<{ role: string; pid: number }>) => { stackBytes: number; nonStackBytes: number; procs: Array<{ name: string; bytes: number }>; roles?: Record<string, number> };
  /** The engine process behind each role; the app registers the supervisor's list with `setRolePidProvider`. */
  rolePids?: () => Array<{ role: string; pid: number }>;
  diskBytes?: () => number;
  queueDepth?: () => number;
  /** macOS gives no cheap GPU figure, so the default is null and nothing is spawned. */
  gpu?: () => number | null;
  /** No role keeps a tokens-per-second counter yet, so the default is null. */
  tokensPerSecond?: () => Record<string, number> | null;
}

let rolePidProvider: () => Array<{ role: string; pid: number }> = () => [];
/** The supervisor's engine processes, registered once by the resources route so this file imports no supervisor. */
export function setRolePidProvider(provider: () => Array<{ role: string; pid: number }>): void { rolePidProvider = provider; }

export function createCollector(deps: CollectorDeps = {}): (sample: SystemSample) => Point {
  const now = deps.now ?? Date.now;
  const cpuTimes = deps.cpuTimes ?? (() => { let idle = 0, total = 0; for (const c of cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; } return { idle, total }; });
  const ownCpu = deps.ownCpuSeconds ?? (() => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; });
  const cores = deps.coreCount ?? (() => Math.max(1, cpus().length));
  const view = deps.view ?? ((rolePids) => memoryWatchdog().resourceView(rolePids));
  const rolePids = deps.rolePids ?? (() => rolePidProvider());
  const disk = deps.diskBytes ?? cachedDiskBytes();
  const queue = deps.queueDepth ?? (() => getGovernorStatus().queue.length);
  let prevCpu: { idle: number; total: number } | null = null;
  let prevOwn: { at: number; seconds: number } | null = null;
  return (sample) => {
    const at = sample.at ?? now();
    const times = cpuTimes();
    let cpu: number | null = null;
    if (prevCpu && times.total > prevCpu.total) cpu = Math.min(100, Math.max(0, (1 - (times.idle - prevCpu.idle) / (times.total - prevCpu.total)) * 100));
    prevCpu = times;
    const own = ownCpu();
    let stackCpu: number | null = null;
    if (prevOwn && at > prevOwn.at) stackCpu = Math.min(100, Math.max(0, ((own - prevOwn.seconds) / ((at - prevOwn.at) / SEC) / cores()) * 100));
    prevOwn = { at, seconds: own };
    const v = view(rolePids());
    const procs: Record<string, number> = {};
    for (const p of v.procs) procs[p.name] = (procs[p.name] ?? 0) + p.bytes;
    const used = Math.max(0, sample.totalBytes - sample.availableBytes);
    return {
      t: at, n: 1,
      total: sample.totalBytes, avail: sample.availableBytes, wired: sample.wiredBytes, compressed: sample.compressorBytes, swap: sample.swapUsedBytes,
      pressure: sample.pressureLevel, used, used_max: used,
      stack: v.stackBytes, stack_max: v.stackBytes, other: v.nonStackBytes, procs, roles: v.roles ?? {},
      cpu, cpu_max: cpu, stack_cpu: stackCpu, stack_cpu_max: stackCpu,
      gpu: deps.gpu ? deps.gpu() : null,
      disk: disk(),
      tps: deps.tokensPerSecond ? deps.tokensPerSecond() : null,
      queue: queue(),
    };
  };
}

/** Models plus engines on disk; a folder walk, so it is refreshed at most every 10 minutes. */
function cachedDiskBytes(): () => number {
  let at = 0, value = 0;
  return () => { const t = Date.now(); if (t - at > 10 * 60_000) { at = t; value = folderBytes(modelsDir) + folderBytes(engineRoot); } return value; };
}

// ---- The running instance --------------------------------------------------

let instance: ResourceHistory | null = null;
export function resourceHistory(): ResourceHistory { return instance ??= new ResourceHistory({ dir: join(dataDir, "resource-history") }); }
export function __setResourceHistoryForTests(next: ResourceHistory | null): void { instance = next; }

/** Subscribes to the memory watchdog's 5 s sample. Returns the stop function. */
export function startResourceHistory(collector: (sample: SystemSample) => Point = createCollector()): () => void {
  const history = resourceHistory();
  history.maintain();
  const stopSamples = onMemorySample((sample) => { try { history.record(collector(sample)); } catch { /* history must never disturb the watchdog */ } });
  const stopEvents = startResourceEvents();
  return () => { stopSamples(); stopEvents(); };
}
