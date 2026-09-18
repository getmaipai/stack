// MaiPai Stack's pinned llama-server builds.
// Binaries arrive through verified downloads and never live in the repo.
import type { HardwareInfo } from "@/lib/hardware";

export interface EngineArchive {
  label: string;
  url: string;
  sha256: string;
  approxBytes: number;
}

export interface EngineBinaryPin {
  id: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  requiresNvidia: boolean;
  label: string;
  archive: EngineArchive;
  extraArchives?: EngineArchive[];
  verified: boolean;
}

export const ENGINE_BINARIES: EngineBinaryPin[] = [
  {
    id: "llama-server-b10797-macos-arm64",
    platform: "darwin",
    arch: "arm64",
    requiresNvidia: false,
    label: "llama-server (macOS, Apple Silicon, Metal), build b10797",
    archive: {
      label: "llama-server (macOS arm64)",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10797/llama-b10797-bin-macos-arm64.tar.gz",
      sha256: "474a788ec73d17a066360b1c50c9733c78a47d062616e91963c65a344548e889",
      approxBytes: 11_108_860,
    },
    verified: true,
  },
  {
    id: "llama-server-b10797-win-cuda-x64",
    platform: "win32",
    arch: "x64",
    requiresNvidia: true,
    label: "llama-server (Windows, NVIDIA CUDA 12.4, x64), build b10797",
    archive: {
      label: "llama-server (Windows CUDA x64)",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10797/llama-b10797-bin-win-cuda-12.4-x64.zip",
      sha256: "98d9195ea691f284c1eb8723e28e9ea0efc0adcacc7f082d5f8732491766b8c9",
      approxBytes: 253_916_914,
    },
    extraArchives: [{
      label: "CUDA 12.4 runtime (cudart)",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b10797/cudart-llama-bin-win-cuda-12.4-x64.zip",
      sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
      approxBytes: 391_443_627,
    }],
    verified: false,
  },
];

export const ENGINE_READY_MARKER = ".engine-ready";
export const DETECTED_ENGINE_VERSION_FLOORS: Record<string, string> = { ollama: "0.5.0", "lm-studio": "0.3.0", comfyui: "0.3.0", "mlx-serve": "0.1.0", omlx: "0.1.0", "llama-server": "b10797" };

export function selectEngineBinary(hw: HardwareInfo): EngineBinaryPin | null {
  return ENGINE_BINARIES.find(
    (pin) => pin.platform === hw.platform && pin.arch === hw.arch && (!pin.requiresNvidia || hw.cudaDevices.length > 0),
  ) ?? null;
}
