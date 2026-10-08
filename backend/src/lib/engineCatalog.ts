// MaiPai Stack's pinned engine builds: llama-server, gguf-parser, and uv (the tool
// that assembles Pocket TTS's environment, STACK-94c). Binaries arrive
// through verified downloads and never live in the repo.
import type { HardwareInfo } from "@/lib/hardware";

export interface EngineArchive {
  label: string;
  url: string;
  sha256: string;
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

export const ENGINE_BINARIES: EngineBinaryPin[] = [
  {
    id: "gguf-parser-v0.26.4-macos-arm64",
    name: "gguf-parser",
    tag: "v0.26.4",
    platform: "darwin",
    arch: "arm64",
    tool: "gguf-parser",
    requiresNvidia: false,
    label: "gguf-parser-go (macOS, Apple Silicon), v0.26.4",
    docsUrl: "https://github.com/gpustack/gguf-parser-go",
    archive: { label: "gguf-parser-go (macOS arm64)", url: "https://github.com/gpustack/gguf-parser-go/releases/download/v0.26.4/gguf-parser-darwin-arm64", sha256: "bb33961acc40466312940290553d9f84fdd1d19f532faedd60e02752e2a082b2", approxBytes: 9_130_434, rawFileName: "gguf-parser" },
    verified: true,
  },
  {
    id: "gguf-parser-v0.26.4-linux-arm64",
    name: "gguf-parser",
    tag: "v0.26.4",
    platform: "linux",
    arch: "arm64",
    tool: "gguf-parser",
    requiresNvidia: false,
    label: "gguf-parser-go (Linux, ARM64), v0.26.4",
    docsUrl: "https://github.com/gpustack/gguf-parser-go",
    archive: { label: "gguf-parser-go (Linux arm64)", url: "https://github.com/gpustack/gguf-parser-go/releases/download/v0.26.4/gguf-parser-linux-arm64", sha256: "46db5a47c96d4860f4c91f1d3ebb0afde90e358a41c263a84c4a1241bc0c36be", approxBytes: 8_847_512, rawFileName: "gguf-parser" },
    verified: false,
  },
  {
    id: "gguf-parser-v0.26.4-linux-x64",
    name: "gguf-parser",
    tag: "v0.26.4",
    platform: "linux",
    arch: "x64",
    tool: "gguf-parser",
    requiresNvidia: false,
    label: "gguf-parser-go (Linux, x64), v0.26.4",
    docsUrl: "https://github.com/gpustack/gguf-parser-go",
    archive: { label: "gguf-parser-go (Linux x64)", url: "https://github.com/gpustack/gguf-parser-go/releases/download/v0.26.4/gguf-parser-linux-amd64", sha256: "b33c4488eb073d3a58329a1c4c7041af168241a1bb832eb962051da99689c1ec", approxBytes: 9_224_344, rawFileName: "gguf-parser" },
    verified: false,
  },
  {
    id: "gguf-parser-v0.26.4-win-x64",
    name: "gguf-parser",
    tag: "v0.26.4",
    platform: "win32",
    arch: "x64",
    tool: "gguf-parser",
    requiresNvidia: false,
    label: "gguf-parser-go (Windows, x64), v0.26.4",
    docsUrl: "https://github.com/gpustack/gguf-parser-go",
    archive: { label: "gguf-parser-go (Windows x64)", url: "https://github.com/gpustack/gguf-parser-go/releases/download/v0.26.4/gguf-parser-windows-amd64.exe", sha256: "8da9ae6b8968d5d2dee4eaf48dbc24ed48bf3de02794c8dbe0b2a9443b12c92c", approxBytes: 9_592_832, rawFileName: "gguf-parser.exe" },
    verified: false,
  },
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
    id: "llama-server-b11476-linux-cuda-x64",
    name: "llama-server",
    tag: "b11476",
    platform: "linux",
    arch: "x64",
    requiresNvidia: true,
    label: "llama-server (Ubuntu, NVIDIA CUDA 12.8, x64), build b11476",
    docsUrl: "https://github.com/ggml-org/llama.cpp/tree/b11476/docs",
    archive: {
      label: "llama-server (Ubuntu CUDA 12.8 x64)",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b11476/llama-b11476-bin-ubuntu-cuda-12.8-x64.tar.gz",
      sha256: "1a854ea10d271145a731f1f7e91119d85c3a93ea4a4015b1d4375860465d1379",
      approxBytes: 171_688_764,
    },
    extraArchives: [{
      label: "CUDA 12.8 runtime (cudart)",
      url: "https://github.com/ggml-org/llama.cpp/releases/download/b11476/cudart-llama-b11476-bin-ubuntu-cuda-12.8-x64.tar.gz",
      sha256: "768e0ed4089b76642c8111556c8a8bb6521fc4171e88c1ae850e3d661370d0f3",
      approxBytes: 594_377_571,
    }],
    verified: false,
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
  {
    id: "uv-0.12.17-macos-arm64",
    name: "uv",
    tag: "0.12.17",
    platform: "darwin",
    arch: "arm64",
    tool: "uv",
    requiresNvidia: false,
    label: "uv (macOS, Apple Silicon), 0.12.17",
    docsUrl: "https://docs.astral.sh/uv/",
    archive: { label: "uv (macOS arm64)", url: "https://github.com/astral-sh/uv/releases/download/0.12.17/uv-aarch64-apple-darwin.tar.gz", sha256: "85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b", approxBytes: 16_929_004 },
    verified: true,
  },
  {
    id: "uv-0.12.17-linux-arm64",
    name: "uv",
    tag: "0.12.17",
    platform: "linux",
    arch: "arm64",
    tool: "uv",
    requiresNvidia: false,
    label: "uv (Linux, ARM64), 0.12.17",
    docsUrl: "https://docs.astral.sh/uv/",
    archive: { label: "uv (Linux aarch64)", url: "https://github.com/astral-sh/uv/releases/download/0.12.17/uv-aarch64-unknown-linux-gnu.tar.gz", sha256: "d636d1b678e9e7f367ecb22b46bd1cabbed234d6bc3b4d96365d2b507f72f86c", approxBytes: 18_965_833 },
    verified: false,
  },
  {
    id: "uv-0.12.17-linux-x64",
    name: "uv",
    tag: "0.12.17",
    platform: "linux",
    arch: "x64",
    tool: "uv",
    requiresNvidia: false,
    label: "uv (Linux, x64), 0.12.17",
    docsUrl: "https://docs.astral.sh/uv/",
    archive: { label: "uv (Linux x64)", url: "https://github.com/astral-sh/uv/releases/download/0.12.17/uv-x86_64-unknown-linux-gnu.tar.gz", sha256: "fa82fd8dde8e8eefdecada6aa0889666556cfceb690d06e0c3bca49eb3070a63", approxBytes: 19_755_224 },
    verified: false,
  },
  {
    id: "comfyui-v0.36.0-macos-arm64",
    name: "comfyui",
    tag: "v0.36.0",
    platform: "darwin",
    arch: "arm64",
    tool: "main.py",
    requiresNvidia: false,
    label: "ComfyUI v0.36.0 source (the same archive on every platform)",
    docsUrl: "https://github.com/comfyanonymous/ComfyUI/tree/v0.36.0",
    archive: { label: "ComfyUI v0.36.0 source", url: "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.36.0.tar.gz", sha256: "ab0d2f14e6a20616c6019d7af733aa897507a9a34ed0e88cec9d9c574065e8a1", approxBytes: 12_479_903 },
    verified: true,
  },
  {
    id: "comfyui-v0.36.0-linux-arm64",
    name: "comfyui",
    tag: "v0.36.0",
    platform: "linux",
    arch: "arm64",
    tool: "main.py",
    requiresNvidia: false,
    label: "ComfyUI v0.36.0 source (the same archive on every platform)",
    docsUrl: "https://github.com/comfyanonymous/ComfyUI/tree/v0.36.0",
    archive: { label: "ComfyUI v0.36.0 source", url: "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.36.0.tar.gz", sha256: "ab0d2f14e6a20616c6019d7af733aa897507a9a34ed0e88cec9d9c574065e8a1", approxBytes: 12_479_903 },
    verified: false,
  },
  {
    id: "comfyui-v0.36.0-linux-x64",
    name: "comfyui",
    tag: "v0.36.0",
    platform: "linux",
    arch: "x64",
    tool: "main.py",
    requiresNvidia: false,
    label: "ComfyUI v0.36.0 source (the same archive on every platform)",
    docsUrl: "https://github.com/comfyanonymous/ComfyUI/tree/v0.36.0",
    archive: { label: "ComfyUI v0.36.0 source", url: "https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.36.0.tar.gz", sha256: "ab0d2f14e6a20616c6019d7af733aa897507a9a34ed0e88cec9d9c574065e8a1", approxBytes: 12_479_903 },
    verified: false,
  },
];

/** The second chat engine (STACK-93): one archive with the binary and
 * its libraries, the same shape as llama-server's. */
export const MLX_SERVE_PIN: EngineBinaryPin = {
  id: "mlx-serve-v26.9.4-macos-arm64",
  name: "mlx-serve",
  tag: "v26.9.4",
  platform: "darwin",
  arch: "arm64",
  tool: "mlx-serve",
  requiresNvidia: false,
  label: "mlx-serve (macOS, Apple Silicon, MLX and GGUF), v26.9.4",
  docsUrl: "https://github.com/ddalcu/mlx-serve/tree/v26.9.4/docs",
  archive: { label: "mlx-serve (macOS arm64)", url: "https://github.com/ddalcu/mlx-serve/releases/download/v26.9.4/mlx-serve-bin-macos-arm64.tar.gz", sha256: "5a8b16317e7e4d5f87f528384a5d28b70bacbdcfce291be2aa6513a87e2a1925", approxBytes: 72_076_199 },
  verified: true,
};
ENGINE_BINARIES.push(MLX_SERVE_PIN);

/** The chat wire's engines, one chosen by `stack.engines.chat.engine`. */
export const CHAT_ENGINES = ["llama-server", "mlx-serve"] as const;
export type ChatEngine = typeof CHAT_ENGINES[number];

/** The role each engine name serves, for the routes that act on "the
 * engine's role" (start, stop, restart, the swap's drain). */
export type EngineRole = "chat" | "tts" | "image";
export const ENGINE_ROLE: Record<string, EngineRole> = { "llama-server": "chat", "mlx-serve": "chat", uv: "tts", "pocket-tts": "tts", comfyui: "image" };
export function engineRole(name: string): EngineRole { return ENGINE_ROLE[name] ?? "chat"; }

/** Runtimes the Stack assembles from pinned wheels through uv, in an
 * environment under data/engines/<name>/<version>/ (STACK-94c). */
export interface ManagedRuntime { name: string; version: string; roles: string[]; platforms: string; }
export const MANAGED_RUNTIMES: ManagedRuntime[] = [
  { name: "pocket-tts", version: "3.1.0", roles: ["tts"], platforms: "macOS 14 or later on arm64 (torch 2.13 ships macOS 14 wheels only; a hashed requirements file per platform, the Linux files land with the first Linux tts run)" },
  { name: "comfyui", version: "v0.36.0", roles: ["image"], platforms: "macOS 14 or later on arm64 (torch 2.13 ships macOS 14 wheels only; a hashed requirements file per platform, the source archive is the same on every platform)" },
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

/** The pin of one engine for a machine; the name filter keeps a uv pin
 * from ever being launched as llama-server. */
export function selectEngineBinary(hw: HardwareInfo, name = "llama-server"): EngineBinaryPin | null {
  return ENGINE_BINARIES.find(
    (pin) => pin.name === name && pin.platform === hw.platform && pin.arch === hw.arch && (!pin.requiresNvidia || hw.cudaDevices.length > 0),
  ) ?? null;
}

export function installedEnginePin(name = "llama-server"): EngineBinaryPin | null {
  return ENGINE_BINARIES.find((pin) => pin.name === name && pin.platform === process.platform && pin.arch === process.arch && !pin.requiresNvidia) ?? null;
}
