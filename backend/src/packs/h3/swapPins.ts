// H3-PIN-01 (b): pin DATA for the head and character swap runner. Data only: nothing here downloads, installs, builds or offers anything.
// The swap routes stay private testing. They are not published, not a default and not installable by a household until the three
// conditions in `SWAP_PUBLISH_CONDITIONS` are all true and the owner has said yes.
export interface SwapPinFile { repo: string; revision: string | null; path: string; bytes: number; sha256: string }

/** The runner's upstream source. The local build carries a patch that is not in this repository (see the conditions). */
export const SWAP_RUNNER_SOURCE = { repo: "https://github.com/sawfwair/mere-run.git", branch: "main", revision: "dec2d759c59f98f99f84399376a4cf602bd66589", licence: "MIT", patch: "not in this repository: 13 modified files and 2 new files, to be added as a reviewed diff when the conditions are met" } as const;

const REF2VA = "Sawfwair/MiniMax-H3-Ref2VA-MLX-8bit";
const REF2VA_REVISION = "61dc387ef1a7166425cdacd63c2340598dcc364f";
const refFile = (path: string, bytes: number, sha256: string): SwapPinFile => ({ repo: REF2VA, revision: REF2VA_REVISION, path, bytes, sha256 });

/** The reference bundle the runner loads (8-bit, 138.6 GB). Sizes and hashes are those of the copy the swap proofs ran on; the large files' hashes come from the bundle's own SHA256SUMS. */
export const SWAP_REFERENCE_BUNDLE: readonly SwapPinFile[] = [
  refFile("transformer.safetensors", 36024412656, "234f22f69f8d40d6ed81cceed8259fa287f3c9417d40fba5274e3a7aa84e18a2"),
  refFile("text_encoder.safetensors", 28222740739, "0d1aebb6c57e6da06dd40423f65c1cdd95a914dd2e9b3a5626ac9f1083c5dc2b"),
  refFile("video_vae.safetensors", 5207806574, "1468f006f2238ed77e1160c2882d076cbc033fcb17fb3e19d6239bee152246ab"),
  refFile("audio_vae.safetensors", 605253470, "9937423e272fb7c3c0954cb9b4c17cf7ca151d67b5c06d0aa10d8f5a7b3579ab"),
  refFile("adaln_cache.safetensors", 873820740, "2cbe9e3324ef2cc5108a3ba7f1219d84079ff00a017f604fd86300005cc64fcd"),
  refFile("tokenizer.json", 7032403, "a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7"),
  refFile("tokenizer_config.json", 11003, "a07e942ac874baa13758de8d1fbdb186683cc03416b5589e1b6671c6b3057c68"),
  refFile("config.json", 857, "ccb73a1b3ab6f4475ca071a93c47a5f23447962946e33b8b8707a903610e1433"),
  refFile("transformer.conversion.json", 859, "e3e110605cc83c255307b0cd2325a46495eca8895d53a9d50af9a9081b20384b"),
];

/** The two adapters. Their source revision was not recorded when they were fetched, so it is null here and a builder pins the current revision and compares these hashes. */
export const SWAP_ADAPTERS: readonly SwapPinFile[] = [
  { repo: "Alissonerdx/Minimax-H3-ComfyUI", revision: null, path: "loras/minimax_h3_head_swap_v1.0_r32.safetensors", bytes: 310177072, sha256: "ea97bd1a8178460661055784d63b4cb560732196fd15d5d7f33bfd214b65ab00" },
  { repo: "Alissonerdx/Minimax-H3-ComfyUI", revision: null, path: "loras/minimax_h3_character_swap_v1.1_ref2va_fro.safetensors", bytes: 80673112, sha256: "ab21167bed71db99ac09527ad1f26f5f3517687ebf2e1f1bd5e91cc0bdf9b9c3" },
];

/** All three must be true, and the owner must say yes, before any swap runner, bundle or adapter is published, made a default or offered for install. */
export const SWAP_PUBLISH_CONDITIONS = [
  "A clean, reproducible rebuild of the runner from the upstream revision plus the reviewed patch, with the build flags recorded.",
  "The licences of the reference bundle repository and of both adapter repositories read and written down.",
  "The owner's yes.",
] as const;
