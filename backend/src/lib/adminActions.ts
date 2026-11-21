// The admin actions that act on the computer or the Stack itself: restart
// the Stack, restart the computer, read the log. The executors are
// injectable so a test never restarts anything. Every action is written to
// the log with its time and source (`admin` for a signed-in session,
// `home` for Home's token) and the remote address, never a secret.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import { adminCookie } from "@/lib/adminGuard";
import { logsDir } from "@/lib/paths";
import { logger } from "@/lib/log";
import { kickstartLaunchdService, launchdInstalled } from "@/service/launchd";
import { restartSystemdService, systemdInstalled } from "@/service/systemd";

export interface AdminExecutors {
  /** Whether a launchd or systemd unit exists to restart (false when the Stack was started by hand). */
  serviceInstalled(): boolean;
  /** Ask the service manager to restart the Stack. It returns before the Stack ends. */
  restartService(): void;
  /** Ask the operating system to restart the computer. */
  rebootHost(): void;
}

const linux = () => process.platform === "linux";

export const realExecutors: AdminExecutors = {
  serviceInstalled: () => (linux() ? systemdInstalled() : launchdInstalled()),
  restartService: () => (linux() ? restartSystemdService() : kickstartLaunchdService()),
  rebootHost: () => {
    if (linux()) {
      const result = spawnSync("systemctl", ["reboot"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr?.trim() || "systemctl reboot failed.");
      return;
    }
    // Asks the logged-in user's session to restart, which needs no sudo; apps get the normal chance to quit.
    spawn("osascript", ["-e", 'tell application "System Events" to restart'], { stdio: "ignore", detached: true }).unref();
  },
};

let executors: AdminExecutors = realExecutors;
export function setAdminExecutorsForTests(next: AdminExecutors | null): void { executors = next ?? realExecutors; }
export function adminExecutors(): AdminExecutors { return executors; }

export type ActionSource = "admin" | "home";

/** `admin` when the request carries an admin session cookie (the guard has already checked it), else `home`. */
export function sourceOf(c: Context): ActionSource { return adminCookie(c.req.raw) ? "admin" : "home"; }
/** The address the connection came from (never a forwarded header). */
export function remoteOf(c: Context): string {
  const env = c.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return env?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

/** One line per admin action: what, when, who (source) and from where. */
export function auditAction(action: string, source: ActionSource, remote: string, extra: Record<string, string> = {}): void {
  logger.appendLine(JSON.stringify({ event: `admin.action.${action}`, at: new Date().toISOString(), source, remote, ...extra }));
}

const REDACTED = "[redacted]";
const RULES: Array<[RegExp, string]> = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(stack_admin|session|sid)=[^\s;,"']+/gi, `$1=${REDACTED}`],
  [/(["']?(?:cookie|set-cookie|authorization|x-maipai-home-token|x-api-key|api[_-]?key|llama_api_key|token|secret|password|passwd|session[_-]?id|setup[_-]?code)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, `$1"${REDACTED}"`],
  [/\b(sk|hf|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

/** A log line with tokens, keys, cookies, passwords, session ids and setup codes replaced. */
export function redactLogLine(line: string): string {
  let out = line;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

export const LOG_TAIL_DEFAULT = 200;
export const LOG_TAIL_MAX = 2000;
const READ_CAP = 4 * 1024 * 1024;

/** The last `tail` lines of the current log file, redacted. Empty when there is no log yet. */
export function readLogTail(tail: number, file = join(logsDir, "stack.log")): string[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, READ_CAP);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift(); // the first line may be cut in half
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-tail).map(redactLogLine);
  } finally { closeSync(fd); }
}
