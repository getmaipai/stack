// VIDEO-GEN-12 (gate half): which pictures this Stack itself made. A clip may
// start from a reference picture only when the picture is one the Stack's own
// image generator produced (or the poster of one of its own clips); a photo of
// a household member, or of any real person, can only arrive as an upload, and
// an upload is refused for every caller until a check for "no identifiable real
// person" exists (owner ruling, 2026-10-17, VIDEO-GEN-12). The ledger holds a
// sha256 and a time per picture, never the picture, the prompt or a name, for
// thirty days and the newest two thousand. It lives beside the video results.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

const MAX_ENTRIES = 2000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const path = (): string => join(dataDir, "video", "generated-images.json");
let cache: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (cache) return cache;
  const map = new Map<string, number>();
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as { images?: Array<[string, number]> };
    const cutoff = Date.now() - KEEP_MS;
    for (const [hash, at] of parsed.images ?? []) if (typeof hash === "string" && typeof at === "number" && at >= cutoff) map.set(hash, at);
  } catch { /* no ledger yet */ }
  cache = map;
  return map;
}

function save(map: Map<string, number>): void {
  try {
    mkdirSync(join(dataDir, "video"), { recursive: true, mode: 0o700 });
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
    const temp = `${path()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ images: entries }), { mode: 0o600 });
    renameSync(temp, path());
  } catch { /* a ledger that cannot be written only means a later reference is refused, never accepted */ }
}

export function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Called with the bytes of every picture the Stack's image generator returns. */
export function recordGeneratedImage(bytes: Uint8Array): void {
  const map = load();
  map.set(sha256Hex(bytes), Date.now());
  save(map);
}

export function wasGeneratedHere(bytes: Uint8Array): boolean { return load().has(sha256Hex(bytes)); }

export function __resetProvenanceForTests(): void { cache = null; }
