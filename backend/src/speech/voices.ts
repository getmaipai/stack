// The voice engine online only when needed (STACK-94d). Pocket TTS runs
// with HF_HUB_OFFLINE=1 always; the Stack fetches, through its own
// pinned and checksummed download path into the hub cache, exactly
// what a request needs and does not have, before the engine uses it:
// a preset voice a person picked (the precomputed embedding, pinned by
// name, revision and sha256 below), a community voice named as an
// hf:// path (resolved to a commit and the hub's own LFS digest, then
// placed at that commit), and the gated cloning weights, once, when a
// token is set and cloning is turned on. Nothing is asked of Hugging
// Face on the engine's start, and a voice the Stack cannot pin is
// refused with the reason rather than fetched by the engine.
import { join } from "node:path";
import { downloadUrl } from "@/lib/download";
import { hfUrl, resolveHuggingFace } from "@/lib/hf";
import { installCatalogModel, type CatalogModelLike } from "@/lib/modelStore";
import { modelsDir } from "@/lib/paths";
import { readHfFile } from "@/lib/store/hfCache";
import { settingValues } from "@/settings";
import { POCKET_TTS_GATED_REPO, POCKET_TTS_UNGATED_REPO } from "@/speech/pocketTts";

/** The precomputed voice embeddings of Pocket TTS 3.1.0's English
 * config (`languages/english/embeddings/<name>.safetensors` in the
 * ungated repository at the revision the package pins for presets),
 * each with its size and sha256 from the hub's file listing, read on
 * 2026-09-20. The engine maps a preset name to exactly this file. */
export const POCKET_TTS_VOICES_REVISION = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487";
export const POCKET_TTS_PRESET_VOICES: Record<string, { bytes: number; sha256: string }> = {
  alba: { bytes: 6_194_424, sha256: "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845" },
  anna: { bytes: 7_816_440, sha256: "5ea82f78db006c9fd34e32ddd5aae82674b5b32646097977436458d00af80dfa" },
  azelma: { bytes: 7_963_896, sha256: "9f3e69f29075f991fd47774566865ef0e0e637cb5a35992c9919761b5b84b1de" },
  bill_boerst: { bytes: 6_735_096, sha256: "75610127d44e0b05b442154f80f89f993df235aecc6cad7070f11000d006c188" },
  caro_davy: { bytes: 5_260_536, sha256: "a5961b63a2e7a5cfd7edc383aa9042fb70fd14a9dee6310cdc633881a7f2449a" },
  charles: { bytes: 6_194_424, sha256: "299edc20182eeccfbf94e308626f259da4fbf339daa8d5905218f2b1774639b8" },
  cosette: { bytes: 6_194_424, sha256: "c4fdc15f5a3a20c44dd0064a37e87d15d25562936e8dbad7e07b9832015a545d" },
  eponine: { bytes: 6_931_704, sha256: "bda3b76a384ff355fe0350736387765946304ae8ca16e59f60ea3296a1c99cc6" },
  estelle: { bytes: 8_258_808, sha256: "ccebef7f51762c7fc08870f5ecf268e8713551ae2c9f7984ddaec0c1e1c77153" },
  eve: { bytes: 6_538_488, sha256: "ea9c2faf862a6c9d2cb61910fdf02842ae56940382cc8c1000fdb1b43269692b" },
  fantine: { bytes: 6_538_488, sha256: "51a8a4355d7f912d4959e4b1918314fda85ad47eba0a33a1d78a4a505d3465f5" },
  george: { bytes: 6_243_576, sha256: "0c1c6c57c55a98d81254b33728150c7776f40647fe95258d1a6c1a02780b5d02" },
  giovanni: { bytes: 4_621_552, sha256: "a5ee718157ec1c6fd9c1e66a7733c7e6337d474a74a7da756455d27717885c59" },
  jane: { bytes: 7_374_072, sha256: "37386227ca8ec5bf1b8e516c13d132ce5ff5437a304fe90129a1c62f41d9a008" },
  javert: { bytes: 6_194_424, sha256: "0ae88e03ca4e76a0e16cbf321a807428febda9d9e9bc0358c02e7f9c9e2c263b" },
  jean: { bytes: 6_194_424, sha256: "90be4b8f50bb4d2dbe27e3fb4e31417cf6a57928931f0a60426a1748821a3d12" },
  juergen: { bytes: 6_243_576, sha256: "e74d67b38339fc01118e3bbe2c90d6d40e601b161dbf7be906421956ba80a532" },
  lola: { bytes: 5_948_664, sha256: "34972e86b07b17272a8061460054a08119399cace9454979052b9e2d96664e8c" },
  marius: { bytes: 6_194_424, sha256: "04f84efcb77a0547ba582c058db496f7ff4920891d49d37b9950d128422582a8" },
  mary: { bytes: 6_194_424, sha256: "a8f2adf260cab966fe0a113d6b549d6efdeaa79de544ae0ff34b5b6a41445a59" },
  michael: { bytes: 7_275_768, sha256: "8937f724ac4719b9aa51ea0ba1f18f9de0af7a663ad6263558266c1a53c9722d" },
  paul: { bytes: 6_980_856, sha256: "ed7a019168f94dfe77009f1b0de59387abc6fbb0db954d38ce722ecb77da61aa" },
  peter_yearsley: { bytes: 3_736_816, sha256: "dd977a6e15591e347c9a23fa7cc09e35a65b462917f5eeb162baff6dc9e3f685" },
  rafael: { bytes: 6_194_424, sha256: "ac19f099f6cd839875a629c3e2e91e0dfc2c197acf2875db168d0ae244fb58bd" },
  stuart_bell: { bytes: 5_260_536, sha256: "5a49da7ca5df05d02587ec4a0981c0d318e045f68e24423c4203ce474d9b33dc" },
  vera: { bytes: 6_735_096, sha256: "4bf50ddd957b5d218b264fdcf18efbbc7384d12da3eca98ca19b9e8dd6976acc" },
};

/** The gated cloning weights the package's English config names first
 * (`kyutai/pocket-tts`, the commit it pins), with the digest the hub
 * lists for the file behind the gate; the same size as the ungated
 * twin, different bytes. Fetched by the Stack with the person's token,
 * once, when voice cloning is turned on; the engine then loads it
 * offline at its next start. */
export const POCKET_TTS_CLONING_REVISION = "39592ff23c9ef80098bb74895d104c26275fe2c9";
export const POCKET_TTS_CLONING_WEIGHTS: CatalogModelLike = {
  id: "pocket-tts-english-cloning",
  role: "tts",
  component: "cloning-weights",
  repo: POCKET_TTS_GATED_REPO,
  license: "CC-BY-4.0",
  revision: POCKET_TTS_CLONING_REVISION,
  engine: "pocket-tts",
  sizing: { profile: "p16", quantization: "fp32" },
  download: {
    url: hfUrl(`${POCKET_TTS_GATED_REPO}/resolve/${POCKET_TTS_CLONING_REVISION}/languages/english/model.safetensors`),
    sha256: "473f47d99560bd50eb8b4509d3cacfe7f316ab20bdca86505403a2e6a936a6e9",
    approx_bytes: 219_029_196,
    hub_file: "languages/english/model.safetensors",
  },
};

/** The licence of a community voice: the repository's card when it
 * declares one; for `kyutai/tts-voices`, which declares none as a whole
 * and states each folder's in its README (read 2026-09-20), the folder's.
 * A voice whose licence neither says is refused. */
export const VOICE_FOLDER_LICENCES: Record<string, Record<string, string>> = {
  "kyutai/tts-voices": {
    "voice-donations/": "CC0-1.0",
    "vctk/": "CC-BY-4.0",
    "expresso/": "CC-BY-NC-4.0",
    "cml-tts/": "CC-BY-4.0",
    "ears/": "CC-BY-NC-4.0",
    "alba-mackenna/": "CC-BY-4.0",
    "voice-zero/": "CC0-1.0",
  },
};
export function voiceLicence(repo: string, path: string, declared: string | null): string | null {
  const folders = VOICE_FOLDER_LICENCES[repo];
  const folder = folders ? Object.keys(folders).find((prefix) => path.startsWith(prefix)) : undefined;
  return folder ? folders![folder]! : declared;
}

export function presetVoiceModel(name: string): CatalogModelLike {
  const pin = POCKET_TTS_PRESET_VOICES[name]!;
  const path = `languages/english/embeddings/${name}.safetensors`;
  return { id: `pocket-tts-voice-${name}`, role: "tts", component: "voice", repo: POCKET_TTS_UNGATED_REPO, license: "CC-BY-4.0", revision: POCKET_TTS_VOICES_REVISION, engine: "pocket-tts", sizing: { profile: "p16", quantization: "n/a" }, download: { url: hfUrl(`${POCKET_TTS_UNGATED_REPO}/resolve/${POCKET_TTS_VOICES_REVISION}/${path}`), sha256: pin.sha256, approx_bytes: pin.bytes, hub_file: path } };
}

/** A voice the Stack will not hand to the engine, with the reason a
 * person can act on; `status` is the route's answer. */
export class VoiceRefusedError extends Error {
  constructor(message: string, readonly status: 400 | 409, readonly reason: "voice-cloning-unavailable" | "voice-not-pinnable") { super(message); this.name = "VoiceRefusedError"; }
}

export interface VoiceOptions {
  /** The downloader, replaceable by the suite; every fetch goes through it. */
  download?: typeof downloadUrl;
  /** The hub resolver for a community voice, replaceable by the suite. */
  resolve?: typeof resolveHuggingFace;
  /** The preset table, replaceable by the suite (the real digests are the hub's). */
  presets?: Record<string, { bytes: number; sha256: string }>;
  /** The cloning weights pin, replaceable by the suite for the same reason. */
  cloningWeights?: CatalogModelLike;
  signal?: AbortSignal;
}

/** The suite's stand-ins for the downloader, the hub resolver and the
 * preset table; null outside tests. */
let optionsForTests: VoiceOptions | null = null;
export function __setVoiceOptionsForTests(options: VoiceOptions | null): void { optionsForTests = options; }
function withDefaults(options: VoiceOptions): VoiceOptions { return { ...optionsForTests, ...options }; }

export function ttsToken(): string | null {
  const token = settingValues()["stack.engines.tts.hf_token"];
  return typeof token === "string" && token.trim() ? token.trim() : null;
}
export function voiceCloningOn(): boolean { return settingValues()["stack.engines.tts.voice_cloning"] === true; }

/** Whether the gated cloning weights are in the hub cache at the pinned digest. */
export function cloningWeightsPresent(): boolean {
  const pin = optionsForTests?.cloningWeights ?? POCKET_TTS_CLONING_WEIGHTS;
  return readHfFile(POCKET_TTS_GATED_REPO, POCKET_TTS_CLONING_REVISION, pin.download!.hub_file!)?.digest === pin.download!.sha256;
}

/** Fetches the gated cloning weights once, with the token; false when
 * no token is set (nothing is asked of the hub without one). */
export async function ensureCloningWeights(given: VoiceOptions = {}): Promise<boolean> {
  const options = withDefaults(given);
  if (cloningWeightsPresent()) return true;
  const token = ttsToken();
  if (!token) return false;
  const download = options.download ?? downloadUrl;
  const pin = options.cloningWeights ?? POCKET_TTS_CLONING_WEIGHTS;
  await installCatalogModel(pin, {
    destination: join(modelsDir, pin.id, "model.safetensors"),
    signal: options.signal,
    download: (url, destination, downloadOptions) => download(url, destination, { ...downloadOptions, expectedSha256: downloadOptions?.expectedSha256 ?? pin.download!.sha256, headers: { Authorization: `Bearer ${token}` } }),
  });
  return true;
}

const HF_PRESET = new RegExp(`^hf://${POCKET_TTS_UNGATED_REPO}/languages/english/embeddings/([A-Za-z0-9_]+)\\.safetensors(?:@[0-9a-f]{40})?$`);
const HF_PATH = /^hf:\/\/([^/@]+\/[^/@]+)\/(.+?)(?:@([^@]+))?$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Whether a voice needs the cloning weights: anything that is not a
 * preset embedding is audio the engine encodes through them. */
export function voiceNeedsCloning(voiceUrl: string | undefined, presets = POCKET_TTS_PRESET_VOICES): boolean {
  if (!voiceUrl) return false;
  if (voiceUrl in presets || HF_PRESET.test(voiceUrl)) return false;
  return true;
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".home.arpa")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  return host === "[::1]" || host.startsWith("[fd") || host.startsWith("[fe80");
}

/** What a request's voice becomes before the engine sees it: a preset
 * name once its embedding is in the hub cache (fetched on the first
 * ask, then served offline); an hf:// path pinned to a commit once the
 * file is placed at the hub's own digest; an http(s) URL only on the
 * household's own network (Home's cloned voices), which the engine
 * reads over the LAN; anything else refused with the reason. A voice
 * that needs cloning is refused when the cloning weights are not on
 * disk and cannot be fetched (no token, or cloning turned off). */
export async function prepareVoice(voiceUrl: string | undefined, given: VoiceOptions = {}): Promise<string | undefined> {
  const options = withDefaults(given);
  if (!voiceUrl) return undefined;
  const presets = options.presets ?? POCKET_TTS_PRESET_VOICES;
  const download = options.download ?? downloadUrl;
  const presetName = voiceUrl in presets ? voiceUrl : HF_PRESET.exec(voiceUrl)?.[1] ?? null;
  if (presetName) {
    if (!(presetName in presets)) throw new VoiceRefusedError(`${presetName} is not a preset voice of this engine build.`, 400, "voice-not-pinnable");
    const base = presetVoiceModel(presetName);
    const model = { ...base, download: { ...base.download!, sha256: presets[presetName]!.sha256, approx_bytes: presets[presetName]!.bytes } };
    if (readHfFile(model.repo!, model.revision!, model.download.hub_file!)?.digest !== model.download.sha256) {
      await installCatalogModel(model, { destination: join(modelsDir, model.id, `${presetName}.safetensors`), download, signal: options.signal });
    }
    return presetName;
  }
  if (/^https?:\/\//.test(voiceUrl)) {
    let host: string;
    try { host = new URL(voiceUrl).hostname; } catch { throw new VoiceRefusedError("The voice URL is not a URL.", 400, "voice-not-pinnable"); }
    if (!privateHost(host)) throw new VoiceRefusedError(`The voice at ${host} cannot be pinned or verified; name a preset voice, a Hugging Face path, or a voice served on this household's own network.`, 400, "voice-not-pinnable");
    requireCloning();
    return voiceUrl;
  }
  const hf = HF_PATH.exec(voiceUrl);
  if (!hf) throw new VoiceRefusedError("A voice is a preset name, a Hugging Face path (hf://owner/repo/file), or a voice served on this household's own network.", 400, "voice-not-pinnable");
  const [, repo, path, requested] = hf as unknown as [string, string, string, string | undefined];
  requireCloning();
  const revision = requested && COMMIT.test(requested) ? requested : null;
  const placed = revision ? readHfFile(repo, revision, path) : null;
  if (placed) return `hf://${repo}/${path}@${revision}`;
  const resolve = options.resolve ?? resolveHuggingFace;
  const resolution = await resolve(repo, { revision: requested ?? undefined });
  const file = resolution.files.find((candidate) => candidate.name === path);
  if (!file) throw new VoiceRefusedError(`${repo} has no file ${path} at ${requested ?? "its current revision"}.`, 400, "voice-not-pinnable");
  if (!file.sha256) throw new VoiceRefusedError(`The hub publishes no digest for ${path} in ${repo}, so the Stack cannot verify it.`, 400, "voice-not-pinnable");
  const licence = voiceLicence(repo, path, resolution.licence);
  if (!licence) throw new VoiceRefusedError(`${repo} declares no licence for ${path}, so the Stack will not install it.`, 400, "voice-not-pinnable");
  const id = `voice-${repo.replace(/[^A-Za-z0-9._-]+/g, "-")}-${path.replace(/[^A-Za-z0-9._-]+/g, "-")}`.slice(0, 120);
  const model: CatalogModelLike = { id, role: "tts", component: "voice", repo, license: licence, revision: resolution.revision, engine: "pocket-tts", sizing: { profile: "p16", quantization: "n/a" }, download: { url: file.url, sha256: file.sha256, approx_bytes: file.sizeBytes ?? 0, hub_file: path } };
  if (readHfFile(repo, resolution.revision, path)?.digest !== file.sha256) await installCatalogModel(model, { destination: join(modelsDir, id, path.split("/").pop()!), download, signal: options.signal });
  return `hf://${repo}/${path}@${resolution.revision}`;
}

/** Cloning is served only with the gated weights on disk or fetchable:
 * a token set and cloning turned on; otherwise the reason. */
function requireCloning(): void {
  if (cloningWeightsPresent()) return;
  if (!voiceCloningOn()) throw new VoiceRefusedError("This voice needs voice cloning, which is turned off; turn on stack.engines.tts.voice_cloning (and set a Hugging Face token) and restart the voice engine.", 409, "voice-cloning-unavailable");
  if (!ttsToken()) throw new VoiceRefusedError("This voice needs the voice-cloning weights, which Hugging Face keeps behind a token; set stack.engines.tts.hf_token and restart the voice engine.", 409, "voice-cloning-unavailable");
}
