// Pocket TTS as a managed engine (STACK-94c): the environment the Stack
// assembles from a pinned uv and a hashed requirements file under
// data/engines/pocket-tts/<version>/, the command that serves it, the
// environment variables that keep every cache under data/, and the read
// of which weights the engine loaded. The engine's wire (spec/voice's
// /tts form and streaming WAV) is spoken by the supervisor's client;
// nothing here parses audio.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot, hfHubRoot, hfRepoName } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./pocket-tts.darwin-arm64.requirements.txt" with { type: "file" };

export const POCKET_TTS_NAME = "pocket-tts";
export const POCKET_TTS_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === POCKET_TTS_NAME)?.version ?? "3.1.0";
/** The weights repositories the package's config names: the gated one
 * when a token is set and accepted, the ungated twin otherwise. */
export const POCKET_TTS_GATED_REPO = "kyutai/pocket-tts";
export const POCKET_TTS_UNGATED_REPO = "kyutai/pocket-tts-without-voice-cloning";
/** What the engine holds resident with torch loaded, before the first
 * measurement replaces it (976 MB seen on the p16 laptop). */
export const POCKET_TTS_ESTIMATED_FOOTPRINT = 1_073_741_824;

/** The hashed requirements file for this platform, compiled with
 * `uv pip compile --generate-hashes` on that platform; a platform with
 * none yet cannot build the environment and says so. */
export function requirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

export function pocketTtsRoot(): string { return engineTagRoot(POCKET_TTS_NAME, POCKET_TTS_VERSION); }
export function pocketTtsVenv(): string { return uvVenvPath(pocketTtsRoot()); }
export function pocketTtsBinary(): string { return join(pocketTtsVenv(), "bin", "pocket-tts"); }
export function pocketTtsInstalled(): boolean { return uvEnvironmentReady({ name: POCKET_TTS_NAME, version: POCKET_TTS_VERSION, root: pocketTtsRoot(), proof: pocketTtsBinary() }); }

/** The engine's environment: uv's homes and the hub cache under data/
 * (see `managedEnv`), and the hub offline always (STACK-94d): the
 * engine reads what the Stack placed in the cache and asks Hugging
 * Face for nothing, at start or on a request; the Stack fetches what
 * a request needs first (`speech/voices.ts`). No token travels: the
 * gated weights, when wanted, are fetched by the Stack. */
export function pocketTtsEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = managedEnv({ HF_HUB_OFFLINE: "1", ...extra });
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  delete env.HF_HUB_ETAG_TIMEOUT;
  return env;
}

function spec(): UvEnvironmentSpec {
  return { name: POCKET_TTS_NAME, version: POCKET_TTS_VERSION, root: pocketTtsRoot(), requirements: requirementsFileFor(), proof: pocketTtsBinary() };
}

/** Builds the environment once (uv, a managed Python, the hashed
 * requirements; one build in flight at a time). */
export function ensurePocketTtsEnvironment(onProgress: (label: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  return ensureUvEnvironment(spec(), onProgress, options);
}

export function pocketTtsCommand(port: number): string[] {
  return [pocketTtsBinary(), "serve", "--host", "127.0.0.1", "--port", String(port)];
}

/** Which weights repository the hub cache holds a snapshot of, the
 * gated one first when both are there (the engine's config tries it
 * first and, offline, finds it in the cache): what the engine loaded,
 * read after its health, not what the config hoped for. */
export function loadedWeightsRepo(options: { hubRoot?: string } = {}): { repo: string; revision: string } | null {
  const hub = options.hubRoot ?? hfHubRoot;
  const candidates = [POCKET_TTS_GATED_REPO, POCKET_TTS_UNGATED_REPO];
  for (const repo of candidates) {
    const snapshots = join(hub, hfRepoName(repo), "snapshots");
    if (!existsSync(snapshots)) continue;
    // The weights snapshot is the one that holds model.safetensors.
    for (const revision of readdirSync(snapshots)) {
      const languages = join(snapshots, revision, "languages");
      if (!existsSync(languages)) continue;
      for (const language of readdirSync(languages)) if (existsSync(join(languages, language, "model.safetensors"))) return { repo, revision };
    }
  }
  return null;
}
