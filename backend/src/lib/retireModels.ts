// Start-up cleanup of the models listed in retiredModels.ts: see that file for the whole retirement path.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { models } from "@/db/schema";
import { logger } from "@/lib/log";
import { removeModelManifest, readModelManifest } from "@/lib/store/manifests";
import { readSettings, updateSettings } from "@/settings";
import { removeSplashHubFolder } from "@/lib/splashStore";
import { RETIRED_MODELS, isRetiredModelId } from "@/lib/retiredModels";

export interface RetireResult { records: string[]; settings: string[]; layouts: string[]; notices: string[]; }

/** Idempotent and cheap (a few table lookups and stat calls); never throws, so start-up is never blocked by it. Files in the models folder are left for tidy. */
export function retireModels(): RetireResult {
  const result: RetireResult = { records: [], settings: [], layouts: [], notices: [] };
  const note = (notice: string): void => { result.notices.push(notice); logger.appendLine(JSON.stringify({ event: "model.retired", notice })); };
  try {
    for (const setting of readSettings({ reveal: true })) {
      if (!setting.key.endsWith(".model") && !setting.key.endsWith(".slot")) continue;
      for (const value of [setting.in_effect, setting.pending]) {
        if (typeof value !== "string" || !isRetiredModelId(value)) continue;
        try { updateSettings({ [setting.key]: setting.default as never }); result.settings.push(setting.key); note(`The ${setting.key} setting named ${value}, which this Stack no longer carries. It now uses the default model for this computer.`); } catch { /* the setting keeps its value; selection falls back anyway */ }
        break;
      }
    }
  } catch { /* settings unreadable: selection still falls back to the default */ }
  for (const retired of RETIRED_MODELS) {
    try {
      const had = !!db.select({ id: models.id }).from(models).where(eq(models.id, retired.id)).get() || !!readModelManifest(retired.id);
      if (had) {
        removeModelManifest(retired.id);
        db.delete(models).where(eq(models.id, retired.id)).run();
        result.records.push(retired.id);
        note(`${retired.id} is no longer part of this Stack (${retired.why}) Its files are listed under Tidy and removed there.`);
      }
      if (retired.repo && removeSplashHubFolder(retired.repo)) result.layouts.push(retired.id);
    } catch (error) { logger.appendLine(JSON.stringify({ event: "model.retire.failed", id: retired.id, reason: String((error as Error).message) })); }
  }
  return result;
}
