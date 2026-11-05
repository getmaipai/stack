import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { sha256OfFile } from "@/lib/fileHash";
import { createJob, finishJob, jobSignal, updateJob, type Job } from "@/lib/jobs";
import { LoraError, type LoraClass } from "@/video/loras";
import { parseHfLoraUrl } from "@/images/loras";

export const LORA_INSTALL_SITES = ["huggingface", "civitai"] as const;
export type LoraInstallSite = typeof LORA_INSTALL_SITES[number];
const MAX_HOPS = 5;
const STALE_PART_MS = 24 * 3_600_000;

interface SiteRules { start: (host: string) => boolean; allowed: (host: string) => boolean; auth: (host: string) => boolean; label: string }
const under = (host: string, base: string): boolean => host === base || host.endsWith(`.${base}`);
export const SITE_RULES: Record<LoraInstallSite, SiteRules> = {
  huggingface: { label: "Hugging Face", start: (h) => h === "huggingface.co", allowed: (h) => under(h, "huggingface.co") || under(h, "hf.co"), auth: (h) => h === "huggingface.co" },
  civitai: { label: "Civitai", start: (h) => h === "civitai.com", allowed: (h) => under(h, "civitai.com") || (h.startsWith("civitai-delivery-worker") && h.endsWith(".r2.cloudflarestorage.com")), auth: (h) => h === "civitai.com" },
};

export function parseInstallUrl(site: LoraInstallSite, value: string): URL {
  if (site === "huggingface") {
    let probe: URL;
    try {
      probe = new URL(value.trim());
    } catch {
      throw new LoraError("bad_url", "That is not a Hugging Face file link.", 422);
    }
    if (!SITE_RULES.huggingface.start(probe.hostname) || probe.protocol !== "https:" || probe.username || probe.password || probe.port) {
      throw new LoraError("host_not_allowed", "Only links from huggingface.co can be fetched here. Download the file yourself and add it as a file instead.", 422);
    }
    let file: ReturnType<typeof parseHfLoraUrl>;
    try {
      file = parseHfLoraUrl(value);
    } catch (error) {
      throw new LoraError("bad_url", error instanceof Error ? error.message : "That is not a Hugging Face file link.", 422);
    }
    return new URL(`https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.file.split("/").map(encodeURIComponent).join("/")}`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LoraError("bad_url", "That is not a link.", 422);
  }
  if (url.protocol !== "https:" || !SITE_RULES.civitai.start(url.hostname) || url.username || url.password || url.port) {
    throw new LoraError("host_not_allowed", "Only links from civitai.com can be fetched here. Download the file yourself and add it as a file instead.", 422);
  }
  if (!/^\/api\/download\/models\/\d+\/?$/.test(url.pathname)) {
    throw new LoraError("bad_url", "The link must be a Civitai download link, like https://civitai.com/api/download/models/12345.", 422);
  }
  url.search = "";
  return url;
}

export interface InstallSource { site: LoraInstallSite; url: string; name: string; licence: string; licenceAcknowledged?: boolean; classification?: LoraClass; strengthDefault?: number; triggerWords?: string[]; addedBy?: string | null; baseModel?: string | null; sha256Expected?: string | null; token?: string | null; sourceUrl?: string | null; sourceHost?: string; extraDescription?: string[] }
export interface InstallAdapter<T> { kind: string; role: string; noun: string; partDir: () => string; parseUrl: (site: LoraInstallSite, value: string) => URL; get: (id: string) => T | null | undefined; importFile: (options: Record<string, unknown>) => Promise<T>; readHeader: (path: string) => unknown; maxBytes: number; /** The code a duplicate found after the download carries (the picture install kept `already_added` from before the shared core). */ duplicateCode?: string }
export interface LoraInstallFailure { code: string; existing_id?: string }

export function partPath(dir: string, url: URL): string { return join(dir, `lora-install-${createHash("sha256").update(url.href).digest("hex").slice(0, 16)}.part`); }
export function sweepParts(dir: string, now = Date.now()): number {
  let removed = 0;
  try { for (const name of readdirSync(dir)) { if (!name.endsWith(".part")) continue; const path = join(dir, name); if (now - statSync(path).mtimeMs > STALE_PART_MS) { rmSync(path, { force: true }); removed += 1; } } } catch { /* nothing there */ }
  return removed;
}
function denied(status: number, site: LoraInstallSite, hadToken: boolean): LoraError {
  const label = SITE_RULES[site].label;
  if (status === 401 || status === 403) return new LoraError(hadToken ? "token_refused" : "token_needed", hadToken ? `${label} refused the saved key or token. Check that it is still valid and that you accepted the file's terms on the site, then try again.` : `${label} needs a sign-in for this file. Save a key or token for ${label}, accept the file's terms on the site if it asks, then try again.`, 502);
  if (status === 404) return new LoraError("source_missing", `${label} does not have that file any more. Check the link.`, 502);
  if (status === 429) return new LoraError("source_busy", `${label} is asking us to slow down. Try again in a few minutes.`, 503);
  return new LoraError("download_failed", `${label} answered ${status} for that file. Try again later.`, 502);
}
async function getFollowing(start: URL, site: LoraInstallSite, token: string | null, range: number, signal: AbortSignal | undefined, fetchImpl: typeof fetch): Promise<Response> {
  const rules = SITE_RULES[site]; let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:" || !rules.allowed(url.hostname) || url.username || url.password) throw new LoraError("host_not_allowed", `That download tried to go somewhere other than ${rules.label}, so it was stopped. Nothing was saved.`, 422);
    const headers: Record<string, string> = { accept: "application/octet-stream", "user-agent": "MaiPai-Stack" };
    if (token && rules.auth(url.hostname)) headers.authorization = `Bearer ${token}`;
    if (range > 0) headers.range = `bytes=${range}-`;
    const response = await fetchImpl(url.href, { headers, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) { const location = response.headers.get("location"); if (!location) throw new LoraError("download_failed", `${rules.label} sent an incomplete redirect. Try again later.`, 502); await response.body?.cancel().catch(() => {}); url = new URL(location, url); continue; }
    return response;
  }
  throw new LoraError("download_failed", `${rules.label} sent too many redirects. Try again later.`, 502);
}
async function download(url: URL, site: LoraInstallSite, token: string | null, part: string, partDir: string, maxBytes: number, signal: AbortSignal | undefined, onBytes: (done: number, total: number) => void, fetchImpl: typeof fetch): Promise<number> {
  mkdirSync(partDir, { recursive: true, mode: 0o700 }); let have = existsSync(part) ? statSync(part).size : 0;
  if (have > maxBytes) { rmSync(part, { force: true }); have = 0; }
  const response = await getFollowing(url, site, token, have, signal, fetchImpl); let total = 0;
  if (have > 0 && response.status === 416) { const match = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? ""); if (match && Number(match[1]) === have) return have; rmSync(part, { force: true }); return download(url, site, token, part, partDir, maxBytes, signal, onBytes, fetchImpl); }
  if (!response.ok || !response.body) throw denied(response.status, site, token !== null);
  if (response.status === 206 && have > 0) { const match = /^bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(response.headers.get("content-range") ?? ""); if (!match || Number(match[1]) !== have) { await response.body.cancel().catch(() => {}); rmSync(part, { force: true }); return download(url, site, token, part, partDir, maxBytes, signal, onBytes, fetchImpl); } total = match[2] === "*" ? 0 : Number(match[2]); }
  else { if (have > 0) rmSync(part, { force: true }); have = 0; total = Number(response.headers.get("content-length") ?? 0); }
  if (total > maxBytes) { await response.body.cancel().catch(() => {}); throw new LoraError("too_large", `That file is larger than ${maxBytes / 1_073_741_824} GB, the most a LoRA can be here.`, 413); }
  const reader = response.body.getReader(); let done = have;
  while (true) { const { value, done: finished } = await reader.read(); if (finished) break; done += value.length; if (done > maxBytes) { await reader.cancel().catch(() => {}); throw new LoraError("too_large", `That file is larger than ${maxBytes / 1_073_741_824} GB, the most a LoRA can be here.`, 413); } appendFileSync(part, value, { mode: 0o600 }); onBytes(done, total); }
  if (total > 0 && done !== total) throw new LoraError("download_cut_short", "The download stopped before the end. Try again; it picks up where it left off.", 502);
  return done;
}

export function startInstall<T>(input: InstallSource, adapter: InstallAdapter<T>, isBusy: () => boolean, setBusy: (id: string | null) => void, deps: { fetch?: typeof fetch } = {}): Job {
  const fetchImpl = deps.fetch ?? fetch;
  if (!LORA_INSTALL_SITES.includes(input.site)) throw new LoraError("bad_source", "The source is huggingface or civitai.", 422);
  if (input.classification !== undefined && !["all-ages", "adult-only"].includes(input.classification)) throw new LoraError("bad_classification", "The classification is all-ages or adult-only.", 422);
  const url = adapter.parseUrl(input.site, input.url);
  const expected = input.sha256Expected ? input.sha256Expected.trim().toLowerCase() : null;
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) throw new LoraError("bad_hash", "The expected hash must be 64 hex characters.", 422);
  if (expected) { const existing = adapter.get(`lora-${expected.slice(0, 16)}`) as { sha256?: string; id?: string } | null | undefined; if (existing && existing.sha256 === expected) throw Object.assign(new LoraError("duplicate_lora", "This style is already in the library; nothing was downloaded.", 409), { existingId: existing.id }); }
  if (isBusy()) throw new LoraError("install_busy", "Another style is downloading. Wait for it to finish, then try again.", 503);
  const token = input.token?.trim() || null;
  const job = createJob({ kind: adapter.kind, role: adapter.role, status: "Downloading a style", input: { stage: "style" } }); setBusy(job.id);
  sweepParts(adapter.partDir()); const part = partPath(adapter.partDir(), url);
  void (async () => { let keepPart = false;
    try {
      const size = await download(url, input.site, token, part, adapter.partDir(), adapter.maxBytes, jobSignal(job.id), (done, total) => updateJob(job.id, { completedBytes: done, totalBytes: total || done }), fetchImpl);
      updateJob(job.id, { status: "Checking the file" }); if (size === 0) throw new LoraError("not_safetensors", "The download was empty. Try again.", 422);
      adapter.readHeader(part);
      const sha256 = await sha256OfFile(part);
      if (expected && sha256 !== expected) throw new LoraError("hash_mismatch", `The file does not match the fingerprint ${SITE_RULES[input.site].label} published for it, so it was not added. Try again; if it happens twice, the source changed the file.`, 422);
      const existing = adapter.get(`lora-${sha256.slice(0, 16)}`) as { id?: string } | undefined;
      if (existing) throw Object.assign(new LoraError(adapter.duplicateCode ?? "duplicate_lora", "This style is already in the library.", 409), { existingId: existing.id });
      const record = await adapter.importFile({ path: part, name: input.name, licence: input.licence, licenceAcknowledged: input.licenceAcknowledged, sourceUrl: input.sourceUrl ?? null, classification: input.classification, strengthDefault: input.strengthDefault, triggerWords: input.triggerWords, addedBy: input.addedBy, declaredBase: input.baseModel ?? null, extraDescription: input.extraDescription ?? [] });
      finishJob(job.id, { ok: true, result: { lora: record } });
    } catch (error) {
      const isLoraError = error instanceof Error && "code" in error && "status" in error;
      const errorCode = isLoraError ? String((error as { code: unknown }).code) : null;
      const interrupted = !isLoraError && !(jobSignal(job.id)?.aborted ?? false);
      keepPart = interrupted || (jobSignal(job.id)?.aborted ?? false) || (errorCode !== null && ["download_cut_short", "source_busy", "download_failed"].includes(errorCode));
      const code = errorCode ?? "download_failed";
      const message = error instanceof Error ? error.message : "The download was interrupted. Try again; it picks up where it left off.";
      const failure: LoraInstallFailure = { code, ...(error instanceof Error && "existingId" in error ? { existing_id: String((error as { existingId: unknown }).existingId) } : {}) };
      finishJob(job.id, { ok: false, reason: `${code}: ${message}`, result: failure });
    } finally { if (!keepPart) rmSync(part, { force: true }); setBusy(null); }
  })();
  return job;
}
