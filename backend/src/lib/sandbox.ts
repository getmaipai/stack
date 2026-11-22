// CODE-SANDBOX-01b: the sandbox service. One small Linux machine per Code session, driven through Apple's `container` CLI.
// Design: Home docs/design/local-coding-2026-10-17.md section 3.4 and code-app-refresh-2026-11-21.md section 4; the hand-run proof
// is docs/reports/code-sandbox-spike-2026-11-21.md. The machine sits on a host-only network with no resolver and loads a lock at
// start (backend/sandbox/sandbox-entry.sh, CODE-SANDBOX-02). A start whose lock does not load is a failed start.
//
// TODO (CODE-SANDBOX-02, egress proxy slice): the allowlist proxy and `network.policy = "hosts"`.
// TODO (CODE-SANDBOX-01b, later slices): governor memory admission, disk and process limits.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, posix, sep } from "node:path";
import { randomBytes } from "node:crypto";

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

export type SandboxErrorCode = "invalid_id" | "invalid_request" | "bad_workspace" | "exists" | "not_found" | "lock_failed" | "start_failed" | "runtime_unavailable" | "network_unavailable" | "not_running" | "snapshot_failed";
const STATUS: Record<SandboxErrorCode, 400 | 404 | 409 | 500 | 503> = { not_running: 409, snapshot_failed: 500, invalid_id: 400, invalid_request: 400, bad_workspace: 400, exists: 409, not_found: 404, lock_failed: 500, start_failed: 500, runtime_unavailable: 503, network_unavailable: 503 };

/** A typed failure; `message` is plain words that say what went wrong and what to do. */
/** `container_system` is `stopped` when the container tool does not answer (not started, not installed). */
export interface RuntimeStatus { container_system: "running" | "stopped"; image: string; image_built: boolean; network: boolean; detail: string }

export class SandboxError extends Error {
  readonly status: 400 | 404 | 409 | 500 | 503;
  constructor(readonly code: SandboxErrorCode, message: string) { super(message); this.name = "SandboxError"; this.status = STATUS[code]; }
}

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs the command in its own session, in the background so busybox setsid does not fork (the exit status is the command's), and waits for it. */
export const SANDBOX_EXEC_WRAPPER = 'p="$1"; shift; setsid sh -c \'echo $$ > "$1"; shift; exec "$@"\' sandbox-exec "$p" "$@" & wait $!';

/** The one place the `container` program is called. Tests pass a fake. */
export type ContainerRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<RunResult>;

export type ExecChunk = { stream: "stdout" | "stderr"; text: string } | { exit: number };
/** Runs one `container` call and streams its output; ends with {exit}. Aborting the signal kills the whole process group. Tests pass a fake. */
export type ContainerStreamer = (args: string[], signal: AbortSignal) => AsyncIterable<ExecChunk>;
export interface ExecRequest { argv: string[]; cwd?: string; env?: Record<string, string> }
export interface SnapshotInfo { id: string; files: number }
export const LOCK_MARKER = "/run/sandbox-lock-ok";
const SNAPSHOT_ID = /^snap-[a-z0-9-]{8,60}$/;
const LABEL = /^[\w .:-]{0,80}$/;

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
  /** Where snapshots live; on the same volume as the workspaces so a clone is instant. Defaults to `<codingRoot>/.snapshots`. */
  snapshotRoot?: string;
}

export interface CreateRequest {
  id: string;
  workspace: string;
  cpus?: number;
  memory_gb?: number;
  env?: Record<string, string>;
  /** TCP ports on the gateway address this machine may reach, added to the configured ones (Home sends its own port, so no per-machine setting is needed). */
  gatewayPorts?: number[];
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

/** The real streamer: the process leads its own group so an abort ends it and anything it started. The caller's variables ride in the argument list of this one process only; nothing here stores or logs them. */
export const realStreamer: ContainerStreamer = async function* (args, signal) {
  const bin = process.env.STACK_CONTAINER_BIN ?? "/opt/homebrew/bin/container";
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const queue: ExecChunk[] = []; let wake: (() => void) | undefined; let done = false;
  const push = (chunk: ExecChunk) => { queue.push(chunk); wake?.(); };
  const decoder = (stream: "stdout" | "stderr") => { const d = new TextDecoder(); return (data: Buffer) => { const text = d.decode(data, { stream: true }); if (text) push({ stream, text }); }; };
  child.stdout.on("data", decoder("stdout")); child.stderr.on("data", decoder("stderr"));
  child.on("error", (error) => { push({ stream: "stderr", text: error.message }); push({ exit: 127 }); done = true; });
  child.on("close", (code, sig) => { if (!done) { push({ exit: code ?? (sig ? 137 : 1) }); done = true; } });
  const kill = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
  if (signal.aborted) kill(); else signal.addEventListener("abort", kill, { once: true });
  try {
    for (;;) {
      while (queue.length) { const chunk = queue.shift()!; yield chunk; if ("exit" in chunk) return; }
      if (done) return;
      await new Promise<void>((resolve) => { wake = resolve; if (queue.length || done) resolve(); });
    }
  } finally { signal.removeEventListener("abort", kill); if (!done) kill(); }
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

  constructor(private readonly run: ContainerRunner, readonly config: SandboxConfig, private readonly now: () => number = Date.now, private readonly stream: ContainerStreamer = realStreamer) { this.gateway = config.gatewayAddress; }

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

  /** What Code needs from the container system, as plain facts for Home's ready check: the system answers, the sandbox image is built, the sandbox network exists.
   * Read-only: it starts nothing (a create does the one start). */
  async runtimeStatus(): Promise<RuntimeStatus> {
    const images = await this.run(["image", "list", "--format", "json"]);
    if (images.code !== 0) return { container_system: "stopped", image: this.config.image, image_built: false, network: false, detail: tail(images.stderr) || "no output" };
    const names = (Array.isArray(parseJson(images.stdout)) ? (parseJson(images.stdout) as Array<{ configuration?: { name?: unknown } }>) : []).map((item) => item.configuration?.name);
    const built = names.some((name) => typeof name === "string" && (name === this.config.image || name.endsWith(`/${this.config.image}`)));
    const networks = await this.run(["network", "list", "--format", "json"]);
    const network = networks.code === 0 && JSON.stringify(parseJson(networks.stdout) ?? "").includes(`"${SANDBOX_NETWORK}"`);
    return { container_system: "running", image: this.config.image, image_built: built, network, detail: "" };
  }

  /** Creates the host-only network once; returns its gateway address. */
  private async ensureNetwork(): Promise<string> {
    if (!this.networkReady) {
      let listed = await this.run(["network", "list", "--format", "json"]);
      if (listed.code !== 0) {
        // The container system is a per-user service that is not running after a restart of the computer. Start it once and ask again.
        await this.run(["system", "start"], { timeoutMs: 120_000 });
        listed = await this.run(["network", "list", "--format", "json"]);
      }
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
      "-e", `SANDBOX_ALLOW_ADDR=${gateway}`, "-e", `SANDBOX_ALLOW_PORTS=${[...new Set([...this.config.allowedPorts, ...(request.gatewayPorts ?? [])])].join(",")}`,
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

  /** Nothing runs unless this machine is running and its lock marker is there. Same fail-closed rule as the start. */
  private async needLocked(id: string): Promise<Entry> {
    const entry = this.need(id);
    if (entry.state !== "running" || (await this.machineState(entry.machine)) !== "running") throw new SandboxError("not_running", "This sandbox is stopped. Start a new one for the session and try again.");
    const marker = await this.run(["exec", entry.machine, "test", "-f", LOCK_MARKER]);
    if (marker.code !== 0) throw new SandboxError("lock_failed", "The sandbox's network lock is not in place, so nothing was run. Remove the sandbox and start a new one.");
    entry.last_active_at = new Date(this.now()).toISOString();
    return entry;
  }

  /** Runs one command in the machine as the unprivileged user. Checks happen before the first byte, so a refusal is a plain error; the
   * returned stream ends with {exit}. `env` reaches only this process and is never stored or logged. Aborting kills the process group. */
  async exec(id: string, request: ExecRequest, signal: AbortSignal): Promise<AsyncIterable<ExecChunk>> {
    const { argv } = request;
    if (!Array.isArray(argv) || argv.length === 0 || argv.length > 500 || argv.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 100_000)) throw new SandboxError("invalid_request", "The command must be a list of 1 to 500 text arguments with no NUL characters.");
    for (const [key, value] of Object.entries(request.env ?? {})) {
      if (!ENV_NAME.test(key) || RESERVED_ENV.test(key)) throw new SandboxError("invalid_request", `The variable name ${key.slice(0, 40)} is not allowed. Use capital letters, digits and underscores, and not a name starting with SANDBOX_.`);
      if (typeof value !== "string" || value.length > 20_000 || value.includes("\0")) throw new SandboxError("invalid_request", `The value of ${key} is too long or has a NUL character.`);
    }
    let cwd = WORKSPACE_MOUNT;
    if (request.cwd !== undefined) {
      const clean = typeof request.cwd === "string" && request.cwd.startsWith("/") && !request.cwd.includes("\0") ? posix.normalize(request.cwd) : "";
      if (clean !== WORKSPACE_MOUNT && !clean.startsWith(`${WORKSPACE_MOUNT}/`)) throw new SandboxError("invalid_request", "The working folder must be /workspace or a folder inside it.");
      cwd = clean.replace(/\/+$/, "") || WORKSPACE_MOUNT;
    }
    const entry = await this.needLocked(id);
    // Killing the host's `container exec` client does not end the command inside the machine, so the command starts in its own
    // process group (setsid) whose id is written to a file; an abort then kills that group in the machine too.
    const pidFile = `/tmp/.exec-${randomBytes(8).toString("hex")}.pid`;
    const wrapped = ["sh", "-c", SANDBOX_EXEC_WRAPPER, "sandbox-exec", pidFile, ...argv];
    const args = ["exec", "--user", "agent", "--workdir", cwd, ...Object.entries(request.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]), entry.machine, ...wrapped];
    const stream = this.stream; const run = this.run; const machine = entry.machine;
    const touch = () => { try { this.touch(id); } catch { /* removed mid-run */ } };
    const killInMachine = () => run(["exec", "--user", "agent", machine, "sh", "-c", `kill -KILL -- -"$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`]).catch(() => undefined);
    return (async function* () {
      try { for await (const chunk of stream(args, signal)) { touch(); yield chunk; } }
      finally { if (signal.aborted) await killInMachine(); else await run(["exec", "--user", "agent", machine, "rm", "-f", pidFile]).catch(() => undefined); }
    })();
  }

  private snapshotRoot(): string { return this.config.snapshotRoot ?? join(this.config.codingRoot, ".snapshots"); }
  private snapshotDir(id: string, snapshot: string): string { return join(this.snapshotRoot(), id, snapshot); }
  private async copyTree(from: string, to: string): Promise<void> {
    // `cp -c` makes an APFS clone (copy on write, instant); a volume without clones falls back to a plain copy.
    for (const flags of [["-cR"], ["-R"]]) {
      const child = Bun.spawn(["/bin/cp", ...flags, `${from}${sep}.`, to], { stdout: "ignore", stderr: "pipe" });
      if ((await child.exited) === 0) return;
    }
    throw new SandboxError("snapshot_failed", "The workspace could not be copied. Check the free disk space and try again.");
  }
  private countFiles(dir: string): number {
    let n = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? this.countFiles(join(dir, e.name)) : 1;
    return n;
  }

  /** A copy-on-write clone of the workspace. The label is kept only in the snapshot's folder name's log line, never executed. */
  async snapshot(id: string, label: string): Promise<SnapshotInfo> {
    if (typeof label !== "string" || !LABEL.test(label)) throw new SandboxError("invalid_request", "The label must be up to 80 letters, digits, spaces or . : _ -.");
    const entry = await this.needLocked(id);
    const snapshot = `snap-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
    const dir = this.snapshotDir(id, snapshot);
    try { mkdirSync(dir, { recursive: true }); await this.copyTree(entry.workspace, dir); return { id: snapshot, files: this.countFiles(dir) }; }
    catch (error) { rmSync(dir, { recursive: true, force: true }); throw error instanceof SandboxError ? error : new SandboxError("snapshot_failed", "The snapshot could not be made. Check the free disk space and try again."); }
  }

  /** Puts the workspace back to a snapshot. The workspace folder itself stays (the machine has it mounted); its contents are replaced. */
  async restore(id: string, snapshot: string): Promise<void> {
    if (!SNAPSHOT_ID.test(snapshot)) throw new SandboxError("invalid_request", "That is not a snapshot id.");
    const entry = await this.needLocked(id);
    const dir = this.snapshotDir(id, snapshot);
    if (!existsSync(dir)) throw new SandboxError("not_found", "No snapshot has this id for this sandbox.");
    try { for (const name of readdirSync(entry.workspace)) rmSync(join(entry.workspace, name), { recursive: true, force: true }); await this.copyTree(dir, entry.workspace); }
    catch (error) { throw error instanceof SandboxError ? error : new SandboxError("snapshot_failed", "The workspace could not be restored. Try again."); }
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
