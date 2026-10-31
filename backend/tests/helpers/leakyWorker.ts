import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setProcessTreeReadersForTests } from "@/lib/processTree";

export function startLeakyWorker(wrap: (child: any) => any): { worker: any; pidFile: string; acceptedFile: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "stack-worker-tree-"));
  const pidFile = join(dir, "pids");
  const acceptedFile = join(dir, "accepted");
  const script = join(dir, "worker.js");
  writeFileSync(script, `const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });\n// A leaky worker: on SIGTERM it exits and leaves its child behind, the shape of the leak the tree stop must cover.\nprocess.on("SIGTERM", () => { process.exit(0); });\nawait Bun.write(${JSON.stringify(pidFile)}, process.pid + "\\n" + child.pid);\nconsole.log(JSON.stringify({ ready: true }));\nlet accepted = false;\nfor await (const _ of Bun.stdin.stream()) { if (!accepted) { accepted = true; await Bun.write(${JSON.stringify(acceptedFile)}, "accepted"); } }\n`);
  const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  __setProcessTreeReadersForTests({
    processTable: () => {
      try { const [root, descendant] = readFileSync(pidFile, "utf8").trim().split("\n").map(Number); return [{ pid: descendant!, ppid: root! }]; }
      catch { return []; }
    },
    commandLine: (pid) => `test-worker-${pid}`,
  });
  return { worker: wrap(child), pidFile, acceptedFile, dir };
}

/** Waits for the worker to write both pids; a busy lane or a slow start under load can take seconds. */
export async function waitForWorkerPids(pidFile: string, timeoutMs = 15_000): Promise<[number, number]> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number); if (pids.length === 2 && pids.every((pid) => Number.isInteger(pid) && pid > 0)) return pids as [number, number]; } catch { /* not written yet */ }
    await Bun.sleep(20);
  }
  throw new Error("The scripted worker did not write its pids in time.");
}

export function workerPids(pidFile: string): [number, number] {
  return readFileSync(pidFile, "utf8").trim().split("\n").map(Number) as [number, number];
}

export async function waitForWorkerRequest(acceptedFile: string): Promise<void> {
  for (let i = 0; i < 750 && !existsSync(acceptedFile); i++) await Bun.sleep(20);
  if (!existsSync(acceptedFile)) throw new Error("The scripted worker did not accept its request.");
}

export function workerTreeGone(pids: number[]): boolean {
  return pids.every((pid) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  });
}

export async function waitForWorkerTreeGone(pids: number[], timeoutMs = 8_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !workerTreeGone(pids)) await Bun.sleep(25);
  return workerTreeGone(pids);
}

export function removeWorkerDir(dir: string): void { __setProcessTreeReadersForTests(null); rmSync(dir, { recursive: true, force: true }); }
