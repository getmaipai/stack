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
