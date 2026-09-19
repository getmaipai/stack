import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { raise } from "@/lib/health";
import { emit } from "@/lib/events";
import { pendingEngineUpdate } from "@/updates/check";
import { ensureEngine } from "@/lib/engineInstall";
import type { EngineBinaryPin } from "@/lib/engineCatalog";
import { getChatBackend, restartChatEngine, stopChatEngine } from "@/lib/supervisor";

export function resolveEnginePin(tag: string): string { return tag.match(/b\d+/)?.[0] ?? tag; }
export interface EngineSwapOptions {
  drain?: () => Promise<void>;
  postLoadCheck?: () => Promise<boolean>;
  emitEvents?: boolean;
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
    if (options.emitEvents !== false) emit({ id: "update.applied", data: { kind: "engine", name, tag } });
    if (name === "llama-server") void import("@/lib/speedTest").then(({ scheduleSpeedTest }) => scheduleSpeedTest());
  } catch (error) {
    if (previous) {
      try { unlinkSync(current); } catch { /* Restore is best effort. */ }
      try { symlinkSync(previous, current); } catch { /* Health item records the failed rollback. */ }
    }
    if (options.emitEvents !== false) failedSwap(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
export async function rollbackEngine(name: string, tag: string): Promise<void> { await swapEngine(name, tag); }
export function currentEngine(name: string): string | null { try { return readlinkSync(engineCurrentPath(name)); } catch { return null; } }
export function failedSwap(reason: string): void {
  emit({ id: "update.failed", data: { kind: "engine", reason } });
  raise({ code: "failed-swap", severity: "critical", title: "An update could not start", text: reason, cause: reason, fix: { label: "Roll back", action: "rollback_update" } });
}

export type EngineUpdateRunner = (name: string, tag: string, target: { url: string; sha256: string; size: number }) => Promise<void>;
function updatePin(name: string, tag: string, target: { url: string; sha256: string; size: number }): EngineBinaryPin {
  return { id: `${name}-${tag}`, platform: process.platform as "darwin" | "win32", arch: process.arch as "arm64" | "x64", requiresNvidia: false, label: `${name} ${tag}`, archive: { label: `${name} ${tag}`, url: target.url, sha256: target.sha256, approxBytes: target.size }, verified: true };
}
async function stageAndSwap(name: string, tag: string, target: { url: string; sha256: string; size: number }): Promise<void> {
  await ensureEngine(updatePin(name, tag, target), undefined, { activate: false });
  await swapEngine(name, tag, { drain: () => stopChatEngine(), postLoadCheck: async () => { await restartChatEngine(); await getChatBackend(); return true; }, emitEvents: false });
}
let engineUpdateRunner: EngineUpdateRunner = stageAndSwap;
export function setEngineUpdateRunnerForTests(value: EngineUpdateRunner): void { engineUpdateRunner = value; }
export function resetEngineUpdateRunnerForTests(): void { engineUpdateRunner = stageAndSwap; }
export async function applyAvailableEngineUpdate(): Promise<{ tag: string; previous: string | null } | null> {
  const target = pendingEngineUpdate(); if (!target) return null;
  const previous = currentEngine("llama-server");
  if (previous === target.version) return null;
  await engineUpdateRunner("llama-server", target.version, target);
  return { tag: target.version, previous };
}
