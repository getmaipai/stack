import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { resolve } from "node:path";
import { join } from "node:path";
import { ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { raise } from "@/lib/health";
import { emit } from "@/lib/events";
import { ensureEngine } from "@/lib/engineInstall";
import type { EngineBinaryPin } from "@/lib/engineCatalog";
import { getProcess, restartRole, stopRole } from "@/lib/supervisor";
import { pendingEngineUpdate } from "@/updates/catalog";

export function resolveEnginePin(tag: string): string { return tag.match(/b\d+/)?.[0] ?? tag; }
export interface EngineSwapOptions {
  drain?: () => Promise<void>;
  postLoadCheck?: () => Promise<boolean>;
  emitEvents?: boolean;
}

export async function swapEngine(name: string, tag: string, options: EngineSwapOptions = {}): Promise<void> {
  const target = engineTagRoot(name, tag);
  // The directory exists from the moment a download starts; only the
  // ready marker means the build finished installing and verified.
  if (!existsSync(join(target, ENGINE_READY_MARKER))) throw new Error(`Engine tag is not installed: ${tag}`);
  const current = engineCurrentPath(name);
  const previous = (() => { try { return readlinkSync(current); } catch { return null; } })();
  if (previous && previous !== tag) rememberPrevious(name, previous);
  try {
    await options.drain?.();
    mkdirSync(resolve(current, ".."), { recursive: true, mode: 0o700 });
    try { unlinkSync(current); } catch { /* First swap. */ }
    symlinkSync(tag, current);
    if (options.postLoadCheck && !await options.postLoadCheck()) throw new Error("The replacement engine failed its post-load check.");
    if (options.emitEvents !== false) emit({ id: "update.applied", data: { kind: "engine", name, tag } });
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

// The tag `current` pointed at before the last swap: what "go back"
// returns to, kept in meta so a failed swap's fix can find it.
function previousKey(name: string): string { return `engines.${name}.previous`; }
function rememberPrevious(name: string, tag: string): void { db.insert(meta).values({ key: previousKey(name), value: tag }).onConflictDoUpdate({ target: meta.key, set: { value: tag } }).run(); }
export function previousEngine(name: string): string | null {
  const tag = db.select({ value: meta.value }).from(meta).where(eq(meta.key, previousKey(name))).get()?.value ?? null;
  return tag && existsSync(engineTagRoot(name, tag)) ? tag : null;
}
export function failedSwap(reason: string): void {
  emit({ id: "update.failed", data: { kind: "engine", reason } });
  raise({ code: "failed-swap", severity: "critical", title: "An update could not start", text: reason, cause: reason, fix: { label: "Roll back", action: "rollback_update" } });
}

export type EngineUpdateRunner = (name: string, tag: string, target: { url: string; sha256: string; size: number }) => Promise<void>;
/** A pin for a build named by url, checksum and tag: what the Catalog
 * index describes, or what Home stages beside the current build. */
export function stagingPin(name: string, tag: string, target: { url: string; sha256: string; size: number }): EngineBinaryPin {
  return { id: `${name}-${tag}`, platform: process.platform as "darwin" | "win32", arch: process.arch as "arm64" | "x64", requiresNvidia: false, label: `${name} ${tag}`, archive: { label: `${name} ${tag}`, url: target.url, sha256: target.sha256, approxBytes: target.size }, verified: true };
}
async function stageAndSwap(name: string, tag: string, target: { url: string; sha256: string; size: number }): Promise<void> {
  await ensureEngine(stagingPin(name, tag, target), undefined, { activate: false });
  await swapEngine(name, tag, { drain: () => stopRole("chat", "Draining for an engine update."), postLoadCheck: async () => { await restartRole("chat"); await getProcess("chat"); return true; }, emitEvents: false });
}
let engineUpdateRunner: EngineUpdateRunner = stageAndSwap;
export function setEngineUpdateRunnerForTests(value: EngineUpdateRunner): void { engineUpdateRunner = value; }
export function resetEngineUpdateRunnerForTests(): void { engineUpdateRunner = stageAndSwap; }
export async function applyAvailableEngineUpdate(): Promise<{ tag: string; previous: string | null } | null> {
  const target = pendingEngineUpdate("llama-server"); if (!target) return null;
  const previous = currentEngine("llama-server");
  await engineUpdateRunner("llama-server", target.tag, { url: target.url, sha256: target.sha256, size: target.size });
  return { tag: target.tag, previous };
}
