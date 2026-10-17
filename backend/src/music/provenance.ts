// MUSIC-GEN-02: which songs this Stack itself made. A song may be changed
// (covered, repainted, extended, trimmed) only when its bytes are a file this
// Stack wrote; a recording a person brought can only arrive as an upload, and
// an upload is refused for every caller (Home's note, section 9: no voice of a
// real person, and no uploaded audio at all in v1; the same rule as the video
// reference pictures, video/provenance.ts). The ledger holds a sha256 and a
// time per song, never the song, the description, the lyrics or a name, for
// thirty days and the newest two thousand. It lives beside the music results.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@/lib/paths";

const MAX_ENTRIES = 2000;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const path = (): string => join(dataDir, "music", "made-here.json");
let cache: Map<string, number> | null = null;

function load(): Map<string, number> {
  if (cache) return cache;
  const map = new Map<string, number>();
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as { songs?: Array<[string, number]> };
    const cutoff = Date.now() - KEEP_MS;
    for (const [hash, at] of parsed.songs ?? []) if (typeof hash === "string" && typeof at === "number" && at >= cutoff) map.set(hash, at);
  } catch { /* no ledger yet */ }
  cache = map;
  return map;
}

function save(map: Map<string, number>): void {
  try {
    mkdirSync(join(dataDir, "music"), { recursive: true, mode: 0o700 });
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
    const temp = `${path()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ songs: entries }), { mode: 0o600 });
    renameSync(temp, path());
  } catch { /* a ledger that cannot be written only means a later source is refused, never accepted */ }
}

export function sha256Hex(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Called with the bytes of every song file the Stack writes (a made song and an edited one). */
export function recordMadeSong(bytes: Uint8Array): string {
  const hash = sha256Hex(bytes);
  const map = load();
  map.set(hash, Date.now());
  save(map);
  return hash;
}

export function wasMadeHere(bytes: Uint8Array): boolean { return load().has(sha256Hex(bytes)); }

export function __resetMusicProvenanceForTests(): void { cache = null; }
