import { hfUrl } from "@/lib/hf";
import type { CatalogModelLike } from "@/lib/modelStore";
import { ERNIE_IMAGE_TURBO_FILES, ERNIE_IMAGE_TURBO_PRIMARY, ERNIE_IMAGE_TURBO_REPO, ERNIE_IMAGE_TURBO_REVISION, KLEIN_4B_FILES, KLEIN_4B_PRIMARY, KLEIN_4B_REPO, KLEIN_4B_REVISION, ZIMAGE_TURBO_FILES, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, type ImagePinFile } from "@/images/pins";

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

// MODEL-SWITCH-01 / CHAT-TPS-04 (2026-10-21): Qwen3.6-35B-A3B, an optional
// chat model an admin installs and chooses in Home Settings, Models. It is
// not bound to any tier: Muse stays the household default (STACK-MUSE-01).
// Mixture of experts, 35B stored and 3B active per token, 40 layers (10
// full-attention layers beside 30 Gated DeltaNet layers), 2 KV heads,
// 262,144 context, Apache-2.0 on the card. Unsloth's GGUF repository,
// pinned to one revision; sha256 and sizes are the repository's git-lfs
// oids. The template reasons by default; the engine's `--reasoning off`
// (every chat launch) turns that off, and a request's own
// `chat_template_kwargs: { enable_thinking: true }` turns it back on for
// one turn. The model has no `/nothink` soft switch. Sampling is the
// card's non-thinking set. The F16 projector (0.9 GB) loads beside the
// weights in the one chat process, so the model reads pictures.
const QWEN36_35B_REPO = "unsloth/Qwen3.6-35B-A3B-GGUF";
const QWEN36_35B_REVISION = "a483e9e6cbd595906af30beda3187c2663a1118c";
export const STACK_CHAT_QWEN36_35B_PROJECTOR: CatalogModelLike = {
  id: "qwen3-6-35b-a3b-mmproj-f16",
  role: "chat",
  component: "projector",
  repo: QWEN36_35B_REPO,
  license: "Apache-2.0",
  revision: QWEN36_35B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p64", quantization: "F16" },
  download: {
    url: hfUrl(`${QWEN36_35B_REPO}/resolve/${QWEN36_35B_REVISION}/mmproj-F16.gguf`),
    sha256: "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f",
    approx_bytes: 899_283_680,
  },
};
export const STACK_CHAT_QWEN36_35B_MODEL: CatalogModelLike = {
  id: "qwen3-6-35b-a3b-ud-q4-k-xl",
  role: "chat",
  repo: QWEN36_35B_REPO,
  license: "Apache-2.0",
  revision: QWEN36_35B_REVISION,
  engine: "llama-server",
  sizing: { profile: "p64", quantization: "UD-Q4_K_XL" },
  download: {
    url: hfUrl(`${QWEN36_35B_REPO}/resolve/${QWEN36_35B_REVISION}/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`),
    sha256: "707a55a8a4397ecde44de0c499d3e68c1ad1d240d1da65826b4949d1043f4450",
    approx_bytes: 22_360_456_160,
  },
  imageInput: { projector: STACK_CHAT_QWEN36_35B_PROJECTOR.id },
  launch: { imageMaxTokens: 2560 },
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen/Qwen3.6-35B-A3B model card, non-thinking (instruct) sampling" },
};

// Optional uncensored chat model: huihui-ai's abliterated Qwen3.8-27B GGUF
// (UD-IQ4_XS), which replaced the HauhauCS Aggressive Q4_K_P build on
// 2026-10-27 after a short side-by-side on this Mac (same answers on
// reasoning, facts, tool calls and refusals; 3.5 GB smaller file). An admin
// installs it on purpose and chooses it in Home Settings; no tier binds or
// downloads it. Home's age and surface gates still apply. The file and
// projector hashes below are the repository's git-lfs oids, one revision.
const QWEN38_UNCENSORED_REPO = "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF";
const QWEN38_UNCENSORED_REVISION = "1c69098e9c32db6dc06fc48f1d6cc75ad07da89e";
export const STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR: CatalogModelLike = {
  id: "qwen3-8-27b-huihui-abliterated-mmproj-bf16",
  role: "chat",
  component: "projector",
  repo: QWEN38_UNCENSORED_REPO,
  license: "Apache-2.0",
  revision: QWEN38_UNCENSORED_REVISION,
  engine: "llama-server",
  sizing: { profile: "p64", quantization: "BF16" },
  download: {
    url: hfUrl(`${QWEN38_UNCENSORED_REPO}/resolve/${QWEN38_UNCENSORED_REVISION}/mmproj-model-bf16.gguf`),
    sha256: "c9a09064683620bea3d3bfed5d4462e1a97a7d2fff7e5045d6862a0a85eeb5b5",
    approx_bytes: 931_145_888,
  },
};
export const STACK_CHAT_QWEN38_UNCENSORED_MODEL: CatalogModelLike = {
  id: "qwen3-8-27b-huihui-abliterated-iq4-xs",
  role: "chat",
  repo: QWEN38_UNCENSORED_REPO,
  license: "Apache-2.0",
  revision: QWEN38_UNCENSORED_REVISION,
  engine: "llama-server",
  sizing: { profile: "p64", quantization: "UD-IQ4_XS" },
  download: {
    url: hfUrl(`${QWEN38_UNCENSORED_REPO}/resolve/${QWEN38_UNCENSORED_REVISION}/Huihui-Qwen3.8-27B-abliterated-UD-IQ4_XS.gguf`),
    sha256: "d83adbbbaace8acdfcfe28004f779326176b9df00b4ec99dc6c24d749723d3b9",
    approx_bytes: 14_403_496_864,
  },
  imageInput: { projector: STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR.id },
  launch: { imageMaxTokens: 2560 },
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen/Qwen3.8-27B model card, instruct/non-thinking sampling (the fine-tune's base model)" },
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

// The `coding` pin (CODE-STACK-01 S1, owner decision 2026-10-18): Qwen3.8-27B,
// dense, at Unsloth's UD-Q4_K_M, bound on p64 and p128 and loaded only while
// someone is coding. unsloth/Qwen3.8-27B-GGUF at HEAD 4ca72078 (read from
// huggingface.co/api/models on 2026-10-18); the file's size and sha256 are
// the repository's git-lfs oid and size, and the sha256 was re-hashed from
// the copy the owner benchmarked. Licence Apache-2.0 on both the GGUF
// repository's metadata and Qwen/Qwen3.8-27B's model card. Sampling is the
// Qwen card's "Thinking Mode" set (Best Practices); the card gives no
// coding-only set, and its SWE-bench runs used temperature 1.0 and top_p 0.95.
// The card's min_p 0.0 and repetition_penalty 1.0 are the engines' defaults.
const QWEN38_27B_REPO = "unsloth/Qwen3.8-27B-GGUF";
const QWEN38_27B_REVISION = "4ca720788d1e01f1bff70c033e0d0028fd02e502";
export const STACK_CODING_MODEL: CatalogModelLike = {
  id: "qwen3.8-27b-ud-q4-k-m",
  role: "coding",
  repo: QWEN38_27B_REPO,
  license: "Apache-2.0",
  revision: QWEN38_27B_REVISION,
  engine: "llama-server",
  companions: ["qwen3.8-27b-dflash2-draft"],
  sizing: { profile: "p64", quantization: "UD-Q4_K_M" },
  download: {
    url: hfUrl(`${QWEN38_27B_REPO}/resolve/${QWEN38_27B_REVISION}/Qwen3.8-27B-UD-Q4_K_M.gguf`),
    sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482",
    approx_bytes: 16_464_440_224,
  },
  sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 0.0, source: "Qwen/Qwen3.8-27B model card, Best Practices, Thinking Mode (the card has no coding-only set; its SWE-bench runs used temperature 1.0 and top_p 0.95)" },
};

// The coding model's Splash draft (CODE-STACK-01 S5a): Inco's DFlash2 draft for
// Qwen3.8-27B, the speculative-decoding model Splash pairs with the target to reach
// about 124 tokens/s on the Studio against 27.6 on llama-server. incoai/Qwen3.8-27B-DFlash2
// at commit 015e7956 (huggingface.co/api/models, 2026-10-18); Apache-2.0 (the repository's
// metadata). Two files: config.json (1,239 bytes, a plain git blob, so its sha256 was hashed
// from the download) and model.safetensors (BF16, 3,848,817,896 bytes, sha256 = the
// repository's git-lfs oid, confirmed by the HEAD request's x-linked-etag). It installs and
// is removed with the coding model (`companions` on the coding pin), is installed only where
// Splash can run, and only Splash reads it: llama-server and every other engine ignore it.
// The Stack lays both files into Splash's own hub-cache folder by hardlink (lib/splashStore.ts)
// and Splash never downloads them: the Stack's downloader verifies the hashes here.
export const QWEN38_27B_DRAFT_REPO = "incoai/Qwen3.8-27B-DFlash2";
const QWEN38_27B_DRAFT_REVISION = "015e795645c74b1a0eeef3b570031fb62e769bc5";
export const STACK_CODING_DRAFT_MODEL: CatalogModelLike = {
  id: "qwen3.8-27b-dflash2-draft",
  role: "coding",
  component: "draft",
  repo: QWEN38_27B_DRAFT_REPO,
  license: "Apache-2.0",
  revision: QWEN38_27B_DRAFT_REVISION,
  engine: "splash",
  sizing: { profile: "p64", quantization: "BF16" },
  download: {
    url: hfUrl(`${QWEN38_27B_DRAFT_REPO}/resolve/${QWEN38_27B_DRAFT_REVISION}/model.safetensors`),
    sha256: "67fc76d68dc5a9415511a4f394ef744d67510cd20e93b37cc2cc7d28e4bab65c",
    approx_bytes: 3_848_817_896,
    directory: "Qwen3.8-27B-DFlash2",
    files: [
      { path: "config.json", sha256: "873e3556509b0da06e29654ba00d4944888d4b5e8a33afde25f7eb27d321e980", bytes: 1_239 },
      { path: "model.safetensors", sha256: "67fc76d68dc5a9415511a4f394ef744d67510cd20e93b37cc2cc7d28e4bab65c", bytes: 3_848_817_896 },
    ],
  },
};

// Home's optional p128 coding choice: Ornith-1.5-122B in MLX 4-bit, pinned
// from verified files (MIT). Its model-card sampling is for precise coding
// tasks; Home's first-run plan and default selection remain the 27B model.
export const ORNITH_122B_REPO = "ezoushen/ornith-1.5-122b-mlx-4bit";
const ORNITH_122B_REVISION = "e30487752c2fcb9157ec970060a2a018be94563c";
export const ORNITH_122B_DRAFT_REPO = "incoai/Ornith-1.5-122B-DFlash2";
const ORNITH_122B_DRAFT_REVISION = "9baefc1bec85c08193ab442e0ca5f7057669b61d";

export const STACK_CODING_HEAVY_MODEL: CatalogModelLike = {
  id: "ornith-1-5-122b-mlx-4bit",
  role: "coding",
  repo: ORNITH_122B_REPO,
  license: "MIT",
  revision: ORNITH_122B_REVISION,
  engine: "splash",
  // 2026-10-22, provisional: measured on a 128 GB machine through a real mode switch (self-test with a tool call and a thinking
  // turn, hard coding tasks the 27B fails, a coding task through Home's gateway). The household chat bench (CHAT-AB-01: tool
  // decision, repetition, companion voice, contention) is still owed, so minors keep thinking off and no tools (rule 8).
  modeVerdict: "offer_with_limits",
  companions: ["ornith-1-5-122b-dflash2-draft"],
  sizing: { profile: "p128", quantization: "MLX-4bit" },
  download: {
    url: hfUrl(`${ORNITH_122B_REPO}/resolve/${ORNITH_122B_REVISION}/model-00013-of-00014.safetensors`),
    sha256: "42e689b43451bc89f5c6340d291b2a19723baa90da243da47516ec384e1f67fb",
    approx_bytes: 69642918741,
    directory: "Ornith-1.5-122B-MLX-4bit",
    files: [
      { path: "chat_template.jinja", sha256: "8b4d21a1e70ccbc8849e5e5e6dd32f3acfb2e2060739475909edc6e9b27c7165", bytes: 7_594 },
      { path: "config.json", sha256: "6de6931334221a4783c5d27f8b379bf72571f1d357e67bbd07c6f06b314c67b9", bytes: 23_357 },
      { path: "merges.txt", sha256: "a9d356d7bdf1ef4949e3e748e95b8e10ad9d4e2e838eddc38a0a7b6b94d1db8d", bytes: 3_353_259 },
      { path: "model-00001-of-00014.safetensors", sha256: "e862bf75c1099ca1acf55532a91e1b5f8307f4e9d428aec8f1842d050ccce587", bytes: 5_172_126_621 },
      { path: "model-00002-of-00014.safetensors", sha256: "9ad63e3052915e6a663e412b20c2bbf3aeb2720ffbe440145b4fa42a0ce1a701", bytes: 5_201_327_902 },
      { path: "model-00003-of-00014.safetensors", sha256: "1ce16e6c33c4bf74ab84fa6a844228015efdc7607bd3d2f858671ecb6fe96df6", bytes: 5_150_926_576 },
      { path: "model-00004-of-00014.safetensors", sha256: "12198e1aeb861366429145bfd2f76dcfdd61b381f3a1ba06fc77b6c86c83a290", bytes: 5_201_328_136 },
      { path: "model-00005-of-00014.safetensors", sha256: "da94add39a40e81db85eef8e1f8a00d7ee5c7e9faea1f3e559cae4d6754d1fbe", bytes: 5_201_328_104 },
      { path: "model-00006-of-00014.safetensors", sha256: "f090a3b7aa288d9a9c5f891a87751f6cba7632c1ed306467077c215a181478c3", bytes: 5_145_298_568 },
      { path: "model-00007-of-00014.safetensors", sha256: "1becd66dc1049f1646db52aa63f152898c3112aaebcf3deb38be2353c3980acf", bytes: 5_201_328_160 },
      { path: "model-00008-of-00014.safetensors", sha256: "e23615aff25fb72d15bc6e409e7feb13e6bdd2d99c1c85d707c22e9c0717d009", bytes: 5_201_328_072 },
      { path: "model-00009-of-00014.safetensors", sha256: "e3c6d94acc72f44976f29d2c1abfde075d6d56481decff13fa1a4063f81824c7", bytes: 5_145_298_550 },
      { path: "model-00010-of-00014.safetensors", sha256: "bf24388b98f03ee88dc60ff2a815752d576b2f6b7527e57dceae19c4dceeadd4", bytes: 5_201_328_156 },
      { path: "model-00011-of-00014.safetensors", sha256: "78b742e08c5d2f93cf530d67f73f008729232271d036fc41bb8afb891641366c", bytes: 5_201_328_064 },
      { path: "model-00012-of-00014.safetensors", sha256: "6a80e29e9325af175fa0bfe19d055f486b1109c5ebb859498bd8b0190aad3ad7", bytes: 5_145_298_572 },
      { path: "model-00013-of-00014.safetensors", sha256: "42e689b43451bc89f5c6340d291b2a19723baa90da243da47516ec384e1f67fb", bytes: 5_201_328_180 },
      { path: "model-00014-of-00014.safetensors", sha256: "8c9601642ce7e20407500dece66b58c61f84a1b2239ffcb5f850a82d5466d7e4", bytes: 1_340_387_394 },
      { path: "model-vision.safetensors", sha256: "97095a5a86d7da387057f1be4f2ccf8d6479b0f985a5d486a00a3751fef4f4a0", bytes: 902_618_768 },
      { path: "model.safetensors.index.json", sha256: "deea07c02a2b760c991d27e5646c3c42bae8d5fa8a4a63be349f95655485f3a1", bytes: 240_719 },
      { path: "preprocessor_config.json", sha256: "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516", bytes: 390 },
      { path: "tokenizer.json", sha256: "a5cd9732badce41de57e6efce8302930ded1c1188c5f81feb2bd6c24c4a1941f", bytes: 19_989_339 },
      { path: "tokenizer_config.json", sha256: "86f01837a638275f2d3479804e79802aaff0e3ccef15e5f29dd6afbe6551daed", bytes: 1_501 },
      { path: "vocab.json", sha256: "ce99b4cb2983d118806ce0a8b777a35b093e2000a503ebde25853284c9dfa003", bytes: 6_722_759 },
    ],
  },
  sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.0, source: "ornith-ai/Ornith-1.5-122B model card, precise coding tasks" },
};

// The pinned Apache-2.0 DFlash2 companion uses verified files and is installed
// only with the optional p128 Ornith coding model.
export const STACK_CODING_HEAVY_DRAFT_MODEL: CatalogModelLike = {
  id: "ornith-1-5-122b-dflash2-draft",
  role: "coding",
  component: "draft",
  repo: ORNITH_122B_DRAFT_REPO,
  license: "Apache-2.0",
  revision: ORNITH_122B_DRAFT_REVISION,
  engine: "splash",
  sizing: { profile: "p128", quantization: "BF16" },
  download: {
    url: hfUrl(`${ORNITH_122B_DRAFT_REPO}/resolve/${ORNITH_122B_DRAFT_REVISION}/model.safetensors`),
    sha256: "448fed97ee07d1bd2ab2550231ceeb6272f7c846903bac46060757757227b05f",
    approx_bytes: 1860569628,
    directory: "Ornith-1.5-122B-DFlash2",
    files: [
      { path: "config.json", sha256: "f85c6e9f50a2f9bd5cc6d855569de90e96dd697a6c4a9f6911f19244bf361f52", bytes: 1_292 },
      { path: "model.safetensors", sha256: "448fed97ee07d1bd2ab2550231ceeb6272f7c846903bac46060757757227b05f", bytes: 1_860_568_336 },
    ],
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
  companions: ["smart-turn-v3.2"],
};
// The optional Parakeet TDT 0.6B v2 int8 package from the same rolling
// `asr-models` release. The checksum pins the asset because the tag can
// replace it under the same name. The archive extracts to three ONNX
// files plus tokens.
export const STACK_STT_PARAKEET_V2_MODEL: CatalogModelLike = {
  id: "parakeet-tdt-0.6b-v2-int8",
  role: "stt",
  repo: "k2-fsa/sherpa-onnx",
  license: "CC-BY-4.0",
  revision: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
  engine: "sherpa-onnx-node",
  sizing: { profile: "p64", quantization: "int8" },
  download: {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
    sha256: "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
    approx_bytes: 482_468_385,
    archive: true,
  },
  measured: { footprintBytes: 1_940_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
  companions: ["smart-turn-v3.2"],
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

// Smart Turn v3.2 (pipecat-ai/smart-turn-v3, BSD-2-Clause): the end-of-turn
// classifier behind POST /v1/audio/endpoint, a component of the `stt` role
// like Silero. 8 MB, CPU. The repository commit and the file's checksum pin
// it (DUPLEX-02); it reads the last 8 s of 16 kHz speech and answers whether
// the speaker has finished.
const SMART_TURN_REPO = "pipecat-ai/smart-turn-v3";
const SMART_TURN_REVISION = "f766f81d3cfdf7737ac64aad813d91bbfd56bf93";
export const STACK_ENDPOINT_MODEL: CatalogModelLike = {
  id: "smart-turn-v3.2",
  role: "stt",
  component: "endpoint",
  repo: SMART_TURN_REPO,
  license: "BSD-2-Clause",
  revision: SMART_TURN_REVISION,
  engine: "onnxruntime-web",
  sizing: { profile: "p16", quantization: "int8" },
  download: {
    url: hfUrl(`${SMART_TURN_REPO}/resolve/${SMART_TURN_REVISION}/smart-turn-v3.2-cpu.onnx`),
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    approx_bytes: 8_679_182,
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

// VOICES-02: the reference-clip tokenizer a cloned voice is encoded through (S3TokenizerV2, 495 MB), pinned by commit,
// sha256 and size like every file here but fetched on the first clip voice rather than with the first-run plan: the
// default voice never needs it, and a household that never makes a voice never pays the disk. Like the gated Pocket
// cloning weights it is not part of STACK_MODELS (the engine runs without it). The repository declares no licence of
// its own; it is the MLX conversion of CosyVoice2-0.5B's speech tokenizer (FunAudioLLM, Apache-2.0).
export const CHATTERBOX_CLONER_REPO = "mlx-community/S3TokenizerV2";
export const CHATTERBOX_CLONER_REVISION = "e0c9886f0e1c35ae85b1f27277416fb19fc72bec";
export const STACK_TTS_CHATTERBOX_CLONER: CatalogModelLike = {
  id: "chatterbox-cloner-s3-tokenizer-v2",
  role: "tts",
  component: "chatterbox-cloner",
  repo: CHATTERBOX_CLONER_REPO,
  license: "Apache-2.0",
  revision: CHATTERBOX_CLONER_REVISION,
  engine: CHATTERBOX_ENGINE,
  sizing: { profile: "p64", quantization: "n/a" },
  download: {
    url: hfUrl(`${CHATTERBOX_CLONER_REPO}/resolve/${CHATTERBOX_CLONER_REVISION}/model.safetensors`),
    sha256: "928726bc1f206a613d36b8f49e297eae9c5593a21bf9b92ddfe2c23f85eb92cc",
    approx_bytes: 494_868_984,
    hub_file: "model.safetensors",
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
  { id: "image-tool-yolox-nano", role: "image", component: "tool-look", repo: "Megvii-BaseDetection/YOLOX", license: "Apache-2.0", revision: "0.1.1rc0", engine: "image-tools", sizing: { profile: "p16", quantization: "fp32" }, download: { url: "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx", sha256: "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d", approx_bytes: 3_659_407 }, measured: { footprintBytes: 150_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } },
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

// MUSIC-GEN-01 (docs/design/music-generation-2026-10-17.md in Home, section
// 3): the `music` role's pins. ACE-Step 1.5 (MIT; the card states it was
// trained on licensed, royalty-free and synthetic audio and that output may
// be used commercially, read 2026-10-17): the 2B turbo DiT, the 1.7B planning
// LM (the "detailed" quality), the Qwen3-Embedding-0.6B text encoder and the
// music VAE, from one revision of ACE-Step/Ace-Step1.5, laid out as ACE-Step
// reads its checkpoints folder (one directory model, every file by sha256 and
// size; the LFS hashes are the Hub's own and were checked against the bytes).
// Two files of that repository are left out on purpose: the model repository's
// `modeling_acestep_v15_turbo.py` and `configuration_acestep_v15.py`. ACE-Step
// overwrites both from its own pinned package before it loads the model, so
// the code that runs is the pinned package's, never the model repository's
// (Home's note, section 3); the Stack therefore does not install them, and the
// worker's checkpoint folder lets ACE-Step write them beside the weights. The
// README and .gitattributes are left out too. The second record is the 0.6B
// planning LM (the "quick" quality, ACE-Step/acestep-5Hz-lm-0.6B, MIT), a
// separate repository, so a separate directory model; the worker's checkpoint
// folder links it in as `acestep-5Hz-lm-0.6B/` (music/musicGen.ts). The peak
// memory of a song is MUSIC_PEAK_BYTES in music/musicGen.ts (not repeated here).
const MUSIC_REPO = "ACE-Step/Ace-Step1.5";
const MUSIC_REVISION = "19671f406d603126926c1b7e2adc169acbcade22";
const MUSIC_LM06_REPO = "ACE-Step/acestep-5Hz-lm-0.6B";
const MUSIC_LM06_REVISION = "148d8ea0225bdab342ee1ae3a354275ccd60ca80";
export const MUSIC_ENGINE = "music-gen";
export const STACK_MUSIC_MODEL_ID = "ace-step-1-5-turbo";
export const STACK_MUSIC_LM_06_ID = "ace-step-1-5-lm-0-6b";
const MUSIC_FILES = [
  { path: "Qwen3-Embedding-0.6B/added_tokens.json", sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680", bytes: 707 },
  { path: "Qwen3-Embedding-0.6B/chat_template.jinja", sha256: "87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5", bytes: 4_116 },
  { path: "Qwen3-Embedding-0.6B/config.json", sha256: "bb23c1607cfe059a58d8f0196cf1cebb52082b1056b8e358a579da80a5759420", bytes: 1_359 },
  { path: "Qwen3-Embedding-0.6B/merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1_671_853 },
  { path: "Qwen3-Embedding-0.6B/model.safetensors", sha256: "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd", bytes: 1_191_586_416 },
  { path: "Qwen3-Embedding-0.6B/special_tokens_map.json", sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd", bytes: 613 },
  { path: "Qwen3-Embedding-0.6B/tokenizer.json", sha256: "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a", bytes: 11_423_705 },
  { path: "Qwen3-Embedding-0.6B/tokenizer_config.json", sha256: "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0", bytes: 5_404 },
  { path: "Qwen3-Embedding-0.6B/vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2_776_833 },
  { path: "acestep-5Hz-lm-1.7B/added_tokens.json", sha256: "db08b66a515fb5d6acca0b3492d25bb44e0deda6241fc1113ac0679d40558c48", bytes: 2_217_787 },
  { path: "acestep-5Hz-lm-1.7B/chat_template.jinja", sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8", bytes: 4_168 },
  { path: "acestep-5Hz-lm-1.7B/config.json", sha256: "73515ca4bfd86a5b56f28bf680311d1911e159c85d7f7ceb2188e310007c9010", bytes: 1_385 },
  { path: "acestep-5Hz-lm-1.7B/merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1_671_853 },
  { path: "acestep-5Hz-lm-1.7B/model.safetensors", sha256: "f161689da73e5ecefa28ff780d51c2d92a00f056d021d7933c779ed5c6cd7db8", bytes: 3_708_521_528 },
  { path: "acestep-5Hz-lm-1.7B/special_tokens_map.json", sha256: "76e233bfc357b0b03d7b6e6ba8e799244f358552575a7cdadb78d3d19106b298", bytes: 1_824_199 },
  { path: "acestep-5Hz-lm-1.7B/tokenizer.json", sha256: "35af56c3f5cb3ea2cc578aa28a8937770981d504f183ac5c8c38baf4bbd4af4d", bytes: 24_321_939 },
  { path: "acestep-5Hz-lm-1.7B/tokenizer_config.json", sha256: "6cd70cdd89425971794f5235562edcc608b0629a6c4686ae51a8b8c8b8ba5e95", bytes: 14_072_925 },
  { path: "acestep-5Hz-lm-1.7B/vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2_776_833 },
  { path: "acestep-v15-turbo/config.json", sha256: "74745ff704ea49164c3d2d1c99fc0670f3fc635a869f0aec2d1311e6a52d400a", bytes: 1_968 },
  { path: "acestep-v15-turbo/model.safetensors", sha256: "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7", bytes: 4_787_825_604 },
  { path: "acestep-v15-turbo/silence_latent.pt", sha256: "a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b", bytes: 3_841_215 },
  { path: "config.json", sha256: "74745ff704ea49164c3d2d1c99fc0670f3fc635a869f0aec2d1311e6a52d400a", bytes: 1_968 },
  { path: "vae/config.json", sha256: "14e019904df567f26df750317a70e2bd08f9f8f3c40ff4a24c97d1cd3f20ccd2", bytes: 425 },
  { path: "vae/diffusion_pytorch_model.safetensors", sha256: "da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0", bytes: 337_431_388 },
];
const MUSIC_LM06_FILES = [
  { path: "added_tokens.json", sha256: "db08b66a515fb5d6acca0b3492d25bb44e0deda6241fc1113ac0679d40558c48", bytes: 2_217_787 },
  { path: "chat_template.jinja", sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8", bytes: 4_168 },
  { path: "config.json", sha256: "873ca63808b74e1e008ab950114765553b898b489b9e077e80db83348a118384", bytes: 1_386 },
  { path: "merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1_671_853 },
  { path: "model.safetensors", sha256: "5d92a60806e2e88c04de58ddc6dde93f2bc8f1336162b3ad5853886c9bcc6b82", bytes: 1_325_804_024 },
  { path: "special_tokens_map.json", sha256: "76e233bfc357b0b03d7b6e6ba8e799244f358552575a7cdadb78d3d19106b298", bytes: 1_824_199 },
  { path: "tokenizer.json", sha256: "35af56c3f5cb3ea2cc578aa28a8937770981d504f183ac5c8c38baf4bbd4af4d", bytes: 24_321_939 },
  { path: "tokenizer_config.json", sha256: "6cd70cdd89425971794f5235562edcc608b0629a6c4686ae51a8b8c8b8ba5e95", bytes: 14_072_925 },
  { path: "vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2_776_833 },
];
export const STACK_MUSIC_MODEL: CatalogModelLike = {
  id: STACK_MUSIC_MODEL_ID,
  role: "music",
  repo: MUSIC_REPO,
  license: "MIT",
  revision: MUSIC_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p64", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_REPO}/resolve/${MUSIC_REVISION}/acestep-v15-turbo/model.safetensors`),
    sha256: "3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7",
    approx_bytes: MUSIC_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "ACE-Step-1.5-checkpoints",
    files: MUSIC_FILES,
  },
};
export const STACK_MUSIC_LM_06: CatalogModelLike = {
  id: STACK_MUSIC_LM_06_ID,
  role: "music",
  component: "planning-lm-0.6b",
  repo: MUSIC_LM06_REPO,
  license: "MIT",
  revision: MUSIC_LM06_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p64", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_LM06_REPO}/resolve/${MUSIC_LM06_REVISION}/model.safetensors`),
    sha256: "5d92a60806e2e88c04de58ddc6dde93f2bc8f1336162b3ad5853886c9bcc6b82",
    approx_bytes: MUSIC_LM06_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "ACE-Step-5Hz-lm-0.6B",
    files: MUSIC_LM06_FILES,
  },
};
export const STACK_MUSIC_MODELS: CatalogModelLike[] = [STACK_MUSIC_MODEL, STACK_MUSIC_LM_06];
// TIER-STEMS-01a: HTDemucs (MIT), pinned to the checkpoint files in the
// official Hugging Face repository. Safetensors weights plus the upstream
// YAML architecture are loaded by the pinned Demucs package.
export const STACK_STEMS_MODEL_ID = "htdemucs";
const STEMS_REPO = "adefossez/HTDemucs";
const STEMS_REVISION = "cbc8a9b1a87023b7fd74e7b3412e6321c0eab003";
export const STACK_STEMS_MODEL: CatalogModelLike = {
  id: STACK_STEMS_MODEL_ID, role: "music", component: "stems", repo: STEMS_REPO, license: "MIT", revision: STEMS_REVISION, engine: "stems",
  sizing: { profile: "p64", quantization: "fp32" },
  download: {
    url: hfUrl(`${STEMS_REPO}/resolve/${STEMS_REVISION}/955717e8.safetensors`), sha256: "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd", approx_bytes: 84_025_440,
    directory: "htdemucs",
    files: [
      { path: "955717e8.safetensors", sha256: "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd", bytes: 84_025_440 },
      { path: "htdemucs.yaml", sha256: "239c445d0b14454d541ad8bd9bb271c9e536d267e8a4625208744cbb2e7bb66c", bytes: 21 },
    ],
  },
};
export const STACK_STEMS_MODELS: CatalogModelLike[] = [STACK_STEMS_MODEL];

// VIDEO-LTX-01: the Detailed video model. LTX-2.3 22B distilled (Lightricks), the MLX layout of prince-canuma's conversion
// (an ungated Hugging Face repository: no account is needed), at one revision, every file by sha256 and size. It makes the
// picture and its sound track in one pass (speech included), up to 10 s a clip at 768 x 448, with an 8 + 3 step distilled
// schedule and the x2 spatial upscaler. The weights are NOT redistributed: an admin's own computer downloads them for
// household use. Licence: LTX-2.x Community License Agreement (LICENSE-2_x, dated 2026-08-11): free for an entity under
// $10,000,000 of annual revenue, a paid licence from Lightricks above that, and an acceptable use policy (no exploiting or
// harming minors, no impersonation without consent, machine-made content disclosed; adult content is not barred). Home
// shows that summary at install and the admin accepts it once. The text encoder is Gemma 3 12B (Gemma Terms of Use), its own
// pin, which the model reads before the picture is drawn. Measured 2026-10-17, Apple M5 Max 128 GB, aggressive tiling.
/** Admission for a Detailed clip: the largest MLX peak measured (43.5 GB, 15 s at 768 x 448 with the clay LoRA merged: 43.3 GB at 5 s) plus the Python process. The ceiling is 10 s (41.9 GB measured). */
export const LTX_PEAK_BYTES = 46_000_000_000;
const LTX_REPO = "prince-canuma/LTX-2.3-distilled";
const LTX_REVISION = "65b104b9387fb173d8e4b92fc5effc47625baf2a";
export const STACK_VIDEO_DETAILED_MODEL_ID = "ltx-2-3-distilled-mlx";
export const STACK_VIDEO_TEXT_ENCODER_ID = "video-gemma-3-12b-text-encoder";
export const LTX_LICENCE = "LTX-2.x Community License Agreement (2026-08-11)";
export const LTX_LICENCE_URL = "https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x";
/** What an admin reads and accepts once before the Detailed video model installs (Home shows it; the Stack records the acceptance). */
export const LTX_LICENCE_NOTICE = {
  id: "ltx-2.x-community-2026-08-11",
  name: LTX_LICENCE,
  url: LTX_LICENCE_URL,
  summary: [
    "The Detailed video model is Lightricks' LTX-2.3. It is not part of MaiPai: this computer downloads it from the maker's published files, for your household's use.",
    "It is free for a person or a business that earns under $10 million a year. A business at or above $10 million a year needs its own paid licence from Lightricks for any commercial use.",
    "It may not be used to harm or exploit children, to make a video of a real person who has not agreed to it, to spread false information on purpose, or to break the law. Adult content is not on that list. MaiPai's own rules for who may make what still apply on top.",
    "Anything you share must say it was made by a machine, and the markings the model puts in a clip are never removed.",
    "Lightricks can update its use policy, and can end the licence if it is broken. The prompt reader is Google's Gemma 3, under the Gemma Terms of Use.",
  ],
};
export const LTX_UPSCALER_FILE = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
const LTX_FILES = [
  { path: "audio_vae/decoder/config.json", sha256: "08462df98b63ab119aceec75c1ff35686027409d2b97f9c01474468f162a5880", bytes: 508 },
  { path: "audio_vae/decoder/model.safetensors", sha256: "919f03edd099c5393eb5889be8abd74bf283a98081bce9859cf5d49f57a5c7fa", bytes: 63836681 },
  { path: "audio_vae/decoder/model.safetensors.index.json", sha256: "7b34bb20249af1e93f4970de3ad4f7b6a99af49a64446cceff77e48bfafe09a9", bytes: 3427 },
  { path: "audio_vae/encoder/config.json", sha256: "8cbee91fbd78002880e5d265b81728155fc92bd6c3a541aaf97089d8eab2f580", bytes: 451 },
  { path: "audio_vae/encoder/model.safetensors", sha256: "4653689ea1cd5f814e8b8ec630c1b94c6d027040ccafae9db19544b0abbf2d20", bytes: 42671257 },
  { path: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors", sha256: "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed", bytes: 995743560 },
  { path: "text_projections/model.safetensors", sha256: "94565b15dc9019c2383f9dc3e2d26d89a7b231baf8960449d7de2574dff5c3a0", bytes: 6344492796 },
  { path: "transformer/config.json", sha256: "a48117b641855fcc65996a84915932b461cef6fca9fa186f8f1e00eae5d50fec", bytes: 899 },
  { path: "transformer/model-00000-of-00018.safetensors", sha256: "9213093a4bd4fc675a8d50404f0ed434aceb1ea1f8ce870698945a36fd4eb4d2", bytes: 2082912296 },
  { path: "transformer/model-00001-of-00018.safetensors", sha256: "ca232148fc188b19c0bc158a0a9882cfaaf2c2f8fe71e53258cc5ee8b337253a", bytes: 2144029888 },
  { path: "transformer/model-00002-of-00018.safetensors", sha256: "11ba2b546405155d1a2215f41d9b0b6dc113764398424fc076220321c9c21054", bytes: 2144171152 },
  { path: "transformer/model-00003-of-00018.safetensors", sha256: "f97c23b4ad9b47bf0de089b61c33a93b0f64a53b8b2c5426e297108d4418fa1e", bytes: 2034806928 },
  { path: "transformer/model-00004-of-00018.safetensors", sha256: "b5204bb7d011fcde3c6f6bfd16df183ba39811089d17d03b4c8567a37fe8f8db", bytes: 2144582280 },
  { path: "transformer/model-00005-of-00018.safetensors", sha256: "d4d176110a3bcadb8ca2ace2f5f9a2fd396129d2466f7ef66f5ae9b6cefcedcc", bytes: 2143923080 },
  { path: "transformer/model-00006-of-00018.safetensors", sha256: "a3222eeeba97da36ec38a56c66eb37c71afb229ab7803efd6fffee6e0b4364a2", bytes: 2119136960 },
  { path: "transformer/model-00007-of-00018.safetensors", sha256: "c9928ebfb04a7457e39282d619a72239e006303cd197e69020db633d26ecf5f9", bytes: 2101932680 },
  { path: "transformer/model-00008-of-00018.safetensors", sha256: "6568dcce0d5e115b5837f6439649a3a5b1f6c7ba9fccea1d9b6985307c857ee4", bytes: 2144582280 },
  { path: "transformer/model-00009-of-00018.safetensors", sha256: "b1c4cd271aa2b0d956ccdc30764bd0c8b730d4a6a651ecbd076520eba4d27eee", bytes: 2143923080 },
  { path: "transformer/model-00010-of-00018.safetensors", sha256: "a956731d2ce11b51a3b820227eea31aad92ceda811d0df66ac1bf293b069bf66", bytes: 2119136960 },
  { path: "transformer/model-00011-of-00018.safetensors", sha256: "e1102c21c977addae2b152918e12b4134c7f6abcdca4a03be26fac58e67e8b70", bytes: 2101932680 },
  { path: "transformer/model-00012-of-00018.safetensors", sha256: "5e677e3f428f6f217fbb4392a816cb6277af0568de50b54065be1bb3375e4153", bytes: 2144582280 },
  { path: "transformer/model-00013-of-00018.safetensors", sha256: "455df8d3c56be982d5a6a831930766f01bdff5a271f65166a86f2fd64db400c7", bytes: 2143923080 },
  { path: "transformer/model-00014-of-00018.safetensors", sha256: "5d24e1a8ad13d88c245678ad32411e15c095fa14ee5f835447dd23dcd29ae0ef", bytes: 2119136960 },
  { path: "transformer/model-00015-of-00018.safetensors", sha256: "b357191a0c1ff8e1fe951d469d9141e8b122227aeda8d385f693e0b958ec0e51", bytes: 2101932680 },
  { path: "transformer/model-00016-of-00018.safetensors", sha256: "7142f785ec9941f39f8b0cd430f7f707a5aa34fbb841d62fad61540df6f505eb", bytes: 2144582104 },
  { path: "transformer/model-00017-of-00018.safetensors", sha256: "87f0947f7939d535334e6680c28eb713d906abb57c6cdaf7298d10a7987cf6ed", bytes: 1908416488 },
  { path: "transformer/model.safetensors.index.json", sha256: "d0621b08dd20b510cd4dd331b71b771ccd7150109d1ced86ac15ab8c5f70642e", bytes: 378827 },
  { path: "vae/decoder/config.json", sha256: "96dd67966852fff5eb7ddbeb8be6146a258a16d6d7597668357490c2259b2657", bytes: 253 },
  { path: "vae/decoder/model.safetensors", sha256: "40fdcbae2dd2aa3576a3e6ae9e797b110e4b036c80e044f04f75fe5a3cee5451", bytes: 814348875 },
  { path: "vae/decoder/model.safetensors.index.json", sha256: "7fdbe0e2304d5b4a89f8f0d2b9d55142760dde6f455e6f85bef01f7c16db2410", bytes: 6242 },
  { path: "vae/encoder/config.json", sha256: "2aa542caf145a9443e2747af089f1cb9d238a8b77f0bdcadaf066d21266bd6e4", bytes: 1209 },
  { path: "vae/encoder/model.safetensors", sha256: "e7972f1d06c8a8414f5d12df25689266bce3e288de3056b0760f9629f68afc9d", bytes: 637884773 },
  { path: "vae/encoder/model.safetensors.index.json", sha256: "36d94841ea46c13cdd7cae1c02cf7ff6f91c5dd678940452cee4fd62839dad1c", bytes: 6022 },
  { path: "vocoder/config.json", sha256: "7197b70ccfb95ef61e7d54a96282d273af30bee63081890a0c3a097425e05785", bytes: 1109 },
  { path: "vocoder/model.safetensors", sha256: "1d9dcddb114eb1ab00e10e46de30a1d47708362bb9bee8b39c7c3c57fa4ba172", bytes: 258309247 },
  { path: "vocoder/model.safetensors.index.json", sha256: "3758875a357dfe658ddba0cbf324ab66f73a1424b4fd515152c8fdbd8b9c1072", bytes: 87274 },
];
export const STACK_VIDEO_DETAILED_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_DETAILED_MODEL_ID,
  role: "video",
  repo: LTX_REPO,
  license: LTX_LICENCE,
  revision: LTX_REVISION,
  engine: VIDEO_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    // The primary file is a top-level one (the downloader derives every other file's address from its folder).
    url: hfUrl(`${LTX_REPO}/resolve/${LTX_REVISION}/${LTX_UPSCALER_FILE}`),
    sha256: LTX_FILES.find((file) => file.path === LTX_UPSCALER_FILE)!.sha256,
    approx_bytes: LTX_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "LTX-2.3-distilled-MLX",
    files: LTX_FILES,
  },
  measured: { footprintBytes: LTX_PEAK_BYTES, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
const GEMMA_REPO = "mlx-community/gemma-3-12b-it-bf16";
const GEMMA_REVISION = "b8b9b412cb795bd6115fdce8c9a0ef0d1664db3a";
const GEMMA_FILES = [
  { path: "added_tokens.json", sha256: "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946", bytes: 35 },
  { path: "chat_template.json", sha256: "fe16baf728db49457cde32802cd7efc0ac8a7a9877dbe22fe3322b2d9dc6ccd9", bytes: 1615 },
  { path: "config.json", sha256: "16a876d6326c4762377a74118847bd3410b66a1875ba05aeb6b695ddbf64b21f", bytes: 1039 },
  { path: "model-00001-of-00005.safetensors", sha256: "319b50ee905f2cfb3f2a9061ed4858ad77a31a73a35a119ea6b7492347069968", bytes: 5301386994 },
  { path: "model-00002-of-00005.safetensors", sha256: "c6d569f73b66667ad5c4ad5d34f98a301868f2b98ca1c2deada9da9f002cc0d1", bytes: 5261631359 },
  { path: "model-00003-of-00005.safetensors", sha256: "8038b2b0e059d3d7a3cdcc911dc3f499952341564526eb9b3b4e6036041b2b37", bytes: 5348137629 },
  { path: "model-00004-of-00005.safetensors", sha256: "7211182ea44707e0857413691164fc146940cf6b3cdf85f7ff037c59a71d5ffa", bytes: 5363867587 },
  { path: "model-00005-of-00005.safetensors", sha256: "71666d602253574a56bb07719d5d8a958baa9a1373c2c4255ebbec1fc796bc45", bytes: 5113526967 },
  { path: "model.safetensors.index.json", sha256: "788cc42a1a92835df62d9a3791f47105f63504c7c404637a73288e9b11bc7b82", bytes: 108605 },
  { path: "special_tokens_map.json", sha256: "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397", bytes: 662 },
  { path: "tokenizer.json", sha256: "4667f2089529e8e7657cfb6d1c19910ae71ff5f28aa7ab2ff2763330affad795", bytes: 33384568 },
  { path: "tokenizer.model", sha256: "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c", bytes: 4689074 },
  { path: "tokenizer_config.json", sha256: "0d95398b39395e5cfb290683a78f3fb0551223c672d8b033333c1a5307473760", bytes: 1157007 },
];
export const STACK_VIDEO_TEXT_ENCODER: CatalogModelLike = {
  id: STACK_VIDEO_TEXT_ENCODER_ID,
  role: "video",
  component: "text-encoder",
  repo: GEMMA_REPO,
  license: "Gemma Terms of Use",
  revision: GEMMA_REVISION,
  engine: VIDEO_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${GEMMA_REPO}/resolve/${GEMMA_REVISION}/model-00001-of-00005.safetensors`),
    sha256: GEMMA_FILES.find((file) => file.path === "model-00001-of-00005.safetensors")!.sha256,
    approx_bytes: GEMMA_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "gemma-3-12b-it-bf16-text-encoder",
    files: GEMMA_FILES,
  },
};
export const STACK_VIDEO_DETAILED_MODELS: CatalogModelLike[] = [STACK_VIDEO_DETAILED_MODEL, STACK_VIDEO_TEXT_ENCODER];

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
export const STACK_IMAGE_ERNIE_ID = "ernie-image-turbo";
function imageFamily(id: string, repo: string, revision: string, primary: string, files: ImagePinFile[], profile: string, footprint: number): CatalogModelLike[] {
  const pin = (file: ImagePinFile): CatalogModelLike["download"] => ({ url: hfUrl(`${repo}/resolve/${revision}/${file.file}`), sha256: file.sha256, approx_bytes: file.bytes, hub_file: file.file });
  const main = files.find((file) => file.file === primary)!;
  const head: CatalogModelLike = { id, role: "image", repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization: "bf16, run 8-bit" }, download: pin(main), measured: { footprintBytes: footprint, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } };
  const parts = files.filter((file) => file.file !== primary).map((file): CatalogModelLike => ({ id: `${id}-${file.file.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, role: "image", component: `${id}:${file.file}`, repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization: "bf16" }, download: pin(file) }));
  return [head, ...parts];
}
export const STACK_IMAGE_KLEIN_MODELS = imageFamily(STACK_IMAGE_KLEIN_ID, KLEIN_4B_REPO, KLEIN_4B_REVISION, KLEIN_4B_PRIMARY, KLEIN_4B_FILES, "p32", 13_500_000_000);
export const STACK_IMAGE_ZIMAGE_MODELS = imageFamily(STACK_IMAGE_ZIMAGE_ID, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_FILES, "p128", 30_100_000_000);
export const STACK_IMAGE_ERNIE_MODELS = imageFamily(STACK_IMAGE_ERNIE_ID, ERNIE_IMAGE_TURBO_REPO, ERNIE_IMAGE_TURBO_REVISION, ERNIE_IMAGE_TURBO_PRIMARY, ERNIE_IMAGE_TURBO_FILES, "p64", 15_000_000_000);
export const STACK_IMAGE_ENGINE_MODELS: CatalogModelLike[] = [...STACK_IMAGE_KLEIN_MODELS, ...STACK_IMAGE_ZIMAGE_MODELS, ...STACK_IMAGE_ERNIE_MODELS];

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
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_MODEL, STACK_CHAT_8B_MODEL, STACK_CHAT_MUSE_30B_XL_MODEL, STACK_CHAT_MUSE_30B_M_MODEL, STACK_CHAT_MUSE_30B_MLX_MODEL, STACK_CHAT_MUSE_30B_PROJECTOR, STACK_CHAT_QWEN36_35B_MODEL, STACK_CHAT_QWEN36_35B_PROJECTOR, STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR, STACK_JUDGE_MODEL, STACK_CODING_MODEL, STACK_CODING_DRAFT_MODEL, STACK_CODING_HEAVY_MODEL, STACK_CODING_HEAVY_DRAFT_MODEL, STACK_MLX_CHAT_MODEL, STACK_STT_MODEL, STACK_STT_PARAKEET_V2_MODEL, STACK_VAD_MODEL, STACK_ENDPOINT_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS, STACK_IMAGE_MODEL, ...STACK_IMAGE_TOOL_MODELS, ...STACK_IMAGE_ENGINE_MODELS, ...STACK_VIDEO_MODELS, ...STACK_VIDEO_DETAILED_MODELS, ...STACK_MUSIC_MODELS, ...STACK_STEMS_MODELS, STACK_EMBED_MODEL, STACK_VISION_MODEL, STACK_VISION_PROJECTOR, STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR, ...STACK_WAKEWORD_MODELS];

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
    { name: "ACE-Step 1.5 XL turbo (4B DiT, MIT), a later quality profile for p128", kind: "model", source: "docs/design/music-generation-2026-10-17.md in Home, MUSIC-GEN-10" },
    { name: "Stable Audio 3.0 for beds and effects (Stability Community licence, behind a licence gate)", kind: "model", source: "docs/design/music-generation-2026-10-17.md in Home, MUSIC-GEN-11" },
  ],
};
