// MaiPai Stack's pinned engine builds: llama-server, gguf-parser, and uv (the tool
// that assembles Pocket TTS's environment, STACK-94c). Binaries arrive
// through verified downloads and never live in the repo. The pin tables are
// data in src/rows/engineCatalog.json; this file keeps the shapes and the helpers.
import { H3_ENGINE_ENTRY } from "@/packs/h3/engineEntry";
import type { HardwareInfo } from "@/lib/hardware";
import data from "@/rows/engineCatalog.json";

export interface EngineArchive {
  label: string;
  url: string;
  sha256: string;
  githubDigest?: string;
  approxBytes: number;
  /** When set, the download is a single executable, stored in the engine directory under this name instead of being extracted. */
  rawFileName?: string;
}

export interface EngineBinaryPin {
  id: string;
  /** The engine name and the upstream build tag: the store's directory
   * is `engines/<name>/<tag>`, and the Catalog's engine index names the
   * same tag, so installed and available compare directly. */
  name: string;
  tag: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  /** The executable inside the extracted archive that proves the
   * install and is launched; `llama-server` when not named. */
  tool?: string;
  requiresNvidia: boolean;
  label: string;
  docsUrl?: string;
  archive: EngineArchive;
  extraArchives?: EngineArchive[];
  verified: boolean;
}

/** Every pinned build, including the three pins named below (mlx-serve, splash, splash-chat), which the rows file carries in place of the old pushes. */
export const ENGINE_BINARIES: EngineBinaryPin[] = data.binaries as unknown as EngineBinaryPin[];

/** A single pin is the very row in ENGINE_BINARIES that carries its id, so callers comparing by reference see one object, as the old pushes gave them. */
const pinRow = (pin: EngineBinaryPin): EngineBinaryPin => ENGINE_BINARIES.find((candidate) => candidate.id === pin.id) ?? pin;

/** The second chat engine (STACK-93): one archive with the binary and
 * its libraries, the same shape as llama-server's. */
export const MLX_SERVE_PIN: EngineBinaryPin = pinRow(data.mlxServe as unknown as EngineBinaryPin);

/** The coding role's fast engine on Apple silicon (CODE-STACK-01 S5a): Inco's Splash, Apache-2.0. The release archive is a Python
 * program with its own bundled interpreter (`python/`), a native engine (`engine/splash`) and the launcher
 * (`install/launcher.py`), wrapped in one top folder that the installer flattens; `engine/splash` proves the install. The url,
 * checksum and size were taken from the vendor's GitHub release 1.7.0 (asset `splash-1.7.0-arm64-macos26.tar.gz`, sha256 matching the release's
 * published `.sha256` asset), verified by download on 2026-11-17; 1.6.1's came from the Catalog's `engines/index.json` entry (CODE-STACK-01 C1). The floors and
 * defaults Splash needs from the machine are data in `engines/splash/engine.json`, not here. Splash is only ever started offline, from files the Stack pinned and laid out itself (lib/splash.ts). */
export const SPLASH_PIN: EngineBinaryPin = pinRow(data.splash as unknown as EngineBinaryPin);

/** Chat's opt-in Splash build: the same vendor 1.7.0 archive as `SPLASH_PIN`, under its own engine name so the chat and coding roles install and report separately. */
export const SPLASH_CHAT_PIN: EngineBinaryPin = pinRow(data.splashChat as unknown as EngineBinaryPin);

/** The coding role's engines, one chosen by `stack.engines.coding.engine`. */
export const CODING_ENGINES = ["llama-server", "splash"] as const;
export type CodingEngine = typeof CODING_ENGINES[number];

/** The chat wire's engines, one chosen by `stack.engines.chat.engine`. */
export const CHAT_ENGINES = ["llama-server", "mlx-serve", "omlx", "splash"] as const;
export type ChatEngine = typeof CHAT_ENGINES[number];

/** The role each engine name serves, for the routes that act on "the
 * engine's role" (start, stop, restart, the swap's drain). */
export type EngineRole = "chat" | "coding" | "tts" | "image" | "video" | "music";
export const ENGINE_ROLE: Record<string, EngineRole> = { "llama-server": "chat", splash: "coding", "splash-chat": "chat", "mlx-serve": "chat", omlx: "chat", uv: "tts", "pocket-tts": "tts", "mlx-audio": "tts", voxcpm2: "tts", "voxcpm2-reduced": "tts", "voxcpm2-stt": "tts", "recorded-speech": "tts", comfyui: "image", "video-gen": "video", "ltx25-gen": "video", "ltx25-max-gen": "video", [H3_ENGINE_ENTRY.name]: "video", "mask-gen": "video", "composite-swap": "video", liveportrait: "image", "music-gen": "music", "sfx-gen": "music", "score-gen": "music", "stems": "music", align: "music", beats: "music", "voice-convert": "music", "image-gen": "image", "h3-image-gen": "image" };
export function engineRole(name: string): EngineRole { return ENGINE_ROLE[name] ?? "chat"; }

/** Runtimes the Stack assembles from pinned wheels through uv, in an
 * environment under data/engines/<name>/<version>/ (STACK-94c). */
export interface ManagedRuntime { name: string; version: string; roles: string[]; platforms: string; }
export const MANAGED_RUNTIMES: ManagedRuntime[] = data.managedRuntimes as unknown as ManagedRuntime[];

export const ENGINE_READY_MARKER = ".engine-ready";

/** Runtimes that ship inside the Stack's own dependencies (package.json
 * and the lockfile) rather than as a downloaded build: their version
 * rides the Stack's release and the monthly dependency sweep, never the
 * engine index. The components inventory reads the version from
 * package.json so there is one definition. */
export interface BundledRuntime { name: string; roles: string[]; platforms: string; }
export const BUNDLED_RUNTIMES: BundledRuntime[] = data.bundledRuntimes as unknown as BundledRuntime[];

/** One definition of how a pin id names its engine and tag: a shipped
 * pin says so itself; staged pins accept upstream build tags and semver tags. */
export function engineNameTag(id: string): { name: string; tag: string } {
  const pin = ENGINE_BINARIES.find((candidate) => candidate.id === id);
  if (pin) return { name: pin.name, tag: pin.tag };
  const versioned = id.match(/^(.*?)-(\d+\.\d+\.\d+(?:[-+].*)?)$/);
  if (versioned) return { name: versioned[1]!, tag: versioned[2]! };
  const match = id.match(/^(.*?)-((?:b\d+.*)|(?:\d+\.\d+\.\d+(?:[-+].*)?))$/);
  return match ? { name: match[1]!, tag: match[2]! } : { name: id, tag: "legacy" };
}
export const DETECTED_ENGINE_VERSION_FLOORS: Record<string, string> = { ollama: "0.5.0", "lm-studio": "0.3.0", comfyui: "0.3.0", "mlx-serve": "0.1.0", omlx: "0.1.0", "llama-server": "b10797" };

/** The pin of one engine for a machine; the name filter keeps a uv pin
 * from ever being launched as llama-server. */
export function selectEngineBinary(hw: HardwareInfo, name = "llama-server"): EngineBinaryPin | null {
  return ENGINE_BINARIES.find(
    (pin) => pin.name === name && pin.platform === hw.platform && pin.arch === hw.arch && (!pin.requiresNvidia || hw.cudaDevices.length > 0),
  ) ?? null;
}

export function installedEnginePin(name = "llama-server"): EngineBinaryPin | null {
  return ENGINE_BINARIES.find((pin) => pin.name === name && pin.platform === process.platform && pin.arch === process.arch && (!pin.requiresNvidia || process.platform === "linux")) ?? null;
}
