import { hfUrl } from "@/lib/hf";
import type { CatalogModelLike } from "@/lib/modelStore";

// The first standalone Stack chat pin: an official Qwen GGUF, small enough
// for p16 while retaining a useful local conversation experience. The
// revision is the Hub commit the sha256 was verified against; downloads
// resolve that commit, never a branch.
export const STACK_CHAT_MODEL: CatalogModelLike = {
  id: "qwen3-1.7b-q8-0",
  role: "chat",
  repo: "Qwen/Qwen3-1.7B-GGUF",
  license: "Apache-2.0",
  revision: "90862c4b9d2787eaed51d12237eafdfe7c5f6077",
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q8_0" },
  download: {
    url: hfUrl("Qwen/Qwen3-1.7B-GGUF/resolve/90862c4b9d2787eaed51d12237eafdfe7c5f6077/Qwen3-1.7B-Q8_0.gguf"),
    sha256: "061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a",
    approx_bytes: 1_834_426_016,
  },
};

// Every pinned model this build ships, by role. One entry today; the
// Catalog's signed index replaces this list as the source at STACK-97.
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_MODEL];

// Engines and models named in dev.md or the backlog for a role but not
// pinned yet: the components inventory lists them as candidates, so a
// role with no pin never reads as forgotten. Each names where it came from.
export interface RoleCandidate { name: string; kind: "engine" | "model"; source: string; }
export const ROLE_CANDIDATES: Partial<Record<string, RoleCandidate[]>> = {
  chat: [
    { name: "mlx-serve", kind: "engine", source: "dev.md, Engines and the supervisor; STACK-14, STACK-93" },
    { name: "oMLX", kind: "engine", source: "dev.md, Engines and the supervisor; STACK-14, STACK-93" },
  ],
  stt: [
    { name: "whisper.cpp", kind: "engine", source: "dev.md, Sizing and profiles; STACK-94" },
    { name: "MLX Whisper", kind: "engine", source: "dev.md, Sizing and profiles; STACK-94" },
    { name: "sherpa-onnx (Linux)", kind: "engine", source: "dev.md, Sizing and profiles; STACK-17" },
  ],
  tts: [
    { name: "the chosen TTS runtime", kind: "engine", source: "dev.md, Sizing and profiles; STACK-94" },
  ],
  image: [
    { name: "ComfyUI (managed)", kind: "engine", source: "dev.md, Jobs; STACK-13" },
  ],
  video: [
    { name: "ComfyUI (managed)", kind: "engine", source: "dev.md, Jobs; STACK-13" },
  ],
};
