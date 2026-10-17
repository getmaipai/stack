// IMGGEN-STACK-01: one install job for a picture model family. It downloads
// every pinned file of the family (each verified by its sha256 and placed in
// the hub cache by the model store, resumable), then builds the mflux
// environment if it is not built, so "turn pictures on" is one call and one
// progress bar. A second call while one runs joins it.
import { basename, join } from "node:path";
import { createJob, finishJob, getJob, jobSignal, updateJob } from "@/lib/jobs";
import { getModel, installCatalogModel, isModelSelectable, type CatalogModelLike } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { emit } from "@/lib/events";
import { ensureImageGenEnvironment, imageGenEnvironmentReady, imageRequirementsFileFor } from "@/images/imageEngine";
import { installPlanFor, type ImageFamilyId } from "@/images/models";

const inFlight = new Map<ImageFamilyId, string>();

type Pin = CatalogModelLike & { download: NonNullable<CatalogModelLike["download"]> };
const installed = (pin: Pin): boolean => { const record = getModel(pin.id); return !!record && isModelSelectable(record) && !!record.modelPath; };

export function startImageInstall(family: ImageFamilyId): { job: string; joined: boolean } {
  const existing = inFlight.get(family);
  if (existing && getJob(existing)) return { job: existing, joined: true };
  const pins = installPlanFor(family).filter((pin): pin is Pin => !!pin.download);
  const items = pins.map((pin) => ({ id: pin.id, label: pin.download.hub_file ?? pin.id, completedBytes: installed(pin) ? pin.download.approx_bytes : 0, totalBytes: pin.download.approx_bytes, state: installed(pin) ? "done" as const : "queued" as const }));
  const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
  const job = createJob({ kind: "image.install", role: "image", totalBytes, items, status: "downloading", input: { family } });
  inFlight.set(family, job.id);
  void (async () => {
    try {
      let done = items.reduce((sum, item) => sum + (item.state === "done" ? item.completedBytes : 0), 0);
      updateJob(job.id, { completedBytes: done });
      for (const pin of pins) {
        if (installed(pin)) continue;
        const destination = join(modelsDir, pin.id, basename(new URL(pin.download.url).pathname));
        const base = done;
        await installCatalogModel(pin, {
          destination, signal: jobSignal(job.id),
          onProgress: (progress) => {
            const nextItems = getJob(job.id)?.items?.map((item) => item.id !== pin.id ? item : { ...item, completedBytes: progress.itemCompletedBytes ?? progress.completedBytes, state: "running" as const });
            updateJob(job.id, { completedBytes: Math.min(totalBytes, base + (progress.itemCompletedBytes ?? progress.completedBytes)), ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }), ...(nextItems ? { items: nextItems } : {}) });
          },
        });
        done += pin.download.approx_bytes;
        const nextItems = getJob(job.id)?.items?.map((item) => item.id !== pin.id ? item : { ...item, completedBytes: item.totalBytes, state: "done" as const });
        updateJob(job.id, { completedBytes: done, ...(nextItems ? { items: nextItems } : {}) });
      }
      if (imageRequirementsFileFor() && !imageGenEnvironmentReady()) {
        updateJob(job.id, { status: "building the picture engine", percent: 99 });
        await ensureImageGenEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) });
      }
      finishJob(job.id, { ok: true, result: { family } });
      emit({ id: "engine.state", data: { engine: "image-gen", state: "installed" } });
    } catch (error) {
      finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) });
    } finally { inFlight.delete(family); }
  })();
  return { job: job.id, joined: false };
}
