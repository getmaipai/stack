// One way to install a pinned model as a job (progress on the event feed,
// the install strip in Home): the pull route and the repair of a missing
// declared part (VISION-03g) both start it. A projector that finishes
// installing restarts a chat process that started without it.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { createJob, finishJob, getJob, jobSignal, updateJob } from "@/lib/jobs";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getModel, installCatalogModel, isModelSelectable, reconcilePinDeclarations, type CatalogModelLike, type DownloadModelOptions } from "@/lib/modelStore";
import { STACK_MODELS } from "@/lib/modelCatalog";
import { modelsDir } from "@/lib/paths";
import { restartForNewProjector } from "@/lib/supervisor";
import { warmUp } from "@/lib/warmup";
import type { RoleId } from "@/roles";

type Pin = CatalogModelLike & { download: NonNullable<CatalogModelLike["download"]> };

export const MISSING_PART_CODE = (id: string): string => `model-part-missing.${id}`;

/** Starts the install job for a pin. `done` settles when the install ends. */
export function startModelInstall(model: Pin, role: RoleId, download?: DownloadModelOptions["download"]): { job: string; done: Promise<void> } {
  // One directory per model id: two pins whose URLs end in the same file name never share a path.
  const destination = join(modelsDir, model.id, basename(new URL(model.download.url).pathname) || `${model.id}.gguf`);
  const items = model.download.files?.map((file) => ({ id: file.path, label: file.path, completedBytes: 0, totalBytes: file.bytes, state: "queued" as const })) ?? [{ id: basename(destination), label: basename(destination), completedBytes: 0, totalBytes: model.download.approx_bytes, state: "queued" as const }];
  const job = createJob({ kind: "model.install", role, totalBytes: items.reduce((sum, item) => sum + item.totalBytes, 0), items, status: "downloading", input: { model: model.id } });
  const done = installCatalogModel(model, { destination, download, signal: jobSignal(job.id), onProgress: (progress) => {
    const itemId = progress.itemId;
    const nextItems = getJob(job.id)?.items?.map((item) => item.id !== itemId ? item : { ...item, completedBytes: progress.itemCompletedBytes ?? progress.completedBytes, totalBytes: progress.itemTotalBytes ?? item.totalBytes, state: progress.itemState ?? "running" });
    const state = progress.itemState === "stalled" ? "stalled" : "running";
    updateJob(job.id, { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes || model.download.approx_bytes, ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }), ...(nextItems ? { items: nextItems } : {}), state, status: progress.status });
  } })
    .then(async (installed) => {
      finishJob(job.id, { ok: true, result: { model: installed.id } });
      if (installed.engineRequirements.component === "projector") {
        try { reconcilePinDeclarations(STACK_MODELS); await restartForNewProjector(); } catch { /* a restart that fails leaves chat serving; the next start loads it */ }
      }
      await warmUp("model-install").catch(() => {});
    })
    .catch((error) => { finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }); })
    .then(() => undefined);
  return { job: job.id, done };
}

function onDisk(id: string): boolean {
  const record = getModel(id);
  return !!record && isModelSelectable(record) && !!record.modelPath && existsSync(record.modelPath);
}

/** The projectors that an installed model declares and that are not on
 * disk: the upgrade case (VISION-03g), since the install plan only ran in
 * the setup wizard. A model that is not installed brings its own parts
 * when it is installed. */
export function missingDeclaredParts(pins: readonly CatalogModelLike[] = STACK_MODELS): Pin[] {
  const missing: Pin[] = [];
  for (const pin of pins) {
    if (!pin.imageInput || !onDisk(pin.id)) continue;
    const part = pins.find((candidate) => candidate.id === pin.imageInput!.projector);
    if (part?.download?.url && part.download.sha256 && !onDisk(part.id) && !missing.some((m) => m.id === part.id)) missing.push(part as Pin);
  }
  return missing;
}

/** Pulls each missing declared part with progress, and raises a Repairs
 * item when it cannot (offline, a bad checksum); the item clears when the
 * part installs. Never throws: a missing picture reader never stops chat. */
export async function pullMissingDeclaredParts(pins: readonly CatalogModelLike[] = STACK_MODELS, download?: DownloadModelOptions["download"]): Promise<string[]> {
  const started: string[] = [];
  for (const part of missingDeclaredParts(pins)) {
    const code = MISSING_PART_CODE(part.id);
    started.push(part.id);
    try {
      const { done } = startModelInstall(part, part.role, download);
      await done;
      if (onDisk(part.id)) resolveHealth(code);
      else raise({ code, severity: "warning", title: "Chat cannot read pictures yet", text: `The picture reader (${part.id}) could not be downloaded, so chat answers text only.`, cause: "The download did not finish.", fix: { label: "Try again", action: "retry_download" } });
    } catch (error) {
      raise({ code, severity: "warning", title: "Chat cannot read pictures yet", text: `The picture reader (${part.id}) could not be downloaded, so chat answers text only.`, cause: error instanceof Error ? error.message : "The download did not finish.", fix: { label: "Try again", action: "retry_download" } });
    }
  }
  return started;
}
