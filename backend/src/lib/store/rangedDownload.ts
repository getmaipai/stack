import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { downloadUrl, type DownloadProgress } from "@/lib/download";

export interface RangedDownloadOptions {
  expectedSha256: string;
  expectedBytes: number;
  parts?: number;
  onProgress?: (progress: DownloadProgress & { partCount: number }) => void;
  signal?: AbortSignal;
}

interface PartState { start: number; end: number; offset: number; }

function sidecar(path: string): string { return `${path}.json`; }
function partPath(dest: string, index: number): string { return `${dest}.partial-${index}`; }

function stateFor(path: string, start: number, end: number): PartState {
  try {
    const parsed = JSON.parse(readFileSync(sidecar(path), "utf8")) as PartState;
    if (parsed.start === start && parsed.end === end) return { ...parsed, offset: Math.min(parsed.offset, end + 1) };
  } catch { /* Start fresh if a sidecar was interrupted while being written. */ }
  return { start, end, offset: start };
}

function report(options: RangedDownloadOptions, bytes: number, total: number, parts: number, status: string): void {
  options.onProgress?.({ completedBytes: bytes, totalBytes: total, status, partCount: parts });
}

async function rangeSupported(url: string, signal?: AbortSignal): Promise<boolean> {
  const response = await fetch(url, { headers: { Range: "bytes=0-0" }, signal });
  await response.arrayBuffer();
  return response.status === 206 && Boolean(response.headers.get("content-range"));
}

async function downloadPart(url: string, index: number, state: PartState, dest: string, total: number, options: RangedDownloadOptions, parts: number): Promise<void> {
  const path = partPath(dest, index);
  const current = existsSync(path) ? statSync(path).size : 0;
  state.offset = Math.min(state.start + current, state.end + 1);
  if (state.offset > state.start) writeFileSync(sidecar(path), JSON.stringify(state));
  if (state.offset > state.end) return;
  const response = await fetch(url, { headers: { Range: `bytes=${state.offset}-${state.end}` }, signal: options.signal });
  if (response.status !== 206) throw new Error("Range response was not partial");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > state.end - state.offset + 1) throw new Error("Range response exceeded requested part");
  appendFileSync(path, bytes);
  state.offset += bytes.length;
  writeFileSync(sidecar(path), JSON.stringify(state));
  report(options, countPartBytes(dest, parts), total, parts, "downloading");
  if (state.offset <= state.end) throw new Error(`Part ${index} ended before its requested range`);
}

function countPartBytes(dest: string, parts: number): number {
  return Array.from({ length: parts }, (_, index) => {
    const path = partPath(dest, index);
    return existsSync(path) ? statSync(path).size : 0;
  }).reduce((sum, value) => sum + value, 0);
}

function assemble(dest: string, parts: number): void {
  writeFileSync(`${dest}.partial`, Buffer.alloc(0));
  for (let index = 0; index < parts; index += 1) appendFileSync(`${dest}.partial`, readFileSync(partPath(dest, index)));
}

export async function rangedDownload(url: string, destination: string, options: RangedDownloadOptions): Promise<void> {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) return;
  if (!(await rangeSupported(url, options.signal))) {
    await downloadUrl(url, destination, { expectedSha256: options.expectedSha256, expectedBytes: options.expectedBytes, signal: options.signal, onProgress: (p) => report(options, p.completedBytes, p.totalBytes, 1, p.status) });
    return;
  }
  const parts = Math.max(1, options.parts ?? 8);
  const width = Math.ceil(options.expectedBytes / parts);
  const states = Array.from({ length: parts }, (_, index) => {
    const start = index * width;
    return stateFor(partPath(destination, index), start, Math.min(options.expectedBytes - 1, start + width - 1));
  }).filter((state) => state.start <= state.end);
  await Promise.all(states.map((state, index) => downloadPart(url, index, state, destination, options.expectedBytes, options, states.length)));
  if (countPartBytes(destination, states.length) !== options.expectedBytes) throw new Error("Ranged download is incomplete; partial files were kept for resume");
  assemble(destination, states.length);
  const hash = createHash("sha256").update(readFileSync(`${destination}.partial`)).digest("hex");
  report(options, options.expectedBytes, options.expectedBytes, states.length, "verifying checksum");
  if (hash !== options.expectedSha256.toLowerCase()) {
    rmSync(`${destination}.partial`, { force: true });
    throw new Error(`Ranged download checksum mismatch: ${hash}`);
  }
  await Bun.write(destination, Bun.file(`${destination}.partial`));
  rmSync(`${destination}.partial`, { force: true });
  for (let index = 0; index < states.length; index += 1) {
    rmSync(partPath(destination, index), { force: true });
    rmSync(sidecar(partPath(destination, index)), { force: true });
  }
}
