// MEDIA-STACK-01: one way to run a media tool. Every tool runs at idle
// priority (taskpolicy -b on a Mac, nice -n 19 elsewhere) so a transcode
// never competes with a chat answer, is killed when its job is cancelled
// (SIGTERM, then SIGKILL two seconds later) and keeps only the tail of its
// error output. Tests inject a fake Runner; the unit tests never need a
// real binary.
import { existsSync } from "node:fs";

export interface RunOptions {
  signal?: AbortSignal;
  /** Called for every line the tool writes to stdout (progress and printed results). */
  onStdoutLine?: (line: string) => void;
  /** Keep stdout whole (ffprobe's JSON), up to 16 MB. */
  collectStdout?: boolean;
  env?: Record<string, string>;
  cwd?: string;
}
export interface RunResult { code: number | null; stdout: string; stderr: string; aborted: boolean; }
export type Runner = (argv: string[], options?: RunOptions) => Promise<RunResult>;

const STDERR_TAIL = 64 * 1024;
const STDOUT_CAP = 16 * 1024 * 1024;

/** The argv with the idle-priority wrapper in front, when the machine has one. */
export function idleArgv(argv: string[]): string[] {
  if (process.env.STACK_MEDIA_NO_NICE === "1") return argv;
  if (process.platform === "darwin" && existsSync("/usr/sbin/taskpolicy")) return ["/usr/sbin/taskpolicy", "-b", ...argv];
  if (existsSync("/usr/bin/nice")) return ["/usr/bin/nice", "-n", "19", ...argv];
  return argv;
}

export const spawnRunner: Runner = async (argv, options = {}) => {
  const child = Bun.spawn(idleArgv(argv), { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(options.cwd ? { cwd: options.cwd } : {}), env: { ...process.env as Record<string, string>, ...options.env } });
  let aborted = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    aborted = true;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
  };
  if (options.signal?.aborted) stop(); else options.signal?.addEventListener("abort", stop, { once: true });
  let stdout = "";
  let stderr = "";
  const reading = [
    (async () => {
      let pending = "";
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        const text = new TextDecoder().decode(chunk);
        if (options.collectStdout && stdout.length < STDOUT_CAP) stdout += text;
        if (options.onStdoutLine) {
          pending += text;
          let newline: number;
          while ((newline = pending.search(/\r|\n/)) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (line) options.onStdoutLine(line); }
        }
      }
      if (options.onStdoutLine && pending) options.onStdoutLine(pending);
    })().catch(() => {}),
    (async () => { for await (const chunk of child.stderr as unknown as AsyncIterable<Uint8Array>) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-STDERR_TAIL); })().catch(() => {}),
  ];
  const code = await child.exited;
  await Promise.all(reading);
  if (killTimer) clearTimeout(killTimer);
  options.signal?.removeEventListener("abort", stop);
  return { code, stdout, stderr, aborted };
};
