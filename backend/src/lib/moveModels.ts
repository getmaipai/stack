import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "@/db";
import { moveJobs } from "@/db/schema";
import { getModel, upsertModel } from "@/lib/modelStore";
import { modelsRootFor, diskStatus, diskIdOfPath, isManagedModelPath } from "@/lib/disks";
import { readDiskSpace } from "@/lib/diskState";
import { liveImpact } from "@/lib/relationshipsLive";
import { sha256OfFile } from "@/lib/download";

export interface MovePlan { bytes: number; oldPath: string; newPath: string }
type State = "planned" | "copying" | "verifying" | "switching" | "cleaning" | "done" | "failed";
const active: State[] = ["copying", "verifying", "switching", "cleaning"];
const bytesAt = (path: string): number => { const s = statSync(path); return s.isDirectory() ? readdirSync(path, { withFileTypes: true }).reduce((n, e) => n + bytesAt(join(path, e.name)), 0) : s.size; };
async function copyTree(src: string, dst: string, progress: (n: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Move cancelled. Try again when ready.");
  mkdirSync(dirname(dst), { recursive: true });
  if (statSync(src).isDirectory()) { mkdirSync(dst, { recursive: true }); for (const name of readdirSync(src)) await copyTree(join(src, name), join(dst, name), progress, signal); return; }
  await new Promise<void>((resolve, reject) => { const input = createReadStream(src), output = createWriteStream(dst); input.on("data", (chunk: Buffer) => progress(chunk.length)); input.on("error", reject); output.on("error", reject); output.on("finish", resolve); input.pipe(output); });
}
async function sameTree(a: string, b: string): Promise<boolean> {
  const sa = statSync(a), sb = statSync(b); if (sa.isDirectory() !== sb.isDirectory()) return false;
  if (!sa.isDirectory()) return sa.size === sb.size && await sha256OfFile(a) === await sha256OfFile(b);
  const aa = readdirSync(a).sort(), bb = readdirSync(b).sort(); if (aa.join("\0") !== bb.join("\0")) return false;
  for (const n of aa) if (!await sameTree(join(a, n), join(b, n))) return false; return true;
}
/** After the old copy is gone, remove the folders it leaves empty, never the models folder itself. */
function pruneEmptyParents(path: string, root: string): void {
  let dir = dirname(path);
  while (dir.startsWith(root + sep) && existsSync(dir) && readdirSync(dir).length === 0) { rmSync(dir, { recursive: true, force: true }); dir = dirname(dir); }
}
const message = (e: unknown) => e instanceof Error ? e.message : "The move failed. Try again.";
function update(id: string, state: State, fields: Partial<typeof moveJobs.$inferInsert> = {}) { db.update(moveJobs).set({ state, updatedAt: new Date().toISOString(), ...fields }).where(eq(moveJobs.id, id)).run(); }

export async function planModelMove(modelId: string, toDiskId: string): Promise<MovePlan> {
  const model = getModel(modelId); if (!model?.modelPath) throw new Error("This model has no file path to move. Install it first.");
  const source = diskStatus(model.diskId); if (!source.connected) throw new Error(`${source.label} is not connected. Plug it back in or choose another drive.`);
  const target = diskStatus(toDiskId); if (!target.connected) throw new Error(`${target.label} is not connected. Plug it back in or choose another drive.`);
  if ((model.diskId ?? "main") === toDiskId) throw new Error("This model is already on that drive. Choose another drive.");
  if (!isManagedModelPath(model.modelPath)) throw new Error("This model is outside Stack managed folders. Move it manually.");
  { const blocked = liveImpact(modelId, "move").blocking; if (blocked.length) throw new Error(blocked.map((note) => note.why).join(" ")); }
  const bytes = bytesAt(model.modelPath), oldRoot = modelsRootFor(model.diskId), newRoot = modelsRootFor(toDiskId);
  const newPath = join(newRoot, relative(oldRoot, model.modelPath));
  let space; try { space = await readDiskSpace(dirname(newRoot)); } catch { space = await readDiskSpace(newRoot); }
  if (space.free < bytes + 5_000_000_000) throw new Error("There is not enough free space on that drive. Free up space or choose another drive.");
  return { bytes, oldPath: model.modelPath, newPath };
}

export async function runModelMove(modelId: string, toDiskId: string, opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal; hooks?: { afterCopy?: () => void | Promise<void>; afterVerify?: () => void | Promise<void>; afterSwitch?: () => void | Promise<void> } } = {}): Promise<void> {
  if (db.select().from(moveJobs).where(inArray(moveJobs.state, active)).all().length) throw new Error("Another move is running. Wait for it to finish.");
  const plan = await planModelMove(modelId, toDiskId), model = getModel(modelId)!; const id = randomUUID(), moving = `${plan.newPath}.moving`, now = new Date().toISOString();
  db.insert(moveJobs).values({ id, modelId, fromDisk: model.diskId ?? "main", toDisk: toDiskId, state: "planned", oldPath: plan.oldPath, newPath: plan.newPath, bytesDone: 0, bytesTotal: plan.bytes, error: null, createdAt: now, updatedAt: now }).run();
  try {
    update(id, "copying"); rmSync(moving, { recursive: true, force: true }); let done = 0;
    await copyTree(plan.oldPath, moving, n => { done += n; update(id, "copying", { bytesDone: done }); opts.onProgress?.(done, plan.bytes); }, opts.signal);
    await opts.hooks?.afterCopy?.(); update(id, "verifying");
    if (bytesAt(moving) !== plan.bytes || !await sameTree(plan.oldPath, moving)) throw new Error("The copied model did not verify. The original is safe; try again.");
    if (statSync(moving).isFile() && model.sha256 && await sha256OfFile(moving) !== model.sha256) throw new Error("The copied model checksum did not match. The original is safe; try again.");
    await opts.hooks?.afterVerify?.(); update(id, "switching"); renameSync(moving, plan.newPath);
    sqlite.transaction(() => { upsertModel({ ...model, modelPath: plan.newPath, diskId: toDiskId === "main" ? null : toDiskId }); })();
    await opts.hooks?.afterSwitch?.(); update(id, "cleaning"); if (isManagedModelPath(plan.oldPath)) { rmSync(plan.oldPath, { recursive: true, force: true }); pruneEmptyParents(plan.oldPath, modelsRootFor(model.diskId)); } update(id, "done");
  } catch (error) {
    const job = db.select().from(moveJobs).where(eq(moveJobs.id, id)).get();
    if (!job || !["switching", "cleaning", "done"].includes(job.state)) { rmSync(moving, { recursive: true, force: true }); update(id, "failed", { error: message(error) }); }
    throw error;
  }
}

export async function resumeMoveJobs(): Promise<void> {
  const jobs = db.select().from(moveJobs).where(inArray(moveJobs.state, ["planned", ...active])).all();
  for (const job of jobs) {
    const moving = `${job.newPath}.moving`, model = getModel(job.modelId);
    if (job.state === "planned" || job.state === "copying" || job.state === "verifying") { rmSync(moving, { recursive: true, force: true }); update(job.id, "failed", { error: "Move interrupted, try again." }); continue; }
    if (job.state === "switching" && model?.modelPath !== job.newPath) {
      if (existsSync(moving)) renameSync(moving, job.newPath);
      if (model && existsSync(job.newPath)) { sqlite.transaction(() => upsertModel({ ...model, modelPath: job.newPath, diskId: job.toDisk === "main" ? null : job.toDisk }))(); }
      else { rmSync(moving, { recursive: true, force: true }); update(job.id, "failed", { error: "Move interrupted, try again." }); continue; }
    }
    update(job.id, "cleaning"); if (isManagedModelPath(job.oldPath)) { rmSync(job.oldPath, { recursive: true, force: true }); pruneEmptyParents(job.oldPath, modelsRootFor(job.fromDisk === "main" ? null : job.fromDisk)); } update(job.id, "done");
  }
}
