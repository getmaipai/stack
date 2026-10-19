// A process and everything it started (CODE-STACK-01 S5a).
//
// Splash is a tree: the Python launcher that becomes the server, and the native
// `engine/splash serve-native` child that holds the weights and does the work
// (measured 2026-10-18: the child's parent is the server process). Signalling only
// the pid the Stack spawned would stop or kill the server and leave the engine
// generating, or leave an orphan holding 20 GB. So the Stack finds the tree by
// parentage when it needs it (a pause, a resume, a memory reading, a stop) and
// signals every member. Nothing here is specific to Splash.

export interface ProcessRow { pid: number; ppid: number; }

/** `ps -axo pid=,ppid=` as rows; empty when ps cannot run. */
export function listProcessTable(): ProcessRow[] {
  try {
    const out = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
    return parseProcessTable(out);
  } catch { return []; }
}

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

/** Every descendant of `root` (children, their children, ...), root excluded, in breadth-first order. */
export function descendantsOf(root: number, table: ProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of table) (children.get(row.ppid) ?? children.set(row.ppid, []).get(row.ppid)!).push(row.pid);
  const found: number[] = [];
  const seen = new Set<number>([root]);
  for (let index = -1; index < found.length; index++) {
    const parent = index === -1 ? root : found[index]!;
    for (const child of children.get(parent) ?? []) if (!seen.has(child)) { seen.add(child); found.push(child); }
  }
  return found;
}

/** `root` first, then its descendants. */
export function processTree(root: number, table: ProcessRow[] = listProcessTable()): number[] {
  return [root, ...descendantsOf(root, table)];
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The command line of one pid, or "" when it is gone: a pid counts as the same process only while this is unchanged. */
export function commandLineOf(pid: number): string {
  try { return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim(); } catch { return ""; }
}

export function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) { try { process.kill(pid, signal); } catch { /* gone */ } }
}

/** A snapshot of a tree that remembers each member's command, so a later cleanup signals only processes that are still the ones it saw (a reused pid is left alone). */
export class TreeSnapshot {
  private readonly members = new Map<number, string>();
  constructor(private readonly root: number) {}

  /** Adds every member of the tree as it is now; members that are gone stay remembered until cleaned. */
  refresh(table: ProcessRow[] = listProcessTable()): number[] {
    const pids = processTree(this.root, table);
    for (const pid of pids) if (!this.members.has(pid)) this.members.set(pid, commandLineOf(pid));
    return pids;
  }

  /** Every remembered member that is still the same process, children before the root. */
  alive(): number[] {
    return [...this.members].filter(([pid, command]) => command !== "" && isAlive(pid) && commandLineOf(pid) === command).map(([pid]) => pid).reverse();
  }

  /** Continue, ask to stop, and after `graceMs` force-stop every remembered member that is still running. Resolves when none is left. */
  async stopAll(graceMs = 5_000): Promise<void> {
    this.refresh();
    let alive = this.alive();
    signalAll(alive, "SIGCONT");
    signalAll(alive, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (alive.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      alive = this.alive();
    }
    if (alive.length > 0) { signalAll(alive, "SIGKILL"); await new Promise((resolve) => setTimeout(resolve, 50)); }
  }

  /** The members that are still running, for a check that nothing was left behind. */
  survivors(): number[] { return this.alive(); }
}

/** Bytes the whole tree holds, from a per-pid reader (the memory reader's `processMemoryBytes`). Null when no member could be read. */
export function treeMemoryBytes(root: number, read: (pid: number) => number | null): number | null {
  let total = 0;
  let any = false;
  for (const pid of processTree(root)) {
    const bytes = read(pid);
    if (bytes !== null) { total += bytes; any = true; }
  }
  return any ? total : null;
}
