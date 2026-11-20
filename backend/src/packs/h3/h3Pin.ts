import { createReadStream, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { engineTagRoot } from "@/lib/store/layout";
import { H3_VIDEO_VERSION } from "@/video/h3";
import { H3_PINNED_FILES, type H3PinFile } from "./h3Pins";
export { H3_PINNED_FILES } from "./h3Pins";

export interface H3PinResult { state: "pinned" | "adopted_existing" | "existing_unverified" | "missing"; matched: string[]; mismatched: string[]; absent: string[]; unpublished_local: string[]; }
const hashCache = new Map<string, string>();
function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
export async function h3PinStatus(home = process.env.MAIPAI_H3_VIDEO_HOME || engineTagRoot("minimax-h3-video-gen", H3_VIDEO_VERSION), files: readonly H3PinFile[] = H3_PINNED_FILES, options: { hashes?: boolean } = {}): Promise<H3PinResult> {
  // `hashes: false` is the cheap look the parts list takes: sizes and any hash already computed in this process; a big file is never read just to list parts.
  const hashing = options.hashes !== false;
  const fromVariable = !!process.env.MAIPAI_H3_VIDEO_HOME && home === process.env.MAIPAI_H3_VIDEO_HOME;
  const models = join(home, "models/minimax_h3");
  const matched: string[] = [], mismatched: string[] = [], absent: string[] = [], unchecked: string[] = [];
  for (const file of files) {
    const path = join(models, file.local);
    if (!existsSync(path)) { absent.push(file.local); continue; }
    const stat = statSync(path);
    if (stat.size !== file.bytes) { mismatched.push(file.local); continue; }
    const key = `${path}:${stat.size}:${stat.mtimeMs}`;
    let hash = hashCache.get(key);
    if (!hash && !hashing) { unchecked.push(file.local); continue; }
    if (!hash) { hash = await sha256(path); hashCache.set(key, hash); }
    (hash === file.sha256 ? matched : mismatched).push(file.local);
  }
  const state = absent.length || mismatched.length || unchecked.length ? (existsSync(home) ? "existing_unverified" : "missing") : fromVariable ? "adopted_existing" : "pinned";
  return { state, matched, mismatched, absent, unpublished_local: ["transformers/4-bit-pruned-stream2", "loras/minimax_h3_turbo_v4_step600_ema.safetensors"] };
}
