// IMGGEN-STACK-01: the image engine's pinned weights, generated from the
// Hugging Face revision listings on 2026-10-17 (large files: the repository's
// git-lfs sha256 and size; small files: hashed from the download). Each file is
// a pinned model record placed in the hub cache at its repository, revision and
// path, where the mflux worker reads the folder offline. Only the files mflux
// loads are pinned (the single-file duplicate of the transformer and the
// repository's pictures are not).
export interface ImagePinFile { file: string; sha256: string; bytes: number; }
export const KLEIN_4B_REPO = "black-forest-labs/FLUX.2-klein-4B";
export const KLEIN_4B_REVISION = "e7b7dc27f91deacad38e78976d1f2b499d76a294";
export const KLEIN_4B_PRIMARY = "transformer/diffusion_pytorch_model.safetensors";
export const KLEIN_4B_FILES: ImagePinFile[] = [
  { file: "text_encoder/config.json", sha256: "214b4c29a0d975e9fddf9994a5673f22cb2c4c5750352f9227c2c3251ebeab40", bytes: 1536 },
  { file: "text_encoder/generation_config.json", sha256: "4347b1aeed2b2b78bc059920a0b7f5fec71482e1344952b76d7665d638d71f13", bytes: 214 },
  { file: "text_encoder/model-00001-of-00002.safetensors", sha256: "8c0506e7f4936fa7e26183a4fd8da4e2bdbc5990ba64ae441f965d51228f36ea", bytes: 4967215360 },
  { file: "text_encoder/model-00002-of-00002.safetensors", sha256: "82f2bd839378541b0557bfabaf37c7d3d637071fdcb73302dedd7cf61162ce07", bytes: 3077766632 },
  { file: "text_encoder/model.safetensors.index.json", sha256: "06b3d5319b6d76d1a4a2433419180016cfd54ed62d086a5e6567a809f8c82634", bytes: 32855 },
  { file: "tokenizer/added_tokens.json", sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680", bytes: 707 },
  { file: "tokenizer/chat_template.jinja", sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8", bytes: 4168 },
  { file: "tokenizer/merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1671853 },
  { file: "tokenizer/special_tokens_map.json", sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd", bytes: 613 },
  { file: "tokenizer/tokenizer.json", sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4", bytes: 11422654 },
  { file: "tokenizer/tokenizer_config.json", sha256: "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0", bytes: 5404 },
  { file: "tokenizer/vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2776833 },
  { file: "transformer/config.json", sha256: "09733c74a3da6d17dd0a0472a091a8950c7c6935889c32c16cc800ede05029de", bytes: 541 },
  { file: "transformer/diffusion_pytorch_model.safetensors", sha256: "9f29f9edcfdae452a653ffb51a534ca4decd389952c225724ff3b94042612a6e", bytes: 7751109744 },
  { file: "vae/config.json", sha256: "0d6dfb69ae95a5e2ac9836284bbb63d8b38ce67b25ba2dff380752b2a10ab948", bytes: 821 },
  { file: "vae/diffusion_pytorch_model.safetensors", sha256: "ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04", bytes: 168120878 },
];
export const ZIMAGE_TURBO_REPO = "Tongyi-MAI/Z-Image-Turbo";
export const ZIMAGE_TURBO_REVISION = "f332072aa78be7aecdf3ee76d5c247082da564a6";
export const ZIMAGE_TURBO_PRIMARY = "transformer/diffusion_pytorch_model-00001-of-00003.safetensors";
export const ZIMAGE_TURBO_FILES: ImagePinFile[] = [
  { file: "text_encoder/config.json", sha256: "8ba006f74fecfaaeb392872a60f4a480e7ec9860153d2e1b769ec81f9a147f8a", bytes: 726 },
  { file: "text_encoder/generation_config.json", sha256: "2325da0f15bb848e018c5ae071b7943332e9f871d6b60e2ed22ca97d4cb993d2", bytes: 239 },
  { file: "text_encoder/model-00001-of-00003.safetensors", sha256: "328a91d3122359d5547f9d79521205bc0a46e1f79a792dfe650e99fc2d651223", bytes: 3957900840 },
  { file: "text_encoder/model-00002-of-00003.safetensors", sha256: "6cd087b316306a68c562436b5492edbcf6e16c6dba3a1308279caa5a58e21ca5", bytes: 3987450520 },
  { file: "text_encoder/model-00003-of-00003.safetensors", sha256: "7ca841ee75b9c61267c0c6148fd8d096d3d21b6d3e161256a9b878154f91fc52", bytes: 99630640 },
  { file: "text_encoder/model.safetensors.index.json", sha256: "6dc0981b8829fead746441f68f38f24c5ca4a3a66351f652c26c6df0efc43ab2", bytes: 32819 },
  { file: "tokenizer/merges.txt", sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5", bytes: 1671853 },
  { file: "tokenizer/tokenizer.json", sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4", bytes: 11422654 },
  { file: "tokenizer/tokenizer_config.json", sha256: "d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101", bytes: 9732 },
  { file: "tokenizer/vocab.json", sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910", bytes: 2776833 },
  { file: "transformer/config.json", sha256: "06d49d1ae533f825c4704cc616fc8bc7826e9d449dde292cc7a95163c69af24a", bytes: 473 },
  { file: "transformer/diffusion_pytorch_model-00001-of-00003.safetensors", sha256: "95facd593e2549e8252acb571c653d57f7ddb7f1060d4e81712f152555a88804", bytes: 9973693184 },
  { file: "transformer/diffusion_pytorch_model-00002-of-00003.safetensors", sha256: "a4bbe43ee184a1fb5af4b412d27555f532893bdc3165b1149e304ed82b5d7015", bytes: 9973714824 },
  { file: "transformer/diffusion_pytorch_model-00003-of-00003.safetensors", sha256: "aba4e37a590e63210878160a718d916d80398f4e1f78ab6c9b2b2a00d92769fa", bytes: 4672282880 },
  { file: "transformer/diffusion_pytorch_model.safetensors.index.json", sha256: "182a119d8018bfc61c9a62685a384af3b7d4a2f8aabbe766e07c9e1eda5b97ab", bytes: 48969 },
  { file: "vae/config.json", sha256: "e80af1e64a71883a9d10c3159d2e493e5934508da57852f6a180ae6ae63b14bd", bytes: 805 },
  { file: "vae/diffusion_pytorch_model.safetensors", sha256: "f5b59a26851551b67ae1fe58d32e76486e1e812def4696a4bea97f16604d40a3", bytes: 167666902 },
];
export const ERNIE_IMAGE_TURBO_REPO = "baidu/ERNIE-Image-Turbo";
export const ERNIE_IMAGE_TURBO_REVISION = "bc68c81e2a1730a394d5fc9fae70713dee940140";
export const ERNIE_IMAGE_TURBO_PRIMARY = "transformer/diffusion_pytorch_model-00001-of-00002.safetensors";
export const ERNIE_IMAGE_TURBO_FILES: ImagePinFile[] = [
  { file: "transformer/diffusion_pytorch_model-00001-of-00002.safetensors", sha256: "7704ba8363a3f10e3ee11cb66044f0e87a2a342c1c116aea7cdbf664cd509a8b", bytes: 9992362400 },
  { file: "transformer/diffusion_pytorch_model-00002-of-00002.safetensors", sha256: "438e3e4784af84e10d961e516bbceddaabe1ecc4a6b607519e9020eadcc86c07", bytes: 6074662728 },
  { file: "transformer/diffusion_pytorch_model.safetensors.index.json", sha256: "cdd72f1fd19be0eb582c73dc94498765ed2b3925822495ce13c5cf526204aa9c", bytes: 38947 },
  { file: "transformer/config.json", sha256: "fe20c18f4ab08b728bf117ff83f5d5b440f2a8baca9f7999b94017819478ba10", bytes: 422 },
  { file: "text_encoder/model.safetensors", sha256: "c2188c5b3d759ac35e3770056153fdcb348276bd1d10f0443a60a2bdcbb6ff7b", bytes: 7698241104 },
  { file: "text_encoder/config.json", sha256: "2c975219345634ee6b5d47172267b530f32f55ca02fef0787eb45285418e3614", bytes: 1678 },
  { file: "vae/diffusion_pytorch_model.safetensors", sha256: "ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04", bytes: 168120878 },
  { file: "vae/config.json", sha256: "4d5ba5e01de06d589dd46e2955ab97e2b0968703dce31b9ebe1d2a38c141836d", bytes: 836 },
  { file: "tokenizer/tokenizer.json", sha256: "577575622324b2e099e2648be26bdeb5e5815ffe66d7004e9e3ddbf421db6bf1", bytes: 17078110 },
  { file: "tokenizer/tokenizer_config.json", sha256: "dfd5e67b652177f3e697dd67b0792bef7779c66522f47f502af2ce1715c5ec59", bytes: 379 },
  { file: "scheduler/scheduler_config.json", sha256: "96031c39fcd4651aeaa07fa6b64262b9332967199e0b89c3a4694db127756f34", bytes: 482 },
  { file: "model_index.json", sha256: "2a483750fcc40efff027e9bd77f4ea8fc56b18beb65e486f8f0c6d214bedd409", bytes: 547 },
];
