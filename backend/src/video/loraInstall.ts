// VIDEO-LORA-06: the `video.lora.install` job. Home (an admin's click) names a Hugging Face or Civitai file; the Stack downloads it into
// the video LoRA library. Design: home `docs/design/video-loras-2026-11-02.md` sections 5.3 and 15.5, ported from Loki Doki's
// civitai-import (`.part` file, Range resume, auth scoped to its own host, a safetensors header check) with the fixes it lacked: the
// hash is computed on receipt and compared, a size cap, a host allow list, every redirect hop checked, no pickle.
//
// What this module never does: decide who may use the file or whether it is adult (Home does, from the source's own data and the
// admin's choice; the audience arrives as `classification`), keep the token anywhere but this call's memory, write the URL, the
// name or the token into the job (the job list shows "a style" and bytes only, so an adult-only style is never named on the strip),
// or fetch anything on its own.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";
import { sha256OfFile } from "@/lib/fileHash";
import { createJob, finishJob, jobSignal, updateJob, type Job } from "@/lib/jobs";
import { parseHfLoraUrl } from "@/images/loras";
import { getLora, importLora, LORA_CLASSES, LoraError, MAX_LORA_BYTES, readSafetensorsHeader, type LoraBase, type LoraClass } from "@/video/loras";

export const LORA_INSTALL_SITES = ["huggingface", "civitai"] as const;
export type LoraInstallSite = typeof LORA_INSTALL_SITES[number];
export const LORA_INSTALL_KIND = "video.lora.install";
const MAX_HOPS = 5;
const STALE_PART_MS = 24 * 3_600_000;

interface SiteRules {
  /** Where the first request may go. */
  start: (host: string) => boolean;
  /** Every hop (the start, a redirect target, the CDN) must pass this. */
  allowed: (host: string) => boolean;
  /** The only hosts that ever receive the token. A CDN host gets none (it signs its own address and rejects a stray header). */
  auth: (host: string) => boolean;
  label: string;
}
const under = (host: string, base: string): boolean => host === base || host.endsWith(`.${base}`);
export const SITE_RULES: Record<LoraInstallSite, SiteRules> = {
  huggingface: { label: "Hugging Face", start: (h) => h === "huggingface.co", allowed: (h) => under(h, "huggingface.co") || under(h, "hf.co"), auth: (h) => h === "huggingface.co" },
  // The Civitai download host is the object store its redirect names (an R2 bucket whose name starts with civitai-delivery-worker): unverified against a live download, so the first real install confirms it (VIDEO-LORA-07).
  civitai: { label: "Civitai", start: (h) => h === "civitai.com", allowed: (h) => under(h, "civitai.com") || (h.startsWith("civitai-delivery-worker") && h.endsWith(".r2.cloudflarestorage.com")), auth: (h) => h === "civitai.com" },
};

export interface VideoLoraInstallInput {
  site: LoraInstallSite;
  /** A Hugging Face file link (resolve or blob) or `https://civitai.com/api/download/models/<version id>`. */
  url: string;
  name: string;
  licence: string;
  licenceAcknowledged?: boolean;
  /** Home's decision (`audience`): adult-only unless an admin chose all-ages. */
  classification?: LoraClass;
  strengthDefault?: number;
  triggerWords?: string[];
  addedBy?: string | null;
  /** The base the source says the file was made for; the tensors still have the last word. */
  baseModel?: LoraBase | null;
  /** The source's published sha256 (lower or upper case), when it gave one. */
  sha256Expected?: string | null;
  /** The admin's token for this site: held in memory for this one call. */
  token?: string | null;
  /** The page the admin chose, recorded on the library record. Never carries a token. */
  sourceUrl?: string | null;
}

/** Validates the address for its site and returns the URL to fetch. Throws a LoraError a person can act on. */
export function parseInstallUrl(site: LoraInstallSite, value: string): URL {
  if (site === "huggingface") {
    let hostOk = false;
    try { const probe = new URL(value.trim()); hostOk = probe.protocol === "https:" && SITE_RULES.huggingface.start(probe.hostname) && !probe.username && !probe.password && !probe.port; } catch { /* not a link: parseHfLoraUrl says so */ }
    if (!hostOk) throw new LoraError("host_not_allowed", "Only links from huggingface.co can be fetched here. Download the file yourself and add it as a file instead.", 422);
    let hf: ReturnType<typeof parseHfLoraUrl>;
    try { hf = parseHfLoraUrl(value); } catch (error) { throw new LoraError("bad_url", error instanceof Error ? error.message : "That is not a Hugging Face file link.", 422); }
    return new URL(`https://huggingface.co/${hf.repo}/resolve/${hf.revision}/${hf.file.split("/").map(encodeURIComponent).join("/")}`);
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new LoraError("bad_url", "That is not a link.", 422); }
  if (url.protocol !== "https:" || !SITE_RULES.civitai.start(url.hostname) || url.username || url.password || url.port) throw new LoraError("host_not_allowed", "Only links from civitai.com can be fetched here. Download the file yourself and add it as a file instead.", 422);
  if (!/^\/api\/download\/models\/\d+\/?$/.test(url.pathname)) throw new LoraError("bad_url", "The link must be a Civitai download link, like https://civitai.com/api/download/models/12345.", 422);
  url.search = ""; // a token in a query string is never accepted or sent
  return url;
}

function partDir(): string { return join(dataDir, "tmp", "video-lora-install"); }
function partPath(url: URL): string { return join(partDir(), `lora-install-${createHash("sha256").update(url.href).digest("hex").slice(0, 16)}.part`); }

/** Removes a `.part` file nobody resumed within a day (called at the start of each install; the Stack never runs one on its own). */
export function sweepInstallParts(now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(partDir())) {
      if (!name.endsWith(".part")) continue;
      const path = join(partDir(), name);
      if (now - statSync(path).mtimeMs > STALE_PART_MS) { rmSync(path, { force: true }); removed += 1; }
    }
  } catch { /* nothing there */ }
  return removed;
}

function denied(status: number, site: LoraInstallSite, hadToken: boolean): LoraError {
  const label = SITE_RULES[site].label;
  if (status === 401 || status === 403) return new LoraError(hadToken ? "token_refused" : "token_needed", hadToken ? `${label} refused the saved key or token. Check that it is still valid and that you accepted the file's terms on the site, then try again.` : `${label} needs a sign-in for this file. Save a key or token for ${label}, accept the file's terms on the site if it asks, then try again.`, 502);
  if (status === 404) return new LoraError("source_missing", `${label} does not have that file any more. Check the link.`, 502);
  if (status === 429) return new LoraError("source_busy", `${label} is asking us to slow down. Try again in a few minutes.`, 503);
  return new LoraError("download_failed", `${label} answered ${status} for that file. Try again later.`, 502);
}

/** One GET that follows redirects by hand: each hop must be https on the site's allow list, and the token goes only to the site's own host, so a redirect to a CDN or anywhere else drops it. */
async function getFollowing(start: URL, site: LoraInstallSite, token: string | null, range: number, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<Response> {
  const rules = SITE_RULES[site];
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:" || !rules.allowed(url.hostname) || url.username || url.password) throw new LoraError("host_not_allowed", `That download tried to go somewhere other than ${rules.label}, so it was stopped. Nothing was saved.`, 422);
    const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "MaiPai-Stack" };
    if (token && rules.auth(url.hostname)) headers.authorization = `Bearer ${token}`;
    if (range > 0) headers.range = `bytes=${range}-`;
    const response = await fetchImpl(url.href, { headers, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get("location");
      if (!location) throw new LoraError("download_failed", `${rules.label} sent an incomplete redirect. Try again later.`, 502);
      await response.body?.cancel().catch(() => {});
      url = new URL(location, url);
      continue;
    }
    return response;
  }
  throw new LoraError("download_failed", `${rules.label} sent too many redirects. Try again later.`, 502);
}

const tooLarge = (): LoraError => new LoraError("too_large", `That file is larger than ${MAX_LORA_BYTES / 1_073_741_824} GB, the most a LoRA can be here.`, 413);

/** Downloads to the `.part` file, resuming from what is already there when the host honours Range. Returns the final size. */
async function download(url: URL, site: LoraInstallSite, token: string | null, part: string, signal: AbortSignal | undefined, onBytes: (done: number, total: number) => void, fetchImpl: typeof fetch): Promise<number> {
  mkdirSync(partDir(), { recursive: true, mode: 0o700 });
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > MAX_LORA_BYTES) { rmSync(part, { force: true }); have = 0; }
  const response = await getFollowing(url, site, token, have, signal, fetchImpl);
  let total = 0;
  if (have > 0 && response.status === 416) {
    // The part is already the whole file (or longer than the file): keep it only if the server agrees on its length.
    const match = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
    if (match && Number(match[1]) === have) return have;
    rmSync(part, { force: true });
    return download(url, site, token, part, signal, onBytes, fetchImpl);
  }
  if (!response.ok || !response.body) throw denied(response.status, site, token !== null);
  if (response.status === 206 && have > 0) {
    const match = /^bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(response.headers.get("content-range") ?? "");
    if (!match || Number(match[1]) !== have) { await response.body.cancel().catch(() => {}); rmSync(part, { force: true }); return download(url, site, token, part, signal, onBytes, fetchImpl); }
    total = match[2] === "*" ? 0 : Number(match[2]);
  } else {
    // A 200 answers with the whole file: start over whatever was kept.
    if (have > 0) rmSync(part, { force: true });
    have = 0;
    total = Number(response.headers.get("content-length") ?? 0);
  }
  if (total > MAX_LORA_BYTES) { await response.body.cancel().catch(() => {}); throw tooLarge(); }
  const reader = response.body.getReader();
  let done = have;
  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    done += value.length;
    if (done > MAX_LORA_BYTES) { await reader.cancel().catch(() => {}); throw tooLarge(); }
    appendFileSync(part, value, { mode: 0o600 });
    onBytes(done, total);
  }
  if (total > 0 && done !== total) throw new LoraError("download_cut_short", "The download stopped before the end. Try again; it picks up where it left off.", 502);
  return done;
}

let installing: string | null = null;
export function __resetLoraInstallForTests(): void { installing = null; }

/** What a failed job carries as its `result`, so Home branches on the code and not on the sentence. */
export interface LoraInstallFailure { code: string; existing_id?: string }

/** Starts the install job. Throws a LoraError (422 bad input, 503 another install is running) before any job exists. */
export function startVideoLoraInstall(input: VideoLoraInstallInput, deps: { fetch?: typeof fetch } = {}): Job {
  const fetchImpl = deps.fetch ?? fetch;
  if (!LORA_INSTALL_SITES.includes(input.site)) throw new LoraError("bad_source", "The source is huggingface or civitai.", 422);
  if (input.classification !== undefined && !LORA_CLASSES.includes(input.classification)) throw new LoraError("bad_classification", "The classification is all-ages or adult-only.", 422);
  const url = parseInstallUrl(input.site, input.url);
  const expected = input.sha256Expected ? input.sha256Expected.trim().toLowerCase() : null;
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) throw new LoraError("bad_hash", "The expected hash must be 64 hex characters.", 422);
  if (expected) {
    const existing = getLora(`lora-${expected.slice(0, 16)}`);
    if (existing && existing.sha256 === expected) throw Object.assign(new LoraError("duplicate_lora", "This style is already in the library; nothing was downloaded.", 409), { existingId: existing.id });
  }
  if (installing) throw new LoraError("install_busy", "Another style is downloading. Wait for it to finish, then try again.", 503);
  const token = input.token?.trim() || null;
  const jobInput: Record<string, unknown> = { stage: "style" }; // nothing that names the file, the site or the person
  const job = createJob({ kind: LORA_INSTALL_KIND, role: "video", status: "Downloading a style", input: jobInput });
  installing = job.id;
  sweepInstallParts();
  const part = partPath(url);
  void (async () => {
    let keepPart = false;
    try {
      const size = await download(url, input.site, token, part, jobSignal(job.id), (done, total) => updateJob(job.id, { completedBytes: done, totalBytes: total || done }), fetchImpl);
      keepPart = false;
      updateJob(job.id, { status: "Checking the file" });
      if (size === 0) throw new LoraError("not_safetensors", "The download was empty. Try again.", 422);
      readSafetensorsHeader(part); // an HTML error page, a pickle or a cut-off file stops here
      const sha256 = await sha256OfFile(part);
      if (expected && sha256 !== expected) throw new LoraError("hash_mismatch", `The file does not match the fingerprint ${SITE_RULES[input.site].label} published for it, so it was not added. Try again; if it happens twice, the source changed the file.`, 422);
      const existing = getLora(`lora-${sha256.slice(0, 16)}`);
      if (existing) throw Object.assign(new LoraError("duplicate_lora", "This style is already in the library.", 409), { existingId: existing.id });
      const record = await importLora({ path: part, name: input.name, licence: input.licence, licenceAcknowledged: input.licenceAcknowledged, sourceUrl: input.sourceUrl ?? null, classification: input.classification, strengthDefault: input.strengthDefault, triggerWords: input.triggerWords, addedBy: input.addedBy, declaredBase: input.baseModel ?? null });
      finishJob(job.id, { ok: true, result: { lora: record } });
    } catch (error) {
      const interrupted = !(error instanceof LoraError) && !(jobSignal(job.id)?.aborted ?? false);
      // A dropped connection or a cancel keeps the part so Try again resumes; a refused file does not.
      keepPart = interrupted || (jobSignal(job.id)?.aborted ?? false) || (error instanceof LoraError && (error.code === "download_cut_short" || error.code === "source_busy" || error.code === "download_failed"));
      const code = error instanceof LoraError ? error.code : "download_failed";
      const message = error instanceof LoraError ? error.message : "The download was interrupted. Try again; it picks up where it left off.";
      const failure: LoraInstallFailure = { code, ...(error instanceof Error && "existingId" in error ? { existing_id: String((error as { existingId: unknown }).existingId) } : {}) };
      finishJob(job.id, { ok: false, reason: `${code}: ${message}`, result: failure });
    } finally {
      if (!keepPart) rmSync(part, { force: true });
      installing = null;
    }
  })();
  return job;
}
