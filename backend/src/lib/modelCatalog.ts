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
  // No measured figure: the 2026-09-20 rehearsal's 414,550,392 bytes was
  // the macOS physical footprint alone, which leaves out the 1.8 GB of
  // weights llama-server memory-maps, so it was withdrawn on 2026-10-06
  // (STACK-PROCMEM-01) until a load is measured with the one definition.
};

// The household's p16 chat choice, copied from Home's verified pin.
export const STACK_CHAT_8B_MODEL: CatalogModelLike = {
  id: "qwen3-8b-instruct-q4-k-m",
  role: "chat",
  repo: "Qwen/Qwen3-8B-GGUF",
  license: "Apache-2.0",
  revision: "7c41481f57cb95916b40956ab2f0b139b296d974",
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q4_K_M" },
  download: {
    url: hfUrl("Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf"),
    sha256: "d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785",
    approx_bytes: 5_027_783_488,
  },
};

// The household's background worker pin, exposed as Stack's distinct
// judge role on machines with a known p16-or-larger profile.
export const STACK_JUDGE_MODEL: CatalogModelLike = {
  id: "qwen3-4b-q4-k-m",
  role: "judge",
  repo: "Qwen/Qwen3-4B-GGUF",
  license: "Apache-2.0",
  revision: "bc640142c66e1fdd12af0bd68f40445458f3869b",
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q4_K_M" },
  download: {
    url: hfUrl("Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf"),
    sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
    approx_bytes: 2_497_280_256,
  },
};

// The `vision` pins (VISION-01b): Qwen's own GGUF of Qwen3-VL-4B-Instruct,
// the language model at Q4_K_M and its multimodal projector at Q8_0 (the
// smaller of the two projector files the repository publishes). Licence
// Apache-2.0, read from the pinned revision's model card. The projector
// is a component of the vision model, loaded with --mmproj and never
// selectable alone; the model declares image input by naming it
// (spec ModelCapabilities.image_input), so picture support follows the
// record, never the model id. The engine build b10797 carries the
// qwen3vl text architecture and its mtmd projector graph.
const QWEN3_VL_REPO = "Qwen/Qwen3-VL-4B-Instruct-GGUF";
const QWEN3_VL_REVISION = "1cd86afb9a95c410a6038ab3b40d8b578c892266";
export const STACK_VISION_PROJECTOR: CatalogModelLike = {
  id: "qwen3-vl-4b-instruct-mmproj-q8-0",
  role: "vision",
  component: "projector",
  repo: QWEN3_VL_REPO,
  license: "Apache-2.0",
  revision: QWEN3_VL_REVISION,
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q8_0" },
  download: {
    url: hfUrl(`${QWEN3_VL_REPO}/resolve/${QWEN3_VL_REVISION}/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf`),
    sha256: "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d",
    approx_bytes: 453_974_304,
  },
};
export const STACK_VISION_MODEL: CatalogModelLike = {
  id: "qwen3-vl-4b-instruct-q4-k-m",
  role: "vision",
  repo: QWEN3_VL_REPO,
  license: "Apache-2.0",
  revision: QWEN3_VL_REVISION,
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q4_K_M" },
  download: {
    url: hfUrl(`${QWEN3_VL_REPO}/resolve/${QWEN3_VL_REVISION}/Qwen3VL-4B-Instruct-Q4_K_M.gguf`),
    sha256: "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
    approx_bytes: 2_497_281_664,
  },
  imageInput: { projector: STACK_VISION_PROJECTOR.id },
  // A picture turn needs a short context: one picture is at most the
  // engine's per-image token cap, plus the question and the description.
  launch: { contextLength: 8192 },
  // Sampling from the model card's recommended settings for the Instruct
  // edition (rule 3: the source is named).
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen/Qwen3-VL-4B-Instruct model card, Generation Hyperparameters, VL" },
};

// The vision-capable chat pins (VISION-02b): Qwen's own GGUF of
// Qwen3-VL-8B-Instruct, the language model at Q4_K_M and its projector
// at Q8_0, so the one resident chat process reads pictures itself and
// nothing extra loads. Licence Apache-2.0, read from the pinned
// revision's card. The text architecture is Qwen3-8B's (36 layers, 8 KV
// heads, head_dim 128), so its KV cache per token is the same; the
// projector is the only extra weight. Selectable beside the Qwen3-8B
// pin; the p16 binding is not moved here (that is the owner's go,
// VISION-02e). The Instruct edition has no thinking mode.
const QWEN3_VL_8B_REPO = "Qwen/Qwen3-VL-8B-Instruct-GGUF";
const QWEN3_VL_8B_REVISION = "f982a07559d4a2f6c8744d840bf6fccab30eea96";
export const STACK_CHAT_VL_8B_PROJECTOR: CatalogModelLike = {
  id: "qwen3-vl-8b-instruct-mmproj-q8-0",
  role: "chat",
  component: "projector",
  repo: QWEN3_VL_8B_REPO,
  license: "Apache-2.0",
  revision: QWEN3_VL_8B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q8_0" },
  download: {
    url: hfUrl(`${QWEN3_VL_8B_REPO}/resolve/${QWEN3_VL_8B_REVISION}/mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf`),
    sha256: "c6ba85508d82f42590e6eb77d5340369ab6fecf107a7561d809523d8aa5f3bfd",
    approx_bytes: 752_289_728,
  },
};
export const STACK_CHAT_VL_8B_MODEL: CatalogModelLike = {
  id: "qwen3-vl-8b-instruct-q4-k-m",
  role: "chat",
  repo: QWEN3_VL_8B_REPO,
  license: "Apache-2.0",
  revision: QWEN3_VL_8B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "Q4_K_M" },
  download: {
    url: hfUrl(`${QWEN3_VL_8B_REPO}/resolve/${QWEN3_VL_8B_REVISION}/Qwen3VL-8B-Instruct-Q4_K_M.gguf`),
    sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
    approx_bytes: 5_027_784_800,
  },
  imageInput: { projector: STACK_CHAT_VL_8B_PROJECTOR.id },
  // One picture takes at most 2,560 tokens (about 2.6 megapixels; the
  // engine scales a larger photo down itself). Unbounded, a 12-megapixel
  // phone photo would take about 12,000 of the window's tokens. Measured
  // on b10797: a 1280 by 1918 photo is 2,400 tokens (VISION-02b).
  launch: { imageMaxTokens: 2560 },
  // The card publishes a VL set and a Text set; one set serves every
  // turn of one process. The VL set is chosen (its temperature is the
  // household's own 0.7, which Home sends on every chat turn), and the
  // CHAT-AB-01 rerun measures it on text turns (VISION-02d).
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen/Qwen3-VL-8B-Instruct-GGUF model card, Generation Hyperparameters, VL" },
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

// Nomic's official GGUF conversion, pinned to the Hub revision whose
// Q4_K_M file matches the household's existing embedding model.
export const STACK_EMBED_MODEL: CatalogModelLike = {
  id: "nomic-embed-text-v1-5-q4-k-m",
  role: "embed",
  repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
  license: "Apache-2.0",
  revision: "0188c9bf409793f810680a5a431e7b899c46104c",
  engine: "llama-server",
  sizing: { profile: "p16", quantization: "q4_k_m" },
  download: {
    url: hfUrl("nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/0188c9bf409793f810680a5a431e7b899c46104c/nomic-embed-text-v1.5.Q4_K_M.gguf"),
    sha256: "d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac",
    approx_bytes: 84_106_624,
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

// Wakeword assets are installed through the same model job and verified
// store as every other pinned file. Home serves these bytes to paired
// robots; the Stack does not run wakeword inference. The openWakeWord
// front end is Apache-2.0; the phrase model is our Bot release asset.
const OPEN_WAKE_WORD_RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
export const STACK_WAKEWORD_MODELS: CatalogModelLike[] = [
  {
    id: "openwakeword-melspectrogram",
    role: "wakeword",
    repo: "dscripka/openWakeWord",
    license: "Apache-2.0",
    revision: "v0.5.1",
    component: "wakeword_asset",
    download: { url: `${OPEN_WAKE_WORD_RELEASE}/melspectrogram.onnx`, sha256: "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f", approx_bytes: 1_087_958 },
  },
  {
    id: "openwakeword-embedding",
    role: "wakeword",
    repo: "dscripka/openWakeWord",
    license: "Apache-2.0",
    revision: "v0.5.1",
    component: "wakeword_asset",
    download: { url: `${OPEN_WAKE_WORD_RELEASE}/embedding_model.onnx`, sha256: "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f", approx_bytes: 1_326_578 },
  },
  {
    id: "trained-hey-maipai-v2",
    role: "wakeword",
    repo: "getmaipai/bot",
    license: "AGPL-3.0",
    revision: "v0.1.0",
    component: "wakeword_asset",
    download: { url: "https://github.com/getmaipai/bot/releases/download/v0.1.0/trained_hey_maipai_v2.onnx", sha256: "6fbff74699801dabf931166badcc51fd655570469fb6d10da1ee5f64b4cba190", approx_bytes: 937_243 },
  },
];

// Every pinned model this build ships, by role. The Catalog's signed
// index replaces this list as the source at STACK-97's model half.
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_MODEL, STACK_CHAT_8B_MODEL, STACK_JUDGE_MODEL, STACK_MLX_CHAT_MODEL, STACK_STT_MODEL, STACK_VAD_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_IMAGE_MODEL, STACK_EMBED_MODEL, STACK_VISION_MODEL, STACK_VISION_PROJECTOR, STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR, ...STACK_WAKEWORD_MODELS];

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
  music: [
    { name: "ACE-Step 1.5 (managed, the official MLX backend, acestep-api), the owner's pick", kind: "engine", source: "docs/plans/jev-and-yue-2026-09-20.md; STACK-99" },
  ],
};
