// VIDEO-MASK-01: optional SAM 2.1 video subject tracking component.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureEngine } from "@/lib/engineInstall";
import { installedEnginePin, MANAGED_RUNTIMES, selectEngineBinary } from "@/lib/engineCatalog";
import { detectHardware } from "@/lib/hardware";
import { getModel } from "@/lib/modelStore";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPath, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import { engineTagRoot } from "@/lib/store/layout";
import requirements from "./mask-gen.darwin-arm64.requirements.txt" with { type: "file" };
import worker from "./mask_worker.py" with { type: "file" };
export const MASK_GEN_NAME = "mask-gen";
export const MASK_GEN_VERSION = MANAGED_RUNTIMES.find((r) => r.name === MASK_GEN_NAME)?.version ?? "2b90b9f";
export const MASK_MODEL_ID = "sam2.1-hiera-small";
export const MASK_PEAK_BYTES = 6_000_000_000;
export function maskRequirementsFileFor(platform = process.platform, arch = process.arch): string | null { return platform === "darwin" && arch === "arm64" ? requirements : null; }
export function maskGenRoot(): string { return engineTagRoot(MASK_GEN_NAME, MASK_GEN_VERSION); }
export function maskGenProof(): string { return join(maskGenRoot(), "venv", "lib", "python3.12", "site-packages", "torch", "__init__.py"); }
function spec(): UvEnvironmentSpec { return { name: MASK_GEN_NAME, version: MASK_GEN_VERSION, root: maskGenRoot(), requirements: maskRequirementsFileFor(), proof: maskGenProof() }; }
export function maskEnvironmentReady(): boolean { return existsSync(join(maskGenRoot(), "sam2", "__init__.py")) && uvEnvironmentReady(spec()); }
export async function ensureMaskEnvironment(onProgress: (phase: string) => void = () => {}, signal?: AbortSignal): Promise<void> {
  if (!maskRequirementsFileFor()) throw new Error(`SAM 2.1 video masks are not available on ${process.platform} ${process.arch} yet.`);
  const pin = installedEnginePin(MASK_GEN_NAME) ?? selectEngineBinary(await detectHardware(), MASK_GEN_NAME);
  if (!pin) throw new Error("No pinned SAM 2.1 source exists for this computer.");
  if (!existsSync(join(maskGenRoot(), "sam2", "__init__.py")) || !existsSync(join(maskGenRoot(), ".engine-ready"))) await ensureEngine(pin, () => {}, { signal, activate: true });
  await ensureUvEnvironment(spec(), onProgress, { signal });
}
export function maskWorkerEnv(): Record<string, string> { const env = managedEnv({ PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: maskGenRoot(), SAM2_BUILD_CUDA: "0", PYTORCH_ENABLE_MPS_FALLBACK: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }); delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN; return env; }
export function maskModelPath(): string | null { const model = getModel(MASK_MODEL_ID); return model?.modelPath && model.verifiedAt && existsSync(model.modelPath) ? model.modelPath : null; }
export function maskPython(): string { return join(uvVenvPath(maskGenRoot()), "bin", "python"); }
export function maskConfigPath(): string { return join(maskGenRoot(), "configs", "sam2.1", "sam2.1_hiera_s.yaml"); }
/** The worker script as a real file. In the compiled Stack the embedded asset path is a virtual `/$bunfs/...` path that Python cannot open (found 2026-11-06 on the first live cutout), so it is written under the engine folder first, as the other engines do. */
export async function materializeMaskWorker(): Promise<string> {
  const root = maskGenRoot();
  mkdirSync(root, { recursive: true });
  const target = join(root, "mask_worker.py");
  writeFileSync(target, await Bun.file(worker).text());
  return target;
}
export { worker as maskWorkerScript };
