import { eq } from "drizzle-orm";
import { basename, join } from "node:path";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { PART_DEFS } from "@/lib/partDefs";
import { createJob, finishJob, listJobs, updateJob } from "@/lib/jobs";
import { getModel, installCatalogModel, upsertModel, type CatalogModelLike, type DownloadModelOptions, type ModelRecord } from "@/lib/modelStore";
import { modelsRootFor, isManagedModelPath } from "@/lib/disks";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { beginUpdate } from "@/updates/engines";
import { getProcess, loadedModelId, restartRole } from "@/lib/supervisor";
import type { RoleId } from "@/roles";
import { catalogModelForId } from "@/updates/catalog";
import { existsSync, rmSync } from "node:fs";

export const MODEL_UPDATE_JOB_KIND = "part.update";
export const modelUpdateCode = (id: string) => `update-failed.${id}`;
const previousKey = (id: string) => `parts.${id}.previous`;
const journalKey = (id: string) => `updates.model.${id}.journal`;
/** One line per update in flight, written before the first byte moves: what the model was (the whole record), where the new files go, and how far the update got. A crash leaves it; the next boot reads it (recoverModelUpdates). */
interface UpdateJournal { phase: "staging" | "loading" | "committed"; revision: string; destination: string; snapshot: ModelRecord }
const writeJournal = (id: string, journal: UpdateJournal): void => { const value = JSON.stringify(journal); db.insert(meta).values({ key: journalKey(id), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run(); };
const clearJournal = (id: string): void => { db.delete(meta).where(eq(meta.key, journalKey(id))).run(); };
export type ModelLoadCheck = (record: ModelRecord) => Promise<void>;
let loadCheckOverride: ModelLoadCheck | undefined;
let crashAt: UpdateJournal["phase"] | null = null;
class SimulatedCrash extends Error {}
export function __setModelLoadCheckForTests(check: ModelLoadCheck | null): void { loadCheckOverride = check ?? undefined; }
/** Stops the update dead after the named phase is journaled, with no cleanup, as a killed process would. */
export function __crashModelUpdateAfterForTests(phase: UpdateJournal["phase"] | null): void { crashAt = phase; }
const crashPoint = (phase: UpdateJournal["phase"]): void => { if (crashAt === phase) { crashAt = null; throw new SimulatedCrash(`crash after ${phase}`); } };
/** The roles that run this model right now, reloaded on the new file. A model no role has loaded is checked by its file alone (the install already verified the digest). */
async function defaultLoadCheck(record: ModelRecord): Promise<void> {
  if (!record.modelPath || !existsSync(record.modelPath)) throw new Error("The new model file is missing.");
  for (const role of record.roles as RoleId[]) {
    if (loadedModelId(role) !== record.id) continue;
    await restartRole(role, "engine-update-postload");
    const proc = await getProcess(role, record.id);
    if (proc.modelId !== record.id) throw new Error("The new model did not load.");
  }
}
/** Puts the previous model back on the roles that were running it. Best effort: the record is already restored. */
async function reloadOld(record: ModelRecord): Promise<void> {
  for (const role of record.roles as RoleId[]) {
    if (loadedModelId(role) === null) continue;
    try { await restartRole(role, "rollback-restart"); await getProcess(role, record.id); } catch { /* The role's own self-heal and health item cover a failed reload. */ }
  }
}
let downloadOverride: DownloadModelOptions["download"] | undefined;
const inFlight = new Map<string, string>();
const settled = new Set<Promise<void>>();
export function __setModelUpdateDownloadForTests(download: DownloadModelOptions["download"] | null): void { downloadOverride = download ?? undefined; }
export async function __settleModelUpdatesForTests(): Promise<void> { await Promise.all(settled); }
export function modelUpdateJob(id: string): string | null { const job = inFlight.get(id); return job && listJobs().some((row) => row.id === job && row.state === "running") ? job : null; }

function savePrevious(record: ModelRecord): void {
  const oldValue = db.select({ value: meta.value }).from(meta).where(eq(meta.key, previousKey(record.id))).get()?.value;
  if (oldValue) {
    try {
      const old = JSON.parse(oldValue) as { modelPath?: string };
      if (old.modelPath && old.modelPath !== record.modelPath && isManagedModelPath(old.modelPath) && existsSync(old.modelPath)) rmSync(old.modelPath, { recursive: true, force: true });
    } catch { /* Replace a malformed remembered value. */ }
  }
  const value = JSON.stringify({ revision: record.revision, modelPath: record.modelPath, sha256: record.sha256, sizeBytes: record.sizeBytes });
  db.insert(meta).values({ key: previousKey(record.id), value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run();
}

async function apply(id: string, download?: DownloadModelOptions["download"], jobId?: string): Promise<{ applied: true; revision: string; previous: string } | { applied: false; reason: string }> {
  const def = PART_DEFS.find((row) => row.id === id && row.kind === "model");
  const snapshot = getModel(id);
  const model = catalogModelForId(id);
  if (!def || !snapshot || !snapshot.modelPath || !existsSync(snapshot.modelPath)) return { applied: false, reason: `${def?.label ?? id} must be installed before it can be updated.` };
  if (!model?.revision || model.revision === snapshot.revision || !model.download?.url) return { applied: false, reason: `${def.label} has no different Catalog revision available.` };
  const revision = model.revision;
  const destination = join(modelsRootFor(snapshot.diskId), id, revision, basename(new URL(model.download.url).pathname) || `${id}.bin`);
  // beginUpdate also holds the crash restarter, as an engine swap does.
  const endUpdate = beginUpdate();
  try {
    writeJournal(id, { phase: "staging", revision, destination, snapshot }); crashPoint("staging");
    const installed = await installCatalogModel(model, { destination, download: download ?? downloadOverride, onProgress: (progress) => { if (jobId) updateJob(jobId, { completedBytes: progress.itemCompletedBytes ?? progress.completedBytes }); } });
    // The old files stay until the new model has loaded: unload the old, load the new, and any failure puts the old back.
    writeJournal(id, { phase: "loading", revision, destination, snapshot }); crashPoint("loading");
    await (loadCheckOverride ?? defaultLoadCheck)(installed);
    writeJournal(id, { phase: "committed", revision, destination, snapshot }); crashPoint("committed");
    savePrevious(snapshot);
    clearJournal(id);
    resolveHealth(modelUpdateCode(id));
    emit({ id: "update.applied", data: { kind: "model", name: id, tag: revision } });
    return { applied: true, revision, previous: snapshot.revision };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    upsertModel(snapshot);
    rmSync(destination, { recursive: true, force: true });
    clearJournal(id);
    await reloadOld(snapshot);
    raise({ code: modelUpdateCode(id), severity: "warning", title: `${def.label} could not be updated`, text: `${def.label} stays on its current version. ${reason}`, cause: reason, fix: { label: "Try again", action: "retry_download" } });
    return { applied: false, reason };
  } finally { endUpdate(); }
}

export async function applyModelUpdate(id: string, deps?: { download?: DownloadModelOptions["download"] }): Promise<{ applied: true; revision: string; previous: string } | { applied: false; reason: string }> { return apply(id, deps?.download); }

export function startModelUpdate(id: string, deps?: { download?: DownloadModelOptions["download"] }): { job: string; joined: boolean } | null {
  const existing = modelUpdateJob(id);
  if (existing) return { job: existing, joined: true };
  const def = PART_DEFS.find((row) => row.id === id)!;
  const model = catalogModelForId(id);
  const job = createJob({ kind: MODEL_UPDATE_JOB_KIND, input: { component: id, model: id, label: def.label }, totalBytes: model?.download?.approx_bytes ?? 0, status: `Updating ${def.label}` });
  inFlight.set(id, job.id);
  const run = (async () => {
    try {
      const result = await apply(id, deps?.download ?? downloadOverride, job.id);
      if (result.applied) finishJob(job.id, { ok: true, result }); else finishJob(job.id, { ok: false, reason: result.reason });
    } catch (error) { finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); }
    finally { inFlight.delete(id); }
  })();
  settled.add(run); void run.finally(() => settled.delete(run));
  return { job: job.id, joined: false };
}

export function previousModel(id: string): { revision: string; modelPath: string; sha256: string | null; sizeBytes: number | null } | null {
  const value = db.select({ value: meta.value }).from(meta).where(eq(meta.key, previousKey(id))).get()?.value;
  if (!value) return null;
  try {
    const previous = JSON.parse(value) as { revision?: string; modelPath?: string; sha256?: string | null; sizeBytes?: number | null };
    if (!previous.revision || !previous.modelPath || !existsSync(previous.modelPath)) return null;
    return { revision: previous.revision, modelPath: previous.modelPath, sha256: previous.sha256 ?? null, sizeBytes: previous.sizeBytes ?? null };
  } catch { return null; }
}

export async function rollbackModel(id: string): Promise<{ ok: true; revision: string } | { ok: false; reason: string }> {
  const previous = previousModel(id); const current = getModel(id); const def = PART_DEFS.find((row) => row.id === id);
  if (!previous || !current) return { ok: false, reason: "No previous model version is recorded or its file is missing." };
  const endUpdate = beginUpdate();
  try {
    upsertModel({ ...current, revision: previous.revision, sha256: previous.sha256, sizeBytes: previous.sizeBytes, modelPath: previous.modelPath, verifiedAt: new Date().toISOString() });
    db.delete(meta).where(eq(meta.key, previousKey(id))).run();
    resolveHealth(modelUpdateCode(id));
    emit({ id: "update.applied", data: { kind: "model", name: id, tag: previous.revision } });
    return { ok: true, revision: previous.revision };
  } finally { endUpdate(); }
}

/** Boot: an update that a crash cut off is finished or undone before anything launches. Before the load check passed it is undone (the old record restored, the new files removed); after, it is finished (the old files become the remembered previous). Returns what it settled. */
export function recoverModelUpdates(): Array<{ id: string; action: "undone" | "finished" }> {
  const settledRows: Array<{ id: string; action: "undone" | "finished" }> = [];
  const rows = db.select().from(meta).all().filter((row) => row.key.startsWith("updates.model.") && row.key.endsWith(".journal"));
  for (const row of rows) {
    const id = row.key.slice("updates.model.".length, -".journal".length);
    try {
      const journal = JSON.parse(row.value) as UpdateJournal;
      if (journal.phase === "committed") { savePrevious(journal.snapshot); settledRows.push({ id, action: "finished" }); }
      else {
        upsertModel(journal.snapshot);
        if (isManagedModelPath(journal.destination)) rmSync(journal.destination, { recursive: true, force: true });
        settledRows.push({ id, action: "undone" });
      }
    } catch { /* A journal that cannot be read names nothing to settle. */ }
    clearJournal(id);
  }
  return settledRows;
}
