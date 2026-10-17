// oMLX as the chat engine on Apple silicon (ENGINE-MLX-01). The Python
// environment the Stack assembles from a pinned uv and one hashed
// requirements file under data/engines/omlx/<version>/ (the same builder
// as Pocket TTS, Chatterbox and ComfyUI), and the command that serves the
// pinned MLX weights on loopback. The measurements behind the choice are
// in Home's docs/design/chat-engine-comparison-2026-10-17.md.
//
// What the Stack decides, not the engine:
//  - loopback only, a random API key per launch (the engine also serves an
//    admin dashboard on the same port; without the key it is closed);
//  - offline always: no Hugging Face calls, no update check, no token;
//  - its prompt cache lives in a directory of its own under the Stack's
//    data and is emptied at every launch, so a conversation's cached
//    state never outlives the engine process (llama-server's lives in RAM
//    and dies with it; this is the same promise).
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, macosMajor, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./omlx.darwin-arm64.requirements.txt" with { type: "file" };

export const OMLX_NAME = "omlx";
export const OMLX_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === OMLX_NAME)?.version ?? "0.7.0";
/** The wheel oMLX ships is tagged macOS 15; uv refuses it on an older Mac, so the engine is not offered there. */
export const OMLX_MACOS_FLOOR = 15;
/** The longest prompt cache the engine may keep on disk. */
export const OMLX_CACHE_MAX = "20GB";
/** Requests the engine runs at once; llama-server's automatic slot count on the same Mac was 4. */
export const OMLX_MIN_CONCURRENT = 4;

/** The hashed requirements file for this platform; MLX is Apple silicon only. */
export function omlxRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

export function omlxRoot(): string { return engineTagRoot(OMLX_NAME, OMLX_VERSION); }
export function omlxVenv(): string { return uvVenvPath(omlxRoot()); }
export function omlxBinary(): string { return join(omlxVenv(), "bin", "omlx"); }
export function omlxStateDir(): string { return join(omlxRoot(), "state"); }
export function omlxCacheDir(): string { return join(omlxStateDir(), "cache"); }
export function omlxModelsDir(): string { return join(omlxStateDir(), "models"); }

/** Whether this Mac can run the engine at all: Apple silicon on macOS 15 or later. */
export function omlxSupportedHere(platform = process.platform, arch = process.arch, macos: number | null = macosMajor()): { ok: boolean; reason: string | null } {
  if (platform !== "darwin" || arch !== "arm64") return { ok: false, reason: "oMLX runs on Apple silicon Macs only." };
  if (macos !== null && macos < OMLX_MACOS_FLOOR) return { ok: false, reason: `oMLX needs macOS ${OMLX_MACOS_FLOOR} or later (this Mac runs ${macos}).` };
  return { ok: true, reason: null };
}

export function omlxInstalled(): boolean { return uvEnvironmentReady({ name: OMLX_NAME, version: OMLX_VERSION, root: omlxRoot(), proof: omlxBinary() }); }

function spec(): UvEnvironmentSpec {
  return { name: OMLX_NAME, version: OMLX_VERSION, root: omlxRoot(), requirements: omlxRequirementsFileFor(), proof: omlxBinary() };
}

export function ensureOmlxEnvironment(onProgress: (label: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  const supported = omlxSupportedHere();
  if (!supported.ok) return Promise.reject(new Error(supported.reason ?? "oMLX is not available here."));
  return ensureUvEnvironment(spec(), onProgress, options);
}

/** A key for one launch. It lives in this process's memory and in the
 * engine's command line (readable only by this user's processes), never
 * in the settings store or a log. */
export function newLaunchKey(): string { return randomBytes(24).toString("base64url"); }

/** The directory oMLX serves as its model folder: one entry, the pinned
 * MLX weights, linked under the name the engine will report. Rebuilt at
 * every launch so a removed model leaves nothing behind. */
export function prepareModelFolder(modelPath: string): { folder: string; modelId: string } {
  const folder = omlxModelsDir();
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const modelId = basename(modelPath);
  symlinkSync(modelPath, join(folder, modelId));
  return { folder, modelId };
}

/** Empties the engine's prompt cache and settings state and recreates the folders. */
export function resetState(): string {
  const state = omlxStateDir();
  rmSync(omlxCacheDir(), { recursive: true, force: true });
  mkdirSync(omlxCacheDir(), { recursive: true, mode: 0o700 });
  return state;
}

export interface OmlxLaunchOptions { port: number; modelFolder: string; apiKey: string; concurrent: number }

export function omlxCommand(options: OmlxLaunchOptions): string[] {
  return [
    omlxBinary(), "serve",
    "--model-dir", options.modelFolder,
    "--base-path", omlxStateDir(),
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--api-key", options.apiKey,
    "--no-hf-cache",
    "--paged-ssd-cache-dir", omlxCacheDir(),
    "--paged-ssd-cache-max-size", OMLX_CACHE_MAX,
    "--max-concurrent-requests", String(Math.max(OMLX_MIN_CONCURRENT, options.concurrent)),
    "--log-level", "warning",
  ];
}

/** Offline always, no token, no analytics, quiet progress bars, unbuffered output (the Stack reads stderr only when the engine exits). */
export function omlxEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = managedEnv({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", TQDM_DISABLE: "1", PYTHONUNBUFFERED: "1", ...extra });
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  delete env.HF_HUB_ETAG_TIMEOUT;
  return env;
}

/** Test and tooling seam: write a file with owner-only mode. */
export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}
