import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { dataDir } from "@/lib/paths";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_AGE_DAYS = 14;
const secrets = new Set<string>();

function logPath(name = "stack"): string {
  const dir = join(dataDir, "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${name}.log`);
}

export function registerLogSecret(secret: string): void { if (secret) secrets.add(secret); }

function redact(value: string): string {
  let result = value.replace(/mps_[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
  for (const secret of secrets) result = result.replaceAll(secret, "[REDACTED]");
  return result;
}

function rotate(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.${Date.now()}`);
  } catch { /* best effort */ }
}

export function log(message: string, ...args: unknown[]): void {
  appendLogLine(format(message, ...args));
}

export function appendLogLine(message: string, name = "stack"): void {
  try {
    const path = logPath(name);
    rotate(path);
    appendFileSync(path, `${redact(message)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    for (const entry of readdirSync(join(dataDir, "logs"))) {
      if (entry.startsWith(`${name}.log.`)) {
        const full = join(dataDir, "logs", entry);
        if (statSync(full).mtimeMs < cutoff) {
          try { unlinkSync(full); } catch { /* best effort */ }
        }
      }
    }
  } catch { /* logging never breaks the daemon */ }
}

export function installConsoleFileMirror(): void {
  const state = globalThis as typeof globalThis & { __stackLogMirror?: boolean };
  if (state.__stackLogMirror) return;
  state.__stackLogMirror = true;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => { original(...args); appendLogLine(format(...args)); };
  }
}

export function installFatalErrorHandlers(shutdown: () => Promise<void> = async () => {}): void {
  const state = globalThis as typeof globalThis & { __stackFatalHandlers?: boolean };
  if (state.__stackFatalHandlers) return;
  state.__stackFatalHandlers = true;
  const capture = async (kind: string, error: unknown) => {
    appendLogLine(`[fatal] ${kind}: ${error instanceof Error ? error.stack ?? error.message : format(error)}`);
    await shutdown();
  };
  process.on("uncaughtException", (error) => void capture("uncaughtException", error));
  process.on("unhandledRejection", (error) => void capture("unhandledRejection", error));
}
