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
  /** The engine name and the upstream build tag: the store's directory
   * is `engines/<name>/<tag>`, and the Catalog's engine index names the
   * same tag, so installed and available compare directly. */
  name: string;
  tag: string;
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  requiresNvidia: boolean;
  label: string;
  docsUrl?: string;
  archive: EngineArchive;
  extraArchives?: EngineArchive[];
  verified: boolean;
}

export const ENGINE_BINARIES: EngineBinaryPin[] = [
  {
    id: "llama-server-b10797-macos-arm64",
    name: "llama-server",
    tag: "b10797",
    platform: "darwin",
    arch: "arm64",
    requiresNvidia: false,
    label: "llama-server (macOS, Apple Silicon, Metal), build b10797",
    docsUrl: "https://github.com/ggml-org/llama.cpp/tree/b10797/docs",
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
    name: "llama-server",
    tag: "b10797",
    platform: "win32",
    arch: "x64",
    requiresNvidia: true,
    label: "llama-server (Windows, NVIDIA CUDA 12.4, x64), build b10797",
    docsUrl: "https://github.com/ggml-org/llama.cpp/tree/b10797/docs",
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

/** Runtimes that ship inside the Stack's own dependencies (package.json
 * and the lockfile) rather than as a downloaded build: their version
 * rides the Stack's release and the monthly dependency sweep, never the
 * engine index. The components inventory reads the version from
 * package.json so there is one definition. */
export interface BundledRuntime { name: string; roles: string[]; platforms: string; }
export const BUNDLED_RUNTIMES: BundledRuntime[] = [
  { name: "sherpa-onnx-node", roles: ["stt"], platforms: "macOS arm64 and x64, Linux arm64 and x64, Windows x64 (upstream's platform packages)" },
];

/** One definition of how a pin id names its engine and tag: a shipped
 * pin says so itself; a staged pin (`<name>-<tag>`, the tag starting
 * with the upstream build number) is split at its first `-b<digits>`. */
export function engineNameTag(id: string): { name: string; tag: string } {
  const pin = ENGINE_BINARIES.find((candidate) => candidate.id === id);
  if (pin) return { name: pin.name, tag: pin.tag };
  const match = id.match(/^(.*?)-(b\d+.*)$/);
  return match ? { name: match[1]!, tag: match[2]! } : { name: id, tag: "legacy" };
}
export const DETECTED_ENGINE_VERSION_FLOORS: Record<string, string> = { ollama: "0.5.0", "lm-studio": "0.3.0", comfyui: "0.3.0", "mlx-serve": "0.1.0", omlx: "0.1.0", "llama-server": "b10797" };

export function selectEngineBinary(hw: HardwareInfo): EngineBinaryPin | null {
  return ENGINE_BINARIES.find(
    (pin) => pin.platform === hw.platform && pin.arch === hw.arch && (!pin.requiresNvidia || hw.cudaDevices.length > 0),
  ) ?? null;
}

export function installedEnginePin(): EngineBinaryPin | null {
  return ENGINE_BINARIES.find((pin) => pin.platform === process.platform && pin.arch === process.arch && !pin.requiresNvidia) ?? null;
}
