// Still-picture SAM 2.1 masks. Uses the video component and worker, while
// keeping the single-picture request and temporary files separate from cutout.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admit, release, withdraw, type GovernorHandle } from "@/lib/governor";
import { CUTOUT_FAILED, CUTOUT_MODEL_MISSING, CUTOUT_NO_MEMORY } from "./cutout";
import { MASK_CONFIG_NAME, maskEnvironmentReady, maskModelPath, maskPython, maskWorkerEnv, materializeMaskWorker } from "@/video/mask";

const GB = 1_000_000_000;
type MaskChild = { stdin: { write(data: string): unknown; end(): unknown }; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill(signal?: number | string): void };
export const STILL_MASK_MAX_PIXELS = 12_000_000;
export const STILL_MASK_MAX_SIDE = 4096;
export const STILL_MASK_BAD_PROMPT = "Give a box or at least one positive point inside the picture.";
export const STILL_MASK_TOO_LARGE = "This picture is over the 12 megapixel or 4096 pixel side limit. Make it smaller first.";
export type StillMaskPrompt = { box?: [number, number, number, number]; points?: Array<{ x: number; y: number; label: 1 | 0 }> };
export function pngDimensions(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (pngDimensions(bytes)) return pngDimensions(bytes);
  if (bytes.length >= 30 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1]!; i += 2;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: bytes[i + 3]! * 256 + bytes[i + 4]!, width: bytes[i + 5]! * 256 + bytes[i + 6]! };
      const length = bytes[i]! * 256 + bytes[i + 1]!;
      if (length < 2) return null;
      i += length;
    }
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    const kind = String.fromCharCode(...bytes.slice(12, 16));
    if (kind === "VP8X") return { width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16) };
    if (kind === "VP8L" && bytes[20] === 0x2f) return { width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8), height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10) };
  }
  return null;
}

export function validateStillMaskPrompt(value: unknown, width: number, height: number): StillMaskPrompt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = value as Record<string, unknown>;
  let box: [number, number, number, number] | undefined;
  if (prompt.box !== undefined) {
    if (!Array.isArray(prompt.box) || prompt.box.length !== 4 || !prompt.box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    const [x0, y0, x1, y1] = prompt.box as number[];
    if (x0! < 0 || y0! < 0 || x1! > width || y1! > height || x1! <= x0! || y1! <= y0!) return null;
    box = [x0!, y0!, x1!, y1!];
  }
  let points: StillMaskPrompt["points"];
  if (prompt.points !== undefined) {
    if (!Array.isArray(prompt.points) || prompt.points.length > 16) return null;
    points = [];
    for (const entry of prompt.points) {
      if (!entry || typeof entry !== "object") return null;
      const point = entry as Record<string, unknown>;
      if (typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y) || (point.label !== 0 && point.label !== 1) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return null;
      points.push({ x: point.x, y: point.y, label: point.label });
    }
  }
  if (!box && !points?.some((point) => point.label === 1)) return null;
  return { ...(box ? { box } : {}), ...(points ? { points } : {}) };
}

export async function segmentStill(args: { image: Uint8Array; width: number; height: number; prompt: StillMaskPrompt; signal: AbortSignal; ffmpeg: string }): Promise<{ png: Uint8Array; area: number; ms: number }> {
  const { image, width, height, prompt, signal } = args;
  const startedAt = performance.now();
  if (width * height > STILL_MASK_MAX_PIXELS || Math.max(width, height) > STILL_MASK_MAX_SIDE) throw new Error(STILL_MASK_TOO_LARGE);
  const model = maskModelPath();
  if (!model || !maskEnvironmentReady()) throw new Error(CUTOUT_MODEL_MISSING);
  const root = join(process.env.STACK_DATA_DIR ?? "/tmp", "mask-still", randomUUID());
  const frames = join(root, "frames"), output = join(root, "masks");
  mkdirSync(frames, { recursive: true, mode: 0o700 }); mkdirSync(output, { recursive: true, mode: 0o700 });
  const source = join(root, "source.bin");
  const requestId = randomUUID();
  let lease: GovernorHandle | null = null;
  let queuedCancel: (() => void) | null = null;
  let child: MaskChild | null = null;
  try {
    writeFileSync(source, image);
    mkdirSync(frames, { recursive: true, mode: 0o700 });
    const id = `mask-${requestId}`;
    queuedCancel = () => withdraw(id);
    signal.addEventListener("abort", queuedCancel, { once: true });
    const admission = await admit({ id, role: "video", kind: "generator", class: "burst", requestedBytes: 6 * GB, measuredPeakBytes: 6 * GB });
    if ("refused" in admission) throw new Error(CUTOUT_NO_MEMORY);
    if ("queued" in admission) {
      const settled = await admission.admitted;
      if (signal.aborted) throw new Error("Cancelled.");
      if ("refused" in settled) throw new Error(CUTOUT_NO_MEMORY);
      lease = settled;
    } else lease = admission;
    signal.removeEventListener("abort", queuedCancel); queuedCancel = null;
    if (signal.aborted) throw new Error("Cancelled.");
    const processChild = Bun.spawn([maskPython(), await materializeMaskWorker()], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: maskWorkerEnv() }) as unknown as MaskChild;
    child = processChild;
    const stdin = processChild.stdin;
    const stdout = processChild.stdout;
    const stderrStream = processChild.stderr;
    const kill = () => { try { child?.kill("SIGTERM"); } catch { /* exited */ } };
    signal.addEventListener("abort", kill, { once: true });
    let stderr = ""; void new Response(stderrStream).text().then((text) => { stderr = text; });
    stdin.write(JSON.stringify({ id: requestId, op: "segment", input: source, width, height, frames_dir: frames, prompt, out_dir: output, model, config: MASK_CONFIG_NAME }) + "\n"); stdin.end();
    let buffer = "", ok = false;
    for await (const chunk of stdout) {
      buffer += new TextDecoder().decode(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const msg = JSON.parse(line) as { ok?: boolean; error?: string }; if (msg.ok) ok = true; if (msg.error) throw new Error(msg.error); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      }
    }
    const code = await processChild.exited;
    signal.removeEventListener("abort", kill);
    if (signal.aborted) throw new Error("Cancelled.");
    if (!ok || code !== 0) throw new Error(stderr || "SAM worker stopped without a result");
    const names = readdirSync(output).filter((name) => name.endsWith(".png"));
    if (names.length !== 1) throw new Error("SAM produced no mask.");
    const png = new Uint8Array(readFileSync(join(output, names[0]!)));
    if (!pngDimensions(png)) throw new Error("SAM mask size was invalid.");
    const measured = Bun.spawnSync([maskPython(), "-c", "from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert('L'); p=list(im.getdata()); print(sum(v >= 128 for v in p)/len(p))", join(output, names[0]!)], { env: maskWorkerEnv() });
    const area = Number(measured.stdout.toString().trim());
    if (measured.exitCode !== 0 || !Number.isFinite(area)) throw new Error("mask area unavailable");
    return { png, area: Math.max(0, Math.min(1, area)), ms: Math.round(performance.now() - startedAt) };
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof Error && [CUTOUT_NO_MEMORY, CUTOUT_MODEL_MISSING, STILL_MASK_TOO_LARGE].includes(error.message)) throw error;
    throw new Error(CUTOUT_FAILED);
  } finally {
    if (queuedCancel) { signal.removeEventListener("abort", queuedCancel); queuedCancel(); }
    try { child?.kill("SIGTERM"); } catch { /* exited */ }
    if (lease) release(lease);
    rmSync(root, { recursive: true, force: true });
  }
}

