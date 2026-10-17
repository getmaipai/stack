// The MLX voice runtime as a managed engine (VOICE-STUDIO-01): the
// Python environment the Stack assembles from a pinned uv and a hashed
// requirements file under data/engines/mlx-audio/<version>/, and the
// small server (`mlx_tts_server.py`) that speaks Pocket TTS's wire on
// top of it, so Home's voice session is unchanged. Chatterbox Turbo is
// the first model it serves; Orpheus is a later class in the same
// script. Like Pocket TTS it runs offline always: the Stack placed
// every file in the hub cache and the engine asks Hugging Face for
// nothing. The environment is the same builder as Pocket TTS and
// ComfyUI (`uvEnvironment.ts`).
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./mlx-audio.darwin-arm64.requirements.txt" with { type: "file" };
import serverScript from "./mlx_tts_server.py" with { type: "file" };

export const MLX_AUDIO_NAME = "mlx-audio";
export const MLX_AUDIO_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === MLX_AUDIO_NAME)?.version ?? "0.5.9";

/** The hashed requirements file for this platform; MLX is Apple silicon
 * only, so any other platform has none and says so. */
export function mlxRequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

export function mlxAudioRoot(): string { return engineTagRoot(MLX_AUDIO_NAME, MLX_AUDIO_VERSION); }
export function mlxAudioVenv(): string { return uvVenvPath(mlxAudioRoot()); }
export function mlxAudioPython(): string { return join(mlxAudioVenv(), "bin", "python"); }
/** A console script the package installs: proof the sync finished. */
export function mlxAudioProof(): string { return join(mlxAudioVenv(), "bin", "mlx_audio.tts.generate"); }
export function mlxAudioInstalled(): boolean { return uvEnvironmentReady({ name: MLX_AUDIO_NAME, version: MLX_AUDIO_VERSION, root: mlxAudioRoot(), proof: mlxAudioProof() }); }

function spec(): UvEnvironmentSpec {
  return { name: MLX_AUDIO_NAME, version: MLX_AUDIO_VERSION, root: mlxAudioRoot(), requirements: mlxRequirementsFileFor(), proof: mlxAudioProof() };
}

export function ensureMlxAudioEnvironment(onProgress: (label: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  return ensureUvEnvironment(spec(), onProgress, options);
}

/** The server script on the real disk (in the compiled daemon the
 * embedded copy lives in Bun's virtual filesystem, which Python cannot
 * open): rewritten at every launch so the script always matches the Stack. */
export async function materializeServerScript(root = mlxAudioRoot()): Promise<string> {
  const target = join(root, "mlx_tts_server.py");
  writeFileSync(target, await Bun.file(serverScript).text());
  chmodSync(target, 0o644);
  return target;
}

/** Offline always, no token, quiet progress bars (the Stack reads stderr only when the engine exits). */
export function mlxAudioEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = managedEnv({ HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_PROGRESS_BARS: "1", TQDM_DISABLE: "1", PYTHONUNBUFFERED: "1", ...extra });
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  delete env.HF_HUB_ETAG_TIMEOUT;
  return env;
}

export function mlxAudioCommand(script: string, port: number, engine: string, repo: string): string[] {
  return [mlxAudioPython(), script, "--host", "127.0.0.1", "--port", String(port), "--engine", engine, "--repo", repo];
}
