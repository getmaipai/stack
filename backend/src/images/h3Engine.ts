// H3-IMAGE-STACK-01: the h3-image-gen engine, the environment MiniMax H3-Image runs in. Its own uv environment (PyPI
// h3-image-mlx 0.1.0a8, Python 3.12, hashed requirements) because its MLX (0.32.4) differs from mflux's. There is no worker and no
// source archive: the runner (images/h3Runner.ts) starts the package's console script once per picture. State and install go
// through the same engine routes and component units as the other engines.
import { join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { ensureUvEnvironment, uvEnvironmentReady, uvVenvPath, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import darwinArm64Requirements from "./h3-image.darwin-arm64.requirements.txt" with { type: "file" };

export const H3_GEN_NAME = "h3-image-gen";
export const H3_GEN_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === H3_GEN_NAME)?.version ?? "0.1.0a8";

export function h3RequirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}
export function h3GenRoot(): string { return engineTagRoot(H3_GEN_NAME, H3_GEN_VERSION); }
/** The package's console script; it exists once the environment is built, so it is the proof. */
export function h3GenBin(): string { return join(uvVenvPath(h3GenRoot()), "bin", "h3-image-mlx"); }
export function h3GenPython(): string { return uvVenvPython(h3GenRoot()); }
export function h3GenEnvironmentReady(): boolean { return uvEnvironmentReady({ name: H3_GEN_NAME, version: H3_GEN_VERSION, root: h3GenRoot(), proof: h3GenBin() }); }
function spec(): UvEnvironmentSpec { return { name: H3_GEN_NAME, version: H3_GEN_VERSION, root: h3GenRoot(), requirements: h3RequirementsFileFor(), proof: h3GenBin() }; }

/** The environment (first time only; a second caller joins the build). */
export function ensureH3GenEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!h3RequirementsFileFor()) throw new Error(`MiniMax H3-Image is not available on ${process.platform} ${process.arch} yet.`);
  return ensureUvEnvironment(spec(), onProgress, options);
}
