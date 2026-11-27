// DISKMODELROWS-01: the disk plan's model rows are data (src/rows/diskModelRows.json). This snapshot was captured from
// the builder before the rows moved, so what each template offers - row ids in order, labels, notes, need and pins -
// cannot drift while the rows move out of diskPlan.ts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import modelRowsJson from "../src/rows/diskModelRows.json";
import { buildDiskPlan } from "@/lib/diskPlan";
import { PROFILE_TIERS } from "@/profiles";

interface SnapRow { id: string; label: string; note: string; need: string; model_ids: string[] }
const r = (id: string, label: string, note: string, need: string, model_ids: string[] = []): SnapRow => ({ id, label, note, need, model_ids });

// Rows every template that offers them gets with the same words.
const HOME = r("home", "Home itself", "Home, the AI program that runs the models, and the space the install needs to build them.", "required");
const CHAT = r("chat", "Chat AI (Qwen3 8B)", "The AI you talk to.", "required", ["qwen3-8b-instruct-q4-k-m"]);
const SPLASH_QWEN36 = r("chat-splash-qwen36-abliterated", "Qwen3.6 35B A3B (Huihui)", "Optional chat model run by Splash, with its speed-up files. Install both, then choose it in Settings.", "optional", ["qwen3-6-35b-a3b-huihui-abliterated-q4-k-m", "qwen3-6-35b-a3b-huihui-abliterated-dflash2-draft"]);
const SPLASH_FLASH = r("chat-splash-qwen38-flash-next", "Qwen3.8 Flash Next 177B (Huihui)", "Optional chat model run by Splash, with its speed-up files. Install both, then choose it in Settings.", "optional", ["qwen3-8-flash-next-177b-huihui-abliterated-iq4-xs", "qwen3-8-flash-next-177b-dflash2-draft"]);
const VISION = r("vision", "Qwen3-VL 4B", "Describes pictures for the parts of Home that need to look at one.", "recommended", ["qwen3-vl-4b-instruct-q4-k-m", "qwen3-vl-4b-instruct-mmproj-q8-0"]);
const JUDGE = r("judge", "Qwen3 4B", "A second, smaller AI that double-checks answers.", "required", ["qwen3-4b-q4-k-m"]);
const CODING = r("coding", "Qwen3.8 27B", "The model that writes code for the coding tools you connect. Its Max level uses the Max chat model, chosen under Chat.", "recommended", ["qwen3.8-27b-ud-q4-k-m", "qwen3.8-27b-dflash2-draft"]);
const EMBED = r("embed", "Memory and search model", "Lets Home find the right memory or page by meaning.", "required", ["nomic-embed-text-v1-5-q4-k-m"]);
const STT_SMALL = r("stt", "Moonshine Tiny English", "Turns what you say into text.", "required", ["moonshine-tiny-en-int8", "silero-vad", "pyannote-segmentation-3.0-int8", "titanet-small-en", "smart-turn-v3.2"]);
const STT_BIG = r("stt", "Moonshine Tiny English", "Turns what you say into text.", "required", ["parakeet-tdt-0.6b-v2-int8", "silero-vad", "pyannote-segmentation-3.0-int8", "titanet-small-en", "smart-turn-v3.2"]);
const VOICE_SMALL = r("voice", "Pocket TTS", "The standard speaking voice.", "required", ["pocket-tts-english", "pocket-tts-english-tokenizer", "pocket-tts-voice-alba"]);
const VOICE_BIG = r("voice", "Pocket TTS", "The standard speaking voice.", "required", ["pocket-tts-english", "pocket-tts-english-tokenizer", "pocket-tts-voice-alba", "mossformer2-se-48k"]);
const VOICE_BETTER = r("voice-better", "Chatterbox Turbo", "A more expressive speaking voice for larger computers.", "recommended", ["chatterbox-turbo-fp16", "chatterbox-turbo-fp16-config", "chatterbox-turbo-fp16-added-tokens", "chatterbox-turbo-fp16-merges", "chatterbox-turbo-fp16-special-tokens-map", "chatterbox-turbo-fp16-tokenizer-config", "chatterbox-turbo-fp16-vocab", "chatterbox-turbo-fp16-conds"]);
const VOXCPM2_NOTE = "Apache-2.0 licence; its listening helper is CC-BY-4.0. Install it, then choose it in Settings, Voice engine.";
const VOXCPM2 = r("voice-voxcpm2", "VoxCPM2", `An optional, very natural speaking voice that can copy a voice from a short recording. The full-size version, for larger computers. ${VOXCPM2_NOTE}`, "optional", ["voxcpm2-bf16", "voxcpm2-bf16-model-00002", "voxcpm2-bf16-model-safetensors-index", "voxcpm2-bf16-config", "voxcpm2-bf16-special-tokens-map", "voxcpm2-bf16-tokenizer", "voxcpm2-bf16-tokenizer-config", "voxcpm2-clip-stt-model", "voxcpm2-clip-stt-config", "voxcpm2-clip-stt-tokenizer", "voxcpm2-clip-stt-vocab"]); // gitleaks:allow
const VOXCPM2_REDUCED = r("voice-voxcpm2-reduced", "VoxCPM2 (smaller)", `The same voice in a smaller version that needs less memory and disk. ${VOXCPM2_NOTE}`, "optional", ["voxcpm2-4bit", "voxcpm2-4bit-config", "voxcpm2-4bit-special-tokens-map", "voxcpm2-4bit-tokenizer", "voxcpm2-4bit-tokenizer-config", "voxcpm2-clip-stt-model", "voxcpm2-clip-stt-config", "voxcpm2-clip-stt-tokenizer", "voxcpm2-clip-stt-vocab"]); // gitleaks:allow
const IMAGE_TOOLS = r("image-tools", "Image editor", "Remove a background, erase an object, upscale, resize or make a depth map for a picture.", "recommended", ["image-tool-isnet-general", "image-tool-lama-big", "image-tool-realesrgan-general-x4v3", "image-tool-depth-anything-v2-small"]);
const TOOL_LOOK = r("tool-look", "Look", "Names household objects, wall colour and light in a picture.", "optional", ["image-tool-yolox-nano", "image-tool-yolox-s"]);
const TALKING_PICTURES = r("talking-pictures", "LivePortrait", "Makes the mouth and blink pictures a talking companion plays back while it speaks. MIT licence; about 0.6 GB of model files plus a 1.5 GB engine, built on this computer. Mac with Apple silicon only.", "recommended", ["liveportrait-landmark", "liveportrait-appearance", "liveportrait-motion", "liveportrait-generator", "liveportrait-warping", "liveportrait-stitching"]);
const PICTURES = r("pictures", "FLUX.2 Klein 4B", "The everyday picture model.", "required", ["flux2-klein-4b", "flux2-klein-4b-text-encoder-config", "flux2-klein-4b-text-encoder-generation-config", "flux2-klein-4b-text-encoder-model-00001-of-00002", "flux2-klein-4b-text-encoder-model-00002-of-00002", "flux2-klein-4b-text-encoder-model-safetensors-index", "flux2-klein-4b-tokenizer-added-tokens", "flux2-klein-4b-tokenizer-chat-template", "flux2-klein-4b-tokenizer-merges", "flux2-klein-4b-tokenizer-special-tokens-map", "flux2-klein-4b-tokenizer-tokenizer", "flux2-klein-4b-tokenizer-tokenizer-config", "flux2-klein-4b-tokenizer-vocab", "flux2-klein-4b-transformer-config", "flux2-klein-4b-vae-config", "flux2-klein-4b-vae-diffusion-pytorch-model"]);
const PICTURES_ERNIE = r("pictures-ernie", "ERNIE-Image-Turbo", "Draws words inside pictures correctly.", "recommended", ["ernie-image-turbo", "ernie-image-turbo-transformer-diffusion-pytorch-model-00002-of-00002", "ernie-image-turbo-transformer-diffusion-pytorch-model-safetensors-index", "ernie-image-turbo-transformer-config", "ernie-image-turbo-text-encoder-model", "ernie-image-turbo-text-encoder-config", "ernie-image-turbo-vae-diffusion-pytorch-model", "ernie-image-turbo-vae-config", "ernie-image-turbo-tokenizer-tokenizer", "ernie-image-turbo-tokenizer-tokenizer-config", "ernie-image-turbo-scheduler-scheduler-config", "ernie-image-turbo-model-index"]);
const PICTURES_H3 = r("pictures-h3", "MiniMax H3-Image", "Makes pictures and changes them, keeps words spelled right, and takes up to sixteen reference pictures.", "recommended", ["minimax-h3-image", "minimax-h3-image-text-encoder", "minimax-h3-image-vae", "minimax-h3-image-tokenizer", "minimax-h3-image-vae-config"]);
const PICTURES_KLEIN3 = r("pictures-klein3", "FLUX 3 Image Klein", "Makes and edits pictures from words, including legible lettering, with up to nine reference pictures.", "optional", ["flux3-image-klein", "flux3-image-klein-transformer-config", "flux3-image-klein-transformer-diffusion-pytorch-model-00002-of-00002", "flux3-image-klein-transformer-diffusion-pytorch-model-safetensors-index", "flux3-image-klein-text-encoder-config", "flux3-image-klein-text-encoder-generation-config", "flux3-image-klein-text-encoder-model-00001-of-00002", "flux3-image-klein-text-encoder-model-00002-of-00002", "flux3-image-klein-text-encoder-model-safetensors-index", "flux3-image-klein-text-encoder-tokenizer", "flux3-image-klein-text-encoder-tokenizer-config", "flux3-image-klein-text-encoder-chat-template", "flux3-image-klein-text-encoder-merges", "flux3-image-klein-text-encoder-vocab", "flux3-image-klein-vae-config", "flux3-image-klein-vae-diffusion-pytorch-model"]);
const PICTURES_ZIMAGE = r("pictures-zimage", "Z-Image-Turbo", "A higher-detail picture model for the largest computers.", "optional", ["z-image-turbo", "z-image-turbo-text-encoder-config", "z-image-turbo-text-encoder-generation-config", "z-image-turbo-text-encoder-model-00001-of-00003", "z-image-turbo-text-encoder-model-00002-of-00003", "z-image-turbo-text-encoder-model-00003-of-00003", "z-image-turbo-text-encoder-model-safetensors-index", "z-image-turbo-tokenizer-merges", "z-image-turbo-tokenizer-tokenizer", "z-image-turbo-tokenizer-tokenizer-config", "z-image-turbo-tokenizer-vocab", "z-image-turbo-transformer-config", "z-image-turbo-transformer-diffusion-pytorch-model-00002-of-00003", "z-image-turbo-transformer-diffusion-pytorch-model-00003-of-00003", "z-image-turbo-transformer-diffusion-pytorch-model-safetensors-index", "z-image-turbo-vae-config", "z-image-turbo-vae-diffusion-pytorch-model"]);
const PICTURES_QWEN = r("pictures-qwen", "Qwen-Image 20B", "The best picture model, used for Max pictures.", "optional", ["qwen-image-2512-q8", "qwen-image-2512-q8-manifest", "qwen-image-2512-q8-text-encoder-0", "qwen-image-2512-q8-text-encoder-1", "qwen-image-2512-q8-text-encoder-2", "qwen-image-2512-q8-text-encoder-3", "qwen-image-2512-q8-text-encoder-4", "qwen-image-2512-q8-text-encoder-5", "qwen-image-2512-q8-text-encoder-6", "qwen-image-2512-q8-text-encoder-model-safetensors-index", "qwen-image-2512-q8-tokenizer-tokenizer", "qwen-image-2512-q8-tokenizer-tokenizer-config", "qwen-image-2512-q8-transformer-1", "qwen-image-2512-q8-transformer-10", "qwen-image-2512-q8-transformer-2", "qwen-image-2512-q8-transformer-3", "qwen-image-2512-q8-transformer-4", "qwen-image-2512-q8-transformer-5", "qwen-image-2512-q8-transformer-6", "qwen-image-2512-q8-transformer-7", "qwen-image-2512-q8-transformer-8", "qwen-image-2512-q8-transformer-9", "qwen-image-2512-q8-transformer-model-safetensors-index", "qwen-image-2512-q8-vae-0", "qwen-image-2512-q8-vae-model-safetensors-index"]);
const PICTURES_CLEARER = r("pictures-clearer", "SeedVR2 3B", "The most careful repair for old, soft or damaged pictures, used by the Best level of Make clearer.", "optional", ["seedvr2-3b", "seedvr2-3b-ema-vae-fp16"]);
const VIDEO = r("video", "Silent video", "Makes short silent clips.", "optional", ["fastwan2-2-ti2v-5b-mlx-bf16", "video-umt5-tokenizer"]);
const MUSIC = r("music", "ACE-Step 1.5", "Makes and changes songs in chat.", "optional", ["ace-step-1-5-turbo", "ace-step-1-5-lm-0-6b"]);
const MUSIC_TRANSCRIBE = r("music-transcribe", "Whisper Large v3 Turbo", "Transcribes finished songs so Home can check the words.", "optional", ["whisper-large-v3-turbo"]);
const MUSIC_BOOST = r("music-boost", "ACE-Step XL Turbo", "A larger song model with clearer voices, used for Boost songs.", "optional", ["ace-step-1-5-xl-turbo-bf16", "ace-step-1-5-xl-turbo-config"]);
const MUSIC_MAX = r("music-max", "ACE-Step XL SFT", "The best song model, with its larger planning model, used for Max songs.", "optional", ["ace-step-1-5-xl-sft-bf16", "ace-step-1-5-xl-sft-config", "ace-step-1-5-lm-4b"]);
const VIDEO_LTX25 = r("video-ltx25", "LTX-2.5 with sound", "Makes clips up to 10 seconds with a sound track and spoken words, from a sentence.", "optional", ["ltx-2-5-q8-distilled-mlx"]);
const VIDEO_LTX25_MAX = r("video-ltx25-max", "LTX-2.5 Max with sound", "Makes 1024 by 576 clips up to 10 seconds with a sound track and spoken words, from a sentence.", "optional", ["ltx-2-5-bf16-distilled-mlx-max"]);
const VIDEO_H3 = r("video-minimax-h3", "MiniMax H3", "Makes five-second clips with stereo sound from a written description.", "optional", ["minimax-h3"]);
const VIDEO_MASK = r("video-mask", "SAM 2.1 subject masks", "Tracks a selected subject through a clip for cutouts and background removal, and makes still-picture masks.", "optional", ["sam2.1-hiera-small"]);
const SOUND_EFFECTS = r("sound-effects", "Stable Audio 3 Small-SFX", "Makes short sound effects and ambience from a sentence, up to 47 seconds.", "optional", ["stable-audio-3-small-sfx"]);
const SCORE = r("score-transcription", "Spotify Basic Pitch", "Turns audio into MIDI and a note list using the bundled model.", "optional");
const STEMS = r("stems", "HTDemucs", "Separates a song made here into vocals, drums, bass and other.", "recommended", ["htdemucs"]);
const STEMS_FT = r("stems-ft", "HTDemucs fine-tuned", "Separates songs into four finer stems.", "optional", ["htdemucs_ft"]);
const STEMS_6S = r("stems-6s", "HTDemucs 6-stem", "Separates songs into six stems, including guitar and piano.", "optional", ["htdemucs_6s"]);
const ALIGN = r("align", "MMS aligner", "Finds when each word of a song's lyrics is sung.", "optional", ["mms-fa-align"]);
const VOICE_CONVERT = r("voice-convert", "SoulX-Singer", "Changes the singer in a vocal toward a reference voice.", "optional", ["soulx-singer-svc", "soulx-singer-rmvpe", "soulx-singer-whisper-base"]);
const RECORDED_SPEECH = r("recorded-speech", "Fish Audio Drama 3", "Makes a finished speech recording with optional voice references and dialogue.", "recommended", ["fish-audio-drama-3-4bit"]);
const FFMPEG = r("ffmpeg", "FFmpeg", "Cuts, mixes and changes sound and video.", "required");
const SHAZAM = r("shazam-signature", "Shazam signature", "Makes a small signature from a few seconds of music so Home can name the song.", "optional");
const SEARCH = r("search", "Search helper", "Looks up web search results for adults, when web search is turned on.", "recommended");

/** Engine environment rows, in the order the builder appends them. */
const ENGINE_ROWS: Record<string, SnapRow> = {
  python: r("engine:python", "Python base for the engines", "The shared Python the voice and picture engines run on.", "required"),
  voice: r("engine:voice", "Voice engine tools", "What the voice runs on.", "required"),
  "voice-better": r("engine:voice-better", "Better voice engine tools", "What the expressive voice runs on.", "required"),
  "voice-voxcpm2": r("engine:voice-voxcpm2", "Optional voice engine tools", "What the optional natural voice runs on.", "required"),
  pictures: r("engine:pictures", "Picture engine tools", "What making pictures runs on.", "required"),
  "pictures-h3": r("engine:pictures-h3", "Picture model engine tools", "What the picture model runs on.", "required"),
  "image-tools": r("engine:image-tools", "Picture editing engine tools", "What removing a background, erasing and enlarging run on.", "required"),
  liveportrait: r("engine:liveportrait", "Companion animation engine tools", "What making a companion's mouth and blink pictures runs on (about 1.5 GB, built on first use from pinned sources).", "required"),
  video: r("engine:video", "Video engine tools", "What making videos runs on.", "required"),
  "video-ltx25": r("engine:video-ltx25", "LTX-2.5 video engine tools", "What the LTX-2.5 videos run on.", "required"),
  "video-ltx25-max": r("engine:video-ltx25-max", "LTX-2.5 Max video engine tools", "What the LTX-2.5 Max videos run on.", "required"),
  "video-mask": r("engine:video-mask", "SAM 2.1 mask tools", "What tracking a subject through a clip runs on.", "required"),
  music: r("engine:music", "Music engine tools", "What making songs runs on.", "required"),
  "sound-effects": r("engine:sound-effects", "Sound effects engine tools", "What making sound effects runs on.", "required"),
  score: r("engine:score", "Score engine tools", "What turning audio into notes runs on.", "required"),
  "swap-composite": r("engine:swap-composite", "Swap composite tools", "What putting a new head into a clip and keeping the rest runs on.", "required"),
  stems: r("engine:stems", "Stem splitting tools", "What separating song stems runs on.", "required"),
  align: r("engine:align", "Lyric timing tools", "What timing a song's words runs on.", "required"),
  "voice-convert": r("engine:voice-convert", "Voice conversion tools", "What converting a singing voice runs on.", "required"),
  "recorded-speech": r("engine:recorded-speech", "Recorded speech tools", "What recorded speech rendering runs on.", "required"),
};
const eng = (...keys: string[]): SnapRow[] => keys.map((key) => ENGINE_ROWS[key]!);

/** What each template's plan holds, row for row, as the code produced it before the model rows became data. */
const SNAPSHOT: Record<string, SnapRow[]> = {
  p16: [HOME, CHAT, EMBED, STT_SMALL, VOICE_SMALL, IMAGE_TOOLS, TOOL_LOOK, SCORE, STEMS, STEMS_FT, STEMS_6S, ALIGN, VOICE_CONVERT, RECORDED_SPEECH, FFMPEG, SHAZAM, SEARCH,
    ...eng("python", "voice", "image-tools", "score", "stems", "align", "voice-convert", "recorded-speech")],
  p32: [HOME, CHAT, JUDGE, EMBED, STT_SMALL, VOICE_SMALL, VOXCPM2_REDUCED, IMAGE_TOOLS, TOOL_LOOK, SOUND_EFFECTS, SCORE, STEMS, STEMS_FT, STEMS_6S, ALIGN, VOICE_CONVERT, RECORDED_SPEECH, FFMPEG, SHAZAM, SEARCH,
    ...eng("python", "voice", "voice-voxcpm2", "image-tools", "sound-effects", "score", "stems", "align", "voice-convert", "recorded-speech")],
  p64: [HOME, CHAT, SPLASH_QWEN36, JUDGE, CODING, EMBED, STT_BIG, VOICE_BIG, VOICE_BETTER, VOXCPM2, VOXCPM2_REDUCED, IMAGE_TOOLS, TOOL_LOOK, TALKING_PICTURES, PICTURES, PICTURES_ERNIE, PICTURES_H3, PICTURES_KLEIN3, PICTURES_CLEARER, MUSIC, MUSIC_TRANSCRIBE, SOUND_EFFECTS, SCORE, STEMS, STEMS_FT, STEMS_6S, ALIGN, VOICE_CONVERT, RECORDED_SPEECH, FFMPEG, SHAZAM, SEARCH,
    ...eng("python", "voice", "voice-better", "voice-voxcpm2", "pictures", "pictures-h3", "image-tools", "liveportrait", "music", "sound-effects", "score", "stems", "align", "voice-convert", "recorded-speech")],
  p128: [HOME, CHAT, SPLASH_QWEN36, SPLASH_FLASH, VISION, JUDGE, CODING, EMBED, STT_BIG, VOICE_BIG, VOICE_BETTER, VOXCPM2, VOXCPM2_REDUCED, IMAGE_TOOLS, TOOL_LOOK, TALKING_PICTURES, PICTURES, PICTURES_ERNIE, PICTURES_H3, PICTURES_KLEIN3, PICTURES_ZIMAGE, PICTURES_QWEN, PICTURES_CLEARER, VIDEO, MUSIC, MUSIC_TRANSCRIBE, MUSIC_BOOST, MUSIC_MAX, VIDEO_LTX25, VIDEO_LTX25_MAX, VIDEO_H3, VIDEO_MASK, SOUND_EFFECTS, SCORE, STEMS, STEMS_FT, STEMS_6S, ALIGN, VOICE_CONVERT, RECORDED_SPEECH, FFMPEG, SHAZAM, SEARCH,
    ...eng("python", "voice", "voice-better", "voice-voxcpm2", "pictures", "pictures-h3", "image-tools", "liveportrait", "video", "video-ltx25", "video-ltx25-max", "video-mask", "music", "sound-effects", "score", "swap-composite", "stems", "align", "voice-convert", "recorded-speech")],
};

// The 128 GB recommended preset is the owner's lineup (2026-11-27): chat is the 35B Huihui with its draft, the voice is VoxCPM2, pictures are FLUX 3 Image Klein.
// Those rows replace the 8B, Pocket TTS and FLUX.2 Klein rows, and the optional rows that would repeat a planned model (Splash 35B, Chatterbox, full VoxCPM2, FLUX 3 Klein) and their engine rows drop out.
const P128_LINEUP: SnapRow[] = SNAPSHOT.p128!.filter((row) => !["chat-splash-qwen36-abliterated", "voice-better", "voice-voxcpm2", "pictures-klein3", "engine:voice", "engine:voice-better"].includes(row.id)).map((row) => {
  if (row.id === "chat") return r("chat", "Chat AI (Qwen3.6 35B A3B (Huihui))", CHAT.note, "required", SPLASH_QWEN36.model_ids);
  if (row.id === "voice") return r("voice", VOXCPM2.label, "An optional, very natural speaking voice that can copy a voice from a short recording. The full-size version, for larger computers.", "required", VOXCPM2.model_ids);
  if (row.id === "pictures") return r("pictures", PICTURES_KLEIN3.label, PICTURES_KLEIN3.note, "required", PICTURES_KLEIN3.model_ids);
  return row;
});

test("every template's rows match the snapshot taken before the model rows moved to data", () => {
  for (const tier of PROFILE_TIERS) {
    const rows = buildDiskPlan(tier).rows.map((row) => ({ id: row.id, label: row.label, note: row.note, need: row.need, model_ids: row.model_ids }));
    const expected = (tier.id === "p128" ? P128_LINEUP : SNAPSHOT[tier.id]!) as unknown as typeof rows;
    expect(rows).toEqual(expected);
  }
});

/** One entry of rows/diskModelRows.json, as the builder reads it. */
interface ModelRowEntry { id: string; part: string; need: string; engines: string[]; pins: string; unlessNotAvailable?: string; gate?: string; family?: string; noteExtra?: string; recommendedFrom?: string }

test("the model rows are data, and the part they name is no longer a literal in diskPlan.ts", () => {
  const entries = modelRowsJson as ModelRowEntry[];
  expect(entries.length).toBeGreaterThan(0);
  const source = readFileSync(join(import.meta.dir, "..", "src", "lib", "diskPlan.ts"), "utf8");
  for (const entry of entries) {
    expect(entry.id.length > 0).toBe(true);
    expect(entry.pins.length > 0).toBe(true);
    // A part id that looks like a model id (lower case, a hyphen, a digit) must not be quoted in the builder any more.
    if (/^[a-z0-9.-]+$/.test(entry.part) && entry.part.includes("-") && /\d/.test(entry.part)) expect(source.includes(`"${entry.part}"`)).toBe(false);
  }
});
