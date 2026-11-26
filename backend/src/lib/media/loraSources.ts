// STACK-LORAS-01 slice 2: everything outbound for LoRAs, in the Stack. The Hugging Face token and the
// Civitai key are held here (encrypted with the Stack's secrets key, never returned by any route);
// browsing reads each site's public search API; an install is gated on the one global licence accept
// and may name a drive; a move copies a file to another drive, checks it, then switches the record.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@/lib/paths";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { globalLicenceAcceptance } from "@/lib/licenceAcceptance";
import { DriveNotConnectedError, diskStatus, loraRootFor } from "@/lib/disks";
import { readDiskSpace } from "@/lib/diskState";
import { sha256OfFile } from "@/lib/fileHash";
import { createJob, finishJob, updateJob, type Job } from "@/lib/jobs";
import { LoraError, describedAs, scanWords, namesRealPerson, type LoraClass, type LoraMedia } from "@/lib/media/loraLibrary";
import { LORA_INSTALL_SITES, type LoraInstallSite } from "@/lib/media/loraInstallCore";
import { loraFileOn, readAllLoras, writeAllLoras } from "@/lib/media/loraStore";
import { startLoraInstall } from "@/images/loras";
import { startVideoLoraInstall } from "@/video/loraInstall";

// ---- keys (the Stack's source connections for LoRAs) ----
const keysFile = (): string => join(dataDir, "lora-source-keys.json");
const readKeys = (): Partial<Record<LoraInstallSite, string>> => { try { return JSON.parse(readFileSync(keysFile(), "utf8")); } catch { return {}; } };
export function setSourceKey(site: LoraInstallSite, key: string | null): void {
  if (!LORA_INSTALL_SITES.includes(site)) throw new LoraError("bad_source", "The source is huggingface or civitai.", 422);
  const keys = readKeys();
  const clean = key?.trim() ?? "";
  if (key !== null && (clean.length < 8 || clean.length > 500 || /\s/.test(clean))) throw new LoraError("bad_key", "That does not look like a key or token. Copy it again from the site.", 422);
  if (key === null) delete keys[site]; else keys[site] = encryptSecret(clean);
  mkdirSync(dirname(keysFile()), { recursive: true });
  const temp = `${keysFile()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(keys), { mode: 0o600 }); renameSync(temp, keysFile());
}
export const sourceKey = (site: LoraInstallSite): string | null => { const stored = readKeys()[site]; if (!stored) return null; try { return decryptSecret(stored); } catch { return null; } };
export const sourceStatus = (): Array<{ site: LoraInstallSite; label: string; has_key: boolean }> => LORA_INSTALL_SITES.map((site) => ({ site, label: site === "huggingface" ? "Hugging Face" : "Civitai", has_key: sourceKey(site) !== null }));

// ---- rate limit (one place, both sites): 2 s apart and 60 requests an hour, the stricter of the two figures the old notes gave ----
const MIN_GAP_MS = 2000, HOURLY = 60;
const stamps: number[] = [];
export function __resetSourceLimitForTests(): void { stamps.length = 0; }
function allowRequest(now = Date.now()): void {
  while (stamps.length && now - stamps[0]! > 3_600_000) stamps.shift();
  if (stamps.length >= HOURLY) throw new LoraError("source_busy", "That is the most searches in an hour. Try again later.", 429);
  if (stamps.length && now - stamps[stamps.length - 1]! < MIN_GAP_MS) throw new LoraError("source_busy", "Searching too fast. Wait a moment, then search again.", 429);
  stamps.push(now);
}

// ---- browse ----
export interface SourceHit { site: LoraInstallSite; remote_id: string; name: string; base_model: string | null; downloads: number; /** What the install call takes as `url`. */ install_url: string; file_name: string | null; bytes: number | null; /** Worked out from the site's own fields, the same classifier an install uses. */ audience_hint: LoraClass; licence: string | null; page_url: string }
export async function browseSource(site: LoraInstallSite, query: string, deps: { fetch?: typeof fetch; now?: number } = {}): Promise<SourceHit[]> {
  if (!LORA_INSTALL_SITES.includes(site)) throw new LoraError("bad_source", "The source is huggingface or civitai.", 422);
  const q = query.trim().slice(0, 100);
  if (!q) throw new LoraError("bad_query", "Type a word to search for.", 422);
  allowRequest(deps.now);
  const fetchImpl = deps.fetch ?? fetch; const token = sourceKey(site);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "MaiPai-Stack", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (site === "huggingface") {
    const response = await fetchImpl(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=lora&limit=20&full=true`, { headers });
    if (!response.ok) throw new LoraError(response.status === 429 ? "source_busy" : "source_failed", `Hugging Face answered ${response.status}. Try again later.`, 502);
    const body = await response.json() as Array<{ id?: string; downloads?: number; tags?: string[]; siblings?: Array<{ rfilename?: string }>; cardData?: { license?: string | string[]; base_model?: string | string[] } }>;
    const hits: SourceHit[] = [];
    for (const model of body) {
      const file = model.siblings?.find((s) => s.rfilename?.endsWith(".safetensors"))?.rfilename; if (!model.id || !file) continue;
      const lic = Array.isArray(model.cardData?.license) ? model.cardData!.license![0] : model.cardData?.license;
      const base = Array.isArray(model.cardData?.base_model) ? model.cardData!.base_model![0] : model.cardData?.base_model;
      const text = describedAs([model.id, ...(model.tags ?? [])], undefined);
      hits.push({ site, remote_id: model.id, name: model.id.split("/").pop()!, base_model: base ?? null, downloads: model.downloads ?? 0, install_url: `https://huggingface.co/${model.id}/resolve/main/${file}`, file_name: file, bytes: null, audience_hint: scanWords(text).adult || namesRealPerson(text) ? "adult-only" : "all-ages", licence: lic ?? null, page_url: `https://huggingface.co/${model.id}` });
    }
    return hits;
  }
  const response = await fetchImpl(`https://civitai.com/api/v1/models?query=${encodeURIComponent(q)}&types=LORA&limit=20`, { headers });
  if (!response.ok) throw new LoraError(response.status === 429 ? "source_busy" : "source_failed", `Civitai answered ${response.status}. Try again later.`, 502);
  const body = await response.json() as { items?: Array<{ id?: number; name?: string; nsfw?: boolean; nsfwLevel?: number; tags?: string[]; stats?: { downloadCount?: number }; modelVersions?: Array<{ baseModel?: string; files?: Array<{ name?: string; sizeKB?: number; type?: string; downloadUrl?: string }> }> }> };
  const hits: SourceHit[] = [];
  for (const item of body.items ?? []) {
    const version = item.modelVersions?.[0]; const file = version?.files?.find((f) => f.name?.endsWith(".safetensors")); if (!item.id || !file?.downloadUrl) continue;
    const match = /\/api\/download\/models\/(\d+)/.exec(file.downloadUrl); if (!match) continue;
    const text = describedAs([item.name, ...(item.tags ?? [])], undefined);
    const adult = item.nsfw === true || (item.nsfwLevel ?? 0) > 1 || scanWords(text).adult || namesRealPerson(text);
    hits.push({ site, remote_id: String(item.id), name: item.name ?? `Civitai ${item.id}`, base_model: version?.baseModel ?? null, downloads: item.stats?.downloadCount ?? 0, install_url: `https://civitai.com/api/download/models/${match[1]}`, file_name: file.name ?? null, bytes: file.sizeKB ? Math.round(file.sizeKB * 1024) : null, audience_hint: adult ? "adult-only" : "all-ages", licence: null, page_url: `https://civitai.com/models/${item.id}` });
  }
  return hits;
}

// ---- install ----
export interface UnifiedInstall { media: LoraMedia; site: LoraInstallSite; url: string; name: string; licence?: string; classification?: LoraClass; strengthDefault?: number; triggerWords?: string[]; addedBy?: string | null; diskId?: string | null; sha256Expected?: string | null; sourceUrl?: string | null; baseModel?: string | null }
export const GLOBAL_LICENCE_REFUSAL = "Accept the licences in the Stack admin first (the Licences card on the AI and models page), then add the style again.";
export function startCatalogInstall(input: UnifiedInstall, deps: { fetch?: typeof fetch } = {}): Job {
  if (!globalLicenceAcceptance()) throw new LoraError("licence_not_accepted", GLOBAL_LICENCE_REFUSAL, 403);
  const diskId = input.diskId && input.diskId !== "main" ? input.diskId : null;
  if (diskId) { try { loraRootFor(diskId); } catch (error) { if (error instanceof DriveNotConnectedError) throw new LoraError("drive_missing", error.message, 422); throw error; } }
  const common = { url: input.url, name: input.name, classification: input.classification, strengthDefault: input.strengthDefault, triggerWords: input.triggerWords, addedBy: input.addedBy, sha256Expected: input.sha256Expected, sourceUrl: input.sourceUrl, token: sourceKey(input.site), diskId, licenceAcknowledged: true };
  if (input.media === "video") return startVideoLoraInstall({ ...common, site: input.site, licence: input.licence?.trim() || "unknown", baseModel: (input.baseModel ?? null) as never }, deps);
  return startLoraInstall({ ...common, site: input.site, licence: input.licence?.trim() || undefined, baseModel: (input.baseModel ?? null) as never }, deps);
}

// ---- move ----
let moving = false;
export function __resetLoraMoveForTests(): void { moving = false; }
/** Moves one LoRA's file to another drive: copy, check the fingerprint, switch the record, delete the original. The original stays until the copy is proved. */
export async function planLoraMove(id: string, toDiskId: string): Promise<{ bytes: number; from: string; to: string }> {
  const record = readAllLoras().find((entry) => entry.id === id);
  if (!record || record.removed_at) throw new LoraError("unknown_lora", "No such LoRA in the library.", 404);
  const media = record.media ?? "picture";
  const target = toDiskId === "main" ? null : toDiskId;
  if ((record.disk_id ?? null) === target) throw new LoraError("same_drive", "This style is already on that drive. Choose another drive.", 422);
  const source = diskStatus(record.disk_id ?? null); if (!source.connected) throw new LoraError("drive_missing", `${source.label} is not connected. Plug it back in, then move the style.`, 422);
  const dest = diskStatus(target); if (!dest.connected) throw new LoraError("drive_missing", `${dest.label} is not connected. Plug it back in or choose another drive.`, 422);
  const from = loraFileOn(media, id, record.disk_id ?? null), to = loraFileOn(media, id, target);
  if (!existsSync(from)) throw new LoraError("lora_missing", `The file for "${record.name}" is missing from the library. Add it again.`, 422);
  const bytes = statSync(from).size;
  let space; try { space = await readDiskSpace(dirname(to).replace(/\/loras$/, "")); } catch { space = null; }
  if (space && space.free < bytes + 1_000_000_000) throw new LoraError("no_space", "There is not enough free space on that drive. Free up space or choose another drive.", 422);
  return { bytes, from, to };
}
export function startLoraMove(id: string, toDiskId: string, deps: { afterCopy?: () => void | Promise<void> } = {}): Promise<Job> {
  return (async () => {
    if (moving) throw new LoraError("move_busy", "Another style is moving. Wait for it to finish.", 503);
    const plan = await planLoraMove(id, toDiskId);
    const record = readAllLoras().find((entry) => entry.id === id)!; const target = toDiskId === "main" ? null : toDiskId;
    const job = createJob({ kind: "lora.move", role: null, status: "Moving a style", totalBytes: plan.bytes, input: { stage: "style" } }); moving = true;
    void (async () => {
      const part = `${plan.to}.moving`;
      try {
        mkdirSync(dirname(plan.to), { recursive: true, mode: 0o700 }); rmSync(part, { force: true });
        copyFileSync(plan.from, part); updateJob(job.id, { completedBytes: plan.bytes, status: "Checking the copy" });
        await deps.afterCopy?.();
        if (statSync(part).size !== plan.bytes || (await sha256OfFile(part)) !== record.sha256) throw new Error("The copy did not match the original. The original is safe; try again.");
        renameSync(part, plan.to);
        const all = readAllLoras(); const index = all.findIndex((entry) => entry.id === id);
        if (index < 0) throw new Error("The style was removed while it moved.");
        all[index] = { ...all[index]!, disk_id: target, mtime_ms: Math.floor(statSync(plan.to).mtimeMs) }; writeAllLoras(all);
        rmSync(plan.from, { force: true });
        finishJob(job.id, { ok: true, result: { id, disk_id: target } });
      } catch (error) {
        rmSync(part, { force: true });
        finishJob(job.id, { ok: false, reason: `move_failed: ${error instanceof Error ? error.message : "The move failed. The original is safe; try again."}` });
      } finally { moving = false; }
    })();
    return job;
  })();
}
