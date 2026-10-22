// The memory watchdog (2026-10-17, after the Studio ran short of memory
// with scratch Stacks, builds and the resident models all competing).
// The governor knows only the workers it loaded; this watches the whole
// machine and acts on it:
//
//   sample (5 s)  ->  ladder with hysteresis  ->  actions
//   NORMAL        admission needs available memory after the job's
//                 declared peak to stay above the reserve.
//   WARN          (kernel pressure 2, or available < reserve + 4 GB)
//                 refuse new generative work, unload idle picture, video
//                 and tool workers and the idle voice engine, cancel
//                 queued generative jobs.
//   CRITICAL      (kernel pressure 4, swap growing fast, or available
//                 < 3 GB) cancel the running generative job (video
//                 first), evict the judge role, and restart the chat
//                 role through the supervisor only if it stays critical
//                 for 60 s. Raise a health item and one notification.
//
// It acts only on what the Stack owns: its engines, workers and jobs.
// Other processes are named in the log and never touched, with one
// exception: an orphaned engine of this Stack's own engines directory
// (parent launchd, older than 90 s, no client connected, outside every
// live Stack's process tree) is stopped, because nothing else will.
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { logger } from "@/lib/log";
import { getSystemSampler, type ProcessRow, type SystemSample, type SystemSampler } from "@/lib/memory/system";
import { cancelGeneratorsForMemory, runningGeneratorKinds } from "@/lib/jobs";
import { setAdmissionGate } from "@/lib/governor";
import { admissionVerdict, latestSample, levelSince, memoryLevel, orphanReaperEnabled, recordAction, recentActions, reserveBytes, setLatestSample, setMemoryLevel, watchdogEnabled, WatchdogRules, type WatchdogLevel } from "@/lib/memoryState";
import { engineRoot } from "@/lib/store/layout";
import { dirname } from "node:path";

const GB = 1_073_741_824;
function gb(bytes: number): string { return (bytes / GB).toFixed(1); }

// ---- the ladder (pure) ----

export interface LadderState { level: WatchdogLevel; enter: number; clear: number; }
export function newLadder(): LadderState { return { level: "normal", enter: 0, clear: 0 }; }

export interface LadderReading { sample: SystemSample; swapGrowthBytes: number; reserve: number; }

/** What the readings call for, ignoring history. */
export function rawLevel(reading: LadderReading): WatchdogLevel {
  const { sample, swapGrowthBytes, reserve } = reading;
  const warnMargin = Math.min(WatchdogRules.warnMarginBytes, reserve / 2);
  if (sample.pressureLevel >= 4 || swapGrowthBytes >= WatchdogRules.swapGrowthCriticalBytes || sample.availableBytes < WatchdogRules.criticalFloorBytes) return "critical";
  if (sample.pressureLevel >= 2 || sample.availableBytes < reserve + warnMargin) return "warn";
  return "normal";
}

/** Whether the readings are comfortably clear of a level (the hysteresis band). */
function clearOf(level: WatchdogLevel, reading: LadderReading): boolean {
  const { sample, swapGrowthBytes, reserve } = reading;
  const clearMargin = Math.min(WatchdogRules.warnClearMarginBytes, reserve);
  if (level === "critical") return sample.pressureLevel < 4 && swapGrowthBytes < GB / 4 && sample.availableBytes >= WatchdogRules.criticalClearBytes;
  if (level === "warn") return sample.pressureLevel < 2 && sample.availableBytes >= reserve + clearMargin;
  return true;
}

const ORDER: Record<WatchdogLevel, number> = { normal: 0, warn: 1, critical: 2 };

/** One step of the ladder. A worse level needs `enterSamples` in a row; a better one needs `clearSamples` clear readings in a row and steps down one level at a time, so a reading hovering at a threshold does not flap. */
export function stepLadder(ladder: LadderState, reading: LadderReading): LadderState {
  const wanted = rawLevel(reading);
  if (ORDER[wanted] > ORDER[ladder.level]) {
    const enter = ladder.enter + 1;
    return enter >= WatchdogRules.enterSamples ? { level: wanted, enter: 0, clear: 0 } : { ...ladder, enter, clear: 0 };
  }
  if (ORDER[ladder.level] > 0 && clearOf(ladder.level, reading)) {
    const clear = ladder.clear + 1;
    return clear >= WatchdogRules.clearSamples ? { level: ladder.level === "critical" ? "warn" : "normal", enter: 0, clear: 0 } : { ...ladder, enter: 0, clear };
  }
  return { ...ladder, enter: 0, clear: 0 };
}

// ---- orphan matching (pure) ----

export interface OrphanRules { engineRoots: string[]; workerEntries: string[]; protectedPids: Set<number>; minAgeSeconds: number; }

/** Which engine processes of this Stack are orphans: the executable lies under this Stack's own engines directory (or it is this Stack's speech worker), its parent is launchd, it is old enough, and it is in no live Stack's tree. Matching is by exact path prefix, so no other program can match. */
export function findOrphans(rows: ProcessRow[], rules: OrphanRules): ProcessRow[] {
  return rows.filter((row) => {
    if (row.ppid !== 1 || row.ageSeconds < rules.minAgeSeconds || rules.protectedPids.has(row.pid)) return false;
    const underEngines = rules.engineRoots.some((root) => row.command.startsWith(root.endsWith("/") ? root : `${root}/`));
    const speechWorker = /^\S*\/bun\s/.test(row.command) && row.command.includes(" speech-worker ") && rules.workerEntries.some((entry) => row.command.includes(`${entry} speech-worker `));
    return underEngines || speechWorker;
  });
}

/** The pids of a process and everything below it. */
export function descendantsOf(rows: ProcessRow[], roots: number[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const out = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) for (const child of children.get(queue.shift()!) ?? []) if (!out.has(child)) { out.add(child); queue.push(child); }
  return out;
}

/** Roots of every live Stack on this computer (this one and any other `serve` process), so no orphan rule can ever match a live Stack's child. */
function liveStackRoots(rows: ProcessRow[], ownPid: number): number[] {
  const roots = new Set<number>([ownPid]);
  for (const row of rows) if (/(maipai-stack[^ ]*|src\/index\.ts) serve\s*$/.test(row.command.trim())) roots.add(row.pid);
  return [...roots];
}

// ---- actions ----

export interface WatchdogActions {
  /** Stop idle on-demand workers (pictures, clips, image tools, the idle voice engine); returns what was stopped. */
  unloadIdleWorkers(): Promise<string[]>;
  cancelQueued(reason: string): string[];
  cancelRunning(reason: string): string[];
  /** Unload a warm role the Stack owns; false when it was not loaded. */
  evictRole(role: "judge"): Promise<boolean>;
  restartChat(): Promise<void>;
  notify(data: Record<string, unknown>): void;
}

async function defaultUnloadIdleWorkers(): Promise<string[]> {
  const stopped: string[] = [];
  const [{ imageGen }, { videoGen }, { musicGen }, { imageTools }, { lookService }, supervisor] = await Promise.all([import("@/images/imageEngine"), import("@/video/videoGen"), import("@/music/musicGen"), import("@/imagetools/imageTools"), import("@/look/look"), import("@/lib/supervisor")]);
  if (imageGen.stopIfIdle()) stopped.push("pictures");
  if (videoGen.stopIfIdle()) stopped.push("video");
  if (musicGen.stopIfIdle()) stopped.push("music");
  if (imageTools.stopIfIdle()) stopped.push("image tools");
  if (lookService.stopIfIdle()) stopped.push("look");
  const last = supervisor.lastRealRequestAt("tts");
  const state = supervisor.getRoleStatus("tts").state;
  if ((state === "ready" || state === "loaded") && (last === null || Date.now() - last > 60_000) && await supervisor.unloadRole("tts", "Unloaded: this computer is low on memory.").catch(() => false)) stopped.push("voice engine");
  return stopped;
}

export const defaultActions: WatchdogActions = {
  unloadIdleWorkers: defaultUnloadIdleWorkers,
  cancelQueued: (reason) => cancelGeneratorsForMemory("queued", reason),
  cancelRunning: (reason) => cancelGeneratorsForMemory("running", reason),
  evictRole: async (role) => (await import("@/lib/supervisor")).unloadRole(role, "Unloaded: this computer is low on memory.").catch(() => false),
  restartChat: async () => { await (await import("@/lib/supervisor")).restartRole("chat"); },
  notify: (data) => { emit({ id: "pressure", data }); },
};

// ---- the watchdog ----

export interface WatchdogOptions {
  sampler?: SystemSampler;
  actions?: WatchdogActions;
  now?: () => number;
  ownPid?: number;
  engineRoots?: string[];
  workerEntries?: string[];
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Re-reads a pid's command line, to prove it is still the process that was judged an orphan. */
  commandOf?: (pid: number) => string | null;
}

export interface TopConsumer { pid: number; name: string; bytes: number; stack: boolean; }
export interface MemoryReport {
  watchdog: { enabled: boolean; level: WatchdogLevel; since: string; reserve_bytes: number; generation_paused: boolean };
  memory: { total_bytes: number; available_bytes: number; free_bytes: number; wired_bytes: number; compressor_bytes: number; swap_used_bytes: number; swap_total_bytes: number; swap_growth_bytes_30s: number; pressure_level: number; pressure: string; sampled_at: string } | null;
  stack: { bytes: number; processes: Array<{ pid: number; name: string; bytes: number }> };
  top_consumers: TopConsumer[];
  non_stack_bytes: number;
  recent_actions: Array<{ at: string; level: WatchdogLevel; action: string; detail: string }>;
  history: Array<{ at: string; available_bytes: number; swap_used_bytes: number; pressure_level: number }>;
}

export class MemoryWatchdog {
  private sampler: SystemSampler;
  private actions: WatchdogActions;
  private now: () => number;
  private ownPid: number;
  private engineRoots: string[];
  private workerEntries: string[];
  private kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  private commandOf: (pid: number) => string | null;
  private ladder = newLadder();
  private ring: SystemSample[] = [];
  private ticks = 0;
  private rows: ProcessRow[] = [];
  private lastActionAt = 0;
  private criticalSince: number | null = null;
  private lastChatRestartAt = 0;
  private lastNotifyAt = 0;
  private lastDevLogAt = new Map<string, number>();
  private orphanSeen = new Map<number, number>();
  private terminated = new Map<number, { at: number; command: string; killed: boolean }>();
  private busy = false;
  private itemRaised = false;

  constructor(options: WatchdogOptions = {}) {
    this.sampler = options.sampler ?? getSystemSampler();
    this.actions = options.actions ?? defaultActions;
    this.now = options.now ?? Date.now;
    this.ownPid = options.ownPid ?? process.pid;
    this.engineRoots = options.engineRoots ?? [engineRoot];
    this.workerEntries = options.workerEntries ?? [`${dirname(process.execPath)}/backend-src/src/index.ts`, Bun.main];
    this.kill = options.kill ?? ((pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } });
    this.commandOf = options.commandOf ?? ((pid) => {
      try { return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() || null; } catch { return null; }
    });
  }

  private swapGrowth(): number {
    const cutoff = this.now() - WatchdogRules.swapGrowthWindowMs;
    const window = this.ring.filter((sample) => sample.at >= cutoff);
    if (window.length < 2) return 0;
    return Math.max(0, window[window.length - 1]!.swapUsedBytes - Math.min(...window.map((sample) => sample.swapUsedBytes)));
  }

  private record(level: WatchdogLevel, action: string, detail: string): void {
    recordAction(level, action, detail);
    logger.appendLine(JSON.stringify({ event: "memory.action", level, action, detail }));
  }

  /** One sample and, when the level asks for it, one round of actions. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const sample = this.sampler.sample();
      this.ring.push(sample);
      if (this.ring.length > WatchdogRules.ringSize) this.ring.shift();
      setLatestSample(sample);
      this.ticks++;
      const tight = memoryLevel() !== "normal";
      if (tight || this.ticks % WatchdogRules.processEvery === 1) this.rows = this.sampler.processes();
      if (!watchdogEnabled() || sample.degraded) { if (memoryLevel() !== "normal") this.leave(); return; }
      const reserve = reserveBytes(sample.totalBytes);
      const previous = this.ladder.level;
      this.ladder = stepLadder(this.ladder, { sample, swapGrowthBytes: this.swapGrowth(), reserve });
      if (this.ladder.level !== previous) {
        setMemoryLevel(this.ladder.level, this.now());
        this.record(this.ladder.level, "level", `${previous} to ${this.ladder.level}: ${gb(sample.availableBytes)} GB available, ${gb(reserve)} GB reserve, kernel level ${sample.pressureLevel}, swap ${gb(sample.swapUsedBytes)} GB`);
        this.criticalSince = this.ladder.level === "critical" ? this.now() : null;
      }
      if (this.ladder.level === "normal") this.leave();
      else await this.act(sample);
      this.devProtection();
      this.reapOrphans();
    } finally {
      this.busy = false;
    }
  }

  private leave(): void {
    if (this.itemRaised) { resolveHealth("memory-low"); resolveHealth("memory-critical"); this.itemRaised = false; }
    if (this.ladder.level !== "normal") { this.ladder = newLadder(); setMemoryLevel("normal", this.now()); }
    this.criticalSince = null;
  }

  private consumers(): TopConsumer[] {
    const tree = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    return [...this.rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5).map((row) => ({ pid: row.pid, name: row.name, bytes: row.rssBytes, stack: tree.has(row.pid) }));
  }

  private raiseItem(level: "warn" | "critical", sample: SystemSample): void {
    const top = this.consumers().map((c) => `${c.name} ${gb(c.bytes)} GB${c.stack ? " (MaiPai)" : ""}`).join(", ");
    const critical = level === "critical";
    this.itemRaised = true;
    raise({
      code: critical ? "memory-critical" : "memory-low",
      severity: critical ? "critical" : "warning",
      title: critical ? "This computer is out of memory" : "This computer is low on memory",
      text: critical
        ? "Picture and video making is stopped and the Stack is freeing memory. Close big apps, or give it a minute to recover."
        : "Picture and video making is paused until memory recovers. Close big apps to speed that up.",
      cause: `${gb(sample.availableBytes)} GB available of ${gb(sample.totalBytes)} GB, ${gb(sample.swapUsedBytes)} GB of swap in use. Biggest users: ${top || "not read yet"}.`,
    });
    resolveHealth(critical ? "memory-low" : "memory-critical");
  }

  private async act(sample: SystemSample): Promise<void> {
    const level = this.ladder.level;
    if (level === "normal") return;
    this.raiseItem(level, sample);
    const now = this.now();
    // New work is already refused by the admission gate; here the running side is trimmed.
    if (now - this.lastActionAt < 10_000 && level !== "critical") return;
    const reason = "Paused: this computer is low on memory. Try again once it recovers.";
    if (level === "warn") {
      const queued = this.actions.cancelQueued(reason);
      if (queued.length > 0) this.record(level, "cancel-queued", `${queued.length} queued job(s) cancelled`);
      const stopped = await this.actions.unloadIdleWorkers();
      if (stopped.length > 0) this.record(level, "unload-idle", stopped.join(", "));
      this.lastActionAt = now;
      return;
    }
    // CRITICAL: one step per round, 10 s apart, so each step's effect shows before the next.
    const queued = this.actions.cancelQueued(reason);
    if (queued.length > 0) this.record(level, "cancel-queued", `${queued.length} queued job(s) cancelled`);
    const stopped = await this.actions.unloadIdleWorkers();
    if (stopped.length > 0) this.record(level, "unload-idle", stopped.join(", "));
    if (now - this.lastActionAt < 10_000) return;
    const kinds = runningGeneratorKinds();
    const cancelled = this.actions.cancelRunning("Stopped: this computer ran out of memory. Close big apps and try again.");
    if (cancelled.length > 0) { this.lastActionAt = now; this.record(level, "cancel-running", `${kinds.join(", ") || "generative job"} cancelled`); this.notifyOnce(sample); return; }
    if (await this.actions.evictRole("judge")) { this.lastActionAt = now; this.record(level, "evict-judge", "the judge role was unloaded"); this.notifyOnce(sample); return; }
    this.notifyOnce(sample);
    if (this.criticalSince !== null && now - this.criticalSince >= WatchdogRules.chatRestartAfterMs && now - this.lastChatRestartAt >= WatchdogRules.chatRestartCooldownMs) {
      this.lastChatRestartAt = now; this.lastActionAt = now;
      this.record(level, "restart-chat", `critical for ${Math.round((now - this.criticalSince) / 1000)} s; the supervisor restarts the chat role`);
      await this.actions.restartChat().catch((error: unknown) => this.record(level, "restart-chat-failed", error instanceof Error ? error.message : String(error)));
    }
  }

  private notifyOnce(sample: SystemSample): void {
    const now = this.now();
    if (now - this.lastNotifyAt < WatchdogRules.notifyEveryMs) return;
    this.lastNotifyAt = now;
    this.actions.notify({ pressure: "critical", source: "memory-watchdog", reason: "This computer is out of memory; picture and video making was stopped.", free_memory_bytes: Math.round(sample.availableBytes), swap_used_bytes: Math.round(sample.swapUsedBytes), top_consumers: this.consumers().map((c) => ({ name: c.name, bytes: c.bytes })) });
  }

  /** Developer protection: name the programs that hold the memory. Nothing is stopped. */
  private devProtection(): void {
    if (this.rows.length === 0) return;
    const tree = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    const others = this.rows.filter((row) => !tree.has(row.pid));
    const sum = others.reduce((total, row) => total + row.rssBytes, 0);
    const big = others.filter((row) => row.rssBytes > WatchdogRules.devSingleBytes);
    const flagged = big.length > 0 ? big : sum > WatchdogRules.devSumBytes ? [...others].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5) : [];
    if (flagged.length === 0) return;
    const key = big.length > 0 ? "single" : "sum";
    const now = this.now();
    if (now - (this.lastDevLogAt.get(key) ?? 0) < WatchdogRules.devLogEveryMs) return;
    this.lastDevLogAt.set(key, now);
    const cwds = this.sampler.cwds(flagged.map((row) => row.pid));
    logger.appendLine(JSON.stringify({ event: "memory.dev-load", reason: big.length > 0 ? "a process holds more than 40 GB" : "other programs hold more than 30 GB together", others_bytes: sum, processes: flagged.map((row) => ({ name: row.name, pid: row.pid, bytes: row.rssBytes, age_seconds: row.ageSeconds, cwd: cwds.get(row.pid) ?? null })) }));
  }

  /** Orphans of this Stack's own engines: SIGTERM, then SIGKILL after 15 s. */
  private reapOrphans(): void {
    if (this.rows.length === 0) return;
    const now = this.now();
    const live = new Set(this.rows.map((row) => row.pid));
    for (const [pid, entry] of this.terminated) {
      if (!live.has(pid)) { this.terminated.delete(pid); continue; }
      if (!entry.killed && now - entry.at >= WatchdogRules.orphanKillGraceMs && this.commandOf(pid) === entry.command) {
        this.kill(pid, "SIGKILL");
        entry.killed = true;
        logger.appendLine(JSON.stringify({ event: "memory.orphan-killed", pid, signal: "SIGKILL" }));
      }
    }
    if (!orphanReaperEnabled()) return;
    const protectedPids = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    const orphans = findOrphans(this.rows, { engineRoots: this.engineRoots, workerEntries: this.workerEntries, protectedPids, minAgeSeconds: WatchdogRules.orphanMinAgeSeconds });
    for (const row of orphans) {
      if (this.terminated.has(row.pid)) continue;
      // An engine somebody is talking to (a benchmark run by hand against the shared engines) is in use, not abandoned.
      if (this.sampler.hasClient(row.pid)) {
        if (!this.orphanSeen.has(row.pid)) { this.orphanSeen.set(row.pid, now); logger.appendLine(JSON.stringify({ event: "memory.orphan-held", pid: row.pid, name: row.name, bytes: row.rssBytes, age_seconds: row.ageSeconds, reason: "no Stack owns it, but a client is connected, so it was left running" })); }
        continue;
      }
      const command = this.commandOf(row.pid);
      if (command !== row.command) continue;
      this.kill(row.pid, "SIGTERM");
      this.terminated.set(row.pid, { at: now, command, killed: false });
      this.orphanSeen.delete(row.pid);
      this.record(memoryLevel(), "reap-orphan", `${row.name} pid ${row.pid} (${gb(row.rssBytes)} GB, ${row.ageSeconds} s old, parent launchd) stopped`);
      logger.appendLine(JSON.stringify({ event: "memory.orphan-reaped", pid: row.pid, name: row.name, bytes: row.rssBytes, age_seconds: row.ageSeconds, signal: "SIGTERM" }));
    }
  }

  report(): MemoryReport {
    const sample = latestSample() ?? this.ring[this.ring.length - 1] ?? null;
    const tree = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    const ownTree = descendantsOf(this.rows, [this.ownPid]);
    const own = this.rows.filter((row) => ownTree.has(row.pid));
    const growth = this.swapGrowth();
    const level = memoryLevel();
    return {
      watchdog: { enabled: watchdogEnabled(), level, since: new Date(levelSince()).toISOString(), reserve_bytes: sample ? reserveBytes(sample.totalBytes) : 0, generation_paused: level !== "normal" },
      memory: sample ? { total_bytes: sample.totalBytes, available_bytes: sample.availableBytes, free_bytes: sample.freeBytes, wired_bytes: sample.wiredBytes, compressor_bytes: sample.compressorBytes, swap_used_bytes: sample.swapUsedBytes, swap_total_bytes: sample.swapTotalBytes, swap_growth_bytes_30s: growth, pressure_level: sample.pressureLevel, pressure: sample.pressure, sampled_at: new Date(sample.at).toISOString() } : null,
      stack: { bytes: own.reduce((total, row) => total + row.rssBytes, 0), processes: own.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 10).map((row) => ({ pid: row.pid, name: row.name, bytes: row.rssBytes })) },
      top_consumers: this.consumers(),
      non_stack_bytes: this.rows.filter((row) => !tree.has(row.pid)).reduce((total, row) => total + row.rssBytes, 0),
      recent_actions: recentActions(),
      history: this.ring.slice(-60).map((s) => ({ at: new Date(s.at).toISOString(), available_bytes: s.availableBytes, swap_used_bytes: s.swapUsedBytes, pressure_level: s.pressureLevel })),
    };
  }
}

let active: MemoryWatchdog | null = null;
export function memoryWatchdog(): MemoryWatchdog { return active ??= new MemoryWatchdog(); }

/** Starts the sampler loop and installs the admission gate. Returns the stop function. */
export function startMemoryWatchdog(options: WatchdogOptions = {}): () => void {
  const dog = active = new MemoryWatchdog(options);
  setAdmissionGate(admissionVerdict);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = (): void => {
    if (stopped) return;
    void dog.tick().catch((error: unknown) => logger.appendLine(JSON.stringify({ event: "memory.watchdog-error", message: error instanceof Error ? error.message : String(error) }))).finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, WatchdogRules.sampleMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  };
  loop();
  return () => { stopped = true; if (timer) clearTimeout(timer); setAdmissionGate(null); };
}

export function __resetMemoryWatchdogForTests(): void { active = null; }
