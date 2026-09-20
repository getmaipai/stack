import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { resolve } from "node:path";
import { join } from "node:path";
import { CHAT_ENGINES, ENGINE_BINARIES, ENGINE_READY_MARKER, type ChatEngine } from "@/lib/engineCatalog";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { raise } from "@/lib/health";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { emit } from "@/lib/events";
import { currentEngineTag, ensureEngine } from "@/lib/engineInstall";
import type { EngineBinaryPin } from "@/lib/engineCatalog";
import { chatEngine, getProcess, restartRole, stopRole } from "@/lib/supervisor";
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
  const previous = currentEngineTag(name);
  if (previous && previous !== tag) rememberPrevious(name, previous);
  try {
    await options.drain?.();
    mkdirSync(resolve(current, ".."), { recursive: true, mode: 0o700 });
    try { unlinkSync(current); } catch { /* First swap. */ }
    symlinkSync(tag, current);
    if (options.postLoadCheck && !await options.postLoadCheck()) throw new Error("The replacement engine failed its post-load check.");
    bumpStackGeneration(`engine ${name} now ${tag}`);
    if (options.emitEvents !== false) emit({ id: "update.applied", data: { kind: "engine", name, tag } });
  } catch (error) {
    if (previous) {
      try { unlinkSync(current); } catch { /* Restore is best effort. */ }
      try { symlinkSync(previous, current); } catch { /* Health item records the failed rollback. */ }
    }
    if (options.emitEvents !== false) failedSwap(error instanceof Error ? error.message : String(error), name);
    throw error;
  }
}
export async function rollbackEngine(name: string, tag: string): Promise<void> { await swapEngine(name, tag); }
/** The tag the `current` link names; one read, defined with the store. */
export const currentEngine = currentEngineTag;

// The tag `current` pointed at before the last swap: what "go back"
// returns to, kept in meta so a failed swap's fix can find it.
function previousKey(name: string): string { return `engines.${name}.previous`; }
function rememberPrevious(name: string, tag: string): void { db.insert(meta).values({ key: previousKey(name), value: tag }).onConflictDoUpdate({ target: meta.key, set: { value: tag } }).run(); }
export function previousEngine(name: string): string | null {
  const tag = db.select({ value: meta.value }).from(meta).where(eq(meta.key, previousKey(name))).get()?.value ?? null;
  return tag && existsSync(engineTagRoot(name, tag)) ? tag : null;
}
/** The health code of a failed swap names the engine, so the rollback
 * fix moves that engine's link: `failed-swap` for llama-server (the
 * code Home has known since the first swap), `failed-swap.<name>` for
 * any other. */
export function failedSwapCode(name: string): string { return name === "llama-server" ? "failed-swap" : `failed-swap.${name}`; }
export function engineOfFailedSwap(code: string): string { return code === "failed-swap" ? "llama-server" : code.slice("failed-swap.".length); }
export function failedSwap(reason: string, name = "llama-server"): void {
  emit({ id: "update.failed", data: { kind: "engine", name, reason } });
  raise({ code: failedSwapCode(name), severity: "critical", title: `An update of ${name} could not start`, text: reason, cause: reason, fix: { label: "Roll back", action: "rollback_update" } });
}

export type EngineUpdateRunner = (name: string, tag: string, target: StagingTarget) => Promise<void>;
/** A pin for a build named by url, checksum and tag: what the Catalog
 * index describes, or what Home stages beside the current build. */
export interface StagingTarget { url: string; sha256: string; size: number; requires?: string[]; extra?: Array<{ url: string; sha256: string; size: number; label?: string }> }
const shippedTool = (name: string): string | undefined => ENGINE_BINARIES.find((pin) => pin.name === name)?.tool;
export function stagingPin(name: string, tag: string, target: StagingTarget): EngineBinaryPin {
  return {
    id: `${name}-${tag}`, name, tag, platform: process.platform as "darwin" | "win32", arch: process.arch as "arm64" | "x64",
    requiresNvidia: target.requires?.includes("nvidia") ?? false, label: `${name} ${tag}`,
    archive: { label: `${name} ${tag}`, url: target.url, sha256: target.sha256, approxBytes: target.size },
    // The binary's name inside the archive is the engine's own (mlx-serve), read from the shipped pin of the same name.
    ...(shippedTool(name) ? { tool: shippedTool(name) } : {}),
    ...(target.extra?.length ? { extraArchives: target.extra.map((archive) => ({ label: archive.label ?? `${name} ${tag} extra`, url: archive.url, sha256: archive.sha256, approxBytes: archive.size })) } : {}),
    verified: true,
  };
}
/** How an update's swap treats the chat role: drained and restarted on
 * the new build when the engine is the one the setting chose; a chat
 * engine not chosen is not the chat role's process, so its link moves
 * with nothing drained and nothing restarted that could prove the build
 * (the proof comes when it is chosen). */
export function updateSwapOptions(name: string): EngineSwapOptions {
  const runsChat = CHAT_ENGINES.includes(name as ChatEngine) ? chatEngine() === name : true;
  if (!runsChat) return { emitEvents: false };
  return { drain: () => stopRole("chat", "Draining for an engine update."), postLoadCheck: async () => { await restartRole("chat"); await getProcess("chat"); return true; }, emitEvents: false };
}
async function stageAndSwap(name: string, tag: string, target: StagingTarget): Promise<void> {
  await ensureEngine(stagingPin(name, tag, target), undefined, { activate: false });
  await swapEngine(name, tag, updateSwapOptions(name));
}
let engineUpdateRunner: EngineUpdateRunner = stageAndSwap;
export function setEngineUpdateRunnerForTests(value: EngineUpdateRunner): void { engineUpdateRunner = value; }
export function resetEngineUpdateRunnerForTests(): void { engineUpdateRunner = stageAndSwap; }
export async function applyAvailableEngineUpdate(): Promise<{ tag: string; previous: string | null } | null> {
  const target = pendingEngineUpdate("llama-server"); if (!target) return null;
  const previous = currentEngine("llama-server");
  await engineUpdateRunner("llama-server", target.tag, { url: target.url, sha256: target.sha256, size: target.size, requires: target.requires, extra: target.extra });
  return { tag: target.tag, previous };
}
