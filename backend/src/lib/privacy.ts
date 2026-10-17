// The Stack's outbound endpoints, as data for Home's privacy page (the
// org "what leaves the house" table). Every fetch target in this backend
// has a row here; tests/privacyRows.test.ts fails when one does not.
import { z } from "zod";

export const PrivacyRowSchema = z.object({
  id: z.string(),
  what: z.string(),
  when: z.string(),
  carries: z.string(),
  receiver: z.string(),
  setting: z.string().nullable(),
  hosts: z.array(z.string()),
});
export type PrivacyRow = z.infer<typeof PrivacyRowSchema>;

export const PRIVACY_ROWS: PrivacyRow[] = [
  {
    id: "catalog-index",
    what: "Checking for engine and model updates",
    when: "Only when Home has switched update checks on, then when Home's schedule calls the check",
    carries: "A GET with If-None-Match and User-Agent: maipai-stack/<version> (<os>-<arch>), no query string or identifier",
    receiver: "The Catalog's signed index on GitHub",
    setting: "stack.updates.enabled",
    hosts: ["github.com"],
  },
  {
    id: "downloads",
    what: "Downloading a model, an engine build or a LoRA",
    when: "Only when Home installs one or applies an update, when an adult adds a LoRA by a Hugging Face link, or, on a Mac whose chat engine is oMLX by default (Apple silicon, 64 GB or more) with the chat engine setting on automatic or oMLX, once in the background at start to fetch the pinned MLX build of the chat model (ENGINE-MLX-01; set the engine to llama-server and nothing is fetched)",
    carries: "The name of the pinned file (for a LoRA added by link, the address the adult pasted, and one request for the repository's licence and tags)",
    receiver: "Hugging Face or the mirror declared in stack.updates.model_host for models, and GitHub for engine archives, straight from this computer",
    setting: null,
    hosts: ["huggingface.co", "github.com"],
  },
  {
    id: "wakeword-assets",
    what: "Downloading pinned wakeword assets for Home to serve to a robot",
    when: "Only when Home asks the Stack to install a wakeword asset using a model download job",
    carries: "The pinned asset filename; no household or person data",
    receiver: "GitHub releases for openWakeWord and MaiPai Bot, straight from this computer",
    setting: null,
    hosts: ["github.com"],
  },
  {
    id: "provenance",
    what: "Reading a model's provenance before install",
    when: "Only when Home asks to install a model by repository",
    carries: "The repository name, then its immutable revision and file list",
    receiver: "Hugging Face or the declared mirror",
    setting: null,
    hosts: ["huggingface.co"],
  },
  {
    id: "model-size-check",
    what: "The first part of a model file's header is read to size it before download; for a model repository, the file list and configuration file are read",
    when: "Only when a person asks whether a model will fit, before any download",
    carries: "The model file's address; nothing about the household or any person",
    receiver: "The model's host (Hugging Face)",
    setting: null,
    hosts: ["huggingface.co", "us.aws.cdn.hf.co"],
  },
  {
    id: "tts-environment",
    what: "Building a Python engine's environment (the packages the voice engines, Pocket TTS and the MLX voice, ComfyUI, the web search service, the image tools, the picture generator, the video engine, the music engine, the oMLX chat engine and the web fetch tool yt-dlp run on)",
    when: "Only when the Stack starts and the search service is not built yet, when Home installs the voice or image engine, on the first image edit (remove background, erase, upscale), when Home installs the video engine or the first clip is made, when Home installs the music engine or the first song is made, when Home installs the picture generator, on the first web fetch (media.fetch, MEDIA-STACK-01), in the background at start on a Mac whose chat engine is oMLX by default and has no environment yet (ENGINE-MLX-01), and again when the Stack updates it",
    carries: "The names of the pinned packages and their hashes; uv, the tool that fetches them, comes from GitHub and sends nothing else. The video engine's source (mlx-video) and the music engine's source (ACE-Step), both pinned by commit and checksum, and the oMLX release wheel (pinned by checksum) come from GitHub the same way",
    receiver: "The Python Package Index, straight from this computer, and GitHub for the uv build",
    setting: null,
    hosts: ["pypi.org", "files.pythonhosted.org", "github.com", "docs.astral.sh"],
  },
  {
    id: "media-fetch",
    what: "Fetching a video or audio file from a link a person pasted, or from a channel or feed a person follows (the media fetch job, yt-dlp)",
    when: "Only when Home submits a media.fetch job: the moment a person pastes a link, and then each time a followed source is polled (at the source's own interval, a few items per check, with a pause between requests). A site that answers with too many requests or a sign-in wall four times is left alone for 30 minutes; only a person's own request goes through while it rests",
    carries: "A request to the site the person named, exactly as a browser's tool would make it: the link, one ordinary client identity, and the site's cookies only when the owner added a cookies file in Home. Nothing about the household or any person",
    receiver: "The site named by the link, straight from this computer. Which sites is the person's choice; the Stack has no list of its own and never contacts a video site by itself",
    setting: null,
    hosts: [],
  },
  {
    id: "media-tools",
    what: "Downloading the pinned ffmpeg and ffprobe builds the media jobs run (probe, transcode, preview)",
    when: "Only the first time a media job needs them, or when the Stack's release pins a new build; the web fetch tool itself arrives through the Python environment row above",
    carries: "The name of the pinned archive; nothing about the household. There is no version check: a new build arrives with the Stack's own release",
    receiver: "GitHub releases of jellyfin-ffmpeg, straight from this computer",
    setting: null,
    hosts: ["github.com"],
  },
  {
    id: "tts-voices",
    what: "The Stack fetching a voice, or the voice-cloning weights, for the voice engine",
    when: "Only when a request names a voice this computer does not hold yet (fetched once, then read from disk), and once for the voice-cloning weights when voice cloning is turned on and a token is set. Never when the voice engine starts: it runs offline and reads only what this computer holds",
    carries: "The file's name and its pinned revision; the Hugging Face token from settings only for the cloning weights, which Hugging Face keeps behind it",
    receiver: "Hugging Face, straight from this computer",
    setting: "stack.engines.tts.hf_token",
    hosts: ["huggingface.co"],
  },
];
