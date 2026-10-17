// STACK-DDGS-01: the ddgs web search sidecar, owned and supervised by the
// Stack. Home's web search needs a source that works with no account and
// no key; the maintained `ddgs` library is that source, and it is Python.
// So the Stack builds a managed Python environment for it (the same
// builder as the voice engines: the pinned uv, a uv-managed Python 3.12,
// a hashed requirements file), starts the small loopback service in
// `ddgs_sidecar.py`, restarts it when it dies (with a growing pause), and
// publishes its address and health on GET /stack/v1/search. Home reads
// that address; it never starts anything itself.
//
// A failing sidecar never fails the Stack: every step here catches, turns
// the failure into a health item that says what went wrong and what to
// do, and tries again later. The words a person searches never reach this
// file: the Stack does not proxy searches, and the sidecar logs none.
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { log } from "@/lib/log";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./ddgs.darwin-arm64.requirements.txt" with { type: "file" };
import serverScript from "./ddgs_sidecar.py" with { type: "file" };

export const DDGS_SIDECAR_NAME = "ddgs-sidecar";
/** The `ddgs` library's version, which is also the environment's version: a new pin is a new environment. */
export const DDGS_SIDECAR_VERSION = "9.16.0";
export const DDGS_HEALTH_CODE = "search.ddgs";

export type DdgsState = "unsupported" | "disabled" | "building" | "starting" | "ready" | "failed";
export interface DdgsStatus {
  /** unsupported: no requirements file for this platform; disabled: switched off; building: the environment is being assembled;
   * starting: the process is launching or restarting; ready: it answered its health check; failed: the build or the process failed and a retry is waiting. */
  state: DdgsState;
  /** The loopback address Home searches through, set only while the sidecar is healthy. */
  url: string | null;
  /** The build phase while building (uv, python, packages). */
  phase: string | null;
  /** The plain reason for unsupported, disabled or failed. */
  reason: string | null;
  /** How many times the process was restarted since the Stack started. */
  restarts: number;
  /** The library the sidecar runs. */
  library: { name: "ddgs"; version: string };
}

/** The hashed requirements file for this platform, compiled with `uv pip compile --generate-hashes`; none yet means the sidecar cannot build here. */
export function ddgsRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

export function ddgsRoot(): string { return engineTagRoot(DDGS_SIDECAR_NAME, DDGS_SIDECAR_VERSION); }
/** The library's own package: proof the sync finished. */
export function ddgsProof(): string { return join(uvVenvPath(ddgsRoot()), "lib", "python3.12", "site-packages", "ddgs", "__init__.py"); }
export function ddgsInstalled(): boolean { return uvEnvironmentReady({ name: DDGS_SIDECAR_NAME, version: DDGS_SIDECAR_VERSION, root: ddgsRoot(), proof: ddgsProof() }); }
function spec(): UvEnvironmentSpec { return { name: DDGS_SIDECAR_NAME, version: DDGS_SIDECAR_VERSION, root: ddgsRoot(), requirements: ddgsRequirementsFileFor(), proof: ddgsProof() }; }

/** The server script on the real disk (the compiled daemon's copy lives in Bun's virtual filesystem, which Python cannot open). */
export async function materializeSidecarScript(root = ddgsRoot()): Promise<string> {
  const target = join(root, "ddgs_sidecar.py");
  writeFileSync(target, await Bun.file(serverScript).text());
  chmodSync(target, 0o644);
  return target;
}

export function ddgsEnv(): Record<string, string> {
  const env = managedEnv({ PYTHONUNBUFFERED: "1" });
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  return env;
}

export async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolvePort(port)); });
  });
}

/** What the supervisor touches, so a test can replace the environment build, the process and the clock. */
export interface DdgsDeps {
  requirements: () => string | null;
  ensureEnvironment: (onProgress: (phase: string) => void) => Promise<void>;
  spawn: (port: number) => Promise<{ exited: Promise<number>; kill: () => void; stderrTail: () => string }>;
  port: () => Promise<number>;
  healthy: (url: string) => Promise<boolean>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(done, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
});

export const defaultDdgsDeps: DdgsDeps = {
  requirements: () => ddgsRequirementsFileFor(),
  ensureEnvironment: (onProgress) => ensureUvEnvironment(spec(), onProgress),
  port: freeLoopbackPort,
  spawn: async (port) => {
    const script = await materializeSidecarScript();
    const child = Bun.spawn([uvVenvPython(ddgsRoot()), script], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: { ...ddgsEnv(), DDGS_SIDECAR_PORT: String(port) } });
    let tail = "";
    void (async () => { for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) tail = (tail + new TextDecoder().decode(chunk)).slice(-1500); })().catch(() => {});
    return { exited: child.exited, kill: () => { try { child.kill(); } catch { /* already gone */ } }, stderrTail: () => tail.trim().split("\n").slice(-3).join(" | ") };
  },
  healthy: async (url) => {
    try { const response = await fetch(new URL("health", url), { signal: AbortSignal.timeout(2000) }); return response.ok; } catch { return false; }
  },
  sleep: realSleep,
  now: Date.now,
};

/** Pauses between restarts of a process that keeps dying, and between rebuild attempts, capped at the last. */
export const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 60_000, 5 * 60_000];
export const REBUILD_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
/** A run this long counts as healthy: the restart pause starts over. */
const STABLE_RUN_MS = 60_000;
/** Consecutive quick deaths before a health item is raised (one restart is not news). */
const DEATHS_BEFORE_HEALTH = 3;

export class DdgsSupervisor {
  private status: DdgsStatus = { state: "building", url: null, phase: null, reason: null, restarts: 0, library: { name: "ddgs", version: DDGS_SIDECAR_VERSION } };
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private kill: (() => void) | null = null;
  private wake: (() => void) | null = null;
  constructor(private readonly deps: DdgsDeps = defaultDdgsDeps) {}

  get(): DdgsStatus { return { ...this.status }; }
  private set(patch: Partial<DdgsStatus>): void { this.status = { ...this.status, ...patch }; }

  /** Starts the supervising loop once; returns at once. Never throws. */
  start(): void {
    if (this.loop) return;
    if (process.env.STACK_DDGS_SIDECAR === "off") { this.set({ state: "disabled", reason: "The search service is switched off (STACK_DDGS_SIDECAR=off)." }); return; }
    if (!this.deps.requirements()) { this.set({ state: "unsupported", reason: `Web search through DuckDuckGo is not available on ${process.platform} ${process.arch} yet.` }); return; }
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal).catch((error) => { log("ddgs sidecar supervisor stopped: %s", error instanceof Error ? error.message : String(error)); });
  }

  /** Stops the process and the loop. */
  async stop(): Promise<void> {
    this.abort?.abort();
    this.kill?.();
    await this.loop;
    this.loop = null;
    this.abort = null;
  }

  /** Cuts the current wait short (Home's "Try again"): a failed build is retried now. */
  retryNow(): void { this.wake?.(); }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    await Promise.race([this.deps.sleep(ms, signal), new Promise<void>((done) => { this.wake = done; })]);
    this.wake = null;
  }

  private fail(reason: string, title: string, what: string): void {
    this.set({ state: "failed", url: null, phase: null, reason });
    try {
      raise({ code: DDGS_HEALTH_CODE, severity: "warning", title, text: `${what} ${reason}`, cause: reason, fix: { label: "Try again", action: "retry_download" } });
    } catch (error) { log("ddgs sidecar health item not raised: %s", error instanceof Error ? error.message : String(error)); }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let builds = 0;
    let deaths = 0;
    while (!signal.aborted) {
      // 1. The environment: built once, kept; a failure is a health item and a later retry.
      try {
        this.set({ state: "building", phase: null, url: null, reason: null });
        await this.deps.ensureEnvironment((phase) => this.set({ phase }));
        builds = 0;
      } catch (error) {
        if (signal.aborted) return;
        const detail = error instanceof Error ? error.message : String(error);
        this.fail(detail, "Web search could not be set up", "The Stack could not build the search service's Python environment, so web search through DuckDuckGo is off. Check this computer's internet connection; the Stack tries again by itself, or press Try again.");
        await this.pause(REBUILD_BACKOFF_MS[Math.min(builds, REBUILD_BACKOFF_MS.length - 1)]!, signal);
        builds += 1;
        continue;
      }
      // 2. The process, until it dies; then a pause that grows while it keeps dying quickly.
      let startedAt = this.deps.now();
      let stderr = "";
      try {
        this.set({ state: "starting", phase: null });
        const port = await this.deps.port();
        const url = `http://127.0.0.1:${port}/`;
        const child = await this.deps.spawn(port);
        this.kill = child.kill;
        startedAt = this.deps.now();
        const ready = await this.waitHealthy(url, child.exited, signal);
        if (ready) {
          this.set({ state: "ready", url, reason: null });
          resolveHealth(DDGS_HEALTH_CODE);
        }
        if (!ready) child.kill();
        else void this.watchLiveness(url, child, signal);
        const code = await child.exited;
        stderr = child.stderrTail();
        this.kill = null;
        if (signal.aborted) return;
        this.set({ state: "starting", url: null, reason: `The search service stopped (exit ${code}).`, restarts: this.status.restarts + 1 });
        if (!ready) stderr = stderr || `It exited with code ${code} before it answered.`;
      } catch (error) {
        stderr = error instanceof Error ? error.message : String(error);
      }
      this.kill = null;
      if (signal.aborted) return;
      deaths = this.deps.now() - startedAt >= STABLE_RUN_MS ? 1 : deaths + 1;
      if (deaths >= DEATHS_BEFORE_HEALTH) this.fail(stderr || "It stopped without saying why.", "Web search keeps stopping", "The search service on this computer keeps stopping, so web search through DuckDuckGo is off. The Stack keeps restarting it; press Try again to restart it now.");
      await this.pause(RESTART_BACKOFF_MS[Math.min(deaths - 1, RESTART_BACKOFF_MS.length - 1)]!, signal);
    }
  }

  /** A hung process never exits: two failed health checks in a row (30 seconds apart) kill it so the loop restarts it. */
  private async watchLiveness(url: string, child: { exited: Promise<number>; kill: () => void }, signal: AbortSignal): Promise<void> {
    let dead = false;
    void child.exited.then(() => { dead = true; });
    let misses = 0;
    while (!dead && !signal.aborted) {
      await this.deps.sleep(30_000, signal);
      if (dead || signal.aborted) return;
      misses = (await this.deps.healthy(url)) ? 0 : misses + 1;
      if (misses >= 2) { child.kill(); return; }
    }
  }

  /** True once the health check passes; false when the process dies first or the wait runs out (30 seconds). */
  private async waitHealthy(url: string, exited: Promise<number>, signal: AbortSignal): Promise<boolean> {
    let dead = false;
    void exited.then(() => { dead = true; });
    const deadline = this.deps.now() + 30_000;
    while (!dead && !signal.aborted && this.deps.now() < deadline) {
      if (await this.deps.healthy(url)) return true;
      await this.deps.sleep(250, signal);
    }
    return false;
  }
}

/** The Stack's one supervisor. */
export const ddgsSupervisor = new DdgsSupervisor();
