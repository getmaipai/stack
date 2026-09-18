import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import { mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { withTimeout } from "@/lib/withTimeout";
import { stackSettingValues } from "@/settings/stackKeys";

export interface DownloadProgress {
  completedBytes: number;
  totalBytes: number;
  status: string;
}

export interface DownloadOptions {
  expectedSha256: string;
  expectedBytes?: number;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  downloadCapMbps?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function throttle(bytes: number, capMbps: number | undefined, startedAt: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<void> {
  if (!capMbps || capMbps <= 0) return;
  const expectedMs = bytes / (capMbps * 125); // Mbps to bytes per millisecond.
  const wait = expectedMs - (now() - startedAt);
  if (wait > 0) await sleep(wait);
}

const STREAM_IDLE_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 6;

export class DownloadVerificationError extends Error {}

export function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function fail(partPath: string, reason: string): never {
  try {
    unlinkSync(partPath);
  } catch {
    // Already gone.
  }
  throw new DownloadVerificationError(`Download failed (${reason}), the partial file was removed`);
}

async function downloadOnce(url: string, destPath: string, opts: DownloadOptions): Promise<void> {
  mkdirSync(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  const startAt = existsSync(partPath) ? statSync(partPath).size : 0;
  const headers: Record<string, string> = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};
  const res = await fetch(url, { headers, signal: opts.signal });
  if (!res.ok && res.status !== 206) throw new Error(`GET ${url} returned ${res.status}`);
  if (startAt > 0 && res.status !== 206) {
    unlinkSync(partPath);
    return downloadOnce(url, destPath, opts);
  }
  if (!res.body) throw new Error(`GET ${url} returned no body`);

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  const totalBytes = opts.expectedBytes ?? (startAt > 0 ? startAt + contentLength : contentLength);
  const out = createWriteStream(partPath, { flags: startAt > 0 ? "a" : "w" });
  const reader = res.body.getReader();
  let completedBytes = startAt;
  const startedAt = (opts.now ?? Date.now)();
  try {
    while (true) {
      const step = await withTimeout(reader.read(), STREAM_IDLE_TIMEOUT_MS, () => new Error(`stalled: no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s`));
      if (step.done) break;
      completedBytes += step.value.byteLength;
      await throttle(completedBytes - startAt, opts.downloadCapMbps, startedAt, opts.now ?? Date.now, opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
      await new Promise<void>((resolve, reject) => out.write(step.value, (err) => (err ? reject(err) : resolve())));
      opts.onProgress?.({ completedBytes, totalBytes, status: "downloading" });
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  const finalSize = statSync(partPath).size;
  if (opts.expectedBytes && finalSize !== opts.expectedBytes) fail(partPath, `size ${finalSize} != expected ${opts.expectedBytes}`);
  opts.onProgress?.({ completedBytes: finalSize, totalBytes: finalSize, status: "verifying checksum" });
  const actual = await sha256OfFile(partPath);
  if (actual !== opts.expectedSha256.toLowerCase()) fail(partPath, `sha256 ${actual.slice(0, 12)} != expected ${opts.expectedSha256.slice(0, 12)}`);
  renameSync(partPath, destPath);
}

export async function downloadUrl(url: string, destPath: string, opts: DownloadOptions): Promise<void> {
  if (existsSync(destPath)) return;
  const configuredCap = Number(stackSettingValues().downloadCapMbps ?? 0);
  const effectiveOptions = opts.downloadCapMbps === undefined ? { ...opts, downloadCapMbps: configuredCap } : opts;
  let verificationRetried = false;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await downloadOnce(url, destPath, effectiveOptions);
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      if (err instanceof DownloadVerificationError) {
        if (verificationRetried) throw err;
        verificationRetried = true;
        opts.onProgress?.({ completedBytes: 0, totalBytes: opts.expectedBytes ?? 0, status: `verification failed, retrying once: ${err.message}` });
        continue;
      }
      if (attempt >= MAX_ATTEMPTS) throw err;
      const message = (err as Error).message ?? String(err);
      if (/\b(404|403)\b/.test(message)) throw err;
      const delaySec = Math.min(5 * 2 ** (attempt - 1), 60);
      opts.onProgress?.({ completedBytes: 0, totalBytes: opts.expectedBytes ?? 0, status: `connection interrupted, resuming in ${delaySec}s (attempt ${attempt}/${MAX_ATTEMPTS - 1}): ${message}` });
      await new Promise<void>((resolve) => setTimeout(resolve, delaySec * 1000));
    }
  }
}
