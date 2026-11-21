// The VoxCPM2 voice engine's runtime (VOICE-VOXCPM2-01 step 1): its own Python environment (mlx-audio 0.6.4, the first line that
// ships the VoxCPM2 model; the Chatterbox environment stays on 0.5.9), assembled from the pinned uv and a hashed requirements file
// by the same builder as mlx-audio, and launched with the same server script, `mlx_tts_server.py --engine voxcpm2`, which speaks
// the Chatterbox wire (same form, chunked 24 kHz WAV). Nothing launches it yet: the supervisor, tiers and the setting come in step 2.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./voxcpm2.darwin-arm64.requirements.txt" with { type: "file" };
import serverScript from "./mlx_tts_server.py" with { type: "file" };
import engineGuardScript from "./engine_guard.py" with { type: "file" };
import streamScript from "./voxcpm_stream.py" with { type: "file" };

export const VOXCPM2_RUNTIME_NAME = "voxcpm2";
export const VOXCPM2_RUNTIME_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === VOXCPM2_RUNTIME_NAME)?.version ?? "1.0.0";
export const VOXCPM2_ENGINE_ID = "voxcpm2";

/** The hashed requirements file for this platform; MLX is Apple silicon only, so any other platform has none. */
export function voxcpm2RequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

export function voxcpm2Root(): string { return engineTagRoot(VOXCPM2_RUNTIME_NAME, VOXCPM2_RUNTIME_VERSION); }
export function voxcpm2Venv(): string { return uvVenvPath(voxcpm2Root()); }
export function voxcpm2Python(): string { return join(voxcpm2Venv(), "bin", "python"); }
/** The package's own VoxCPM2 model code: proof the sync finished with a version that has it. */
export function voxcpm2Proof(): string { return join(voxcpm2Venv(), "lib", "python3.12", "site-packages", "mlx_audio", "tts", "models", "voxcpm2", "voxcpm2.py"); }

function spec(): UvEnvironmentSpec {
  return { name: VOXCPM2_RUNTIME_NAME, version: VOXCPM2_RUNTIME_VERSION, root: voxcpm2Root(), requirements: voxcpm2RequirementsFileFor(), proof: voxcpm2Proof() };
}
export function voxcpm2Installed(): boolean { return uvEnvironmentReady(spec()); }
export function ensureVoxcpm2Environment(onProgress: (label: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  return ensureUvEnvironment(spec(), onProgress, options);
}

/** The server script, its launch-key guard and the streaming wrapper on the real disk (Python cannot open Bun's embedded copies),
 * rewritten at every launch so they always match the Stack. Returns the server script's path. */
export async function materializeVoxcpm2Server(root = voxcpm2Root()): Promise<string> {
  const files: Array<[string, string]> = [["mlx_tts_server.py", serverScript], ["engine_guard.py", engineGuardScript], ["voxcpm_stream.py", streamScript]];
  for (const [name, source] of files) {
    const target = join(root, name);
    writeFileSync(target, await Bun.file(source).text());
    chmodSync(target, 0o644);
  }
  return join(root, "mlx_tts_server.py");
}

/** The command that starts the engine: the VoxCPM2 environment's Python, the shared server script, the hub-cache repo (4-bit or bf16). */
export function voxcpm2Command(script: string, port: number, repo: string): string[] {
  return [voxcpm2Python(), script, "--host", "127.0.0.1", "--port", String(port), "--engine", VOXCPM2_ENGINE_ID, "--repo", repo];
}
