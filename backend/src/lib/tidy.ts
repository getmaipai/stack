import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { componentDefs, listComponents, uninstallComponent } from "@/lib/components";
import { listModels, getModel, type CatalogModelLike } from "@/lib/modelStore";
import { STACK_MODELS, STACK_VIDEO_DETAILED_MODELS, STACK_VIDEO_LTX25_MODELS, STACK_VIDEO_LTX25_MAX_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_IMAGE_ERNIE_MODELS, STACK_IMAGE_QWEN_MODELS } from "@/lib/modelCatalog";
import { modelsDir } from "@/lib/paths";
import { readSettings } from "@/settings";
import { loadedRoleForModel, selectedModel } from "@/lib/supervisor";
import { listJobs } from "@/lib/jobs";
import { logger } from "@/lib/log";
import { settingValues } from "@/settings";
import { readModelManifest, listModelManifests } from "@/lib/store/manifests";
import { resolveRoleState } from "@/lib/router";
import { listLoras } from "@/video/loras";

export type TidyKind = "superseded" | "orphan_folder" | "partial_download";
export interface TidyItem { id: string; kind: TidyKind; bytes: number; reason: string; blocked: string | null; }
export interface TidyPlan { reclaimable_bytes: number; items: TidyItem[]; }
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const catalogPins = (): CatalogModelLike[] => [...STACK_MODELS, ...STACK_VIDEO_DETAILED_MODELS, ...STACK_VIDEO_LTX25_MODELS, ...STACK_VIDEO_LTX25_MAX_MODELS, ...STACK_IMAGE_KLEIN_MODELS, ...STACK_IMAGE_ZIMAGE_MODELS, ...STACK_IMAGE_ERNIE_MODELS, ...STACK_IMAGE_QWEN_MODELS, ...componentDefs().flatMap((component) => component.pins)];
function graceHours(): number { const value = Number(settingValues()["stack.storage.tidy_grace_hours"] ?? 24); return Number.isFinite(value) ? Math.max(0, value) : 24; }
function pathBytes(path: string): number { try { const s = lstatSync(path); if (s.isSymbolicLink()) return 0; if (!s.isDirectory()) return s.size; return readdirSync(path).reduce((n, name) => n + pathBytes(join(path, name)), 0); } catch { return 0; } }
function settingPointsAt(id: string): string | null {
  for (const setting of readSettings({ reveal: true })) {
    if ((setting.key.endsWith(".model") || setting.key.endsWith(".slot")) && String(setting.in_effect) === id) return `The ${setting.key} setting still names this model.`;
  }
  return null;
}
function successorReadySince(successor: string): number | null {
  const key = `tidy.successor_ready.${successor}`;
  const installed = getModel(successor)?.modelPath && existsSync(getModel(successor)!.modelPath!);
  const roleState = resolveRoleState("video");
  if (!installed || roleState.state !== "ready" || selectedModel("video")?.id !== successor) { db.delete(meta).where(eq(meta.key, key)).run(); return null; }
  const stored = db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value;
  if (stored) return Number(stored);
  const since = Date.now();
  db.insert(meta).values({ key, value: String(since) }).onConflictDoUpdate({ target: meta.key, set: { value: String(since) } }).run();
  return since;
}
function blockerFor(id: string, componentId: string, componentModelIds: string[]): string | null {
  const depended = listLoras().filter((lora) => (id === "ltx-2-3-distilled-mlx" && lora.base_model === "ltx-2.3") || (id === "ltx-2-5-q8-distilled-mlx" && lora.base_model === "ltx-2.5"));
  if (depended.length) return `Installed video style${depended.length === 1 ? "" : "s"} ${depended.map((lora) => lora.name).join(", ")} depend on ${id}; remove those styles first.`;
  const runningJob = listJobs().find((job) => ["running", "queued", "paused", "stalled"].includes(job.state) && componentModelIds.some((modelId) => JSON.stringify(job.input ?? {}).includes(modelId)));
  if (runningJob) return `Job ${runningJob.id} is using ${id}; let it finish or cancel it first.`;
  const loaded = componentModelIds.find((modelId) => loadedRoleForModel(modelId));
  if (loaded) return `The video role has ${loaded} loaded; unload it before tidying.`;
  if (settingPointsAt(id)) return settingPointsAt(id);
  return null;
}
function safeModelsPath(path: string): boolean {
  const root = realpathSync(modelsDir);
  const absolute = resolve(path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== absolute) return false;
  let cursor = root;
  for (const part of rel.split(sep)) { cursor = join(cursor, part); try { if (lstatSync(cursor).isSymbolicLink()) return false; } catch { break; } }
  return true;
}
function referencedPaths(): Set<string> {
  const paths = new Set<string>();
  for (const model of listModels()) { if (model.modelPath) paths.add(resolve(model.modelPath)); }
  for (const pin of catalogPins()) if (pin.repo && pin.revision && pin.download?.hub_file) {
    const snapshot = resolve(modelsDir, "hub", `models--${pin.repo.replaceAll("/", "--")}`, "snapshots", pin.revision, pin.download.hub_file);
    if (existsSync(snapshot)) paths.add(snapshot);
  }
  for (const manifest of listModelManifests()) for (const blob of manifest.blobs) paths.add(resolve(blob.path));
  return paths;
}
function knownFolderNames(): Set<string> {
  return new Set([...catalogPins().map((pin) => pin.id), ...listModels().map((model) => model.id), ...listModelManifests().map((manifest) => manifest.id), "hub", "manifests", "store"]);
}
function activeInputModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const job of listJobs()) if (["queued", "running", "paused", "stalled"].includes(job.state)) {
    const input = job.input as Record<string, unknown> | null;
    if (!input) continue;
    for (const key of ["model", "model_id", "modelId", "component", "component_id", "componentId"]) if (typeof input[key] === "string") ids.add(input[key] as string);
    for (const part of JSON.stringify(input).match(/[A-Za-z0-9][A-Za-z0-9._-]{1,127}/g) ?? []) ids.add(part);
  }
  for (const component of componentDefs()) if (ids.has(component.id)) for (const pin of component.pins) ids.add(pin.id);
  return ids;
}
function folderItems(now: number): TidyItem[] {
  const refs = referencedPaths(); const known = knownFolderNames(); const active = activeInputModelIds();
  let entries: string[]; try { entries = readdirSync(modelsDir); } catch { return []; }
  const out: TidyItem[] = [];
  for (const entry of entries) {
    const path = join(modelsDir, entry); let info;
    try { info = lstatSync(path); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry)) continue;
    if (known.has(entry) || active.has(entry)) continue;
    const references = [...refs].some((ref) => ref === resolve(path) || ref.startsWith(resolve(path) + sep));
    const age = now - info.mtimeMs;
    if (references) continue;
    out.push({ id: path, kind: "orphan_folder", bytes: pathBytes(path), reason: age < graceHours() * HOUR ? `Unreferenced model folder; removable after ${new Date(info.mtimeMs + graceHours() * HOUR).toISOString()}.` : "Unreferenced model folder is past the grace period.", blocked: null });
  }
  return out;
}
function partialItems(now: number): TidyItem[] {
  const out: TidyItem[] = []; const active = activeInputModelIds(); const known = knownFolderNames();
  const visit = (dir: string, topName: string): void => { let names: string[]; try { names = readdirSync(dir); } catch { return; } for (const name of names) { const path = join(dir, name); let info; try { info = lstatSync(path); } catch { continue; } if (info.isSymbolicLink()) continue; if (info.isDirectory()) visit(path, topName || name); else if (info.isFile() && (name.endsWith(".part") || /\.partial-[^/]+$/.test(name))) { if (active.has(topName) || [...active].some((id) => name.includes(id)) || [...known].some((id) => name.includes(id) && active.has(id))) continue; const age = now - info.mtimeMs; if (age < 7 * DAY) continue; out.push({ id: path, kind: "partial_download", bytes: info.size, reason: "Failed or cancelled download is older than seven days.", blocked: null }); } } };
  visit(modelsDir, "");
  return out;
}
export async function planTidy(now = Date.now()): Promise<TidyPlan> {
  const list = await listComponents(); const byId = new Map(list.components.map((c) => [c.id, c]));
  const items: TidyItem[] = [];
  for (const oldPin of catalogPins().filter((pin) => !!pin.superseded_by)) {
    const unit = componentDefs().find((candidate) => candidate.pins.some((pin) => pin.id === oldPin.id));
    const view = unit ? byId.get(unit.id) : byId.get(oldPin.id);
    if (items.some((item) => item.kind === "superseded" && item.id === (unit?.id ?? oldPin.id))) continue;
    const oldRecord = getModel(oldPin.id);
    if (!oldRecord?.modelPath) continue;
    let blocked: string | null = null; let removableAt = now;
    for (const successor of oldPin.superseded_by!) {
      const since = successorReadySince(successor);
      if (!since) { blocked = `${successor} must be installed and the video role must report it ready first.`; break; }
      removableAt = Math.max(removableAt, since + graceHours() * HOUR);
    }
    const componentModelIds = unit?.pins.map((pin) => pin.id) ?? [oldPin.id];
    const blocker = blockerFor(oldPin.id, unit?.id ?? oldPin.id, componentModelIds);
    if (!blocked && blocker) blocked = blocker;
    if (!blocked && (view?.requirement === "required" || view?.plan_need === "required")) blocked = "This component is required for this machine's tier.";
    const graceBlocked = !blocked && now < removableAt ? `The successor must stay ready until ${new Date(removableAt).toISOString()}.` : null;
    const reason = blocked ? `Superseded by ${oldPin.superseded_by!.join(", ")}. ${blocked}` : graceBlocked ?? `Superseded by ${oldPin.superseded_by!.join(", ")} and ready past the grace period.`;
    items.push({ id: unit?.id ?? oldPin.id, kind: "superseded", bytes: view?.size_bytes ?? oldRecord.sizeBytes ?? pathBytes(oldRecord.modelPath), reason, blocked });
  }
  items.push(...folderItems(now), ...partialItems(now));
  return { reclaimable_bytes: items.filter((item) => !item.blocked && !item.reason.includes("removable after")).reduce((sum, item) => sum + item.bytes, 0), items };
}
export async function runTidy(dryRun = true, now = Date.now()): Promise<{ dry_run: boolean; removed: TidyItem[]; skipped: TidyItem[] }> {
  const plan = await planTidy(now); const removed: TidyItem[] = []; const skipped: TidyItem[] = [];
  const orphanFolders = plan.items.filter((item) => item.kind === "orphan_folder" && !item.blocked && !item.reason.includes("removable after"));
  const orphanBytes = orphanFolders.reduce((sum, item) => sum + item.bytes, 0);
  const safetyBlocked = !dryRun && (orphanFolders.length > 3 || orphanBytes > 25 * 1_000_000_000);
  for (const item of plan.items) {
    if (safetyBlocked && item.kind === "orphan_folder") { skipped.push({ ...item, blocked: "Tidy is blocked because this run exceeds the limit of three orphan folders or 25 GB." }); continue; }
    if (item.blocked || item.reason.includes("removable after")) { skipped.push(item); continue; }
    if (dryRun) { skipped.push({ ...item, blocked: "Dry run only; no files were removed." }); continue; }
    try {
      if (item.kind === "superseded") await uninstallComponent(item.id);
      else {
        if (!safeModelsPath(item.id)) throw new Error("The path is outside the models directory or crosses a symbolic link.");
        if ([...referencedPaths()].some((path) => path === resolve(item.id) || path.startsWith(resolve(item.id) + sep))) throw new Error("A model record or catalog snapshot now references this path.");
        rmSync(item.id, { recursive: true, force: false });
      }
      removed.push(item); logger.appendLine(JSON.stringify({ event: "tidy.removed", id: item.id, bytes: item.bytes, reason: item.reason }));
    } catch (error) { skipped.push({ ...item, blocked: `Could not remove ${basename(item.id)}: ${(error as Error).message}. The next storage sweep will try again.` }); }
  }
  return { dry_run: dryRun, removed, skipped };
}
