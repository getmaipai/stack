import { hfUrl } from "@/lib/hf";
import type { CatalogModelLike } from "@/lib/modelStore";
import { H3_PINNED_FILES } from "@/packs/h3/h3Pins";
import { H3_IMAGE_FILES, H3_IMAGE_PRIMARY, ERNIE_IMAGE_TURBO_FILES, ERNIE_IMAGE_TURBO_PRIMARY, ERNIE_IMAGE_TURBO_REPO, ERNIE_IMAGE_TURBO_REVISION, KLEIN_4B_FILES, KLEIN_4B_PRIMARY, QWEN_IMAGE_FILES, QWEN_IMAGE_PRIMARY, QWEN_IMAGE_REPO, QWEN_IMAGE_REVISION, SEEDVR2_FILES, SEEDVR2_PRIMARY, SEEDVR2_REPO, SEEDVR2_REVISION, KLEIN_4B_REPO, KLEIN_4B_REVISION, KLEIN3_FILES, KLEIN3_PRIMARY, KLEIN3_REPO, KLEIN3_REVISION, ZIMAGE_TURBO_FILES, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, type ImagePinFile } from "@/images/pins";
import data from "@/rows/modelCatalog.json";

// The household's Standard chat model on every profile, copied from Home's verified pin.
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

// MODEL-SWITCH-01 / CHAT-TPS-04 (2026-10-21): Qwen3.6-35B-A3B, an optional
// chat model an admin installs and chooses in Home Settings, Models. It is
// not bound to any tier.
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

// Optional Huihui Qwen3.6-35B-A3B abliterated chat model, served by Splash,
// which requires a DFlash2 draft. Like the dense model above, an admin installs
// it on purpose and chooses it in Settings; no tier binds or downloads it. Splash 1.6.1 measured a 21 GB
// resident footprint at 32k context (7x faster to first token than the dense
// 27B on a 5.5k-token Home prompt). The dense Huihui Qwen3.8-27B above stays
// installable and selectable.
const QWEN36_HUIHUI_35B_REPO = "mradermacher/Huihui-Qwen3.6-35B-A3B-abliterated-GGUF";
const QWEN36_HUIHUI_35B_REVISION = "0693fc2b47f66380f4b568b01e05195d22edd3a2";
export const STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL: CatalogModelLike = {
  id: "qwen3-6-35b-a3b-huihui-abliterated-q4-k-m",
  role: "chat",
  repo: QWEN36_HUIHUI_35B_REPO,
  license: "Apache-2.0",
  revision: QWEN36_HUIHUI_35B_REVISION,
  engine: "splash",
  companions: ["qwen3-6-35b-a3b-huihui-abliterated-dflash2-draft"],
  sizing: { profile: "p64", quantization: "Q4_K_M" },
  download: {
    url: hfUrl(`${QWEN36_HUIHUI_35B_REPO}/resolve/${QWEN36_HUIHUI_35B_REVISION}/Huihui-Qwen3.6-35B-A3B-abliterated.Q4_K_M.gguf`),
    sha256: "fbaa4eb3e2365abffd495c5efa7df88c2b2a5088ba32cd2895973d130991e92b",
    approx_bytes: 21_166_758_784,
  },
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen/Qwen3.6-35B-A3B model card, non-thinking sampling" },
};

const QWEN36_HUIHUI_35B_DRAFT_REPO = "incoai/Qwen3.6-35B-A3B-DFlash2";
const QWEN36_HUIHUI_35B_DRAFT_REVISION = "51ef7b6923ad6c14cb1bb41c37a9041446496ab6";
export const STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT: CatalogModelLike = {
  id: "qwen3-6-35b-a3b-huihui-abliterated-dflash2-draft",
  role: "chat",
  component: "draft",
  repo: QWEN36_HUIHUI_35B_DRAFT_REPO,
  license: "Apache-2.0",
  revision: QWEN36_HUIHUI_35B_DRAFT_REVISION,
  engine: "splash",
  sizing: { profile: "p64", quantization: "BF16" },
  download: {
    url: hfUrl(`${QWEN36_HUIHUI_35B_DRAFT_REPO}/resolve/${QWEN36_HUIHUI_35B_DRAFT_REVISION}/model.safetensors`),
    sha256: "d1f16c0ff85afbe6166fabfae998af3ec16fa11da87da4391b5e0e0a7c796a4d",
    approx_bytes: 1_052_513_456,
    directory: "Qwen3.6-35B-A3B-DFlash2",
    files: [
      { path: "config.json", sha256: "86d2e8e57e7c70bb867240708d00c0535ae9ed3c828dbdcb21584471c7bbce59", bytes: 1_291 },
      { path: "model.safetensors", sha256: "d1f16c0ff85afbe6166fabfae998af3ec16fa11da87da4391b5e0e0a7c796a4d", bytes: 1_052_513_456 },
    ],
  },
};

// Optional Huihui Qwen3.8 Flash Next 177B abliterated chat model, the Max chat
// model, served by Splash with its DFlash2 draft (measured 2026-11-21 on a
// 128 GB M5 Max, Splash 1.7.0: 70 GB in memory at a 32K window, 74 GB after
// long code replies, 81 tokens/s, first token 1.13 s on a 6,400-token prompt).
// Splash keeps about 27 GB of the 94 GB of weights on the SSD, so only the rest
// counts as resident. The GGUF is split in three parts (a split GGUF is one
// model, Splash reads the parts from one folder): the three parts are one
// directory model, each part pinned by size and sha256 (git-lfs oids). It runs
// alone (Max drains the other loads first), is never a tier's recommended
// model and is never installed by default. Licence: Qwen community licence.
const FLASH_NEXT_REPO = "huihui-ai/Huihui-Qwen3.8-Flash-Next-abliterated-v2-GGUF";
const FLASH_NEXT_REVISION = "cbc7fba13f1939ac3fa42b18d77ccf43847d74ef";
const FLASH_NEXT_FOLDER = "unsloth-UD-IQ4_XS";
const FLASH_NEXT_PARTS: Array<{ path: string; sha256: string; bytes: number }> = [
  { path: `${FLASH_NEXT_FOLDER}/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf`, sha256: "5ce89370720f8bf90890f439361282104c1aa1482d4013bb9a50923e758e71a4", bytes: 10_946_624 },
  { path: `${FLASH_NEXT_FOLDER}/Qwen3.8-Flash-Next-UD-IQ4_XS-00002-of-00003.gguf`, sha256: "ede87d3bd3e354d43f0e710b2df6791d3479e396847e53adbe2b48be7ba6d663", bytes: 49_835_229_856 },
  { path: `${FLASH_NEXT_FOLDER}/Qwen3.8-Flash-Next-UD-IQ4_XS-00003-of-00003.gguf`, sha256: "f8aa8bd7ba134b3b7fe4fc95b9131fc8f6678ace374a0fa6e632225031665995", bytes: 43_836_407_744 },
];
export const STACK_CHAT_QWEN38_FLASH_NEXT_MODEL: CatalogModelLike = {
  id: "qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs",
  role: "chat",
  repo: FLASH_NEXT_REPO,
  license: "qwen-community-1.0",
  revision: FLASH_NEXT_REVISION,
  engine: "splash",
  // 2026-11-21, provisional: 5 of 5 on a five-task repo coding check 81 tokens/s, 70 to 74 GB at 32K. Coding mode loads it when it and its draft are installed, and the everyday coding model (Qwen3.8 27B) when they are not; the window stays at the pinned 32K (larger windows are unmeasured).
  modeVerdict: "offer_with_limits",
  companions: ["qwen3-8-flash-next-177b-dflash2-draft"],
  sizing: { profile: "p128", quantization: "UD-IQ4_XS" },
  // The window Splash was measured and budgeted at; the chat launch honours it instead of the window setting.
  launch: { contextLength: 32_768 },
  download: {
    // The first part names the pin (the weights file of a directory model); `files` holds all three, which a re-install verifies and fetches one by one.
    url: hfUrl(`${FLASH_NEXT_REPO}/resolve/${FLASH_NEXT_REVISION}/${FLASH_NEXT_PARTS[0]!.path}`),
    sha256: FLASH_NEXT_PARTS[0]!.sha256,
    approx_bytes: FLASH_NEXT_PARTS.reduce((sum, part) => sum + part.bytes, 0),
    directory: "Qwen3.8-Flash-Next-UD-IQ4_XS",
    files: FLASH_NEXT_PARTS,
  },
  sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "Qwen3.8 family non-thinking sampling, as the Qwen3.8-27B card (the Flash Next card was not checked)" },
};

const FLASH_NEXT_DRAFT_REPO = "incoai/Qwen3.8-Flash-Next-DFlash2";
const FLASH_NEXT_DRAFT_REVISION = "a22a1744e85c17364dcc54a6a420af7135d4c7f6";
export const STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT: CatalogModelLike = {
  id: "qwen3-8-flash-next-177b-dflash2-draft",
  role: "chat",
  component: "draft",
  repo: FLASH_NEXT_DRAFT_REPO,
  license: "Apache-2.0",
  revision: FLASH_NEXT_DRAFT_REVISION,
  engine: "splash",
  sizing: { profile: "p128", quantization: "BF16" },
  download: {
    url: hfUrl(`${FLASH_NEXT_DRAFT_REPO}/resolve/${FLASH_NEXT_DRAFT_REVISION}/model.safetensors`),
    sha256: "d6723f2a359eaf33ec0c95f22ae8edda896774020c552296a85e1913b4d3186f",
    approx_bytes: 1_206_140_008,
    directory: "Qwen3.8-Flash-Next-DFlash2",
    files: [
      { path: "config.json", sha256: "2409575986f9ea24d455343eb469c0e6940def5edab1d1be503bb8eb4cc3b1b9", bytes: 1_236 },
      { path: "model.safetensors", sha256: "d6723f2a359eaf33ec0c95f22ae8edda896774020c552296a85e1913b4d3186f", bytes: 1_206_140_008 },
    ],
  },
};

/** The optional chat models Splash runs from a pinned GGUF and a DFlash2 draft through `--model-dir` and `--draft-model` (Splash prepares its own model folder from them): the one list the install, the launch, the disk plan and the tiers read. `profiles` are the machines that are offered it, `ssdBytes` the weights Splash keeps on the SSD instead of in memory, `measuredPeakBytes` the whole-process peak measured after long replies at the pinned window (the memory ledger and the mode check count this instead of the formula plus the Metal headroom; null when none was measured), `note` the file the install leaves beside Splash's data. */
export const SPLASH_LOCAL_CHAT_MODELS: ReadonlyArray<{ pin: CatalogModelLike; draftPin: CatalogModelLike; profiles: readonly string[]; ssdBytes: number; measuredPeakBytes: number | null; note: string; row: string }> = [
  { pin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, draftPin: STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT, profiles: ["p64", "p128"], ssdBytes: 0, measuredPeakBytes: null, note: "prepared-qwen36-35b.json", row: "chat-splash-qwen36-abliterated" },
  { pin: STACK_CHAT_QWEN38_FLASH_NEXT_MODEL, draftPin: STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT, profiles: ["p128"], ssdBytes: 27_000_000_000, measuredPeakBytes: 74_000_000_000, note: "prepared-qwen38-flash-next.json", row: "chat-splash-qwen38-flash-next" },
];

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

// HELPER-01: the admin Helper runs this same pinned file (Qwen3-4B Q4_K_M) in
// its own process, so one copy on disk serves the judge and the Helper.
// Chosen by the bench in docs/helper-bench.md.
export const STACK_HELPER_MODEL_ID = STACK_JUDGE_MODEL.id;

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
export const STACK_STT_MODEL: CatalogModelLike = data.STACK_STT_MODEL as unknown as CatalogModelLike;
// The optional Parakeet TDT 0.6B v2 int8 package from the same rolling
// `asr-models` release. The checksum pins the asset because the tag can
// replace it under the same name. The archive extracts to three ONNX
// files plus tokens.
export const STACK_STT_PARAKEET_V2_MODEL: CatalogModelLike = data.STACK_STT_PARAKEET_V2_MODEL as unknown as CatalogModelLike;
export const STACK_VAD_MODEL: CatalogModelLike = data.STACK_VAD_MODEL as unknown as CatalogModelLike;

// Speaker detection (CAPTION-01g, packaged 2026-11-07): two components of the `stt` role, installed beside Parakeet and
// Silero from the Engines page. Both are sherpa-onnx release assets pinned by checksum (the tags can replace a file).
// pyannote segmentation 3.0 (MIT, int8 export): the archive extracts to a folder holding model.int8.onnx.
export const STACK_DIARIZATION_SEGMENTATION_MODEL: CatalogModelLike = data.STACK_DIARIZATION_SEGMENTATION_MODEL as unknown as CatalogModelLike;
// NVIDIA NeMo TitaNet small speaker embedding (CC-BY-4.0, English), one ONNX file. The release folder's name is spelled
// "speaker-recongition-models" upstream.
export const STACK_DIARIZATION_EMBEDDING_MODEL: CatalogModelLike = data.STACK_DIARIZATION_EMBEDDING_MODEL as unknown as CatalogModelLike;

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
const CHATTERBOX_FILES: Array<{ file: string; sha256: string; bytes: number }> = data.CHATTERBOX_FILES as unknown as Array<{ file: string; sha256: string; bytes: number }>;
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

// IMAGETOOLS-01: the ONNX models behind the image tools,
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
  { id: "image-tool-yolox-s", role: "image", component: "tool-look", repo: "Megvii-BaseDetection/YOLOX", license: "Apache-2.0", revision: "0.1.1rc0", engine: "image-tools", sizing: { profile: "p16", quantization: "fp32" }, download: { url: "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx", sha256: "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063", approx_bytes: 35_858_002 } },
  imageToolPin("image-tool-isnet-general", "tool-isnet-general", "imgly/isnet-general-onnx", "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f", "onnx/model.onnx", "MIT", "cc2c9f5c1751b9737cb81e708ff0c5e9542c2205daed22418a4fd2ab5d4c481a", 176_149_806, 3_400_000_000),
  imageToolPin("image-tool-lama-big", "tool-lama", "Carve/LaMa-ONNX", "c3c0c9e468934d62e79c329e35d82dd09ff8c444", "lama_fp32.onnx", "Apache-2.0", "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6", 208_044_816, 2_000_000_000),
  imageToolPin("image-tool-realesrgan-general-x4v3", "tool-realesrgan", "Heliosoph/realesrgan-onnx", "488e5dda07333179f229a6205d92135eea4c25e9", "realesr-general-x4v3.onnx", "BSD-3-Clause", "09b757accd747d7e423c1d352b3e8f23e77cc5742d04bae958d4eb8082b76fa4", 4_871_181, 1_500_000_000),
  imageToolPin("image-tool-depth-anything-v2-small", "tool-depth", "onnx-community/depth-anything-v2-small", "4472b7362082ad9968fee890ca0f1e5aca36b93d", "onnx/model.onnx", "Apache-2.0", "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c", 99_060_839, 1_500_000_000),
];

// TALK-06: exact upstream files at the supplied model revision. The model
// card identifies the code and all weights, including landmark.onnx, as MIT.
// The whole worker's peak memory footprint (macOS `footprint`, which counts the GPU buffers), measured 2026-11-09 on the Mac Studio:
// 4.06 GB on a 1024 x 1024 picture, 4.99 GB on a 4000 x 4000 (16 megapixel) picture, four frames each.
const LIVEPORTRAIT_MEASURED_PEAK_BYTES = 4_986_000_000;
const LIVEPORTRAIT_REPO = "KwaiVGI/LivePortrait";
const LIVEPORTRAIT_REV = "82a4fa6735ca58432b6ce39301b4b9ee066dea47";
const liveportraitPin = (id: string, file: string, sha256: string, bytes: number): CatalogModelLike => ({ id, role: "image", component: "liveportrait", repo: LIVEPORTRAIT_REPO, license: "MIT", revision: LIVEPORTRAIT_REV, engine: "liveportrait", sizing: { profile: "p16", quantization: "fp32" }, download: { url: hfUrl(`${LIVEPORTRAIT_REPO}/resolve/${LIVEPORTRAIT_REV}/${file}`), sha256, approx_bytes: bytes, hub_file: file }, measured: { footprintBytes: LIVEPORTRAIT_MEASURED_PEAK_BYTES, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } });
export const STACK_LIVEPORTRAIT_MODELS: CatalogModelLike[] = [
  liveportraitPin("liveportrait-landmark", "liveportrait/landmark.onnx", "31d22a5041326c31f19b78886939a634a5aedcaa5ab8b9b951a1167595d147db", 114_666_491),
  liveportraitPin("liveportrait-appearance", "liveportrait/base_models/appearance_feature_extractor.pth", "5279bb8654293dbdf327030b397f107237dd9212fb11dd75b83dfb635211ceb5", 3_387_959),
  liveportraitPin("liveportrait-motion", "liveportrait/base_models/motion_extractor.pth", "251e6a94ad667a1d0c69526d292677165110ef7f0cf0f6d199f0e414e8aa0ca5", 112_545_506),
  liveportraitPin("liveportrait-generator", "liveportrait/base_models/spade_generator.pth", "4780afc7909a9f84e24c01d73b31a555ef651521a1fe3b2429bd04534d992aee", 221_813_590),
  liveportraitPin("liveportrait-warping", "liveportrait/base_models/warping_module.pth", "2f61a6f265fe344f14132364859a78bdbbc2068577170693da57fb96d636e282", 182_180_086),
  liveportraitPin("liveportrait-stitching", "liveportrait/retargeting_models/stitching_retargeting_module.pth", "3652d5a3f95099141a56986aaddec92fadf0a73c87a20fac9a2c07c32b28b611", 2_393_098),
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
const VIDEO_FILES = data.VIDEO_FILES;
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
const UMT5_FILES = data.UMT5_FILES;
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

export const STACK_VIDEO_MASK_MODEL_ID = "sam2.1-hiera-small";
export const STACK_VIDEO_MASK_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_MASK_MODEL_ID, role: "video", repo: "facebook/sam2.1-hiera-small", license: "Apache-2.0",
  revision: "ee5bba1d82bb8749febdf90f45e84b687142ba03", engine: "mask-gen", sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl("facebook/sam2.1-hiera-small/resolve/ee5bba1d82bb8749febdf90f45e84b687142ba03/sam2.1_hiera_small.pt"), sha256: "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38", approx_bytes: 184416285, hub_file: "sam2.1_hiera_small.pt" },
  measured: { footprintBytes: 4_900_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
export const STACK_VIDEO_MASK_MODELS: CatalogModelLike[] = [STACK_VIDEO_MASK_MODEL];

// MODELS-STAGED-2026-11-15: weights fetched to the Studio's hub cache on Jesse's approval, before any engine uses them.
// Nothing here is in STACK_MODELS, so no first-run install, tier plan or component row names them until an engine is
// wired; each is checked by sha256 and by size against the installed hub-cache blob (tests/stagedModels.test.ts).
// All were read from the authors' own repositories on 2026-11-15, never a mirror. The pickled .pth files
// (GFPGAN, facexlib) are data until a loader is written and reviewed: nothing loads them yet.
export const STACK_STAGED_STATE = "installed" as const;
/** GFPGAN v1.4 face repair (TencentARC/GFPGAN, release v1.3.0 asset GFPGANv1.4.pth). Apache-2.0 (LICENSE, 2026-11-15; its third-party notices cover tqdm only). */
export const STACK_FACE_REPAIR_GFPGAN: CatalogModelLike = data.STACK_FACE_REPAIR_GFPGAN as unknown as CatalogModelLike;
/** facexlib face detector GFPGAN calls first (xinntao/facexlib release v0.1.0). MIT. */
export const STACK_FACE_REPAIR_DETECTOR: CatalogModelLike = data.STACK_FACE_REPAIR_DETECTOR as unknown as CatalogModelLike;
/** facexlib face parser GFPGAN pastes the repaired face back with (xinntao/facexlib release v0.2.2). MIT. */
export const STACK_FACE_REPAIR_PARSER: CatalogModelLike = data.STACK_FACE_REPAIR_PARSER as unknown as CatalogModelLike;
/** Chatterbox voice change: the S3Gen decoder (ResembleAI/chatterbox, s3gen.safetensors) renders a source speaker's speech tokens in the reference voice. MIT. The repository's pickled conds.pt and the .pt twins are not installed. */
export const STACK_VOICE_CHANGE_CHATTERBOX: CatalogModelLike = {
  id: "chatterbox-vc-s3gen", role: "tts", repo: "ResembleAI/chatterbox", license: "MIT", revision: "5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18", engine: "chatterbox-vc",
  download: { url: hfUrl("ResembleAI/chatterbox/resolve/5bb1f6ee58e50c3b8d408bc82a6d3740c2db6e18/s3gen.safetensors"), sha256: "2b78103c654207393955e4900aac14a12de8ef25f4b09424f1ef91941f161d4e", approx_bytes: 1_056_484_620, hub_file: "s3gen.safetensors" },
};
/** VoxCPM2 (OpenBMB, Apache-2.0) as the mlx-community MLX conversions, VOICE-VOXCPM2-01: the owner's blind-listening pick for the conversation voice.
 * Selected only by the setting `stack.voice.engine` (`voxcpm2`, bf16, the Standard size; `voxcpm2-reduced`, 4-bit, the Reduced size): they are in
 * STACK_MODELS so the disk plan can offer them, but no tier's first-run plan names them and they carry no `sizing` (no tier binds them). Every file is pinned by sha256 and size at the revision the
 * voice lab measured, placed in the hub cache, and read offline by `mlx_tts_server.py --engine voxcpm2 --repo <repo>`. The README, .gitattributes and
 * sample WAVs of the repositories are not installed. Measured in the lab (Apple M5 Max): first audio 114 to 196 ms over HTTP.
 * The two sizes carry their own engine name so a record says which size it is (`selectedModel` filters on it). */
export const VOXCPM2_ENGINE = "voxcpm2";
export const VOXCPM2_REDUCED_ENGINE = "voxcpm2-reduced";
const VOXCPM2_FILES: Array<{ id: string; repo: string; revision: string; quantization: string; engine: string; files: Array<{ file: string; sha256: string; bytes: number }> }> = [
  { id: "voxcpm2-bf16", repo: "mlx-community/VoxCPM2-bf16", revision: "a7fb80d9056983135a54ca3f71fcc5a637ccddf5", quantization: "bf16", engine: VOXCPM2_ENGINE, files: [
    { file: "model-00001.safetensors", sha256: "676b05649d915e63f2291a0b091bd72250785b2448fe14ec81f3566cf5f47950", bytes: 4_286_190_791 },
    { file: "model-00002.safetensors", sha256: "adddb9b85026763751beb20ba050aa46ef19b6b55cf6cb6a8c44ac8b06ec5cff", bytes: 669_068_875 },
    { file: "model.safetensors.index.json", sha256: "e5c9dbe10f771ec0bc6ee244531475615547c1129b3adf6b51fd00b1466ee75a", bytes: 67_424 },
    { file: "config.json", sha256: "cf9f7d2b880e63720b6d886319b0d6ab14182bcf2939915fdf3aad12d60bc071", bytes: 5_210 },
    { file: "special_tokens_map.json", sha256: "068594063e37662c02b21acf42ebb334ef6a74fb810e68a2368f88f08351de76", bytes: 1_632 },
    { file: "tokenizer.json", sha256: "f8984687e4a92a3503d521396d454b7d68e9fdaab2a0288eb3536c7c1aa4bc20", bytes: 3_676_772 },
    { file: "tokenizer_config.json", sha256: "466575c55f0cf49530666c2e46ed14f26237dbd227ba7f4bb3bbec93df90edfc", bytes: 4_952 },
  ] },
  { id: "voxcpm2-4bit", repo: "mlx-community/VoxCPM2-4bit", revision: "dc9e5c187858da5f4a13dc4c247e297339216381", quantization: "MLX 4-bit", engine: VOXCPM2_REDUCED_ENGINE, files: [
    { file: "model.safetensors", sha256: "25bddc99a7cc6d28214f12dd676ed0afa9b0a805d6477f85c275bb113cb8acee", bytes: 2_297_215_329 },
    { file: "config.json", sha256: "91bff6db1be27bc0f4f2a287cca7a8fbb8b1d7a0b026a5dc4a71bc5f2f1ddcfb", bytes: 5_332 },
    { file: "special_tokens_map.json", sha256: "068594063e37662c02b21acf42ebb334ef6a74fb810e68a2368f88f08351de76", bytes: 1_632 },
    { file: "tokenizer.json", sha256: "f8984687e4a92a3503d521396d454b7d68e9fdaab2a0288eb3536c7c1aa4bc20", bytes: 3_676_772 },
    { file: "tokenizer_config.json", sha256: "466575c55f0cf49530666c2e46ed14f26237dbd227ba7f4bb3bbec93df90edfc", bytes: 4_952 },
  ] },
];
export const STACK_TTS_VOXCPM2_MODELS: CatalogModelLike[] = VOXCPM2_FILES.flatMap((model) => model.files.map((part, index) => ({
  id: index === 0 ? model.id : `${model.id}-${part.file.replace(/\.[^.]+$/, "").replace(/[._]/g, "-")}`,
  role: "tts" as const,
  ...(index === 0 ? {} : { component: `${model.engine}-${part.file.replace(/\.[^.]+$/, "").replace(/[._]/g, "-")}` }),
  repo: model.repo,
  license: "Apache-2.0",
  revision: model.revision,
  engine: model.engine,
  download: { url: hfUrl(`${model.repo}/resolve/${model.revision}/${part.file}`), sha256: part.sha256, approx_bytes: part.bytes, hub_file: part.file },
})));
/** The pinned speech-to-text the VoxCPM2 engine uses to read the words of a reference clip when the request brings none (NVIDIA Parakeet TDT 0.6B v2,
 * CC-BY-4.0, the mlx-community conversion). It is a companion of both VoxCPM2 sizes and installs only with them; the engine loads it offline from the
 * hub cache (`STT_REPO` in `mlx_tts_server.py`) and a missing file is a clear error, never a download. Not the Stack's `stt` role model (that is a sherpa
 * ONNX build behind its own worker, which the Python engine cannot call). Read from the hub cache on 2026-11-21 at the repository's head. */
export const VOXCPM2_STT_REPO = "mlx-community/parakeet-tdt-0.6b-v2";
export const VOXCPM2_STT_REVISION = "8ae155301e23d820d82aa60d24817c900e69e487";
export const VOXCPM2_STT_ENGINE = "voxcpm2-stt";
const VOXCPM2_STT_FILES: Array<{ file: string; sha256: string; bytes: number }> = data.VOXCPM2_STT_FILES as unknown as Array<{ file: string; sha256: string; bytes: number }>;
export const STACK_TTS_VOXCPM2_STT_MODELS: CatalogModelLike[] = VOXCPM2_STT_FILES.map((part) => ({
  id: `voxcpm2-clip-stt-${part.file.replace(/\.[^.]+$/, "").replace(/[._]/g, "-")}`,
  role: "tts" as const,
  component: `voxcpm2-clip-stt-${part.file.replace(/\.[^.]+$/, "").replace(/[._]/g, "-")}`,
  repo: VOXCPM2_STT_REPO,
  license: "CC-BY-4.0",
  revision: VOXCPM2_STT_REVISION,
  engine: VOXCPM2_STT_ENGINE,
  download: { url: hfUrl(`${VOXCPM2_STT_REPO}/resolve/${VOXCPM2_STT_REVISION}/${part.file}`), sha256: part.sha256, approx_bytes: part.bytes, hub_file: part.file },
}));
/** Every file one VoxCPM2 size needs: its own pack and the clip speech-to-text companion. */
export function voxcpm2PackFor(engine: string): CatalogModelLike[] {
  return [...STACK_TTS_VOXCPM2_MODELS.filter((pin) => pin.engine === engine), ...STACK_TTS_VOXCPM2_STT_MODELS];
}
export const STACK_STAGED_MODELS: CatalogModelLike[] = [STACK_FACE_REPAIR_GFPGAN, STACK_FACE_REPAIR_DETECTOR, STACK_FACE_REPAIR_PARSER, STACK_VOICE_CHANGE_CHATTERBOX];
/** Held by the coordinator on 2026-11-15 (a possible engine switch may replace them): recorded, never downloaded. */
export const STACK_HELD_MODELS = ["LTX-2.5 IC-LoRA adapters", "CrossView-Warp adapter", "MoGe-2", "MuseTalk 1.5", "LatentSync 1.6"] as const;

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
export const STACK_MUSIC_WHISPER_ID = "whisper-large-v3-turbo";
const MUSIC_WHISPER_REPO = "mlx-community/whisper-large-v3-turbo";
const MUSIC_WHISPER_REVISION = "f7f36a552f0b2fe385e92622c39b334c817c08d4";
const MUSIC_WHISPER_FILES = data.MUSIC_WHISPER_FILES;
const MUSIC_FILES = data.MUSIC_FILES;
const MUSIC_LM06_FILES = data.MUSIC_LM06_FILES;
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
export const STACK_MUSIC_WHISPER: CatalogModelLike = {
  id: STACK_MUSIC_WHISPER_ID, role: "music", component: "sung-transcription", repo: MUSIC_WHISPER_REPO, license: "MIT", revision: MUSIC_WHISPER_REVISION, engine: MUSIC_ENGINE,
  sizing: { profile: "p64", quantization: "fp16" },
  download: { url: hfUrl(`${MUSIC_WHISPER_REPO}/resolve/${MUSIC_WHISPER_REVISION}/weights.npz`), sha256: MUSIC_WHISPER_FILES[0]!.sha256, approx_bytes: MUSIC_WHISPER_FILES.reduce((sum, file) => sum + file.bytes, 0), directory: "whisper-large-v3-turbo", files: MUSIC_WHISPER_FILES },
};
export const STACK_MUSIC_MODELS: CatalogModelLike[] = [STACK_MUSIC_MODEL, STACK_MUSIC_LM_06];
// MUSIC-XL-01: the Boost song model, ACE-Step XL Turbo in bf16 (2026-11-02 listening test: the clearest vocals).
// Two pins because two repos hold it: the bf16 weights (a community conversion, Apache-2.0, one file) and the
// maker's config and silence latent (MIT). music/musicGen.ts links both into `acestep-v15-xl-turbo-bf16/`.
// Optional and p128 only: a computer without it makes Boost songs with the Standard model.
const MUSIC_XL_WEIGHTS_REPO = "DanielMarius/acestep_v1.5_xl_turbo_bf16.safetensors";
const MUSIC_XL_WEIGHTS_REVISION = "2d5092dee202829616bea161c10d095d587bff42";
const MUSIC_XL_WEIGHTS_FILE = "acestep_v1.5_xl_turbo_bf16.safetensors";
const MUSIC_XL_CONFIG_REPO = "ACE-Step/acestep-v15-xl-turbo";
const MUSIC_XL_CONFIG_REVISION = "d4a0b288b83ebb7e25a8c0b32c573c22e134e8ee";
export const STACK_MUSIC_XL_ID = "ace-step-1-5-xl-turbo-bf16";
export const STACK_MUSIC_XL_CONFIG_ID = "ace-step-1-5-xl-turbo-config";
const MUSIC_XL_CONFIG_FILES = data.MUSIC_XL_CONFIG_FILES;
export const STACK_MUSIC_XL: CatalogModelLike = {
  id: STACK_MUSIC_XL_ID,
  role: "music",
  component: "dit-xl-turbo-bf16",
  repo: MUSIC_XL_WEIGHTS_REPO,
  license: "Apache-2.0",
  revision: MUSIC_XL_WEIGHTS_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_XL_WEIGHTS_REPO}/resolve/${MUSIC_XL_WEIGHTS_REVISION}/${MUSIC_XL_WEIGHTS_FILE}`),
    sha256: "86a1afb0a1f711f0e3304ff65d874df3ae6783db683dcf982513fb9b6d14ae71",
    approx_bytes: 9_974_719_892,
  },
};
export const STACK_MUSIC_XL_CONFIG: CatalogModelLike = {
  id: STACK_MUSIC_XL_CONFIG_ID,
  role: "music",
  component: "dit-xl-turbo-config",
  repo: MUSIC_XL_CONFIG_REPO,
  license: "MIT",
  revision: MUSIC_XL_CONFIG_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_XL_CONFIG_REPO}/resolve/${MUSIC_XL_CONFIG_REVISION}/config.json`),
    sha256: MUSIC_XL_CONFIG_FILES[0]!.sha256,
    approx_bytes: MUSIC_XL_CONFIG_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "ACE-Step-XL-Turbo-config",
    files: MUSIC_XL_CONFIG_FILES,
  },
};
export const STACK_MUSIC_XL_MODELS: CatalogModelLike[] = [STACK_MUSIC_XL, STACK_MUSIC_XL_CONFIG];

// MUSIC-MAX-01: the Max song model, ACE-Step XL SFT (50 to 70 steps with guidance) in bf16, and its 4B planning LM. Same shape as Boost: the
// bf16 weights are a community conversion (Apache-2.0, one file), the maker's config and silence latent are MIT, and the 4B LM (MIT) is a
// separate repository whose weights come as two shards. The worker loads the XL models as float32 (2026-11-02: bf16 on the torch MPS path
// made noise on the Studio, float32 sang), so the files stay 10 GB each on disk and hold about 28 GB while a song runs.
const MUSIC_SFT_WEIGHTS_REPO = "DanielMarius/acestep_v1.5_xl_sft_bf16.safetensors";
const MUSIC_SFT_WEIGHTS_REVISION = "982a1af323046af40d1da43cde2c307000bed75b";
const MUSIC_SFT_WEIGHTS_FILE = "acestep_v1.5_xl_sft_bf16.safetensors";
const MUSIC_SFT_CONFIG_REPO = "ACE-Step/acestep-v15-xl-sft";
const MUSIC_SFT_CONFIG_REVISION = "d06de46b4622f781cf07f4a013a67d591ca52819";
const MUSIC_LM4_REPO = "ACE-Step/acestep-5Hz-lm-4B";
const MUSIC_LM4_REVISION = "0a3ec94b557aea7d508da38b31cfe7341f6ff737";
export const STACK_MUSIC_SFT_ID = "ace-step-1-5-xl-sft-bf16";
export const STACK_MUSIC_SFT_CONFIG_ID = "ace-step-1-5-xl-sft-config";
export const STACK_MUSIC_LM_4B_ID = "ace-step-1-5-lm-4b";
const MUSIC_SFT_CONFIG_FILES = data.MUSIC_SFT_CONFIG_FILES;
const MUSIC_LM4_FILES = data.MUSIC_LM4_FILES;
export const STACK_MUSIC_SFT: CatalogModelLike = {
  id: STACK_MUSIC_SFT_ID,
  role: "music",
  component: "dit-xl-sft-bf16",
  repo: MUSIC_SFT_WEIGHTS_REPO,
  license: "Apache-2.0",
  revision: MUSIC_SFT_WEIGHTS_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_SFT_WEIGHTS_REPO}/resolve/${MUSIC_SFT_WEIGHTS_REVISION}/${MUSIC_SFT_WEIGHTS_FILE}`),
    sha256: "3c05ae268353b3540fb1fd7db4fd77ffbda9802ec641b624e15648e030ecf3ce",
    approx_bytes: 9_974_719_930,
  },
};
export const STACK_MUSIC_SFT_CONFIG: CatalogModelLike = {
  id: STACK_MUSIC_SFT_CONFIG_ID,
  role: "music",
  component: "dit-xl-sft-config",
  repo: MUSIC_SFT_CONFIG_REPO,
  license: "MIT",
  revision: MUSIC_SFT_CONFIG_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_SFT_CONFIG_REPO}/resolve/${MUSIC_SFT_CONFIG_REVISION}/config.json`),
    sha256: MUSIC_SFT_CONFIG_FILES[0]!.sha256,
    approx_bytes: MUSIC_SFT_CONFIG_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "ACE-Step-XL-SFT-config",
    files: MUSIC_SFT_CONFIG_FILES,
  },
};
export const STACK_MUSIC_LM_4: CatalogModelLike = {
  id: STACK_MUSIC_LM_4B_ID,
  role: "music",
  component: "planning-lm-4b",
  repo: MUSIC_LM4_REPO,
  license: "MIT",
  revision: MUSIC_LM4_REVISION,
  engine: MUSIC_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${MUSIC_LM4_REPO}/resolve/${MUSIC_LM4_REVISION}/model-00001-of-00002.safetensors`),
    sha256: "ada9d0d4ff48f112de3f7b82cd4e7d57b4245932657e8b8edc9a5ded6a23b77f",
    approx_bytes: MUSIC_LM4_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "ACE-Step-5Hz-lm-4B",
    files: MUSIC_LM4_FILES,
  },
};
export const STACK_MUSIC_MAX_MODELS: CatalogModelLike[] = [STACK_MUSIC_SFT, STACK_MUSIC_SFT_CONFIG, STACK_MUSIC_LM_4];
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
export const STACK_STEMS_FT_MODEL_ID = "htdemucs_ft";
export const STACK_STEMS_FT_MODEL: CatalogModelLike = {
  id: STACK_STEMS_FT_MODEL_ID, role: "music", component: "stems", repo: "adefossez/HTDemucs-ft", license: "MIT", revision: "d74ac89c3a1e874fc78f152555cf4d8533f06cd4", engine: "stems",
  sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl(`adefossez/HTDemucs-ft/resolve/d74ac89c3a1e874fc78f152555cf4d8533f06cd4/f7e0c4bc.safetensors`), sha256: "2c85ab3c62dd6edd8e0b965e38b16fd1cdde357cc25de6b6bc9ce7c83f60925f", approx_bytes: 336_101_909, directory: "htdemucs_ft", files: [
    { path: "f7e0c4bc.safetensors", sha256: "2c85ab3c62dd6edd8e0b965e38b16fd1cdde357cc25de6b6bc9ce7c83f60925f", bytes: 84_025_440 }, { path: "d12395a8.safetensors", sha256: "5b01a97567ae9a3178a6236fb520251045c03eb8834bc8c24a4eec11d6c8fb56", bytes: 84_025_440 }, { path: "92cfc3b6.safetensors", sha256: "a241863551f30d01c42bd7b97da40839922ead3acb0f1fcab25682f55b4eeb59", bytes: 84_025_440 }, { path: "04573f0d.safetensors", sha256: "68854b0d7c2b3274723b5761f6fd9f5aec5f1bcd3f0de7c1669546fdb7871b7c", bytes: 84_025_440 }, { path: "htdemucs_ft.yaml", sha256: "69470b8c1bbd674437b51bc9fb491327a10ab0396b702c93389b9cf750016346", bytes: 149 },
  ] },
};
export const STACK_STEMS_6S_MODEL_ID = "htdemucs_6s";
export const STACK_STEMS_6S_MODEL: CatalogModelLike = {
  id: STACK_STEMS_6S_MODEL_ID, role: "music", component: "stems", repo: "adefossez/HTDemucs-6s", license: "MIT", revision: "3c5ee475be622df764938de97e4281a7b07ffa58", engine: "stems",
  sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl(`adefossez/HTDemucs-6s/resolve/3c5ee475be622df764938de97e4281a7b07ffa58/5c90dfd2.safetensors`), sha256: "d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411", approx_bytes: 54_885_765, directory: "htdemucs_6s", files: [
    { path: "5c90dfd2.safetensors", sha256: "d2a1745f0744721f6b8ca5bf469b67c651ea5ed1b52998cab033b2158609d411", bytes: 54_885_744 }, { path: "htdemucs_6s.yaml", sha256: "207405151270af8fd81c2373c25d27950916682ac91dca7884a11ce13dad6f58", bytes: 21 },
  ] },
};
export const STACK_STEMS_MODELS: CatalogModelLike[] = [STACK_STEMS_MODEL, STACK_STEMS_FT_MODEL, STACK_STEMS_6S_MODEL];

// SVC-01: SoulX-Singer singing voice conversion (Apache-2.0 code and weights).
// Model and RMVPE files are installed through the ordinary checksum-verifying model store.
const SOULX_REVISION = "40493ad90286056c7a9095035164434a79daa8c9";
const SOULX_PREPROCESS_REVISION = "83dc50289d22a81b1e9998f5b9e111aef7c1fdcd";
export const STACK_VOICE_CONVERT_MODEL_ID = "soulx-singer-svc";
export const STACK_VOICE_CONVERT_MODEL: CatalogModelLike = {
  id: STACK_VOICE_CONVERT_MODEL_ID, role: "music", component: "voice-convert", repo: "Soul-AILab/SoulX-Singer", license: "Apache-2.0", revision: SOULX_REVISION, engine: "voice-convert",
  sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl(`Soul-AILab/SoulX-Singer/resolve/${SOULX_REVISION}/model-svc.pt`), sha256: "38e72d9e15be6eef3cc937daaf81421a7b5b546816786530bb9aa346cee5d43c", approx_bytes: 2_793_965_154, directory: "soulx-singer-svc", files: [
    { path: "model-svc.pt", sha256: "38e72d9e15be6eef3cc937daaf81421a7b5b546816786530bb9aa346cee5d43c", bytes: 2_793_965_154 },
    { path: "config.yaml", sha256: "d164c978dde6f57e1075bc21ef5f9b7b27895267f35b735cebe863418492be38", bytes: 579 },
  ] },
};
export const STACK_VOICE_CONVERT_F0_ID = "soulx-singer-rmvpe";
export const STACK_VOICE_CONVERT_F0: CatalogModelLike = {
  id: STACK_VOICE_CONVERT_F0_ID, role: "music", component: "voice-convert", repo: "Soul-AILab/SoulX-Singer-Preprocess", license: "Apache-2.0", revision: SOULX_PREPROCESS_REVISION, engine: "voice-convert",
  sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl(`Soul-AILab/SoulX-Singer-Preprocess/resolve/${SOULX_PREPROCESS_REVISION}/rmvpe/rmvpe.pt`), sha256: "6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193", approx_bytes: 181_184_272 },
};
export const STACK_VOICE_CONVERT_WHISPER: CatalogModelLike = {
  id: "soulx-singer-whisper-base", role: "music", component: "voice-convert", repo: "openai/whisper-base", license: "Apache-2.0", revision: "e37978b90ca9030d5170a5c07aadb050351a65bb", engine: "voice-convert",
  sizing: { profile: "p64", quantization: "fp32" },
  download: { url: hfUrl("openai/whisper-base/resolve/e37978b90ca9030d5170a5c07aadb050351a65bb/model.safetensors"), sha256: "07cadb9f25677c8d50df603e66a98fbd842cce45047139baeb16e6219a1e807b", approx_bytes: 290_403_936, directory: "soulx-singer-whisper-base", files: [
    { path: "model.safetensors", sha256: "07cadb9f25677c8d50df603e66a98fbd842cce45047139baeb16e6219a1e807b", bytes: 290_403_936 },
    { path: "config.json", sha256: "a153c53883a6799b6f056b4a8d1a515c9926d03994682ba88a7616618d7da0c1", bytes: 1_983 },
    { path: "preprocessor_config.json", sha256: "9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666", bytes: 184_990 },
  ] },
};
export const STACK_VOICE_CONVERT_MODELS: CatalogModelLike[] = [STACK_VOICE_CONVERT_MODEL, STACK_VOICE_CONVERT_F0, STACK_VOICE_CONVERT_WHISPER];

// MUSIC-GEN-20b: the forced aligner behind POST /v1/audio/align, torchaudio's MMS_FA bundle (Meta's MMS wav2vec2 CTC
// alignment model, the file torchaudio would fetch itself, here pinned by sha256 and installed through the normal
// download path so nothing is fetched at run time). Licence: CC-BY-NC-4.0 (the MMS release): household use, no resale.
export const STACK_ALIGN_MODEL_ID = "mms-fa-align";
export const STACK_ALIGN_MODEL: CatalogModelLike = {
  id: STACK_ALIGN_MODEL_ID, role: "music", component: "align", repo: "facebookresearch/fairseq/examples/mms/data_prep", license: "CC-BY-NC-4.0", revision: "torchaudio-2.10.0-MMS_FA", engine: "align",
  sizing: { profile: "p16", quantization: "fp32" },
  download: { url: "https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt", sha256: "20ef12963ab4924bef49ac4fc7f58ad5da2ee43b2c11bc8c853c9b90ecdbc680", approx_bytes: 1_262_047_414 },
};
export const STACK_ALIGN_MODELS: CatalogModelLike[] = [STACK_ALIGN_MODEL];

// MP-07: sound effects, Stable Audio 3 Small-SFX (433M DiT, 44.1 kHz stereo, 8 steps) with its T5Gemma text encoder, run by the
// `sfx-gen` engine (Stability AI's stable-audio-3 source, MIT, pinned in engineCatalog). Stability's own repository is gated, so
// the pin is the ungated, unmodified mirror ddalcu/Stable-Audio-3-Small-SFX-MLX-Serve at one revision; every file is pinned by
// sha256 and size, and the pin, not the host, is the integrity check (the four large files match the hashes of Stability's
// release). Licence: the Stability AI Community License (free for a person or business under US$1M a year; commercial use needs
// registration with Stability; outputs may not train a foundation model) for the model, and Google's Gemma Terms of Use for the
// text encoder; LICENSE.md, LICENSE_GEMMA.md and NOTICE ship in the folder, and an admin accepts SFX_LICENCE_NOTICE once before
// the install (components.ts). Optional: never bundled, never in the first-run plan.
/** SCORE-STACK-01: Basic Pitch ships its small ONNX model in the pinned package wheel; there is no separate model file to catalog or accept. */
export const STACK_SCORE_MODEL_BUNDLE = { id: "basic-pitch-0.4.0", role: "music" as const, component: "score-gen", license: "Apache-2.0", revision: "0.4.0", bundled: true } as const;

export const STACK_SFX_MODEL_ID = "stable-audio-3-small-sfx";
export const SFX_REPO = "ddalcu/Stable-Audio-3-Small-SFX-MLX-Serve";
export const SFX_REVISION = "977fd4791852ba56657a8c814cfd3b0049b2ebae";
export const SFX_ENGINE = "sfx-gen";
export const SFX_LICENCE = "Stability AI Community License; Gemma Terms of Use (T5Gemma text encoder)";
const SFX_FILES = data.SFX_FILES;
export const STACK_SFX_MODEL: CatalogModelLike = {
  id: STACK_SFX_MODEL_ID, role: "music", component: "sound-effects", repo: SFX_REPO, license: SFX_LICENCE, revision: SFX_REVISION, engine: SFX_ENGINE,
  sizing: { profile: "p32", quantization: "fp32" },
  download: { url: hfUrl(`${SFX_REPO}/resolve/${SFX_REVISION}/model.safetensors`), sha256: SFX_FILES[0]!.sha256, approx_bytes: SFX_FILES.reduce((sum, file) => sum + file.bytes, 0), directory: "stable-audio-3-small-sfx", files: SFX_FILES },
};
export const STACK_SFX_MODELS: CatalogModelLike[] = [STACK_SFX_MODEL];
/** What an admin reads and accepts once before the sound effects model installs (Home shows it; the Stack records the acceptance). */
export const SFX_LICENCE_NOTICE = {
  id: "stability-community-gemma-2026-11-13",
  name: SFX_LICENCE,
  /** The licence text at the pinned revision (the same LICENSE.md the install puts beside the model); Stability's own page is stability.ai/community-license. */
  url: hfUrl(`${SFX_REPO}/blob/${SFX_REVISION}/LICENSE.md`),
  summary: [
    "The Stable Audio 3 Small-SFX model is not part of MaiPai: this computer downloads it from its published files, for your household's use.",
    "It is free for a person, or a business that earns under US$1 million a year. Using it for a business needs a free registration with Stability AI (stability.ai/community-license); a business over US$1 million a year needs Stability's paid licence.",
    "Sounds it makes may not be used to build or improve another foundation AI model, and its use must follow Stability AI's acceptable use policy and the law. Home says \"Powered by Stability AI\" where sounds are made.",
    "Its text encoder (T5Gemma) is Google's, under the Gemma Terms of Use (ai.google.dev/gemma/terms). MaiPai's own rules for who may make what still apply on top.",
  ],
};

// REC-VOICE-01: non-realtime recorded speech (the live tts role remains
// Chatterbox Turbo). This MLX conversion is pinned file-by-file so the
// household installs and verifies the weights through the ordinary store.
export const STACK_RECORDED_SPEECH_MODEL_ID = "fish-audio-drama-3-4bit";
const FISH_DRAMA3_REPO = "mlx-community/fish-audio-drama-3-4bit";
const FISH_DRAMA3_REVISION = "2b0c8028998533972e77359cce56b8bf1c5d6d4a";
const FISH_DRAMA3_FILES = data.FISH_DRAMA3_FILES;
export const STACK_RECORDED_SPEECH_MODEL: CatalogModelLike = {
  id: STACK_RECORDED_SPEECH_MODEL_ID, role: "tts", component: "recorded-speech", repo: FISH_DRAMA3_REPO,
  license: "fish-audio-community", revision: FISH_DRAMA3_REVISION, engine: "recorded-speech",
  sizing: { profile: "p64", quantization: "MLX 4-bit" },
  download: { url: hfUrl(`${FISH_DRAMA3_REPO}/resolve/${FISH_DRAMA3_REVISION}/model-00001.safetensors`), sha256: FISH_DRAMA3_FILES[0]!.sha256, approx_bytes: FISH_DRAMA3_FILES.reduce((n, file) => n + file.bytes, 0), directory: "fish-audio-drama-3-4bit", files: FISH_DRAMA3_FILES },
};
export const STACK_RECORDED_SPEECH_MODELS: CatalogModelLike[] = [STACK_RECORDED_SPEECH_MODEL];

// Speech dereverb, measured fp16 MLX conversion. The Hub LFS object is pinned
// by commit and content hash; config.json is synthesized by the worker.
export const STACK_DEREVERB_MODEL_ID = "mossformer2-se-48k";
const MOSSFORMER_REVISION = "ccd0ded00e26f38e9f5b0ba21608aa6a0bcd6434";
export const STACK_DEREVERB_MODEL: CatalogModelLike = {
  id: STACK_DEREVERB_MODEL_ID, role: "tts", component: "dereverb", repo: "starkdmi/MossFormer2_SE_48K_MLX",
  license: "Apache-2.0", revision: MOSSFORMER_REVISION, engine: "mlx-audio",
  download: { url: hfUrl(`starkdmi/MossFormer2_SE_48K_MLX/resolve/${MOSSFORMER_REVISION}/model_fp16.safetensors`), sha256: "61e63484df9c2be7e1111ca0346d431422a98b263331021a67c2d7ddb2f67a85", approx_bytes: 110_652_628, directory: "mossformer2-se-48k", files: [
    { path: "model_fp16.safetensors", sha256: "61e63484df9c2be7e1111ca0346d431422a98b263331021a67c2d7ddb2f67a85", bytes: 110_652_628 },
  ] },
};
export const STACK_DEREVERB_MODELS: CatalogModelLike[] = [STACK_DEREVERB_MODEL];

export const LTX_LICENCE = "LTX-2.x Community License Agreement (2026-08-11)";
export const LTX_LICENCE_URL = "https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2_x";
/** What an admin reads and accepts once before an LTX-2.5 video model installs (Home shows it; the Stack records the acceptance). */
export const LTX_LICENCE_NOTICE = {
  id: "ltx-2.x-community-2026-08-11",
  name: LTX_LICENCE,
  url: LTX_LICENCE_URL,
  summary: [
    "The LTX-2.5 video model is not part of MaiPai: this computer downloads it from the maker's published files, for your household's use.",
    "It is free for a person or a business that earns under $10 million a year. A business at or above $10 million a year needs its own paid licence from Lightricks for any commercial use.",
    "It may not be used to harm or exploit children, to make a video of a real person who has not agreed to it, to spread false information on purpose, or to break the law. Adult content is not on that list. MaiPai's own rules for who may make what still apply on top.",
    "Anything you share must say it was made by a machine, and the markings the model puts in a clip are never removed.",
  ],
};

// LTX25-ENGINE-01 (VIDEO-TIERS-01 in Home): the LTX-2.5 video model for the adult Standard and Boost video slots. The distilled
// transformer at 8-bit with the bundled Gemma 4 text encoder, the connector, the two VAEs, the audio VAE, the vocoder and the x2
// spatial upscaler, one pack of MrMofer's conversion (an UNGATED Hugging Face repository: no account or login is needed; the
// official dgrauet packs are gated and so cannot be a pin). The dev transformer, the distilled LoRA, the temporal upscaler and the
// duration head are not pinned: the distilled pipeline reads none of them. It is run by the fork runtime pinned in engineCatalog
// (`ltx25-gen`, MrMoferFRAN/ltx-2-mlx commit 5795228). Every file is pinned by sha256 and size at one revision, and the weights are
// NOT redistributed: an admin's own computer downloads them. The licence is the LTX-2.x Community License Agreement of 2026-08-11
// One acceptance, LICENCE-ACK-01, covers both LTX-2.5 packs. Optional: never bundled.
export const LTX25_REPO = "MrMofer/ltx-2.5-mlx-q8";
export const LTX25_REVISION = "f1b56e7dc89f71a9af2cddac787b89ed22a8b7fc";
export const STACK_VIDEO_LTX25_MODEL_ID = "ltx-2-5-q8-distilled-mlx";
export const LTX25_ENGINE = "ltx25-gen";
const LTX25_PRIMARY = "spatial_upscaler_x2.safetensors";
/** Files the worker checks before it runs a clip. */
export const LTX25_REQUIRED_FILES = ["transformer-distilled.safetensors", "connector.safetensors", "vae_decoder.safetensors", "vae_encoder.safetensors", "audio_vae.safetensors", "vocoder.safetensors", LTX25_PRIMARY, "text_encoder/model.safetensors", "text_encoder/tokenizer.json", "config.json", "embedded_config.json"];
const LTX25_FILES = data.LTX25_FILES;
export const STACK_VIDEO_LTX25_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_LTX25_MODEL_ID,
  role: "video",
  repo: LTX25_REPO,
  license: LTX_LICENCE,
  revision: LTX25_REVISION,
  engine: LTX25_ENGINE,
  sizing: { profile: "p128", quantization: "q8" },
  download: {
    url: hfUrl(`${LTX25_REPO}/resolve/${LTX25_REVISION}/${LTX25_PRIMARY}`),
    sha256: LTX25_FILES.find((file) => file.path === LTX25_PRIMARY)!.sha256,
    approx_bytes: LTX25_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "LTX-2.5-distilled-q8-MLX",
    files: LTX25_FILES,
  },
  // The largest measured footprint (768 x 448, 5 s); every size's own figure is in video/ltx25.ts.
  measured: { footprintBytes: 45_800_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
export const STACK_VIDEO_LTX25_MODELS: CatalogModelLike[] = [STACK_VIDEO_LTX25_MODEL];

// H3-VIDEO-STACK-01: published source files are pinned. Two files on existing installs have no published source; they keep working there and are not offered elsewhere.
export const STACK_VIDEO_H3_MODEL_ID = "minimax-h3";
export const H3_VIDEO_LICENSE = "MiniMax H3 Community License";
export const H3_VIDEO_LICENSE_NOTICE = data.H3_VIDEO_LICENSE_NOTICE;
export const STACK_VIDEO_H3_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_H3_MODEL_ID, role: "video", license: H3_VIDEO_LICENSE,
  engine: "minimax-h3-video-gen", sizing: { profile: "p128", quantization: "8-bit or Core4 stream2" },
  download: { url: hfUrl(`${H3_PINNED_FILES[0].repo}/resolve/${H3_PINNED_FILES[0].revision}/${H3_PINNED_FILES[0].path}`), sha256: H3_PINNED_FILES[0].sha256, approx_bytes: H3_PINNED_FILES.reduce((sum, file) => sum + file.bytes, 0), directory: "minimax_h3", files: H3_PINNED_FILES.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) },
  measured: { footprintBytes: 42_100_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
export const STACK_VIDEO_H3_MODELS: CatalogModelLike[] = [STACK_VIDEO_H3_MODEL];

// LTX25-MAX-01: the LTX-2.5 Max pack, for the Max video slot (1024x576, 10 s). The distilled transformer at bf16 with the Gemma 4 text
// encoder (its own folder, `gemma4-12b-ltx-v1`), the connector, the VAEs, the audio VAE, the vocoder, the duration head and the x2
// spatial upscaler, from the UNGATED mlx-community conversion (no account or login; the official dgrauet packs are gated and cannot be
// pinned). Left out because the distilled path reads none of them: the dev transformer (38 GB), the temporal upscaler, the pruned and
// diffusion VAE decoders, the README. It is run by the dgrauet runtime pinned in engineCatalog (`ltx25-max-gen`, release 0.18.0) and
// MUST be given the Gemma folder (video/ltx25.ts): without it the prompt is silently ignored. Every file is pinned by sha256 and size
// at one revision (hashed from the real files, 2026-11-02, and equal to the repository's own LFS digests), and nothing is
// redistributed: an admin's computer downloads it. `LICENSE.md` (the LTX-2.x Community License Agreement, 2026-08-11) and the
// acceptable-use PDF are part of the pin and stay with the weights. Optional, never bundled; the same licence acceptance covers it.
export const LTX25_MAX_REPO = "mlx-community/ltx-2.5-mlx";
export const LTX25_MAX_REVISION = "891eef810a598b93817afd2b592501a911290e21";
export const STACK_VIDEO_LTX25_MAX_MODEL_ID = "ltx-2-5-bf16-distilled-mlx-max";
export const LTX25_MAX_ENGINE = "ltx25-max-gen";
export const LTX25_MAX_GEMMA_FOLDER = "gemma4-12b-ltx-v1";
const LTX25_MAX_PRIMARY = "spatial_upscaler_x2_v1_1.safetensors";
/** Files the worker checks before it runs a Max clip. */
export const LTX25_MAX_REQUIRED_FILES = ["transformer-distilled.safetensors", "connector.safetensors", "vae_decoder.safetensors", "vae_encoder.safetensors", "audio_vae.safetensors", "vocoder.safetensors", LTX25_MAX_PRIMARY, `${LTX25_MAX_GEMMA_FOLDER}/model.safetensors`, `${LTX25_MAX_GEMMA_FOLDER}/tokenizer.json`, `${LTX25_MAX_GEMMA_FOLDER}/config.json`, "config.json", "embedded_config.json"];
const LTX25_MAX_FILES = data.LTX25_MAX_FILES;
export const STACK_VIDEO_LTX25_MAX_MODEL: CatalogModelLike = {
  id: STACK_VIDEO_LTX25_MAX_MODEL_ID,
  role: "video",
  repo: LTX25_MAX_REPO,
  license: LTX_LICENCE,
  revision: LTX25_MAX_REVISION,
  engine: LTX25_MAX_ENGINE,
  sizing: { profile: "p128", quantization: "bf16" },
  download: {
    url: hfUrl(`${LTX25_MAX_REPO}/resolve/${LTX25_MAX_REVISION}/${LTX25_MAX_PRIMARY}`),
    sha256: LTX25_MAX_FILES.find((file) => file.path === LTX25_MAX_PRIMARY)!.sha256,
    approx_bytes: LTX25_MAX_FILES.reduce((sum, file) => sum + file.bytes, 0),
    directory: "LTX-2.5-distilled-bf16-MLX-community",
    files: LTX25_MAX_FILES,
  },
  // The OS footprint of the 1024x576, 10 s clip (`footprint`, M5 Max); the MLX peak (37 GB) is not the admission figure.
  measured: { footprintBytes: 48_600_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" },
};
export const STACK_VIDEO_LTX25_MAX_MODELS: CatalogModelLike[] = [STACK_VIDEO_LTX25_MAX_MODEL];

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
export const STACK_IMAGE_KLEIN3_ID = "flux3-image-klein";
export const STACK_IMAGE_ZIMAGE_ID = "z-image-turbo";
export const STACK_IMAGE_ERNIE_ID = "ernie-image-turbo";
export const STACK_IMAGE_QWEN_ID = "qwen-image-2512-q8";
function imageFamily(id: string, repo: string, revision: string, primary: string, files: ImagePinFile[], profile: string, footprint: number | null, quantization = "bf16, run 8-bit"): CatalogModelLike[] {
  const pin = (file: ImagePinFile): CatalogModelLike["download"] => ({ url: hfUrl(`${repo}/resolve/${revision}/${file.file}`), sha256: file.sha256, approx_bytes: file.bytes, hub_file: file.file });
  const main = files.find((file) => file.file === primary)!;
  const head: CatalogModelLike = { id, role: "image", repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization }, download: pin(main), ...(footprint === null ? {} : { measured: { footprintBytes: footprint, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } }) };
  const parts = files.filter((file) => file.file !== primary).map((file): CatalogModelLike => ({ id: `${id}-${file.file.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, role: "image", component: `${id}:${file.file}`, repo, license: "Apache-2.0", revision, engine: IMAGE_ENGINE_NAME, sizing: { profile, quantization: quantization.startsWith("bf16") ? "bf16" : quantization }, download: pin(file) }));
  return [head, ...parts];
}
export const STACK_IMAGE_KLEIN_MODELS = imageFamily(STACK_IMAGE_KLEIN_ID, KLEIN_4B_REPO, KLEIN_4B_REVISION, KLEIN_4B_PRIMARY, KLEIN_4B_FILES, "p32", 13_500_000_000);
export const STACK_IMAGE_KLEIN3_MODELS = imageFamily(STACK_IMAGE_KLEIN3_ID, KLEIN3_REPO, KLEIN3_REVISION, KLEIN3_PRIMARY, KLEIN3_FILES, "p64", null, "bf16, distilled, 16 steps").map((pin) => ({ ...pin, license: "FLUX Kommunity License" }));
export const STACK_IMAGE_ZIMAGE_MODELS = imageFamily(STACK_IMAGE_ZIMAGE_ID, ZIMAGE_TURBO_REPO, ZIMAGE_TURBO_REVISION, ZIMAGE_TURBO_PRIMARY, ZIMAGE_TURBO_FILES, "p128", 30_100_000_000);
export const STACK_IMAGE_ERNIE_MODELS = imageFamily(STACK_IMAGE_ERNIE_ID, ERNIE_IMAGE_TURBO_REPO, ERNIE_IMAGE_TURBO_REVISION, ERNIE_IMAGE_TURBO_PRIMARY, ERNIE_IMAGE_TURBO_FILES, "p64", 15_000_000_000);
export const STACK_IMAGE_QWEN_MODELS = imageFamily(STACK_IMAGE_QWEN_ID, QWEN_IMAGE_REPO, QWEN_IMAGE_REVISION, QWEN_IMAGE_PRIMARY, QWEN_IMAGE_FILES, "p128", 37_400_000_000, "8-bit, prebuilt");
// H3-IMAGE-STACK-01: MiniMax H3-Image, run by the h3-image-gen engine (its own uv environment, PyPI h3-image-mlx 0.1.0a8), one
// process per picture. Five pinned files from two repositories; the primary record is the DiT and the four others are components.
// Each file sits in the hub cache at its own repository and revision, and the runner's `--models` folder is assembled from them at
// run time (images/h3Layout.ts). 49.3 GB on disk. Studio bakeoff 2026-11-15: 19.7 GB whole-process-tree peak resident, 1.8 GB streaming.
export const H3_IMAGE_ENGINE = "h3-image-gen";
export const STACK_IMAGE_H3_ID = "minimax-h3-image";
export const H3_LICENCE = "MiniMax-H3-Image Community License";
export const H3_LICENCE_URL = "https://huggingface.co/MiniMaxAI/MiniMax-H3-Image";
/** What an admin reads and accepts once before MiniMax H3-Image installs (Home shows it in Settings; the Stack records the acceptance). The install is never refused on licence grounds beyond that one acceptance. */
export const H3_LICENCE_NOTICE = {
  id: "minimax-h3-image-community-2026-11-10",
  name: `${H3_LICENCE} Agreement (2026-11-10)`,
  url: H3_LICENCE_URL,
  summary: [
    "The MiniMax H3-Image model is not part of MaiPai: this computer downloads it from the maker's published files, for your household's use.",
    "The licence limits where the model may be used (its Applicable Territory), and some regions and larger companies must apply to MiniMax separately. Read it before you accept.",
  ],
};
export const KLEIN3_LICENCE_NOTICE = data.KLEIN3_LICENCE_NOTICE;
export const STACK_IMAGE_H3_MODELS: CatalogModelLike[] = H3_IMAGE_FILES.map((file): CatalogModelLike => {
  const primary = file.file === H3_IMAGE_PRIMARY;
  return {
    id: primary ? STACK_IMAGE_H3_ID : `${STACK_IMAGE_H3_ID}-${file.part}`, role: "image", ...(primary ? {} : { component: `${STACK_IMAGE_H3_ID}:${file.file}` }),
    repo: file.repo, license: H3_LICENCE, revision: file.revision, engine: H3_IMAGE_ENGINE, sizing: { profile: "p16", quantization: "int8, prebuilt (ConvRot)" },
    download: { url: hfUrl(`${file.repo}/resolve/${file.revision}/${file.file}`), sha256: file.sha256, approx_bytes: file.bytes, hub_file: file.file },
    ...(primary ? { measured: { footprintBytes: 19_700_000_000, contextLength: 0, hardware: "Apple M5 Max, 128 GB unified memory" } } : {}),
  };
});
export const STACK_IMAGE_ENGINE_MODELS: CatalogModelLike[] = [...STACK_IMAGE_KLEIN_MODELS, ...STACK_IMAGE_KLEIN3_MODELS, ...STACK_IMAGE_ZIMAGE_MODELS, ...STACK_IMAGE_ERNIE_MODELS, ...STACK_IMAGE_QWEN_MODELS];
// MAKE-CLEARER-2026-11-13: SeedVR2 3B restores a picture (the Best level of Make clearer). It is not a picture family (it makes no picture from words and
// is not an LoRA base), so it is not in STACK_IMAGE_ENGINE_MODELS; the same mflux worker runs it, from this folder, offline. Footprint measured through mflux
// 0.23.0 in low-RAM mode on a 512 px picture (macOS peak memory footprint, M5 Max, 128 GB): 9.84 GB; the default mode peaks at 36.7 GB.
export const STACK_IMAGE_RESTORE_ID = "seedvr2-3b";
export const STACK_IMAGE_RESTORE_MODELS = imageFamily(STACK_IMAGE_RESTORE_ID, SEEDVR2_REPO, SEEDVR2_REVISION, SEEDVR2_PRIMARY, SEEDVR2_FILES, "p64", 9_840_000_000, "fp16");

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
export const STACK_MODELS: CatalogModelLike[] = [STACK_CHAT_8B_MODEL, STACK_CHAT_QWEN36_35B_MODEL, STACK_CHAT_QWEN36_35B_PROJECTOR, STACK_CHAT_QWEN38_UNCENSORED_MODEL, STACK_CHAT_QWEN38_UNCENSORED_PROJECTOR, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_MODEL, STACK_CHAT_QWEN36_HUIHUI_35B_ABLITERATED_DRAFT, STACK_CHAT_QWEN38_FLASH_NEXT_MODEL, STACK_CHAT_QWEN38_FLASH_NEXT_DRAFT, STACK_JUDGE_MODEL, STACK_CODING_MODEL, STACK_CODING_DRAFT_MODEL, STACK_STT_MODEL, STACK_STT_PARAKEET_V2_MODEL, STACK_VAD_MODEL, STACK_DIARIZATION_SEGMENTATION_MODEL, STACK_DIARIZATION_EMBEDDING_MODEL, STACK_ENDPOINT_MODEL, STACK_TTS_MODEL, STACK_TTS_TOKENIZER, STACK_TTS_VOICE, STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS, STACK_RECORDED_SPEECH_MODEL, STACK_DEREVERB_MODEL, STACK_IMAGE_MODEL, ...STACK_IMAGE_TOOL_MODELS, ...STACK_LIVEPORTRAIT_MODELS, ...STACK_IMAGE_ENGINE_MODELS, ...STACK_IMAGE_H3_MODELS, ...STACK_IMAGE_RESTORE_MODELS, ...STACK_VIDEO_MODELS, ...STACK_VIDEO_MASK_MODELS, ...STACK_VIDEO_LTX25_MODELS, ...STACK_VIDEO_LTX25_MAX_MODELS, ...STACK_MUSIC_MODELS, STACK_MUSIC_WHISPER, ...STACK_MUSIC_XL_MODELS, ...STACK_MUSIC_MAX_MODELS, ...STACK_STEMS_MODELS, ...STACK_ALIGN_MODELS, ...STACK_SFX_MODELS, ...STACK_VOICE_CONVERT_MODELS, STACK_EMBED_MODEL, STACK_VISION_MODEL, STACK_VISION_PROJECTOR, STACK_CHAT_VL_8B_MODEL, STACK_CHAT_VL_8B_PROJECTOR, ...STACK_WAKEWORD_MODELS, ...STACK_TTS_VOXCPM2_MODELS, ...STACK_TTS_VOXCPM2_STT_MODELS];

// Engines and models named in dev.md or the backlog for a role but not
// pinned yet: the components inventory lists them as candidates, so a
// role with no pin never reads as forgotten. Each names where it came from.
export interface RoleCandidate { name: string; kind: "engine" | "model"; source: string; }
export const ROLE_CANDIDATES: Partial<Record<string, RoleCandidate[]>> = data.ROLE_CANDIDATES as unknown as Partial<Record<string, RoleCandidate[]>>;
