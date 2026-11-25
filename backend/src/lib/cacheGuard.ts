import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { dataDir, modelsDir } from "@/lib/paths";
import { connectedModelRoots } from "@/lib/disks";
import { listJobs } from "@/lib/jobs";
import { referencedPaths } from "@/lib/tidy";
import { settingValues } from "@/settings";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { logger } from "@/lib/log";
import { splashDirs } from "@/lib/splashStore";
import { listModels } from "@/lib/modelStore";

export type OwnedCache = { path: string; kind: "tmp_leftover" | "dangling_link"; bytes: number; ageHours: number };
export type OutsideCache = { path: string; bytes: number; note: "Not referenced by the Stack" };
export interface CachePlan { owned: OwnedCache[]; outside: OutsideCache[]; tidy: { reclaimable_bytes: number }; }
const active = () => listJobs().some((job) => ["queued", "running", "paused", "stalled"].includes(job.state));
function treeBytes(path: string): number { try { const st = lstatSync(path); if (st.isSymbolicLink()) return 0; return st.isDirectory() ? readdirSync(path).reduce((n, name) => n + treeBytes(join(path, name)), 0) : st.size; } catch { return 0; } }
function newestMtime(path: string): number { const st = lstatSync(path); if (st.isSymbolicLink()) return st.mtimeMs; if (!st.isDirectory()) return st.mtimeMs; return readdirSync(path).reduce((n, name) => Math.max(n, newestMtime(join(path, name))), st.mtimeMs); }
function inside(path: string, root: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)); }
function safeDataParent(path: string): boolean { try { const parent = realpathSync(join(path, "..")); return inside(parent, realpathSync(dataDir)); } catch { return false; } }
function outsideCachePath(): string { return join(process.env.HOME || homedir(), ".cache", "huggingface"); }
export async function planCaches(now = Date.now()): Promise<CachePlan> {
  const owned: OwnedCache[] = [];
  const tmp = join(dataDir, "tmp");
  const referenced = referencedPaths();
  for (const model of listModels()) if (model.modelPath) referenced.add(resolve(model.modelPath));
  if (!active()) { try { for (const name of readdirSync(tmp)) { const path = join(tmp, name); try { const newest = newestMtime(path), ageHours = Math.max(0, (now - newest) / 3_600_000); if (ageHours >= Number(settingValues()["stack.storage.tmp_hours"] ?? 6)) owned.push({ path, kind: "tmp_leftover", bytes: treeBytes(path), ageHours }); } catch { owned.push({ path, kind: "tmp_leftover", bytes: 0, ageHours: 0 }); } } } catch { /* No temporary directory yet. */ } }
  for (const root of [modelsDir, ...connectedModelRoots()]) { try { for (const name of readdirSync(root)) { const path = join(root, name); try { if (lstatSync(path).isSymbolicLink()) { try { realpathSync(path); } catch { if (!referenced.has(resolve(path))) owned.push({ path, kind: "dangling_link", bytes: 0, ageHours: Math.max(0, (now - lstatSync(path).mtimeMs) / 3_600_000) }); } } } catch { /* Ignore entries that disappeared. */ } } } catch { /* Ignore disconnected roots. */ } }
  const { planTidy } = await import("@/lib/tidy"); const tidy = await planTidy(now);
  const candidate = outsideCachePath(); const outside: OutsideCache[] = [];
  if (existsSync(candidate) && !inside(candidate, dataDir) && !inside(candidate, splashDirs().homeDir)) outside.push({ path: candidate, bytes: treeBytes(candidate), note: "Not referenced by the Stack" });
  return { owned, outside, tidy: { reclaimable_bytes: tidy.reclaimable_bytes } };
}
export async function runCacheGuard(now = Date.now()): Promise<{ removed: OwnedCache[]; problems: string[] }> {
  const removed: OwnedCache[] = [], problems: string[] = [];
  if (settingValues()["stack.storage.cache_guard_enabled"] !== false) {
    const plan = await planCaches(now);
    for (const item of plan.owned) {
      try {
        const roots = item.kind === "dangling_link" ? [modelsDir, ...connectedModelRoots()] : [join(dataDir, "tmp")];
        const root = roots.find((candidate) => { try { return inside(item.path, realpathSync(candidate)); } catch { return false; } });
        if (!root) throw new Error("the path is outside the Stack's temporary and model folders");
        const realRoot = realpathSync(root), realParent = realpathSync(join(item.path, ".."));
        if (!inside(realParent, realRoot) || resolve(item.path) === resolve(root)) throw new Error("the path is outside the allowed Stack folder");
        const refs = referencedPaths(); for (const model of listModels()) if (model.modelPath) refs.add(resolve(model.modelPath));
        if (refs.has(resolve(item.path)) || [...refs].some((ref) => ref.startsWith(resolve(item.path) + sep))) throw new Error("a model record references this path");
        if (item.kind === "tmp_leftover" && item.bytes === 0) throw new Error("the folder could not be read to measure its contents");
        const st = lstatSync(item.path);
        if (item.kind === "dangling_link") { if (!st.isSymbolicLink()) throw new Error("the link changed before cleanup"); try { realpathSync(item.path); throw new Error("the link is no longer dangling"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } unlinkSync(item.path); }
        else { if (st.isSymbolicLink()) throw new Error("the path changed into a symbolic link"); rmSync(item.path, { recursive: true, force: false }); }
        removed.push(item); logger.appendLine(JSON.stringify({ event: "cache.removed", path: item.path, bytes: item.bytes, kind: item.kind }));
      } catch (error) { problems.push(`Could not clean ${item.path}: ${(error as Error).message}.`); }
    }
  }
  await updateOutsideHealth();
  return { removed, problems };
}
async function updateOutsideHealth(): Promise<void> {
  const item = (await planCaches()).outside[0];
  if (settingValues()["stack.storage.outside_cache_check"] === true && item) raise({ code: "cache.outside", severity: "warning", title: "Hugging Face cache is outside Stack storage", text: `${item.path} contains ${item.bytes.toLocaleString()} bytes. It is not referenced by the Stack.`, cause: "This folder is managed outside the Stack and may use disk space." });
  else resolveHealth("cache.outside");
}
export async function clearOutsideCache(path: string): Promise<{ freed_bytes: number; kept: string[]; problems: string[] }> {
  const candidate = (await planCaches()).outside.find((item) => item.path === path);
  if (!candidate) throw new Error("That cache folder is not an outside cache listed by the Stack.");
  const kept: string[] = [], problems: string[] = []; let freed_bytes = 0;
  const visit = (dir: string, top = true): void => { let names: string[]; try { names = readdirSync(dir); } catch (error) { problems.push(`Could not read ${dir}: ${(error as Error).message}.`); return; } for (const name of names) { const entry = join(dir, name); try { const st = lstatSync(entry); const preserve = top && (name === "token" || name === "stored_tokens" || /\.(json|toml|cfg)$/i.test(name)); if (preserve) { kept.push(entry); continue; } if (st.isSymbolicLink()) { unlinkSync(entry); continue; } if (st.isDirectory()) { visit(entry, false); if (readdirSync(entry).length === 0) rmSync(entry); } else { freed_bytes += st.size; rmSync(entry); } } catch (error) { problems.push(`Could not remove ${entry}: ${(error as Error).message}.`); } } };
  visit(path); logger.appendLine(JSON.stringify({ event: "cache.cleared", path, freed_bytes, kept: kept.length, problems: problems.length })); resolveHealth("cache.outside");
  return { freed_bytes, kept, problems };
}
