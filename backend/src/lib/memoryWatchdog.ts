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
//                 < 3 GB) the running generative job is the LAST thing
//                 given up (`criticalStep`, pure): unload idle workers
//                 and the idle voice engine, evict the idle judge, put
//                 an idle chat on the smaller Reduced model (never while
//                 a person is chatting), wait one settle window, re-read
//                 the pressure, and only if the raw reading is still
//                 critical cancel the running job (video first; it ends
//                 `cancelled` with code `memory_cancelled`, and Home
//                 starts it again). Chat restarts through the supervisor
//                 only if it stays critical for 60 s. Reduced is left
//                 again once the level has been normal for a minute.
//                 Raise a health item and one notification.
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
import { cancelGeneratorsForMemory, generatorWorkPending, runningGeneratorKinds } from "@/lib/jobs";
import { getGovernorStatus, setAdmissionGate, videoWindowStats } from "@/lib/governor";
import { admissionVerdict, chatPagedOut, latestSample, levelSince, memoryLevel, orphanReaperEnabled, recordAction, recentActions, reserveBytes, setChatPagedOut, setLatestSample, setMemoryLevel, watchdogEnabled, WatchdogRules, type WatchdogLevel } from "@/lib/memoryState";
import { engineRoot } from "@/lib/store/layout";
import { dirname, join } from "node:path";
import { getRoleStatus, lastInteractiveAt } from "@/lib/supervisor";
import { controlReducedChat, reducedHolders } from "@/lib/reducedChatLease";
import { getReducedChatState } from "@/lib/reducedChat";
import { dataDir } from "@/lib/paths";
import { folderBytes, runSweeps } from "@/lib/sweeps";
import { descendantsOf as childPids, startTimeOf, commandLineOf } from "@/lib/processTree";
import { ownedPids, finishedSurvivors } from "@/lib/ownedProcesses";
import { getMemoryReader } from "@/lib/memory";
import { settingValues } from "@/settings";
import { metalHostFault } from "@/lib/hostProbe";
import { readDevBudget } from "@/lib/devBudget";

/** DEV-BUDGET-01: the dev budget the governor keeps back and what the launcher says development holds (both 0 when no dev launcher runs). */
const budgetFields = (): { budget_bytes: number; used_bytes: number } => { const b = readDevBudget(); return { budget_bytes: b.budgetBytes, used_bytes: b.usedBytes }; };

const GB = 1_073_741_824;
const VOICE_KEEP_MS = 300_000;
/** Nobody has used chat, speech or voice this long: chat may be put on the smaller Reduced model to make room. A person chatting always keeps the full model. */
const CHAT_IDLE_MS = 120_000;
/** The level must have been normal this long before Reduced is left again, so a brief dip does not swap chat back and forth. */
const REDUCED_HOLD_MS = 60_000;
/** After a give-back freed something, wait this long before judging whether the job must go. */
const SETTLE_MS = 10_000;
function gb(bytes: number): string { return (bytes / GB).toFixed(1); }

// ---- the ladder (pure) ----

export interface LadderState { level: WatchdogLevel; enter: number; clear: number; }
export function newLadder(): LadderState { return { level: "normal", enter: 0, clear: 0 }; }

export interface LadderReading { sample: SystemSample; swapGrowthBytes: number; reserve: number; }
type SwapoutsSample = SystemSample & { swapouts?: number };

/** Read the cumulative counter beside the memory sample on macOS. */
function swapoutsOf(sample: SystemSample): number | null {
  const supplied = (sample as SwapoutsSample).swapouts;
  if (supplied !== undefined) return supplied;
  if (process.platform !== "darwin") return null;
  try {
    const output = Bun.spawnSync(["vm_stat"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    const match = /^Swapouts:\s+(\d+)/m.exec(output);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

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

/** A chat pageout skips only the ordinary two-sample entry delay for WARN. */
function stepLadderForChatPageout(ladder: LadderState, reading: LadderReading, chatPagedOut: boolean): LadderState {
  const next = stepLadder(ladder, reading);
  if (!chatPagedOut || ladder.level !== "normal" || rawLevel(reading) !== "normal") return next;
  // Chat paging out a little while tens of gigabytes are free is not a shortage: pausing pictures and clips for it only made people wait (2026-10-29: paused at 43 GB free with a 10 GB reserve).
  if (reading.sample.availableBytes >= reading.reserve + 3 * WatchdogRules.warnClearMarginBytes) return next;
  return { level: "warn", enter: 0, clear: 0 };
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


// ---- the critical ladder (pure) ----

export type ReducedState = "off" | "entering" | "reduced" | "leaving";
export interface CriticalInputs {
  /** Idle workers and the idle voice engine were already asked to unload in this critical episode. */
  idleGivenBack: boolean;
  /** The idle judge was already evicted (or there was none to evict) in this episode. */
  judgeSettled: boolean;
  /** A give-back is still running (an unload, an eviction or the Reduced swap). */
  giveBackInFlight: boolean;
  /** Nobody has used chat, speech or voice for CHAT_IDLE_MS. */
  chatIdle: boolean;
  reduced: ReducedState;
  /** Reduced was already tried in this episode and could not be entered (coding mode, no small model, swap failed). */
  reduceTried: boolean;
  /** The newest sample, read on its own without the ladder's hysteresis, is still critical. */
  rawCritical: boolean;
  /** A give-back that freed something finished less than SETTLE_MS ago: its effect is not read yet. */
  settling: boolean;
}
/** `cancel-running` means "the last resort": the caller stops the running generative job if there is one, and goes on to the chat-restart rule if there is none. */
export type CriticalStep = "unload-idle" | "evict-judge" | "reduce-chat" | "wait" | "cancel-running";

/** What one critical round does, in order of cost to a person: give back what is idle, shrink an idle chat, and only then stop the running job. */
export function criticalStep(input: CriticalInputs): CriticalStep {
  if (!input.idleGivenBack) return "unload-idle";
  if (!input.judgeSettled) return "evict-judge";
  if (input.giveBackInFlight || input.reduced === "entering" || input.reduced === "leaving") return "wait";
  // The Stack's own idle memory is given back whatever the pressure reads now; the rest waits on a fresh reading.
  if (!input.rawCritical) return "wait";
  if (input.chatIdle && input.reduced === "off" && !input.reduceTried) return "reduce-chat";
  if (input.settling) return "wait";
  return "cancel-running";
}

// ---- actions ----

export interface WatchdogActions {
  /** Stop idle on-demand workers (pictures, clips, image tools, the idle voice engine); returns what was stopped. */
  unloadIdleWorkers(): Promise<string[]>;
  cancelQueued(reason: string): string[];
  cancelRunning(reason: string): string[];
  /** Unload a warm role the Stack owns; false when it was not loaded. */
  evictRole(role: "judge"): Promise<boolean>;
  /** Put chat on the smaller Reduced model. `reduced`: this call did it (the watchdog owns it and leaves it later); `already`: someone else holds Reduced; `waiting`: a chat turn is running, nothing changed; `unavailable`: it cannot be done here (coding mode, no small model, swap failed). */
  reduceChat(): Promise<"reduced" | "already" | "waiting" | "unavailable">;
  /** Give chat its normal model back after a reduce this watchdog made. `kept`: Home or the Max window still holds Reduced (the watchdog's hold is dropped); `waiting`: a chat turn is running, try again. */
  restoreChat(): Promise<"restored" | "kept" | "waiting" | "failed">;
  restartChat(): Promise<void>;
  restartChatGuard(cause: "memory-ceiling" | "maintenance-restart"): Promise<void>;
  notify(data: Record<string, unknown>): void;
}

async function defaultUnloadIdleWorkers(): Promise<string[]> {
  const stopped: string[] = [];
  const [{ imageGen }, { videoGen }, { musicGen }, { imageTools }, { livePortrait }, { lookService }, supervisor] = await Promise.all([import("@/images/imageEngine"), import("@/video/videoGen"), import("@/music/musicGen"), import("@/imagetools/imageTools"), import("@/liveportrait/liveportrait"), import("@/look/look"), import("@/lib/supervisor")]);
  if (imageGen.stopIfIdle()) stopped.push("pictures");
  if (videoGen.stopIfIdle()) stopped.push("video");
  if (musicGen.stopIfIdle()) stopped.push("music");
  if (imageTools.stopIfIdle()) stopped.push("image tools");
  if (livePortrait.stopIfIdle()) stopped.push("talking pictures");
  if (lookService.stopIfIdle()) stopped.push("look");
  const last = supervisor.lastInteractiveAt();
  const state = supervisor.getRoleStatus("tts").state;
  if ((state === "ready" || state === "loaded") && (last === null || Date.now() - last > VOICE_KEEP_MS) && await supervisor.unloadRole("tts", "Unloaded: this computer is low on memory.", "memory-watchdog-evict").catch(() => false)) stopped.push("voice engine");
  return stopped;
}

export const defaultActions: WatchdogActions = {
  unloadIdleWorkers: defaultUnloadIdleWorkers,
  cancelQueued: (reason) => cancelGeneratorsForMemory("queued", reason),
  cancelRunning: (reason) => cancelGeneratorsForMemory("running", reason),
  evictRole: async (role) => { const supervisor = await import("@/lib/supervisor"); if (supervisor.processRoleFor(role) === "chat") return false; return supervisor.unloadRole(role, "Unloaded: this computer is low on memory.", "memory-watchdog-evict").catch(() => false); },
  reduceChat: async () => {
    const result = await controlReducedChat(true, "watchdog").catch(() => null);
    if (!result) return "unavailable";
    if (result.status === 200) return "reduced";
    return result.status === 202 ? "waiting" : "unavailable";
  },
  restoreChat: async () => {
    const result = await controlReducedChat(false, "watchdog").catch(() => null);
    if (!result) return "failed";
    if (result.status === 200) return reducedHolders().length > 0 ? "kept" : "restored";
    return result.status === 202 ? "waiting" : "failed";
  },
  restartChat: async () => { const supervisor = await import("@/lib/supervisor"); await supervisor.restartRole("chat", "memory-watchdog"); void import("@/lib/supervisor").then(({ getProcess }) => getProcess("chat")).catch(() => {}); },
  restartChatGuard: async (cause) => { const supervisor = await import("@/lib/supervisor"); await supervisor.restartChatForHostGuard(cause); },
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
  chatLoaded?: () => boolean;
  /** True when nobody has used chat, speech or voice for CHAT_IDLE_MS (default: read from the supervisor). */
  chatIdle?: () => boolean;
  folderBytes?: (dir: string) => number;
  runSweeps?: (reason: string) => unknown;
  /** Reads the kernel's per-process memory figure. */
  processMemoryBytes?: (pid: number) => number | null;
  chatGuard?: () => Promise<{ pid: number | null; uptimeMs: number | null; engine: string | null; activeRequests: number; kind: string | null }>;
  chatCapBytes?: () => number | null | Promise<number | null>;
  ceilingFactor?: () => number;
  canary?: () => Promise<string | null>;
  jobsQuiet?: () => boolean;
  maintenanceHours?: () => number;
}

export interface TopConsumer { pid: number; name: string; bytes: number; stack: boolean; }
export interface MemoryReport {
  video_window: { shrinks: number; restores: number; shrunk_now: boolean; shrunk_since: string | null };
  watchdog: { enabled: boolean; level: WatchdogLevel; since: string; reserve_bytes: number; generation_paused: boolean; chat_paged_out: boolean; survivors_stopped: number };
  ledger: { reserved_bytes: number; warm_bytes: number; burst_bytes: number; budget_bytes: number; working_margin_bytes: number; free_bytes: number; queue_depth: { reserved: number; warm: number; burst: number }; chat_paged_out: boolean };
  memory: { total_bytes: number; available_bytes: number; free_bytes: number; wired_bytes: number; compressor_bytes: number; swap_used_bytes: number; swap_total_bytes: number; swap_growth_bytes_30s: number; pressure_level: number; pressure: string; sampled_at: string } | null;
  stack: { bytes: number; tmp_bytes: number; unaccounted_bytes: number; unregistered: { count: number; bytes: number }; processes: Array<{ pid: number; name: string; bytes: number }> };
  /** MEM-SPACE-05: what other programs hold beside the Stack, with the big ones named (name and bytes only, never a pid or folder). Empty list when nothing is flagged. */
  dev_load: { others_bytes: number; processes: Array<{ name: string; bytes: number }>; budget_bytes: number; used_bytes: number };
  top_consumers: TopConsumer[];
  non_stack_bytes: number;
  recent_actions: Array<{ at: string; level: WatchdogLevel; action: string; detail: string }>;
  history: Array<{ at: string; available_bytes: number; swap_used_bytes: number; pressure_level: number }>;
}

function reducedStateNow(): ReducedState { return getReducedChatState(); }

export class MemoryWatchdog {
  private devLoad: Omit<MemoryReport["dev_load"], "budget_bytes" | "used_bytes"> = { others_bytes: 0, processes: [] };
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
  private chatLoaded: () => boolean;
  private previousSwapouts: number | null = null;
  private consecutiveSwapoutRises = 0;
  private unloadInFlight = false;
  private evictInFlight = false;
  private judgeEvictionSettled = false;
  private judgeEvicted = false;
  private diskTempRaised = false;
  private measureFolder: (dir: string) => number;
  private sweepDisk: (reason: string) => unknown;
  private survivorSeen = new Set<number>();
  private survivorTerminated = new Map<number, { at: number; startTime: string; command: string; kind: string }>();
  private survivorsStopped = 0;
  private unaccountedSince: number | null = null;
  private unaccountedRaised = false;
  private lastSurvivorAt: number | null = null;
  private idleGivenBack = false;
  private criticalJudgeDone = false;
  private reduceTried = false;
  private reduceInFlight = false;
  private reduceWaits = 0;
  private lastGiveBackAt = 0;
  /** This watchdog entered Reduced (not Home, not the Max window), so it is the one to leave it. */
  private reducedOwned = false;
  private restoreInFlight = false;
  private normalSince: number | null = null;
  private chatIdleNow: () => boolean;
  private processMemoryBytes: (pid: number) => number | null;
  private chatGuard: NonNullable<WatchdogOptions["chatGuard"]>;
  private chatCapBytes: () => Promise<number | null>;
  private ceilingFactor: NonNullable<WatchdogOptions["ceilingFactor"]>;
  private canary: NonNullable<WatchdogOptions["canary"]>;
  private jobsQuiet: NonNullable<WatchdogOptions["jobsQuiet"]>;
  private maintenanceHours: NonNullable<WatchdogOptions["maintenanceHours"]>;
  private overCeilingLooks = 0;
  private memoryRestartAt: number[] = [];
  private maintenanceRestartAt = 0;
  private hostFaultRaised = false;
  private metalFaultRaised = false;
  private restartLimitRaised = false;
  private chatStartedObservedAt: number | null = null;
  private quietSince: number | null = null;

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
    this.chatLoaded = options.chatLoaded ?? (() => ["ready", "loaded", "busy"].includes(getRoleStatus("chat").state));
    this.chatIdleNow = options.chatIdle ?? (() => { const last = lastInteractiveAt(); return last === null || this.now() - last >= CHAT_IDLE_MS; });
    this.measureFolder = options.folderBytes ?? folderBytes;
    this.sweepDisk = options.runSweeps ?? runSweeps;
    this.processMemoryBytes = options.processMemoryBytes ?? ((pid) => getMemoryReader().processMemoryBytes(pid));
    this.chatGuard = options.chatGuard ?? (async () => (await import("@/lib/supervisor")).chatProcessRuntime());
    this.chatCapBytes = async () => {
      const bytes = await (options.chatCapBytes ? options.chatCapBytes() : (await import("@/lib/supervisor")).chatSplashMemoryCapBytes());
      return bytes;
    };
    this.ceilingFactor = options.ceilingFactor ?? (() => Number(settingValues()["stack.engines.chat.memory_ceiling_factor"] ?? 1.15));
    this.canary = options.canary ?? (() => metalHostFault("splash"));
    this.jobsQuiet = options.jobsQuiet ?? (() => !generatorWorkPending());
    this.maintenanceHours = options.maintenanceHours ?? (() => Number(settingValues()["stack.engines.chat.maintenance_restart_hours"] ?? 12));
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
      const swapouts = swapoutsOf(sample);
      const swapoutsRose = swapouts !== null && this.previousSwapouts !== null && swapouts > this.previousSwapouts;
      if (swapouts !== null) this.previousSwapouts = swapouts;
      this.consecutiveSwapoutRises = swapoutsRose ? this.consecutiveSwapoutRises + 1 : 0;
      setChatPagedOut(this.consecutiveSwapoutRises >= 2 && this.chatLoaded());
      this.ring.push(sample);
      if (this.ring.length > WatchdogRules.ringSize) this.ring.shift();
      setLatestSample(sample);
      this.ticks++;
      this.survivorsStopped = 0;
      if (this.ticks % 12 === 0) {
        const tempDir = `${dataDir}/tmp`;
        if (this.measureFolder(tempDir) > 2 * GB) {
          this.sweepDisk("disk-temp");
          if (this.measureFolder(tempDir) > 2 * GB) {
            if (!this.diskTempRaised) raise({ code: "disk-temp-grew", severity: "warning", title: "Temporary files are taking more than 2 GB", text: `Temporary files in ${tempDir} exceed 2 GB. Restart the engine to clear them.`, cause: `${tempDir} is still over the 2 GB temporary-file limit.`, fix: { label: "Restart engine", action: "restart_engine" } });
            this.diskTempRaised = true;
          } else if (this.diskTempRaised) { resolveHealth("disk-temp-grew"); this.diskTempRaised = false; }
        } else if (this.diskTempRaised) { resolveHealth("disk-temp-grew"); this.diskTempRaised = false; }
      }
      const tight = memoryLevel() !== "normal";
      if (tight || this.ticks % WatchdogRules.processEvery === 1) this.rows = this.measureProcesses(this.sampler.processes());
      if (!watchdogEnabled() || sample.degraded) { this.devLoad = { others_bytes: 0, processes: [] }; if (memoryLevel() !== "normal") this.leave(); this.reapSurvivors(); this.checkUnaccounted(); return; }
      await this.chatGuardTick();
      const reserve = reserveBytes(sample.totalBytes);
      const previous = this.ladder.level;
      this.ladder = stepLadderForChatPageout(this.ladder, { sample, swapGrowthBytes: this.swapGrowth(), reserve }, chatPagedOut());
      if (this.ladder.level !== previous) {
        setMemoryLevel(this.ladder.level, this.now());
        this.record(this.ladder.level, "level", `${previous} to ${this.ladder.level}: ${gb(sample.availableBytes)} GB available, ${gb(reserve)} GB reserve, kernel level ${sample.pressureLevel}, swap ${gb(sample.swapUsedBytes)} GB`);
        this.criticalSince = this.ladder.level === "critical" ? this.now() : null;
        if (this.ladder.level === "critical") { this.judgeEvicted = false; this.judgeEvictionSettled = false; this.idleGivenBack = false; this.criticalJudgeDone = false; this.reduceTried = false; this.reduceWaits = 0; }
      }
      if (this.ladder.level === "normal") this.leave();
      else { this.normalSince = null; await this.act(sample, rawLevel({ sample, swapGrowthBytes: this.swapGrowth(), reserve }) === "critical"); }
      this.devProtection();
      this.reapOrphans();
      this.reapSurvivors();
      this.checkUnaccounted();
    } finally {
      this.busy = false;
    }
  }

  /** HOST-GUARD-05: the only reserved role with automatic memory restarts. We require two measured ceiling looks, a two-minute idle window, no queued/held/running generator, and a passing Metal canary. */
  private async chatGuardTick(): Promise<void> {
    const process = await this.chatGuard();
    if (!process.pid || process.kind !== "spawned" || process.engine !== "splash-chat" || process.uptimeMs === null) {
      this.overCeilingLooks = 0; this.chatStartedObservedAt = null; this.quietSince = null; return;
    }
    const startedAt = this.now() - process.uptimeMs;
    if (this.chatStartedObservedAt !== null && this.chatStartedObservedAt !== startedAt) {
      resolveHealth("resident-memory-grew.chat");
      this.restartLimitRaised = false;
    }
    this.chatStartedObservedAt = startedAt;
    const row = this.rows.find((candidate) => candidate.pid === process.pid);
    const cap = await this.chatCapBytes();
    if (this.metalFaultRaised) {
      const recoveryFault = await this.canary();
      if (recoveryFault) return;
      resolveHealth("host-metal-fault");
      this.metalFaultRaised = false;
    }
    if (row && cap && row.rssBytes > cap * this.ceilingFactor()) this.overCeilingLooks++;
    else this.overCeilingLooks = 0;
    if (this.overCeilingLooks === 0) {
      resolveHealth("resident-memory-grew.chat");
      this.restartLimitRaised = false;
    }

    const now = this.now();
    this.memoryRestartAt = this.memoryRestartAt.filter((at) => now - at < 24 * 60 * 60_000);
    const quietNow = this.chatIdleNow() && process.activeRequests === 0 && this.jobsQuiet();
    this.quietSince = quietNow ? (this.quietSince ?? now) : null;
    const quiet = quietNow && this.quietSince !== null && now - this.quietSince >= CHAT_IDLE_MS;
    const canRestart = quiet && this.overCeilingLooks >= 2;
    const maintenanceHours = this.maintenanceHours();
    const maintenanceDue = maintenanceHours > 0 && process.uptimeMs >= maintenanceHours * 60 * 60_000 && (this.maintenanceRestartAt === 0 || now - this.maintenanceRestartAt >= 24 * 60 * 60_000);
    if (!canRestart && !(maintenanceDue && quiet)) return;
    if (maintenanceDue && quiet) {
      const fault = await this.canary();
      if (fault) { this.reportHostFault(fault); return; }
      if (this.metalFaultRaised) { resolveHealth("host-metal-fault"); this.metalFaultRaised = false; }
      this.maintenanceRestartAt = now;
      await this.actions.restartChatGuard("maintenance-restart");
      resolveHealth("resident-memory-grew.chat");
      this.restartLimitRaised = false;
      this.chatStartedObservedAt = null;
      this.record(memoryLevel(), "maintenance-restart-chat", "chat reached its scheduled uptime in a quiet window");
      return;
    }
    if (!canRestart) return;
    const fault = await this.canary();
    if (fault) { this.reportHostFault(fault); return; }
    if (this.metalFaultRaised) { resolveHealth("host-metal-fault"); this.metalFaultRaised = false; }
    if (this.memoryRestartAt.length >= 4 || (this.memoryRestartAt.length > 0 && now - this.memoryRestartAt[this.memoryRestartAt.length - 1]! < 60 * 60_000)) {
      if (!this.restartLimitRaised) raise({ code: "resident-memory-grew.chat", severity: "warning", title: "Chat is using more memory than its limit", text: "Chat stayed above its memory limit. Restart the engine to start it fresh.", cause: "Automatic chat restarts reached their hourly or daily limit.", fix: { label: "Restart engine", action: "restart_engine" } });
      this.restartLimitRaised = true;
      return;
    }
    this.memoryRestartAt.push(now);
    this.overCeilingLooks = 0;
    resolveHealth("resident-memory-grew.chat");
    this.restartLimitRaised = false;
    await this.actions.restartChatGuard("memory-ceiling");
    this.chatStartedObservedAt = null;
    this.record(memoryLevel(), "memory-ceiling-restart-chat", `chat exceeded ${gb(cap!)} GB by the configured ceiling factor`);
  }

  private reportHostFault(reason: string): void {
    if (this.metalFaultRaised) return;
    this.metalFaultRaised = true;
    raise({ code: "host-metal-fault", severity: "warning", title: "This Mac cannot restart its Metal engine", text: "The Stack kept chat running because macOS could not pass its Metal check. Check the Mac and try again later.", cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
  }

  /** Keep enumeration cheap: measure the 40 largest RSS processes and every Stack-owned pid. */
  private measureProcesses(rows: ProcessRow[]): ProcessRow[] {
    const own = descendantsOf(rows, [this.ownPid]);
    const selected = new Set([...rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 40).map((row) => row.pid));
    for (const row of rows) if (row.pid === this.ownPid || own.has(row.pid)) selected.add(row.pid);
    return rows.map((row) => {
      if (!selected.has(row.pid)) return row;
      try {
        const measured = this.processMemoryBytes(row.pid);
        return measured === null ? row : { ...row, rssBytes: measured };
      } catch { return row; }
    });
  }

  private leave(): void {
    if (this.itemRaised) { resolveHealth("memory-low"); resolveHealth("memory-critical"); this.itemRaised = false; }
    if (this.ladder.level !== "normal") { this.ladder = newLadder(); setMemoryLevel("normal", this.now()); }
    this.criticalSince = null;
    this.judgeEvicted = false;
    this.judgeEvictionSettled = false;
    this.idleGivenBack = false;
    this.criticalJudgeDone = false;
    this.reduceTried = false;
    this.reduceWaits = 0;
    setChatPagedOut(false);
    this.maybeRestoreChat();
  }

  /** Reduced made by this watchdog ends once the level has stayed normal for a minute and no chat turn is running; a turn in flight only delays it. */
  private maybeRestoreChat(): void {
    if (!this.reducedOwned || this.restoreInFlight) return;
    const now = this.now();
    this.normalSince ??= now;
    if (now - this.normalSince < REDUCED_HOLD_MS) return;
    this.restoreInFlight = true;
    void this.actions.restoreChat().then((result) => {
      if (result === "restored") { this.reducedOwned = false; this.record("normal", "restore-chat", "memory recovered; chat is back on its normal model"); }
      else if (result === "kept") { this.reducedOwned = false; this.record("normal", "restore-chat-kept", "another holder still needs the smaller model"); }
    }).catch((error: unknown) => this.record("normal", "restore-chat-failed", error instanceof Error ? error.message : String(error))).finally(() => { this.restoreInFlight = false; });
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

  private async act(sample: SystemSample, rawCritical = true): Promise<void> {
    const level = this.ladder.level;
    if (level === "normal") return;
    this.raiseItem(level, sample);
    const now = this.now();
    // New work is already refused by the admission gate; here the running side is trimmed.
    if (now - this.lastActionAt < 10_000 && level !== "critical") return;
    const reason = "Paused: this computer is low on memory. Try again once it recovers.";
    if (level === "warn") {
      this.startUnload(level, now);
      if (!this.evictInFlight) this.startEvict(level, now, sample);
      return;
    }
    // CRITICAL (`criticalStep`): the running job is the last thing given up.
    const queued = this.actions.cancelQueued(reason);
    if (queued.length > 0) this.record(level, "cancel-queued", `${queued.length} queued job(s) cancelled`);
    const kinds = runningGeneratorKinds();
    const step = criticalStep({
      idleGivenBack: this.idleGivenBack,
      judgeSettled: this.criticalJudgeDone,
      giveBackInFlight: this.unloadInFlight || this.evictInFlight || this.reduceInFlight,
      chatIdle: this.chatIdleNow(),
      reduced: reducedStateNow(),
      reduceTried: this.reduceTried,
      rawCritical,
      settling: now - this.lastGiveBackAt < SETTLE_MS,
    });
    switch (step) {
      case "unload-idle": this.idleGivenBack = true; this.startUnload(level, now); return;
      case "evict-judge":
        if (this.unloadInFlight || this.evictInFlight) return;
        this.startEvict(level, now, sample);
        return;
      case "reduce-chat": this.startReduce(level); return;
      case "wait": return;
      case "cancel-running": {
        const cancelled = this.actions.cancelRunning("Stopped: this computer got too busy. It can start again in a little while.");
        if (cancelled.length > 0) { this.lastActionAt = now; this.lastGiveBackAt = now; this.record(level, "cancel-running", `${kinds.join(", ") || "generative job"} cancelled`); this.notifyOnce(sample); return; }
        break;
      }
    }
    if (this.evictInFlight) { this.notifyOnce(sample); return; }
    this.judgeEvictionSettled = false;
    const criticalSince = this.criticalSince;
    if (criticalSince !== null && now - criticalSince >= WatchdogRules.chatRestartAfterMs && now - this.lastChatRestartAt >= WatchdogRules.chatRestartCooldownMs) {
      this.lastChatRestartAt = now; this.lastActionAt = now;
      const report = this.report();
      if (report.stack.bytes <= report.non_stack_bytes) { this.record(level, "chat-restart-skipped", "another program holds most of the memory"); return; }
      this.record(level, "restart-chat", `critical for ${Math.round((now - criticalSince) / 1000)} s; the supervisor restarts the chat role`);
      void this.actions.restartChat().catch((error: unknown) => this.record(level, "restart-chat-failed", error instanceof Error ? error.message : String(error)));
    }
  }

  private startUnload(level: WatchdogLevel, now: number): void {
    if (this.unloadInFlight) return;
    this.unloadInFlight = true;
    this.lastActionAt = now;
    void this.actions.unloadIdleWorkers().then((stopped) => { if (stopped.length > 0) { this.lastGiveBackAt = this.now(); this.record(level, "unload-idle", stopped.join(", ")); } }).catch((error: unknown) => this.record(level, "unload-idle-failed", error instanceof Error ? error.message : String(error))).finally(() => { this.unloadInFlight = false; });
  }

  private startEvict(level: WatchdogLevel, now: number, sample: SystemSample): void {
    if (level === "warn") {
      this.evictInFlight = true;
      void import("@/lib/supervisor").then(({ lastInteractiveAt }) => {
        const last = lastInteractiveAt();
        if (last !== null && now - last < VOICE_KEEP_MS) return false;
        return this.actions.evictRole("judge");
      }).then((evicted) => { if (evicted) { this.lastActionAt = now; this.record(level, "evict-judge", "the judge role was unloaded"); } }).catch((error: unknown) => this.record(level, "evict-judge-failed", error instanceof Error ? error.message : String(error))).finally(() => { this.judgeEvictionSettled = true; this.evictInFlight = false; });
      return;
    }
    this.evictInFlight = true;
    void this.actions.evictRole("judge").then((evicted) => { if (evicted) { this.judgeEvicted = true; this.lastActionAt = now; this.lastGiveBackAt = this.now(); this.record(level, "evict-judge", "the judge role was unloaded"); this.notifyOnce(sample); } }).catch((error: unknown) => this.record(level, "evict-judge-failed", error instanceof Error ? error.message : String(error))).finally(() => { this.judgeEvictionSettled = true; this.criticalJudgeDone = true; this.evictInFlight = false; });
  }

  /** Chat is idle and the pressure is still critical: put it on the smaller model before any job is stopped. A turn that starts first wins (the swap answers `waiting`), and the step is tried again next round. */
  private startReduce(level: WatchdogLevel): void {
    if (this.reduceInFlight) return;
    this.reduceInFlight = true;
    this.reduceTried = true;
    void this.actions.reduceChat().then((result) => {
      if (result === "reduced") { this.reducedOwned = true; this.lastGiveBackAt = this.now(); this.record(level, "reduce-chat", "chat idle; it now uses the smaller model so a running job can keep going"); }
      else if (result === "waiting") { this.reduceWaits++; this.reduceTried = this.reduceWaits >= 2; }
      else this.record(level, "reduce-chat-skipped", result === "already" ? "chat was already on the smaller model" : "chat could not switch to the smaller model here");
    }).catch((error: unknown) => this.record(level, "reduce-chat-failed", error instanceof Error ? error.message : String(error))).finally(() => { this.reduceInFlight = false; });
  }

  private notifyOnce(sample: SystemSample): void {
    const now = this.now();
    if (now - this.lastNotifyAt < WatchdogRules.notifyEveryMs) return;
    this.lastNotifyAt = now;
    this.actions.notify({ pressure: "critical", source: "memory-watchdog", reason: "This computer is out of memory; picture and video making was stopped.", free_memory_bytes: Math.round(sample.availableBytes), swap_used_bytes: Math.round(sample.swapUsedBytes), top_consumers: this.consumers().map((c) => ({ name: c.name, bytes: c.bytes })) });
  }

  /** Developer protection: name the programs that hold the memory. Nothing is stopped. */
  private devProtection(): void {
    if (this.rows.length === 0) { this.devLoad = { others_bytes: 0, processes: [] }; return; }
    const tree = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    const others = this.rows.filter((row) => !tree.has(row.pid));
    const sum = others.reduce((total, row) => total + row.rssBytes, 0);
    const big = others.filter((row) => row.rssBytes > WatchdogRules.devSingleBytes);
    const flagged = big.length > 0 ? big : sum > WatchdogRules.devSumBytes ? [...others].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 5) : [];
    this.devLoad = { others_bytes: sum, processes: flagged.map((row) => ({ name: row.name, bytes: row.rssBytes })) };
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

  private reapSurvivors(): void {
    const now = this.now();
    const alive = new Set(this.rows.map((row) => row.pid));
    for (const [pid, entry] of this.survivorTerminated) {
      if (!alive.has(pid)) { this.survivorTerminated.delete(pid); continue; }
      const row = this.rows.find((item) => item.pid === pid);
      if (now - entry.at >= 5_000 && row && (row.ppid === this.ownPid || row.ppid === 1) && startTimeOf(pid) === entry.startTime && commandLineOf(pid) === entry.command) {
        this.kill(pid, "SIGKILL"); this.survivorTerminated.delete(pid);
        logger.appendLine(JSON.stringify({ event: "process.survivor", kind: entry.kind, pid, age_seconds: 0, rss_bytes: this.rows.find((row) => row.pid === pid)?.rssBytes ?? 0, action: "SIGKILL" }));
      }
    }
    const current = new Set<number>();
    for (const survivor of finishedSurvivors(now)) {
      const row = this.rows.find((item) => item.pid === survivor.pid);
      if (!row || (row.ppid !== this.ownPid && row.ppid !== 1)) continue;
      current.add(row.pid);
      if (!this.survivorSeen.has(row.pid) || this.survivorTerminated.has(row.pid)) continue;
      if (startTimeOf(row.pid) !== survivor.startTime || commandLineOf(row.pid) !== survivor.command) continue;
      this.kill(row.pid, "SIGTERM");
      this.survivorTerminated.set(row.pid, { at: now, startTime: survivor.startTime, command: survivor.command, kind: survivor.kind });
      this.survivorsStopped++;
      this.lastSurvivorAt = now;
      logger.appendLine(JSON.stringify({ event: "process.survivor", kind: survivor.kind, pid: row.pid, age_seconds: row.ageSeconds, rss_bytes: row.rssBytes, action: "SIGTERM" }));
      raise({ code: "stray-process", severity: "warning", title: "A helper process was left running and has been stopped", text: `A ${survivor.kind} helper ran for ${row.ageSeconds} seconds after its job finished.`, cause: "A finished Stack job left a helper process running." });
    }
    this.survivorSeen = current;
    if (this.lastSurvivorAt !== null && now - this.lastSurvivorAt >= 10 * 60_000) { resolveHealth("stray-process"); this.lastSurvivorAt = null; }
  }

  private checkUnaccounted(): void {
    const report = this.report();
    const bytes = report.stack.unaccounted_bytes;
    const now = this.now();
    if (bytes > 4 * GB) {
      this.unaccountedSince ??= now;
      if (!this.unaccountedRaised && now - this.unaccountedSince >= 2 * 60_000) {
        this.unaccountedRaised = true;
        void this.actions.unloadIdleWorkers();
        logger.appendLine(JSON.stringify({ event: "memory.unaccounted", bytes, unregistered_count: report.stack.unregistered.count, unregistered_bytes: report.stack.unregistered.bytes }));
        raise({ code: "memory-unaccounted", severity: "warning", title: "MaiPai is using more memory than its models account for", text: `${gb(bytes)} GB is unaccounted for, with ${report.stack.unregistered.count} unregistered helper processes. Idle helpers were unloaded.`, cause: "The Stack process tree uses more memory than loaded models account for.", fix: { label: "Restart engine", action: "restart_engine" } });
      }
    } else { this.unaccountedSince = null; if (bytes < 2 * GB && this.unaccountedRaised) { resolveHealth("memory-unaccounted"); this.unaccountedRaised = false; } }
  }

  report(): MemoryReport {
    const sample = latestSample() ?? this.ring[this.ring.length - 1] ?? null;
    const tree = descendantsOf(this.rows, liveStackRoots(this.rows, this.ownPid));
    const ownTree = descendantsOf(this.rows, [this.ownPid]);
    const own = this.rows.filter((row) => row.pid === this.ownPid || ownTree.has(row.pid));
    const growth = this.swapGrowth();
    const level = memoryLevel();
    const governor = getGovernorStatus();
    const classBytes = { reserved: 0, warm: 0, burst: 0 };
    const queueDepth = { reserved: 0, warm: 0, burst: 0 };
    for (const item of governor.loaded) classBytes[item.class] += item.peakBytes;
    for (const item of governor.queue) queueDepth[item.class]++;
    return {
      video_window: videoWindowStats(),
      watchdog: { enabled: watchdogEnabled(), level, since: new Date(levelSince()).toISOString(), reserve_bytes: sample ? reserveBytes(sample.totalBytes) : 0, generation_paused: level !== "normal", chat_paged_out: chatPagedOut(), survivors_stopped: this.survivorsStopped },
      ledger: { reserved_bytes: classBytes.reserved, warm_bytes: classBytes.warm, burst_bytes: classBytes.burst, budget_bytes: governor.capBytes, working_margin_bytes: governor.marginBytes, free_bytes: governor.freeMemoryBytes, queue_depth: queueDepth, chat_paged_out: chatPagedOut() },
      memory: sample ? { total_bytes: sample.totalBytes, available_bytes: sample.availableBytes, free_bytes: sample.freeBytes, wired_bytes: sample.wiredBytes, compressor_bytes: sample.compressorBytes, swap_used_bytes: sample.swapUsedBytes, swap_total_bytes: sample.swapTotalBytes, swap_growth_bytes_30s: growth, pressure_level: sample.pressureLevel, pressure: sample.pressure, sampled_at: new Date(sample.at).toISOString() } : null,
      // 20 GB fresh and 101–103 GB after hours vs 2.6 GB `ps` RSS for the same pid: use the shared process-memory definition.
      stack: { bytes: own.reduce((total, row) => total + row.rssBytes, 0), tmp_bytes: folderBytes(join(dataDir, "tmp")), unaccounted_bytes: Math.max(0, own.reduce((total, row) => total + row.rssBytes, 0) - governor.loaded.reduce((total, item) => total + item.peakBytes, 0)), unregistered: (() => { const registered = ownedPids(); const old = own.filter((row) => row.pid !== this.ownPid && row.ageSeconds > 60 && !registered.has(row.pid)); return { count: old.length, bytes: old.reduce((total, row) => total + row.rssBytes, 0) }; })(), processes: own.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 10).map((row) => ({ pid: row.pid, name: row.name, bytes: row.rssBytes })) },
      dev_load: { ...this.devLoad, ...budgetFields() },
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
