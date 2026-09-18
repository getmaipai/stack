import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { raise } from "@/lib/health";
import { emit } from "@/lib/events";

export function resolveEnginePin(tag: string): string { return tag.match(/b\d+/)?.[0] ?? tag; }
export interface EngineSwapOptions {
  drain?: () => Promise<void>;
  postLoadCheck?: () => Promise<boolean>;
}

export async function swapEngine(name: string, tag: string, options: EngineSwapOptions = {}): Promise<void> {
  const target = engineTagRoot(name, tag);
  if (!existsSync(target)) throw new Error(`Engine tag is not installed: ${tag}`);
  const current = engineCurrentPath(name);
  const previous = (() => { try { return readlinkSync(current); } catch { return null; } })();
  try {
    await options.drain?.();
    mkdirSync(resolve(current, ".."), { recursive: true, mode: 0o700 });
    try { unlinkSync(current); } catch { /* First swap. */ }
    symlinkSync(tag, current);
    if (options.postLoadCheck && !await options.postLoadCheck()) throw new Error("The replacement engine failed its post-load check.");
    emit({ id: "update.applied", data: { kind: "engine", name, tag } });
    if (name === "llama-server") void import("@/lib/speedTest").then(({ scheduleSpeedTest }) => scheduleSpeedTest());
  } catch (error) {
    if (previous) {
      try { unlinkSync(current); } catch { /* Restore is best effort. */ }
      try { symlinkSync(previous, current); } catch { /* Health item records the failed rollback. */ }
    }
    failedSwap(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
export async function rollbackEngine(name: string, tag: string): Promise<void> { await swapEngine(name, tag); }
export function currentEngine(name: string): string | null { try { return readlinkSync(engineCurrentPath(name)); } catch { return null; } }
export function failedSwap(reason: string): void {
  emit({ id: "update.failed", data: { kind: "engine", reason } });
  raise({ code: "failed-swap", severity: "critical", title: "An update could not start", text: reason, cause: reason, fix: { label: "Roll back", action: "rollback_update" } });
}
