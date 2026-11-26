// STACK-LORAS-01 slice 1: the one LoRA catalog for pictures and video. It reads the unified store
// (loraStore.ts) and is the only place that edits a record beyond what the two libraries do for
// their own generation path: trash and restore, the extras Home sends on import, the preview
// pictures, and the rules around raising and lowering an audience. Home reads this over the
// paired token and keeps no copy.
//
// The second fence. A request that names an adult-only LoRA must say its audience is `adult`
// (the libraries' `resolve` enforces that); an id the Stack cannot find, or that is in the
// trash, counts as adult-only and is refused too. `classification` is the nsfw tag: `adult-only`
// means nsfw. The Stack does not know users. The tag comes from the download site's check at install
// or from an admin (a Stack admin, or Home calling with its token after Home's own rules said yes).
// Changing it needs no ticket here; who may lower it is Home's rule (owner decision 2026-11-26).
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Lora as SpecLora } from "@maipai/spec/gen/ts/lora.js";
import { dataDir } from "@/lib/paths";
import { diskStatus } from "@/lib/disks";
import { LoraError, type Audience, type LoraClass, type LoraMedia, type LoraRecord } from "@/lib/media/loraLibrary";
import { loraDriveProblem, readAllLoras, writeAllLoras } from "@/lib/media/loraStore";
import { imageLoras } from "@/images/loras";
import { updateLora as updateVideoLora, isLoraId } from "@/video/loras";

export const TRASH_DAYS = 30;
export type LoraStatus = "ready" | "drive_missing" | "installing" | "failed";
export interface CatalogLora extends Omit<LoraRecord, "status" | "classification_origin"> {
  media: LoraMedia;
  /** Who set the nsfw tag: the download site's check, an admin, or null for a record from before this was kept. */
  classification_origin: "site" | "admin" | null;
  disk_id: string | null;
  disk_label: string;
  /** `drive_missing` is worked out on every read; the rest is stored. */
  status: LoraStatus;
  removed_at: string | null;
  trash_until: string | null;
  /** The status line a person reads when it is not ready. */
  status_note: string | null;
}

export const previewDir = (): string => join(dataDir, "loras", "previews");

function view(record: LoraRecord): CatalogLora {
  const problem = loraDriveProblem(record);
  const diskId = record.disk_id ?? null;
  return {
    ...record, media: record.media ?? "picture", disk_id: diskId, disk_label: diskStatus(diskId).label,
    status: problem ? "drive_missing" : record.status ?? "ready", removed_at: record.removed_at ?? null, trash_until: record.trash_until ?? null,
    status_note: problem ?? (record.status === "failed" ? "The install did not finish. Remove it and add it again." : record.status === "installing" ? "Still downloading." : null),
    classification_origin: record.classification_origin ?? null, preview: record.preview ?? null, home: record.home ?? null,
  };
}

/** Removes trashed records whose 30 days are over (record and file). Returns how many went. */
export function sweepLoraTrash(now = new Date()): number {
  const all = readAllLoras();
  const expired = all.filter((record) => record.trash_until && Date.parse(record.trash_until) <= now.getTime());
  if (!expired.length) return 0;
  for (const record of expired) {
    try { const media = record.media ?? "picture"; rmSync(fileOf(record, media), { force: true }); } catch { /* a missing drive keeps its file; the record still goes */ }
    if (record.preview) rmSync(join(previewDir(), record.preview), { force: true });
  }
  const gone = new Set(expired.map((record) => record.id));
  writeAllLoras(all.filter((record) => !gone.has(record.id)));
  return expired.length;
}
import { loraFileOn } from "@/lib/media/loraStore";
const fileOf = (record: LoraRecord, media: LoraMedia): string => loraFileOn(media, record.id, record.disk_id ?? null);
export const catalogFilePath = (record: LoraRecord): string => fileOf(record, record.media ?? "picture");

export function listCatalog(opts: { removed?: boolean; media?: LoraMedia } = {}): CatalogLora[] {
  sweepLoraTrash();
  return readAllLoras().filter((record) => (opts.removed ? !!record.removed_at : !record.removed_at) && (!opts.media || (record.media ?? "picture") === opts.media)).map(view);
}
export function getCatalog(id: string): CatalogLora | null {
  const record = readAllLoras().find((entry) => entry.id === id);
  return record ? view(record) : null;
}

export interface CatalogPatch {
  name?: string; classification?: LoraClass; strengthDefault?: number; triggerWords?: string[]; sourceUrl?: string | null; description?: string; kind?: string;
  /** Who may use it, written to `home.availability.who`. */
  availabilityWho?: "admins" | "adults" | "people";
  /** Fields only Home reads, kept in the record's `home` part: add-ins, trigger position, whether chat may suggest it, the strength range. Anything else is refused. */
  homePatch?: Record<string, unknown>;
}
const HOME_KEYS = ["allow_suggesting", "trigger_position", "positive_addins", "negative_addins", "avoid_as_positive", "strength"];
const words = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 8 && value.every((word) => typeof word === "string" && word.length <= 120);
const range = (value: unknown): value is { min: number; default: number; max: number } => {
  const v = value as { min?: unknown; default?: unknown; max?: unknown } | null;
  return !!v && [v.min, v.default, v.max].every((n) => typeof n === "number" && n >= 0 && n <= 2) && (v.min as number) <= (v.default as number) && (v.default as number) <= (v.max as number);
};
/** The Home-only fields a PATCH may carry, checked one by one. A key outside the list, or a value of the wrong shape, is a plain 422. */
export function checkHomePatch(patch: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const good = key === "allow_suggesting" ? typeof value === "boolean" : key === "trigger_position" ? value === "start" || value === "end" : key === "strength" ? range(value) : HOME_KEYS.includes(key) && words(value);
    if (!HOME_KEYS.includes(key) || !good) throw new LoraError("bad_home_patch", `The setting ${key.slice(0, 40)} is not one this can change, or its value is not allowed.`, 422);
  }
  return patch;
}
const WHO = ["admins", "adults", "people"];
const KINDS = ["style", "character", "motion", "other"];

export async function patchCatalog(id: string, patch: CatalogPatch): Promise<CatalogLora> {
  const found = readAllLoras().find((record) => record.id === id);
  if (!found || found.removed_at) throw new LoraError("unknown_lora", "No such LoRA in the library.", 404);
  const media = found.media ?? "picture";
  if (patch.classification !== undefined && !["all-ages", "adult-only"].includes(patch.classification)) throw new LoraError("bad_classification", "The classification is all-ages or adult-only.", 422);
  if (patch.description !== undefined && patch.description.length > 140) throw new LoraError("bad_description", "Keep the description to 140 characters or fewer.", 422);
  if (patch.kind !== undefined && !KINDS.includes(patch.kind)) throw new LoraError("bad_kind", "The kind is style, character, motion or other.", 422);
  const libraryPatch = { name: patch.name, classification: patch.classification, strengthDefault: patch.strengthDefault, triggerWords: patch.triggerWords, sourceUrl: patch.sourceUrl };
  if (media === "video") await updateVideoLora(id, libraryPatch); else await imageLoras.update(id, libraryPatch);
  if (patch.availabilityWho !== undefined && !WHO.includes(patch.availabilityWho)) throw new LoraError("bad_availability", "Who can use it is admins, adults or people.", 422);
  const homePatch = patch.homePatch ? checkHomePatch(patch.homePatch) : null;
  if (patch.description !== undefined || patch.kind !== undefined || patch.availabilityWho !== undefined || homePatch) {
    const all = readAllLoras(); const index = all.findIndex((record) => record.id === id);
    const home = { ...(all[index]!.home ?? {}) } as Record<string, unknown>;
    if (patch.description !== undefined) home.description = patch.description;
    if (patch.kind !== undefined) home.kind = patch.kind;
    if (homePatch) Object.assign(home, homePatch);
    if (patch.availabilityWho !== undefined) {
      const current = home.availability && typeof home.availability === "object" ? home.availability as Record<string, unknown> : null;
      home.availability = current ? { ...current, who: patch.availabilityWho } : { who: patch.availabilityWho, people: [] };
    }
    all[index] = { ...all[index]!, home }; writeAllLoras(all);
  }
  return getCatalog(id)!;
}

/** Puts a LoRA in the trash for 30 days: unusable at once, restorable until then. */
export function trashCatalog(id: string, now = new Date()): CatalogLora {
  const all = readAllLoras(); const index = all.findIndex((record) => record.id === id);
  if (index < 0) throw new LoraError("unknown_lora", "No such LoRA in the library.", 404);
  if (all[index]!.removed_at) return view(all[index]!);
  all[index] = { ...all[index]!, removed_at: now.toISOString(), trash_until: new Date(now.getTime() + TRASH_DAYS * 86_400_000).toISOString() };
  writeAllLoras(all);
  return view(all[index]!);
}
export function restoreCatalog(id: string): CatalogLora {
  const all = readAllLoras(); const index = all.findIndex((record) => record.id === id);
  if (index < 0) throw new LoraError("unknown_lora", "No such LoRA in the library.", 404);
  if (!all[index]!.removed_at) return view(all[index]!);
  all[index] = { ...all[index]!, removed_at: null, trash_until: null };
  writeAllLoras(all);
  return view(all[index]!);
}
/** Deletes a trashed or live LoRA and its file now (the "empty trash" path and the components page). */
export function purgeCatalog(id: string): boolean {
  const all = readAllLoras(); const record = all.find((entry) => entry.id === id);
  if (!record) return false;
  try { rmSync(catalogFilePath(record), { force: true }); } catch { /* the drive is gone; the record still goes */ }
  if (record.preview) rmSync(join(previewDir(), record.preview), { force: true });
  writeAllLoras(all.filter((entry) => entry.id !== id));
  return true;
}

/** The fence in one function: every id must be a live LoRA the audience may use; an unknown or trashed id counts as adult-only. Throws `lora_not_allowed` or `unknown_lora`. */
export function assertLorasAllowed(ids: string[], audience: Audience): void {
  const all = readAllLoras();
  for (const id of ids) {
    const record = isLoraId(id) ? all.find((entry) => entry.id === id) : undefined;
    if (!record || record.removed_at) {
      if (audience !== "adult") throw new LoraError("lora_not_allowed", "That style is not available here.", 422);
      throw new LoraError("unknown_lora", `No LoRA with the id ${String(id).slice(0, 40)} is in the library.`, 422);
    }
    if (record.classification === "adult-only" && audience !== "adult") throw new LoraError("lora_not_allowed", "That LoRA is adult-only and this request is not for an adult audience.", 422);
  }
}

export interface ImportItem { lora: unknown; preview?: { content_type: string; data_base64: string } | null }
export interface ImportResult { id: string; result: "imported" | "unchanged" | "missing_file" | "conflict" | "invalid"; note?: string }
const PREVIEW_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const MAX_PREVIEW_BYTES = 2_000_000;

/** Takes Home's records and previews. Idempotent by id and never deletes: a record whose file the Stack does not have is reported `missing_file` and not created; a record whose sha256 differs is a `conflict` and left alone; adult-only is never lowered by an import (it can only raise). */
export function importCatalog(items: ImportItem[]): ImportResult[] {
  const results: ImportResult[] = [];
  const all = readAllLoras();
  for (const item of items) {
    const parsed = SpecLora.safeParse(item.lora);
    const rawId = typeof (item.lora as { id?: unknown } | null)?.id === "string" ? String((item.lora as { id: string }).id) : "unknown";
    if (!parsed.success) { results.push({ id: rawId, result: "invalid", note: "That record is not a valid LoRA record." }); continue; }
    const spec = parsed.data;
    const index = all.findIndex((record) => record.id === spec.id);
    if (index < 0) { results.push({ id: spec.id, result: "missing_file", note: "The Stack has no file with this id, so nothing was added." }); continue; }
    const current = all[index]!;
    if (current.sha256 !== spec.file.sha256) { results.push({ id: spec.id, result: "conflict", note: "The Stack's file has a different fingerprint, so the record was left as it is." }); continue; }
    let preview = current.preview ?? null;
    if (item.preview) {
      const extension = PREVIEW_TYPES[item.preview.content_type];
      const bytes = Buffer.from(item.preview.data_base64, "base64");
      if (extension && bytes.length > 0 && bytes.length <= MAX_PREVIEW_BYTES) {
        mkdirSync(previewDir(), { recursive: true, mode: 0o700 });
        const name = `${spec.id}${extension}`; const temp = join(previewDir(), `${name}.${process.pid}.tmp`);
        writeFileSync(temp, bytes, { mode: 0o600 }); renameSync(temp, join(previewDir(), name));
        for (const other of readdirSync(previewDir())) if (other.startsWith(`${spec.id}.`) && other !== name && !other.endsWith(".tmp")) rmSync(join(previewDir(), other), { force: true });
        preview = name;
      }
    }
    const classification: LoraClass = current.classification === "adult-only" || spec.audience === "adult-only" ? "adult-only" : "all-ages";
    const next: LoraRecord = {
      ...current, name: spec.name, trigger_words: spec.trigger_words, strength_default: spec.strength.default, classification,
      added_by: current.added_by ?? spec.added_by, removed_at: spec.removed_at, trash_until: spec.trash_until, home: spec as unknown as Record<string, unknown>, preview,
    };
    if (JSON.stringify(next) === JSON.stringify(current)) { results.push({ id: spec.id, result: "unchanged" }); continue; }
    all[index] = next;
    results.push({ id: spec.id, result: "imported", ...(classification !== (spec.audience === "adult-only" ? "adult-only" : "all-ages") ? { note: "The Stack kept adult-only: an import never lowers an audience." } : {}) });
  }
  writeAllLoras(all);
  return results;
}
