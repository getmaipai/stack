// The pinned H3 clip runtime's engine entry (H3-PIN-01): it lives with the pack so the model's name stays inside the pack folder (rule E8).
import type { EngineBinaryPin } from "@/lib/engineCatalog";
export const H3_ENGINE_ENTRY: EngineBinaryPin = {
    id: "minimax-h3-video-gen-55bb7dd-macos-arm64",
    name: "minimax-h3-video-gen",
    tag: "55bb7dd",
    platform: "darwin",
    arch: "arm64",
    tool: "pyproject.toml",
    requiresNvidia: false,
    label: "ComfyUI-MiniMax-H3-MLX-SolAttn source, commit 55bb7dd (Apache-2.0; MiniMax H3 video runtime)",
    docsUrl: "https://github.com/yshenaw/ComfyUI-MiniMax-H3-MLX-SolAttn/tree/55bb7ddd015321a25385683419951e7c7f518775",
    archive: { label: "MiniMax H3 video runtime source", url: "https://codeload.github.com/yshenaw/ComfyUI-MiniMax-H3-MLX-SolAttn/tar.gz/55bb7ddd015321a25385683419951e7c7f518775", sha256: "5ed91b6815555ea4638aa4648b4918308e6182c73a650d09c694a1e3d1ae1356", approxBytes: 125691 },
    verified: true,
  };
