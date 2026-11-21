// CODE-SANDBOX-01b: the sandbox service. One small Linux machine per Code session, driven through Apple's `container` CLI.
// Design: Home docs/design/local-coding-2026-10-17.md section 3.4 and code-app-refresh-2026-11-21.md section 4; the hand-run proof
// is docs/reports/code-sandbox-spike-2026-11-21.md. The machine sits on a host-only network with no resolver and loads a lock at
// start (backend/sandbox/sandbox-entry.sh, CODE-SANDBOX-02). A start whose lock does not load is a failed start.
//
// TODO (CODE-SANDBOX-02, egress proxy slice): the allowlist proxy and `network.policy = "hosts"`.
// TODO (CODE-SANDBOX-01b, later slices): governor memory admission, snapshots, disk and process limits, OpenCode in the image.
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

export const SANDBOX_NETWORK = "maipai-sandbox-net";
export const MACHINE_PREFIX = "maipai-sbx-";
export const WORKSPACE_MOUNT = "/workspace";
export const DEFAULT_CPUS = 4;
export const DEFAULT_MEMORY_GB = 4;
export const MAX_CPUS = 8;
export const MAX_MEMORY_GB = 16;
export const DEFAULT_IDLE_MS = 30 * 60_000;
export const ENTRY_EXIT_LOCK_FAILED = 70;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV = /^SANDBOX_/;

export type SandboxErrorCode = "invalid_id" | "invalid_request" | "bad_workspace" | "exists" | "not_found" | "lock_failed" | "start_failed" | "runtime_unavailable" | "network_unavailable";
const STATUS: Record<SandboxErrorCode, 400 | 404 | 409 | 500 | 503> = { invalid_id: 400, invalid_request: 400, bad_workspace: 400, exists: 409, not_found: 404, lock_failed: 500, start_failed: 500, runtime_unavailable: 503, network_unavailable: 503 };

/** A typed failure; `message` is plain words that say what went wrong and what to do. */
export class SandboxError extends Error {
  readonly status: 400 | 404 | 409 | 500 | 503;
  constructor(readonly code: SandboxErrorCode, message: string) { super(message); this.name = "SandboxError"; this.status = STATUS[code]; }
}

export interface RunResult { code: number; stdout: string; stderr: string }
/** The one place the `container` program is called. Tests pass a fake. */
export type ContainerRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<RunResult>;

export interface SandboxConfig {
  /** Every workspace must sit under this folder. */
  codingRoot: string;
  /** The pinned sandbox image. */
  image: string;
  /** TCP ports the machine may reach on the gateway address (the hub's gateway port; the proxy port later). */
  allowedPorts: number[];
  /** The gateway address on the sandbox network; read from the network when unset. */
  gatewayAddress?: string;
  idleMs: number;
  /** How long a start may take before the lock is judged not loaded. */
  startTimeoutMs: number;
  pollMs: number;
}

export interface CreateRequest {
  id: string;
  workspace: string;
  cpus?: number;
  memory_gb?: number;
  env?: Record<string, string>;
  /** Internal: tests of the lock run the probe as root, behind the same lock. Never set by a route. */
  runAs?: string;
  /** Internal: replaces the default idle workload. Never set by a route. */
  workload?: string[];
}

export interface SandboxInfo {
  id: string;
  machine: string;
  state: "running" | "stopped";
  workspace: string;
  cpus: number;
  memory_gb: number;
  created_at: string;
  last_active_at: string;
}

interface Entry extends SandboxInfo { }

export const machineName = (id: string): string => `${MACHINE_PREFIX}${id}`;
export const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
  const n = value === undefined || !Number.isFinite(value) ? fallback : Math.round(value);
  return Math.min(max, Math.max(min, n));
};

export const defaultConfig = (codingRoot: string): SandboxConfig => ({
  codingRoot,
  image: process.env.STACK_SANDBOX_IMAGE ?? "maipai-sandbox:local",
  allowedPorts: (process.env.STACK_SANDBOX_ALLOWED_PORTS ?? "").split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536), // TODO CODE-SANDBOX-01b: the real gateway port.
  gatewayAddress: process.env.STACK_SANDBOX_GATEWAY || undefined,
  idleMs: Number(process.env.STACK_SANDBOX_IDLE_MINUTES ?? 30) * 60_000 || DEFAULT_IDLE_MS,
  startTimeoutMs: 20_000,
  pollMs: 250,
});

export const realRunner: ContainerRunner = async (args, options) => {
  const bin = process.env.STACK_CONTAINER_BIN ?? "/opt/homebrew/bin/container";
  try {
    const child = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), options?.timeoutMs ?? 60_000);
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const code = await child.exited;
    clearTimeout(timer);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};

/** Finds a value by key name in parsed JSON, depth first. */
function findKey(value: unknown, match: (key: string) => boolean): unknown {
  if (Array.isArray(value)) { for (const item of value) { const found = findKey(item, match); if (found !== undefined) return found; } return undefined; }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) if (match(key) && typeof inner === "string") return inner;
    for (const inner of Object.values(value)) { const found = findKey(inner, match); if (found !== undefined) return found; }
  }
  return undefined;
}
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const tail = (text: string): string => text.trim().split("\n").slice(-3).join(" ").slice(0, 300);

export class SandboxService {
  private readonly entries = new Map<string, Entry>();
  private networkReady = false;
  private gateway: string | undefined;

  constructor(private readonly run: ContainerRunner, readonly config: SandboxConfig, private readonly now: () => number = Date.now) { this.gateway = config.gatewayAddress; }

  /** The workspace after every check: absolute, an existing folder, strictly inside the coding root (links resolved), no characters that
   * could add options to the mount. Throws `bad_workspace`. */
  checkWorkspace(path: string): string {
    const refuse = (why: string): never => { throw new SandboxError("bad_workspace", `${why} Pick a folder inside the coding folder.`); };
    if (typeof path !== "string" || !isAbsolute(path)) refuse("The workspace path must be a full path starting with /.");
    if (/[,\0\n\r]/.test(path)) refuse("The workspace path has a comma or control character the sandbox cannot mount.");
    if (!existsSync(path) || !statSync(path).isDirectory()) refuse("The workspace folder does not exist.");
    let real: string; let root: string;
    try { real = realpathSync(path); root = realpathSync(this.config.codingRoot); } catch { return refuse("The workspace or the coding folder could not be read."); }
    if (real === root || !real.startsWith(root.endsWith(sep) ? root : root + sep)) refuse("The workspace is outside the coding folder.");
    return real;
  }

  /** Creates the host-only network once; returns its gateway address. */
  private async ensureNetwork(): Promise<string> {
    if (!this.networkReady) {
      const listed = await this.run(["network", "list", "--format", "json"]);
      if (listed.code !== 0) throw new SandboxError("runtime_unavailable", `The sandbox runtime did not answer (${tail(listed.stderr) || "no output"}). Start the container system and try again.`);
      const known = JSON.stringify(parseJson(listed.stdout) ?? "").includes(`"${SANDBOX_NETWORK}"`);
      if (!known) {
        const made = await this.run(["network", "create", "--internal", SANDBOX_NETWORK]);
        if (made.code !== 0) throw new SandboxError("network_unavailable", `The sandbox network could not be created (${tail(made.stderr)}). Check the container system and try again.`);
      }
      this.networkReady = true;
    }
    if (!this.gateway) {
      const shown = await this.run(["network", "inspect", SANDBOX_NETWORK]);
      const found = findKey(parseJson(shown.stdout), (key) => /gateway/i.test(key));
      if (typeof found !== "string" || !/^(\d{1,3}\.){3}\d{1,3}/.test(found)) throw new SandboxError("network_unavailable", "The sandbox network's gateway address could not be read. Set STACK_SANDBOX_GATEWAY and try again.");
      this.gateway = found.split("/")[0]!;
    }
    return this.gateway;
  }

  /** The exact `container run` arguments for a request (exported for tests). */
  runArgs(request: CreateRequest, workspace: string, gateway: string, cpus: number, memoryGb: number): string[] {
    // The person's variables never go in as `-e`: the entry script runs as root with CAP_NET_ADMIN and a PATH, LD_PRELOAD or BASH_ENV
    // from the person could replace the lock step. They travel in one reserved variable and reach the workload only after the rights are dropped.
    const pairs = Object.entries(request.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const env = pairs.length ? ["-e", `SANDBOX_WORKLOAD_ENV=${Buffer.from(pairs.join("\0")).toString("base64")}`] : [];
    return [
      "run", "-d", "--name", machineName(request.id),
      "--label", "maipai.sandbox=1",
      "--network", SANDBOX_NETWORK, "--no-dns",
      "--cpus", String(cpus), "--memory", `${memoryGb}g`,
      "--cap-add", "CAP_NET_ADMIN", // for the lock step only; the entry script drops it for good.
      "--mount", `type=bind,source=${workspace},target=${WORKSPACE_MOUNT}`,
      "-e", `SANDBOX_ALLOW_ADDR=${gateway}`, "-e", `SANDBOX_ALLOW_PORTS=${this.config.allowedPorts.join(",")}`,
      ...(request.runAs ? ["-e", `SANDBOX_USER=${request.runAs}`] : []),
      ...env,
      this.config.image, ...(request.workload ?? []),
    ];
  }

  async create(request: CreateRequest): Promise<SandboxInfo> {
    if (!ID_PATTERN.test(request.id)) throw new SandboxError("invalid_id", "The sandbox id must be 6 to 40 lowercase letters, digits or dashes, starting with a letter or digit.");
    for (const key of Object.keys(request.env ?? {})) if (!ENV_NAME.test(key) || RESERVED_ENV.test(key)) throw new SandboxError("invalid_request", `The variable name ${key.slice(0, 40)} is not allowed. Use capital letters, digits and underscores, and not a name starting with SANDBOX_.`);
    if (this.entries.has(request.id)) throw new SandboxError("exists", "A sandbox with this id already exists. Delete it first or use another id.");
    const workspace = this.checkWorkspace(request.workspace);
    const cpus = clamp(request.cpus, DEFAULT_CPUS, 1, MAX_CPUS);
    const memoryGb = clamp(request.memory_gb, DEFAULT_MEMORY_GB, 1, MAX_MEMORY_GB);
    const gateway = await this.ensureNetwork();
    const machine = machineName(request.id);

    const started = await this.run(this.runArgs(request, workspace, gateway, cpus, memoryGb), { timeoutMs: 120_000 });
    if (started.code !== 0) {
      await this.discard(machine);
      throw new SandboxError("start_failed", `The sandbox machine did not start (${tail(started.stderr) || "no message"}). Check that the container system is running and the sandbox image is built, then try again.`);
    }
    const failure = await this.waitForLock(machine);
    if (failure) {
      await this.discard(machine);
      throw new SandboxError(failure.locked ? "lock_failed" : "start_failed", failure.message);
    }
    const stamp = new Date(this.now()).toISOString();
    const entry: Entry = { id: request.id, machine, state: "running", workspace, cpus, memory_gb: memoryGb, created_at: stamp, last_active_at: stamp };
    this.entries.set(request.id, entry);
    return { ...entry };
  }

  /** Waits until the lock marker exists, or the machine stopped (the entry script exits 70 when the rules fail), or time ran out. */
  private async waitForLock(machine: string): Promise<{ locked: boolean; message: string } | null> {
    const lockedMessage = "The sandbox's network lock did not load, so the machine was removed and nothing ran in it. Check that the sandbox image is current and the container system allows the network capability, then try again.";
    const deadline = this.now() + this.config.startTimeoutMs;
    for (;;) {
      const state = await this.machineState(machine);
      if (state === "stopped" || state === "missing") {
        const logs = await this.run(["logs", machine]);
        const lock = /sandbox-entry|network lock|lock rules|lock marker|SANDBOX_ALLOW/.test(logs.stdout + logs.stderr);
        return lock ? { locked: true, message: lockedMessage } : { locked: false, message: `The sandbox machine stopped right after it started (${tail(logs.stderr || logs.stdout) || "no message"}). Try again; if it repeats, rebuild the sandbox image.` };
      }
      if (state === "running") {
        const marker = await this.run(["exec", machine, "test", "-f", "/run/sandbox-lock-ok"]);
        if (marker.code === 0) return null;
      }
      if (this.now() >= deadline) return { locked: true, message: lockedMessage };
      await Bun.sleep(this.config.pollMs);
    }
  }

  private async machineState(machine: string): Promise<"running" | "stopped" | "missing"> {
    const listed = await this.run(["list", "--all", "--format", "json"]);
    const rows = parseJson(listed.stdout);
    if (!Array.isArray(rows)) return "missing";
    for (const row of rows) {
      if (findKey(row, (key) => key === "id") !== machine) continue;
      const status = String(findKey(row, (key) => key === "status" || key === "state") ?? "").toLowerCase();
      return status === "running" ? "running" : "stopped";
    }
    return "missing";
  }

  private async discard(machine: string): Promise<void> {
    await this.run(["stop", machine]).catch(() => undefined);
    await this.run(["delete", "--force", machine]).catch(() => undefined);
  }

  private need(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new SandboxError("not_found", "No sandbox has this id. List the sandboxes and use one of those ids.");
    return entry;
  }

  /** Reading a sandbox counts as activity, so a session being watched is not stopped for idleness. */
  get(id: string): SandboxInfo { const entry = this.need(id); entry.last_active_at = new Date(this.now()).toISOString(); return { ...entry }; }
  list(): SandboxInfo[] { return [...this.entries.values()].map((e) => ({ ...e })); }
  touch(id: string): void { this.need(id).last_active_at = new Date(this.now()).toISOString(); }

  async stop(id: string): Promise<SandboxInfo> {
    const entry = this.need(id);
    if (entry.state === "running") { await this.run(["stop", entry.machine]); entry.state = "stopped"; }
    return { ...entry };
  }

  async remove(id: string): Promise<void> {
    const entry = this.need(id);
    await this.discard(entry.machine);
    this.entries.delete(id);
  }

  /** Reads what the machine printed (the lock test reads the probe's lines). */
  async logs(id: string): Promise<string> { const entry = this.need(id); return (await this.run(["logs", entry.machine])).stdout; }

  /** Stops every running machine nobody has used for the idle time. Returns the ids stopped. */
  async sweepIdle(): Promise<string[]> {
    const stopped: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== "running" || this.now() - Date.parse(entry.last_active_at) < this.config.idleMs) continue;
      await this.stop(entry.id).catch(() => undefined);
      stopped.push(entry.id);
    }
    return stopped;
  }
}

let shared: SandboxService | undefined;
/** The daemon's one service. Coding folder: STACK_CODING_ROOT, else `<data>/coding`. */
export function sandboxService(dataDir: string): SandboxService {
  shared ??= new SandboxService(realRunner, defaultConfig(process.env.STACK_CODING_ROOT ?? join(dataDir, "coding")));
  return shared;
}
export function setSandboxServiceForTests(service: SandboxService | undefined): void { shared = service; }

/** Starts the idle stop check; returns the function that ends it. */
export function startSandboxSweeper(service: SandboxService, everyMs = 60_000): () => void {
  const timer = setInterval(() => { void service.sweepIdle().catch(() => undefined); }, everyMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
