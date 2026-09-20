// Pocket TTS as a managed engine (STACK-94c): the environment the Stack
// assembles from a pinned uv and a hashed requirements file under
// data/engines/pocket-tts/<version>/, the command that serves it, the
// environment variables that keep every cache under data/, and the read
// of which weights the engine loaded. The engine's wire (spec/voice's
// /tts form and streaming WAV) is spoken by the supervisor's client;
// nothing here parses audio.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_READY_MARKER, installedEnginePin, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineBinaryPath, ensureEngine } from "@/lib/engineInstall";
import { dataDir } from "@/lib/paths";
import { engineTagRoot, hfHubRoot, hfRepoName } from "@/lib/store/layout";
import { writeEngineManifest } from "@/lib/store/manifests";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import darwinArm64Requirements from "./pocket-tts.darwin-arm64.requirements.txt" with { type: "file" };

export const POCKET_TTS_NAME = "pocket-tts";
export const POCKET_TTS_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === POCKET_TTS_NAME)?.version ?? "3.1.0";
export const POCKET_TTS_PYTHON = "3.12";
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
export function pocketTtsVenv(): string { return join(pocketTtsRoot(), "venv"); }
export function pocketTtsBinary(): string { return join(pocketTtsVenv(), "bin", "pocket-tts"); }
export function pocketTtsInstalled(): boolean { return existsSync(join(pocketTtsRoot(), ENGINE_READY_MARKER)) && existsSync(pocketTtsBinary()); }

/** uv's own homes, all under data/: the managed interpreter, the wheel
 * cache, and HOME so nothing a tool writes lands in the person's
 * account (Pocket TTS caches https voices under ~/.cache/pocket_tts,
 * the hub client under ~/.cache/huggingface). */
export function pocketTtsEnv(extra: Record<string, string> = {}): Record<string, string> {
  const home = join(dataDir, "home");
  // The daemon's own secrets never travel: the key that protects the
  // token stays with the daemon, only the token itself goes.
  const inherited = { ...process.env as Record<string, string> };
  for (const key of Object.keys(inherited)) if (key === "STACK_SECRETS_KEY" || key.startsWith("MAIPAI_SECRETS")) delete inherited[key];
  return {
    ...inherited,
    HOME: home,
    UV_PYTHON_INSTALL_DIR: join(dataDir, "engines", "uv", "python"),
    UV_CACHE_DIR: join(dataDir, "engines", "uv", "cache"),
    HF_HUB_CACHE: hfHubRoot,
    HF_HUB_DISABLE_TELEMETRY: "1",
    // The engine asks the hub for the gated weights at every start and
    // falls back to the pinned ungated file when refused; on a machine
    // with no connection that ask must fail fast, not wait ten seconds.
    HF_HUB_ETAG_TIMEOUT: "3",
    ...extra,
  };
}

async function run(command: string[], env: Record<string, string>, signal?: AbortSignal): Promise<void> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env });
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  signal?.removeEventListener("abort", abort);
  if (signal?.aborted) throw new Error("The environment build was cancelled.");
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited ${code}: ${(err || out).trim().split("\n").slice(-5).join(" | ")}`);
}

/** Builds the environment once: uv installed (a pinned engine build,
 * checksummed), a venv on a managed Python, the hashed requirements
 * synced, the ready marker written last. Progress is by phase, not by
 * bytes: uv reports none the job could read. */
let building: Promise<void> | null = null;
export function ensurePocketTtsEnvironment(onProgress: (label: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (pocketTtsInstalled()) return Promise.resolve();
  // One build at a time on one venv; a second caller waits on the first.
  building ??= buildPocketTtsEnvironment(onProgress, options).finally(() => { building = null; });
  return building;
}

async function buildPocketTtsEnvironment(onProgress: (label: string) => void, options: { signal?: AbortSignal }): Promise<void> {
  const requirements = requirementsFileFor();
  if (!requirements) throw new Error(`No hashed requirements file for ${process.platform} ${process.arch} yet; the tts environment cannot be built on this machine.`);
  const uvPin = installedEnginePin("uv");
  if (!uvPin) throw new Error(`No pinned uv build for ${process.platform} ${process.arch}.`);
  onProgress("uv");
  await ensureEngine(uvPin, () => {}, { signal: options.signal, activate: true });
  const uv = engineBinaryPath(uvPin);
  const root = pocketTtsRoot();
  const venv = pocketTtsVenv();
  rmSync(venv, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const env = pocketTtsEnv();
  onProgress("python");
  await run([uv, "venv", venv, "--python", POCKET_TTS_PYTHON], env, options.signal);
  onProgress("packages");
  await run([uv, "pip", "sync", "--python", join(venv, "bin", "python"), "--require-hashes", requirements], env, options.signal);
  if (!existsSync(pocketTtsBinary())) throw new Error("The environment built but pocket-tts is not in it.");
  writeFileSync(join(root, ENGINE_READY_MARKER), new Date().toISOString());
  writeEngineManifest({ kind: "engine", name: POCKET_TTS_NAME, tag: POCKET_TTS_VERSION, assetUrl: `requirements:${requirements.split("/").pop()}`, sizeBytes: 0, githubDigest: "", sha256: "", extractedAt: new Date().toISOString(), blobs: [] });
  bumpStackGeneration(`engine ${POCKET_TTS_NAME} environment built at ${POCKET_TTS_VERSION}`);
}

export function pocketTtsCommand(port: number): string[] {
  return [pocketTtsBinary(), "serve", "--host", "127.0.0.1", "--port", String(port)];
}

/** Which weights repository the hub cache holds a snapshot of, gated
 * first when a token is set: what the engine loaded, read after its
 * health, not what the config hoped for. */
export function loadedWeightsRepo(options: { tokenSet: boolean; hubRoot?: string } = { tokenSet: false }): { repo: string; revision: string } | null {
  const hub = options.hubRoot ?? hfHubRoot;
  const candidates = options.tokenSet ? [POCKET_TTS_GATED_REPO, POCKET_TTS_UNGATED_REPO] : [POCKET_TTS_UNGATED_REPO, POCKET_TTS_GATED_REPO];
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
