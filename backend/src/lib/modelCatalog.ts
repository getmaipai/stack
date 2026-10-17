import { hfUrl } from "@/lib/hf";
import type { CatalogModelLike } from "@/lib/modelStore";
import { KLEIN_4B_FILES, KLEIN_4B_PRIMARY, KLEIN_4B_REPO, KLEIN_4B_REVISION, ZIMAGE_TURBO_FILES, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, type ImagePinFile } from "@/images/pins";

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

// The household chat pin above 24 GB (STACK-MUSE-01, 2026-10-16): Meta's
// own GGUF repository of Muse Glimmer 30B (dense 29.6B, Apache-2.0 on the
// card), pinned to one revision; sha256 and sizes are the repository's
// git-lfs oids, confirmed against a live HEAD on each resolve URL. p32
// binds the 17 GB Q4_K_M (the Q4_K_XL beside the 4B judge would leave a
// 32 GB Mac under the governor's 4 GiB margin); p64 and p128 bind the
// KQuant-Dynamic Q4_K_XL, the build the owner named. p16 (a 24 GB Mac or
// smaller) keeps Qwen3-8B. The template reasons on every turn at a
// strength it reads from `reasoning_strength` (low, medium, high, xhigh;
// there is no off, so `--reasoning off` does not reach it), and the launch
// pins it low for chat latency; a request may raise it per turn. Sampling
// from the card. llama-server parses the model's ATEM tool calls natively
// from b10353 (the pinned b10797 does).
const MUSE_30B_REPO = "meta-models/Muse-Glimmer-30B-GGUF";
const MUSE_30B_REVISION = "70bf1b61ac09f91b24d39038091b41c582bc5d7a";
// VISION-03a: the repository's own multimodal projector (one file for both
// quantizations, 1.4 GB, Apache-2.0 repo) loads beside the model in the one
// resident chat process, so Muse reads pictures itself and nothing extra
// runs. One picture takes at most 2,560 tokens: measured on b10797, a
// 1,440 by 900 screenshot is 1,704 prompt tokens and a 2,000 pixel photo
// 2,551 to 2,567 (docs/design/vision-images-2026-10-17.md in Home).
const MUSE_30B_LAUNCH = { chatTemplateKwargs: { reasoning_strength: "low" }, imageMaxTokens: 2560 };
export const STACK_CHAT_MUSE_30B_PROJECTOR: CatalogModelLike = {
  id: "muse-glimmer-30b-mmproj-q4-k-m",
  role: "chat",
  component: "projector",
  repo: MUSE_30B_REPO,
  license: "Apache-2.0",
  revision: MUSE_30B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p32", quantization: "Q4_K_M" },
  download: {
    url: hfUrl(`${MUSE_30B_REPO}/resolve/${MUSE_30B_REVISION}/mmproj-Muse-Glimmer-30B-Q4_K_M.gguf`),
    sha256: "f48b452316f9b213758e8659444029b961a24a07f99a1abb2a9f88b06f7c00c6",
    approx_bytes: 1_400_328_928,
  },
};
const MUSE_30B_SAMPLING = { temperature: 1.0, top_p: 0.95, top_k: 64, source: "meta-models/Muse-Glimmer-30B-GGUF model card, recommended sampling" };
export const STACK_CHAT_MUSE_30B_XL_MODEL: CatalogModelLike = {
  id: "muse-glimmer-30b-q4-k-xl",
  role: "chat",
  repo: MUSE_30B_REPO,
  license: "Apache-2.0",
  revision: MUSE_30B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p64", quantization: "Q4_K_XL" },
  download: {
    url: hfUrl(`${MUSE_30B_REPO}/resolve/${MUSE_30B_REVISION}/Muse-Glimmer-30B-KQuant-Dynamic-Q4_K_XL.gguf`),
    sha256: "ac7023d6a4c704eb9af54ab53e476a66b7f5b6c0ef2fc4a8dde5253c291a6c38",
    approx_bytes: 19_653_960_832,
  },
  imageInput: { projector: STACK_CHAT_MUSE_30B_PROJECTOR.id },
  launch: MUSE_30B_LAUNCH,
  sampling: MUSE_30B_SAMPLING,
};
export const STACK_CHAT_MUSE_30B_M_MODEL: CatalogModelLike = {
  id: "muse-glimmer-30b-q4-k-m",
  role: "chat",
  repo: MUSE_30B_REPO,
  license: "Apache-2.0",
  revision: MUSE_30B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p32", quantization: "Q4_K_M" },
  download: {
    url: hfUrl(`${MUSE_30B_REPO}/resolve/${MUSE_30B_REVISION}/Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf`),
    sha256: "4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e",
    approx_bytes: 16_756_683_904,
  },
  imageInput: { projector: STACK_CHAT_MUSE_30B_PROJECTOR.id },
  launch: MUSE_30B_LAUNCH,
  sampling: MUSE_30B_SAMPLING,
};

// ENGINE-MLX-01: the same Muse Glimmer 30B as an MLX 4-bit directory, for
// the oMLX chat engine (docs/design/chat-engine-comparison-2026-10-17.md in
// Home). mlx-community's conversion of meta-models/Muse-Glimmer-30B (the
// vision tower is inside the weights, so there is no projector file),
// affine 4-bit, group size 64, 19.44 GB. Every file is pinned by path,
// size and sha256 at one repository revision; the sha256 of the four
// weight shards are the repository's git-lfs oids, the rest were hashed
// from the download. Measured on the Studio (M5 Max, 128 GB, 2026-10-17):
// 19.4 GB resident idle, 19.9 GB after a 16,410-token prompt; the 22 GB
// figure adds the 128k-token context's key and value cache (13 global
// layers, 2 key-value heads, 128 wide, bf16: about 1.7 GB). The GGUF pins
// stay installed beside it as the fallback. Sampling is the GGUF record's
// (the card's); the reasoning strength is sent with each request.
const MUSE_30B_MLX_REPO = "mlx-community/Muse-Glimmer-30B-4bit";
const MUSE_30B_MLX_REVISION = "3e7677d7a40d348a3daba263a2b1c0aa41910710";
export const STACK_CHAT_MUSE_30B_MLX_MODEL: CatalogModelLike = {
  id: "muse-glimmer-30b-mlx-4bit",
  role: "chat",
  repo: MUSE_30B_MLX_REPO,
  license: "Apache-2.0",
  revision: MUSE_30B_MLX_REVISION,
  engine: "omlx",
  sizing: { profile: "p64", quantization: "MLX 4-bit (affine, group 64)" },
  download: {
    url: hfUrl(`${MUSE_30B_MLX_REPO}/resolve/${MUSE_30B_MLX_REVISION}/model-00001-of-00004.safetensors`),
    sha256: "72c99dc670867308f70aab212331e4dd0e19d46bf409a134da1848b9dbe47c91",
    approx_bytes: 19_443_246_692,
    directory: "Muse-Glimmer-30B-4bit",
    files: [
      { path: "config.json", sha256: "c7f48468db2ef9c3de4cb912be24ecc9fbed36d83f3b8386a0b224ee7ba876ca", bytes: 6_796 },
      { path: "generation_config.json", sha256: "b0e427c998641420eb4091cc85d4e15643fb57f89222834a14ec76430625b6fb", bytes: 148 },
      { path: "chat_template.jinja", sha256: "114f55ebdc1804c1af371197b9fdf2d6bb925966c9dfe46b73782a71bc07965e", bytes: 7_167 },
      { path: "model-00001-of-00004.safetensors", sha256: "72c99dc670867308f70aab212331e4dd0e19d46bf409a134da1848b9dbe47c91", bytes: 5_310_085_129 },
      { path: "model-00002-of-00004.safetensors", sha256: "f2af4b82d578cee5eeeef3f0d3f139eae3adfc2fc2a27b52ec2ac5886e131cf4", bytes: 5_366_299_665 },
      { path: "model-00003-of-00004.safetensors", sha256: "2892bb7971d20a7ecfd84a51404e0ae1f0863580562ccef58fdf444da25bc5a2", bytes: 5_343_216_475 },
      { path: "model-00004-of-00004.safetensors", sha256: "6496c62ac6a229be31c784835c43077224e80750182c2693e29c08ddae455a31", bytes: 3_395_202_844 },
      { path: "model.safetensors.index.json", sha256: "10e1f963a4dc827c303594d988c6d44711171eaa70eeb3e810c2ce321d4c0323", bytes: 218_191 },
      { path: "processor_config.json", sha256: "cfa67148d85e40281b4a126253a1476a63b11137e21cb2422b7ccff46a11c1af", bytes: 395 },
      { path: "tokenizer.json", sha256: "c9dbee66967b58f31a7c27f723c3760da3526ccd0427578e8905b0abb0031c4d", bytes: 28_129_897 },
      { path: "tokenizer_config.json", sha256: "b2c352bba1d2ee25295aa84e7bdaa15a2b0305b79009926bcea72516ca200d42", bytes: 79_985 },
    ],
  },
  launch: { chatTemplateKwargs: { reasoning_strength: "low" }, readsPictures: true },
  sampling: MUSE_30B_SAMPLING,
  measured: { footprintBytes: 22_000_000_000, contextLength: 131_072, hardware: "Apple M5 Max, 128 GB unified memory" },
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

// The second `tts` engine (VOICE-STUDIO-01): Chatterbox Turbo 350M through
// the mlx-audio port, pinned as the mlx-community fp16 conversion at one
// commit, every file by sha256 and size. Placed in the hub cache like
// Pocket's files; the engine runs offline and reads them there. The
// weights card says Apache-2.0 (the upstream ResembleAI card says MIT;
// both permit this use); the mlx-audio code is MIT; the MLX port carries
// no watermark code. The reference-clip tokenizer (S3TokenizerV2, 472 MB)
// is not pinned: the default voice is the repository's own conditioning
// file, and cloning waits for its slice. Measured 2026-10-17, M5 Max
// 128 GB: first audio 0.45 s, real-time factor 0.27, 4.8 GB peak.
const CHATTERBOX_REPO = "mlx-community/chatterbox-turbo-fp16";
const CHATTERBOX_REVISION = "b2d0a13aa7cfff0a06d9acb247ae91c8f19a6d75";
export const CHATTERBOX_ENGINE = "chatterbox-turbo";
const CHATTERBOX_FILES: Array<{ file: string; sha256: string; bytes: number }> = [
  { file: "config.json", sha256: "aacce8af47c9c930636e47da981339fe0d30e08623d19226aa9a43bd3425b736", bytes: 2_059 },
  { file: "added_tokens.json", sha256: "72e4ab6acb0d9309ac3df4b526ae5fd80a2da5bc5ab7bb02d85096a374f69193", bytes: 418 },
  { file: "merges.txt", sha256: "1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5", bytes: 456_318 },
  { file: "special_tokens_map.json", sha256: "92ba8063bf40aa163eadebbfe0de07c2aebe44cf0d4a9e8726580b0781fd2640", bytes: 470 },
  { file: "tokenizer_config.json", sha256: "bca16a2ac1ddbd78b8d6228f0031884cc74b6ea54b967d6f6d2ebae9ccde23e6", bytes: 3_878 },
  { file: "vocab.json", sha256: "f6bd25a65e4e63ca31360e9fb11c7e4f9a391a78385d640acd814092dd6eee4f", bytes: 999_186 },
  { file: "conds.safetensors", sha256: "df9ad2c54848027d94cf01f9fc0ed22bc5d3165df6e6a85c903c1124b8a78a4a", bytes: 164_884 },
];
export const STACK_TTS_CHATTERBOX_MODEL: CatalogModelLike = {
  id: "chatterbox-turbo-fp16",
  role: "tts",
  repo: CHATTERBOX_REPO,
  license: "Apache-2.0",
  revision: CHATTERBOX_REVISION,
  engine: CHATTERBOX_ENGINE,
  sizing: { profile: "p64", quantization: "fp16" },
  download: {
    url: hfUrl(`${CHATTERBOX_REPO}/resolve/${CHATTERBOX_REVISION}/model.safetensors`),
    sha256: "9f70328a3f6c5257257aea76e9b14c34d8225745d133e4c1e83aa31f3f72a80b",
    approx_bytes: 2_985_990_960,
    hub_file: "model.safetensors",
  },
  // The post-warm peak of the MLX arrays (mx.get_peak_memory) on the Studio.
  measured: { footprintBytes: 4_800_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
export const STACK_TTS_CHATTERBOX_PARTS: CatalogModelLike[] = CHATTERBOX_FILES.map((part) => ({
  id: `chatterbox-turbo-fp16-${part.file.replace(/\.[^.]+$/, "").replace(/_/g, "-")}`,
  role: "tts" as const,
  component: `chatterbox-${part.file.replace(/\.[^.]+$/, "").replace(/_/g, "-")}`,
  repo: CHATTERBOX_REPO,
  license: "Apache-2.0",
  revision: CHATTERBOX_REVISION,
  engine: CHATTERBOX_ENGINE,
  sizing: { profile: "p64", quantization: "n/a" },
  download: { url: hfUrl(`${CHATTERBOX_REPO}/resolve/${CHATTERBOX_REVISION}/${part.file}`), sha256: part.sha256, approx_bytes: part.bytes, hub_file: part.file },
}));

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

// IMAGETOOLS-01: the three small ONNX models behind the image tools,
// pinned by revision and sha256 and placed in the hub cache like every
// `hub_file` pin. They are components of the `image` role (never selected
// as the image generator) for the `image-tools` runtime. Benchmarked on
// the Studio (M5 Max, CPU provider, 2026-10-17): IS-Net 0.8 s and 3.2 GB
// peak per picture, LaMa 2 to 4 s and 1.9 GB, Real-ESRGAN general x4v3
// 2.7 s for 1024 to 4096 and 1.4 GB. Licences: IS-Net general use is
// Apache-2.0 upstream (DIS) and MIT on the imgly ONNX card; LaMa
// (big-lama) is Apache-2.0; Real-ESRGAN is BSD-3-Clause. The ONNX files
// are third-party conversions of those weights; the sha256 pins which
// bytes are accepted.
const IMAGE_TOOL_ENGINE = "image-tools";
function imageToolPin(id: string, component: string, repo: string, revision: string, file: string, license: string, sha256: string, bytes: number, peak: number): CatalogModelLike {
  return {
    id, role: "image", component, repo, license, revision, engine: IMAGE_TOOL_ENGINE,
    sizing: { profile: "p16", quantization: "fp32" },
    download: { url: hfUrl(`${repo}/resolve/${revision}/${file}`), sha256, approx_bytes: bytes, hub_file: file },
    measured: { footprintBytes: peak, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
  };
}
export const STACK_IMAGE_TOOL_MODELS: CatalogModelLike[] = [
  imageToolPin("image-tool-isnet-general", "tool-isnet-general", "imgly/isnet-general-onnx", "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f", "onnx/model.onnx", "MIT", "cc2c9f5c1751b9737cb81e708ff0c5e9542c2205daed22418a4fd2ab5d4c481a", 176_149_806, 3_400_000_000),
  imageToolPin("image-tool-lama-big", "tool-lama", "Carve/LaMa-ONNX", "c3c0c9e468934d62e79c329e35d82dd09ff8c444", "lama_fp32.onnx", "Apache-2.0", "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6", 208_044_816, 2_000_000_000),
  imageToolPin("image-tool-realesrgan-general-x4v3", "tool-realesrgan", "Heliosoph/realesrgan-onnx", "488e5dda07333179f229a6205d92135eea4c25e9", "realesr-general-x4v3.onnx", "BSD-3-Clause", "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4", 4_871_181, 1_500_000_000),
];

// VIDEO-GEN-01: the `video` role's pin. Wan2.2 TI2V-5B with the FastWan
// 3-step DMD distillation, converted to MLX (bf16), at one revision of
// the community conversion, every file by sha256 and size (the three
// large oids are the repository's git-lfs oids, confirmed against a
// live revision listing and by hashing the benchmarked copy). A
// directory model, like the MLX chat pin: the worker reads the folder.
// Licences: the conversion's card says Apache-2.0, the base
// Wan-AI/Wan2.2-TI2V-5B is Apache-2.0 and FastVideo/FastWan2.2-TI2V-5B
// is Apache-2.0; the runtime (mlx-video) is MIT. No safety filter exists
// in the weights or the runtime, so every gate lives in Home. Measured
// 2026-10-17, Apple M5 Max 128 GB: 5 s, 121 frames, 24 fps at 832 x 480
// in 130 to 140 s, peak memory footprint 44.1 GB with `--tiling
// aggressive` (any other tiling peaks near 112 GB). The tokenizer is the
// umt5 files mlx-video would otherwise fetch from the Hub at run time;
// pinned here so the worker runs offline.
const VIDEO_REPO = "lBroth/FastWan2.2-TI2V-5B-MLX";
const VIDEO_REVISION = "de2998ac446581895089ae363f4dcc0c02ca9ea2";
export const VIDEO_ENGINE = "video-gen";
export const STACK_VIDEO_MODEL_ID = "fastwan2-2-ti2v-5b-mlx-bf16";
export const STACK_VIDEO_TOKENIZER_ID = "video-umt5-tokenizer";
const VIDEO_FILES = [
  { path: "model.safetensors", sha256: "d770a93f780208ad8b4edea9ea17c1f9532debb59292688ea038e824a30bbf84", bytes: 9_999_659_892 },
  { path: "t5_encoder.safetensors", sha256: "e86ee4199903e00a88dcd43583a43a6eb898cef600e38670f222d7e37d163787", bytes: 11_361_845_505 },
  { path: "vae.safetensors", sha256: "a2d3602f692144facc3d58c56db30820c4400e67d4bb821feff3ea8347629804", bytes: 2_818_778_952 },
  { path: "config.json", sha256: "6c6520bb7c9af3172de23a7acf67b53958974d81001eac5b6ab24d9577018003", bytes: 1_662 },
];
export const STACK_VIDEO_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_MODEL_ID,
  role: "video",
  repo: VIDEO_REPO,
  license: "Apache-2.0",
  revision: VIDEO_REVISION,
  engine: VIDEO_ENGINE,
  sizing: { profile: "p64", quantization: "bf16" },
  download: {
    url: hfUrl(`${VIDEO_REPO}/resolve/${VIDEO_REVISION}/model.safetensors`),
    sha256: VIDEO_FILES[0]!.sha256,
    approx_bytes: VIDEO_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "FastWan2.2-TI2V-5B-MLX",
    files: VIDEO_FILES,
  },
  measured: { footprintBytes: 44_088_747_800, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
const UMT5_REPO = "google/umt5-xxl";
const UMT5_REVISION = "66cb9e7e85526fe440a945569e42c72fb6cbc0ad";
const UMT5_FILES = [
  { path: "tokenizer.json", sha256: "af904105ce1071b1202bba0059a841f4a7b85b48b6ec179c4948e3483476e0dd", bytes: 16_853_013 },
  { path: "tokenizer_config.json", sha256: "616015e2b6c26f9a98ae3171634518d440a46260ebc1115c2596792d33827bdc", bytes: 6_841 },
  { path: "special_tokens_map.json", sha256: "14ef492a69e59396e918521a5f8394af1acf9f8dddd47273693b2b42570dfd12", bytes: 6_623 },
  { path: "spiece.model", sha256: "e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458", bytes: 4_548_313 },
];
export const STACK_VIDEO_TOKENIZER: CatalogModelLike = {
  id: STACK_VIDEO_TOKENIZER_ID,
  role: "video",
  component: "tokenizer",
  repo: UMT5_REPO,
  license: "Apache-2.0",
  revision: UMT5_REVISION,
  engine: VIDEO_ENGINE,
  sizing: { profile: "p64", quantization: "n/a" },
  download: {
    url: hfUrl(`${UMT5_REPO}/resolve/${UMT5_REVISION}/tokenizer.json`),
    sha256: UMT5_FILES[0]!.sha256,
    approx_bytes: UMT5_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "umt5-xxl-tokenizer",
    files: UMT5_FILES,
  },
};
export const STACK_VIDEO_MODELS: CatalogModelLike[] = [STACK_VIDEO_MODEL, STACK_VIDEO_TOKENIZER];

// IMGGEN-STACK-01 (docs/design/image-engine-2026-10-17.md in Home): the
// image generator's weights for the mflux worker. One family is a primary
// record (the transformer, or its first shard) plus a component record for
// every other file mflux reads, all placed in the hub cache at the pinned
// revision; the worker is handed that snapshot folder and runs offline.
// The same bf16 weights serve 8-bit generation (quantized in memory at
// load, 2 s) and bf16 reference edits. Peaks are the MLX allocations
// measured on the Studio (M5 Max, 128 GB), 1024 x 1024.
export const IMAGE_ENGINE_NAME = "mflux";
export const STACK_IMAGE_KLEIN_ID = "flux2-klein-4b";
export const STACK_IMAGE_ZIMAGE_ID = "z-image-turbo";
function imageFamily(id: string, repo: string, revision: string, primary: string, files: ImagePinFile[], profile: string, footprint: number): CatalogModelLike[] {
  const pin = (file: ImagePinFile): CatalogModelLike["download"] => ({ url: hfUrl(`${repo}/resolve/${revision}/${file.file}`), sha256: file.sha256, approx_bytes: file.bytes, hub_file: file.file });
  const main = files.find((file) => file.file === primary)!;
  const head: CatalogModelLike = { id, role: "image", repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization: "bf16, run 8-bit" }, download: pin(main), measured: { footprintBytes: footprint, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } };
  const parts = files.filter((file) => file.file !== primary).map((file): CatalogModelLike => ({ id: `${id}-${file.file.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, role: "image", component: `${id}:${file.file}`, repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization: "bf16" }, download: pin(file) }));
  return [head, ...parts];
}
export const STACK_IMAGE_KLEIN_MODELS = imageFamily(STACK_IMAGE_KLEIN_ID, KLEIN_4B_REPO, KLEIN_4B_REVISION, KLEIN_4B_PRIMARY, KLEIN_4B_FILES, "p32", 13_500_000_000);
export const STACK_IMAGE_ZIMAGE_MODELS = imageFamily(STACK_IMAGE_ZIMAGE_ID, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_FILES, "p128", 30_100_000_000);
export const STACK_IMAGE_ENGINE_MODELS: CatalogModelLike[] = [...STACK_IMAGE_KLEIN_MODELS, ...STACK_IMAGE_ZIMAGE_MODELS];

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
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_MODEL, STACK_CHAT_8B_MODEL, STACK_CHAT_MUSE_30B_XL_MODEL, STACK_CHAT_MUSE_30B_M_MODEL, STACK_CHAT_MUSE_30B_MLX_MODEL, STACK_CHAT_MUSE_30B_PROJECTOR, STACK_JUDGE_MODEL, STACK_MLX_CHAT_MODEL, STACK_STT_MODEL, STACK_VAD_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS, STACK_IMAGE_MODEL, ...STACK_IMAGE_TOOL_MODELS, ...STACK_IMAGE_ENGINE_MODELS, ...STACK_VIDEO_MODELS, STACK_EMBED_MODEL, STACK_VISION_MODEL, STACK_VISION_PROJECTOR, STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR, ...STACK_WAKEWORD_MODELS];

// Engines and models named in dev.md or the backlog for a role but not
// pinned yet: the components inventory lists them as candidates, so a
// role with no pin never reads as forgotten. Each names where it came from.
export interface RoleCandidate { name: string; kind: "engine" | "model"; source: string; }
export const ROLE_CANDIDATES: Partial<Record<string, RoleCandidate[]>> = {
  chat: [
  ],
  stt: [
    { name: "Whisper tiny.en or base.en on the same runtime, the named alternative", kind: "model", source: "dev.md, The speech roles" },
  ],
  tts: [
    { name: "Kokoro 82M through the stt worker's runtime, rejected by the owner's ear on 2026-09-04; the alternative if he reverses it", kind: "model", source: "dev.md, The speech roles" },
  ],
  video: [
    { name: "Kandinsky 6.0 Lite distill (3B, MIT, sound-capable), the second pin; no MLX port yet", kind: "model", source: "docs/design/video-generation-2026-10-17.md in Home, VIDEO-GEN-10" },
    { name: "Wan2.2 A14B (the quality profile, two 14B experts)", kind: "model", source: "docs/design/video-generation-2026-10-17.md in Home, VIDEO-GEN-10" },
  ],
  music: [
    { name: "ACE-Step 1.5 (managed, the official MLX backend, acestep-api), the owner's pick", kind: "engine", source: "docs/plans/jev-and-yue-2026-09-20.md; STACK-99" },
  ],
};
