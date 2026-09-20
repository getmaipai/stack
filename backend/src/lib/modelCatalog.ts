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
  // scripts/bench/studio-bench.sh, 2026-09-20 09:23 UTC, the protocol
  // rehearsal on the p16 laptop: 2,222 prompt tokens/s, 112.5 generated
  // tokens/s, the footprint the supervisor measured after that load.
  measured: { footprintBytes: 414_550_392, contextLength: 4096, hardware: "Apple M4 Pro, 24 GB unified memory" },
};

// The `stt` pins (STACK-94b): sherpa-onnx's Moonshine tiny English
// package and the Silero voice activity detector, from k2-fsa's rolling
// `asr-models` release. A rolling tag can replace an asset under the
// same name, so the sha256 is the pin and the revision: a mismatch at
// download is a refusal and a deliberate re-pin, never a quiet update.
// The archive extracts to a directory of ONNX files; `modelPath` is
// that directory. Silero is a component of the role, not a model a
// person selects, so `selectedModel` skips it.
export const STACK_STT_MODEL: CatalogModelLike = {
  id: "moonshine-tiny-en-int8",
  role: "stt",
  repo: "k2-fsa/sherpa-onnx",
  license: "MIT",
  revision: "d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2",
  engine: "sherpa-onnx-node",
  sizing: { profile: "p16", quantization: "int8" },
  download: {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2",
    sha256: "d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2",
    approx_bytes: 107_600_538,
    archive: true,
  },
  // scripts/prove-stt.sh, 2026-09-20, the p16 laptop: the worker's
  // resident set after the post-load check, bun plus onnxruntime plus
  // the model; context is not a speech quantity.
  measured: { footprintBytes: 239_387_872, contextLength: 0, hardware: "Apple M4 Pro, 24 GB unified memory" },
};
export const STACK_VAD_MODEL: CatalogModelLike = {
  id: "silero-vad",
  role: "stt",
  component: "vad",
  repo: "k2-fsa/sherpa-onnx",
  license: "MIT",
  revision: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  engine: "sherpa-onnx-node",
  sizing: { profile: "p16", quantization: "fp32" },
  download: {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    approx_bytes: 643_854,
  },
};

// The `tts` pins (STACK-94c): Pocket TTS's own files at the revisions
// its config names, the ungated repository (the gated twin is fetched
// by the engine itself when a token is set). Each is placed in the
// Stack's Hugging Face hub cache (`hub_file`), where the engine finds
// it and fetches nothing at first start; the tokenizer and the default
// voice embedding are components of the role. Licence: CC BY 4.0, from
// the repositories' own cards.
const POCKET_TTS_REPO = "kyutai/pocket-tts-without-voice-cloning";
const POCKET_TTS_WEIGHTS_REVISION = "d29db7978e464fb90cb3359ee0c69a273b9142cc";
const POCKET_TTS_VOICES_REVISION = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487";
export const STACK_TTS_MODEL: CatalogModelLike = {
  id: "pocket-tts-english",
  role: "tts",
  repo: POCKET_TTS_REPO,
  license: "CC-BY-4.0",
  revision: POCKET_TTS_WEIGHTS_REVISION,
  engine: "pocket-tts",
  sizing: { profile: "p16", quantization: "fp32" },
  download: {
    url: hfUrl(`${POCKET_TTS_REPO}/resolve/${POCKET_TTS_WEIGHTS_REVISION}/languages/english/model.safetensors`),
    sha256: "be9c6b4876d3f30740a8225dfcaa2e43dc4aeb753c15272735bee16bbb4abb0a",
    approx_bytes: 219_029_196,
    hub_file: "languages/english/model.safetensors",
  },
  // scripts/prove-tts.sh, 2026-09-20, the p16 laptop: the engine's
  // resident set after the post-load check, torch and the model.
  measured: { footprintBytes: 828_868_000, contextLength: 0, hardware: "Apple M4 Pro, 24 GB unified memory" },
};
export const STACK_TTS_TOKENIZER: CatalogModelLike = {
  id: "pocket-tts-english-tokenizer",
  role: "tts",
  component: "tokenizer",
  repo: POCKET_TTS_REPO,
  license: "CC-BY-4.0",
  revision: POCKET_TTS_WEIGHTS_REVISION,
  engine: "pocket-tts",
  sizing: { profile: "p16", quantization: "n/a" },
  download: {
    url: hfUrl(`${POCKET_TTS_REPO}/resolve/${POCKET_TTS_WEIGHTS_REVISION}/languages/english/tokenizer.model`),
    sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6",
    approx_bytes: 59_339,
    hub_file: "languages/english/tokenizer.model",
  },
};
export const STACK_TTS_VOICE: CatalogModelLike = {
  id: "pocket-tts-voice-alba",
  role: "tts",
  component: "voice",
  repo: POCKET_TTS_REPO,
  license: "CC-BY-4.0",
  revision: POCKET_TTS_VOICES_REVISION,
  engine: "pocket-tts",
  sizing: { profile: "p16", quantization: "n/a" },
  download: {
    url: hfUrl(`${POCKET_TTS_REPO}/resolve/${POCKET_TTS_VOICES_REVISION}/languages/english/embeddings/alba.safetensors`),
    sha256: "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845",
    approx_bytes: 6_194_424,
    hub_file: "languages/english/embeddings/alba.safetensors",
  },
};

// The `image` pin (STACK-13b): Stable Diffusion 1.5, the EMA-only
// single-file checkpoint, the smallest mainstream file ComfyUI's plain
// checkpoint loader takes, from the maintained mirror of the original
// repository. CreativeML Open RAIL-M, from the repository's card; the
// use terms are the person's, as every model's are.
export const STACK_IMAGE_MODEL: CatalogModelLike = {
  id: "sd-1-5-emaonly",
  role: "image",
  repo: "stable-diffusion-v1-5/stable-diffusion-v1-5",
  license: "CreativeML-OpenRAIL-M",
  revision: "451f4fe16113bff5a5d2269ed5ad43b0592e9a14",
  engine: "comfyui",
  sizing: { profile: "p16", quantization: "fp32" },
  download: {
    url: hfUrl("stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/451f4fe16113bff5a5d2269ed5ad43b0592e9a14/v1-5-pruned-emaonly.safetensors"),
    sha256: "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa",
    approx_bytes: 4_265_146_304,
  },
};

// The MLX build of the same chat model, for mlx-serve (STACK-93): a
// directory of nine files, each pinned by path, size and sha256 (the
// small ones hashed from the download, the hub keeps no LFS digest for
// them), so the Studio bench compares the two engines on one model.
const MLX_REPO = "mlx-community/Qwen3-1.7B-4bit";
const MLX_REVISION = "3b1b1768f8f8cf8351c712464f906e86c2b8269e";
const mlxFile = (path: string) => hfUrl(`${MLX_REPO}/resolve/${MLX_REVISION}/${path}`);
export const STACK_MLX_CHAT_MODEL: CatalogModelLike = {
  id: "qwen3-1.7b-mlx-4bit",
  role: "chat",
  repo: MLX_REPO,
  license: "Apache-2.0",
  revision: MLX_REVISION,
  engine: "mlx-serve",
  sizing: { profile: "p16", quantization: "4-bit" },
  download: {
    url: mlxFile("model.safetensors"),
    sha256: "0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f",
    approx_bytes: 984_013_244,
    directory: "Qwen3-1.7B-4bit",
    files: [
      { path: "model.safetensors", sha256: "0e86d9677e519323849eac1bc272caae88567a481ff188c431f70be543d9995f", bytes: 968_080_210 },
      { path: "model.safetensors.index.json", sha256: "1e3058d4ba4b04e4de35b74467725cbef90ff022198404218e48f21adc9cfa15", bytes: 49_731 },
      { path: "config.json", sha256: "507a6701220524eb8b283425bf0856a9ae4f21f4052e563896ddd668994b1dc7", bytes: 937 },
      { path: "tokenizer.json", sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4", bytes: 11_422_654 },
      { path: "tokenizer_config.json", sha256: "253153d0738ceb4c668d2eff957714dd2bea0b56de772a9fdccd96cbf517e6a0", bytes: 9_706 },
      { path: "special_tokens_map.json", sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd", bytes: 613 },
      { path: "added_tokens.json", sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680", bytes: 707 },
      { path: "vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2_776_833 },
      { path: "merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1_671_853 },
    ],
  },
};

// Every pinned model this build ships, by role. The Catalog's signed
// index replaces this list as the source at STACK-97's model half.
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_MODEL, STACK_MLX_CHAT_MODEL, STACK_STT_MODEL, STACK_VAD_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_IMAGE_MODEL];

// Engines and models named in dev.md or the backlog for a role but not
// pinned yet: the components inventory lists them as candidates, so a
// role with no pin never reads as forgotten. Each names where it came from.
export interface RoleCandidate { name: string; kind: "engine" | "model"; source: string; }
export const ROLE_CANDIDATES: Partial<Record<string, RoleCandidate[]>> = {
  chat: [
    { name: "oMLX", kind: "engine", source: "the named alternative the Studio bench can call for: dev.md, The second chat engine; STACK-14" },
  ],
  stt: [
    { name: "Whisper tiny.en or base.en on the same runtime, the named alternative", kind: "model", source: "dev.md, The speech roles" },
  ],
  tts: [
    { name: "Kokoro 82M through the stt worker's runtime, rejected by the owner's ear on 2026-09-04; the alternative if he reverses it", kind: "model", source: "dev.md, The speech roles" },
  ],
  video: [
    { name: "ComfyUI (managed), the same environment as image", kind: "engine", source: "dev.md, Jobs; a later item" },
  ],
};
