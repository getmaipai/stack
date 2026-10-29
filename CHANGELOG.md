# Changelog

All notable changes to MaiPai Stack are recorded here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [Semantic Versioning](https://semver.org/). The Stack has no
release of its own: it ships inside MaiPai Home's installer and updates
with Home's releases, so this file tracks what a Home release picks up.

## [Unreleased]

### Added

- Coding runs on the vendor Splash 1.4.1 release (the same archive chat uses); the Ornith fork build `1.3.2-ornith.1` is retired. A real run on the Studio served the pinned Ornith-122B model and answered a tool call.
- Parakeet TDT 0.6B v2 int8 as the speech-to-text model on the 64 GB and 128 GB tiers (STT-PARAKEET-01 and -03): about half to a third of the word errors of Moonshine tiny, at about 1.8 GB resident. The 16 GB and 32 GB tiers keep Moonshine tiny, now bound explicitly.
- Fast Look (LOOK-01 step 3a): `POST /v1/images/looks` runs pinned YOLOX-nano in memory, returns household object tracks and scene tags, and keeps no image or labels on disk or in logs. Detailed Look remains unavailable.
- `media.companion_clip` now estimates each frame's actual key background from its border and removes muted or drifting green and magenta backgrounds with hue keying and colour unmixing (CMEDIA-KEY-01).
- `media.companion_clip` on the media job lane: removes green or magenta key backgrounds (or accepts alpha video), fits a loop or one-shot, and writes a transparent still plus compact H.264 and optional AV1 companion clips with the premultiplied-colour and matte player contract (CMEDIA-STACK-01).
- An optional chat model, Qwen3.6-35B-A3B (Unsloth UD-Q4_K_XL and its F16 picture file, pinned at one revision), that no tier installs. Home pulls it and loads it with `POST /stack/v1/models` and `.../actions`; the chosen chat model is stored in the new setting `stack.engines.chat.model` so it survives a restart, and an id that is no longer installed falls back to the tier's model (MODEL-SWITCH-01).
- Voices made from a reference clip on the Chatterbox Turbo engine (VOICES-02). `POST /v1/audio/speech` takes an optional `temperature` (0.1 to 2.0) and `pitch_semitones` (-12 to 12) beside `voice_url`; `voice_url` may be the address of a clip (WAV, MP3 or FLAC, 6 to 30 seconds) on the household's own network. The engine caches the prepared clip per sha256, passes the temperature to the model for that job only and restores its default voice after, and shifts the output pitch with the formants kept (numpy and scipy, no new dependency); a voice without a pitch skips the shift. A value out of range is refused with a plain message before the engine hears it. The clip tokenizer (S3TokenizerV2, 495 MB, pinned by commit and sha256) is fetched once, on the first clip voice.

### Fixed

- Engine builds staged by URL accept the Catalog engine-index tag format, including Splash `1.3.2` and llama-server `b10797`; malformed tags are rejected before a download. The schema reuses the Catalog's one tag validator. Added a Stack-side Splash coding-wire contract for JSON and streaming shapes, model-name rewriting and the 20-second pause limit (CODE-STACK-01 S5a).

### Changed

- Coding runs on Splash, about four times faster, on an Apple silicon Mac with an M3 chip or newer, 64 GB of memory or more and macOS 26.4 or later; every other computer, and any Mac where Splash does not start, keeps llama-server. Splash is installed from the pinned release (`POST /stack/v1/engines/splash/install`), its draft model (3.8 GB) installs and is removed with the coding model, the Stack lays Splash's model cache out itself by hardlink so Splash downloads nothing and runs offline, and the whole Splash process tree pauses for chat, stops cleanly and leaves nothing behind. New settings `stack.engines.coding.engine` (auto, splash or llama-server) and `stack.engines.coding.splash_cache_gb` (8); `GET /stack/v1/roles` says which engine serves coding and why (`coding.engine`, `engine_requested`, `engine_reason`); a Splash that fails to start falls back to llama-server for the same request with a repair item. The update check now accepts version tags such as `1.3.2` in the Catalog's engine index (it accepted build numbers only, which would have rejected the whole index once Splash was in it) (CODE-STACK-01 S5a).

- The coding engine now honours thinking turned off: a request with Anthropic `thinking: {type: "disabled"}`, `chat_template_kwargs.enable_thinking: false`, `reasoning_effort: "none"` or Responses `reasoning.effort: "none"` reaches the model with thinking really off (the engine ignored the Anthropic field). It also pauses while chat is being answered (for at most 120 s at a time; `stack.engines.coding.yield_to_chat`, default on), reports the model by its pin id in replies, shows its context window and slots on `GET /stack/v1/roles`, sizes its start with the engine's dry run for any model file name, and says in plain words that `previous_response_id` is not kept (CODE-STACK-01 S3b).

- Detailed video (LTX-2.3, about 74 GB) is now a Recommended part of the plan on the 128 GB tier: the setup wizard checks it by default and the maker's licence is accepted once during setup. It can be unticked, an upgrade never downloads it on its own (it shows as not installed with an Install button), and the Recommended free-space figure on that tier grows from 63.2 GB to 153.5 GB (VIDEO-LTX-03). Reversed by the AIMODELS-DATA-01 entry below: the row is optional and unchecked by default.

- The chat engine `auto` is now llama-server on every tier (ENGINE-MLX-02), even where oMLX is installed. oMLX stays available: set `stack.engines.chat.engine` to `omlx`, and only then are its environment and the 19 GB MLX model fetched. On our benches oMLX got the tool name right 58 of 70 times against 65 of 70, made fewer tool calls on math and conversions, and leaked raw tool markup once in 60 replies. The first-run plan and the default disk totals on p64 and p128 no longer include the MLX weights (`required_free_bytes` 88.9 GB to 63.2 GB), and the disk plan lists "Faster chat engine (oMLX)" as an optional row. A Mac that already runs oMLX under `auto` returns to llama-server after the next restart; set the engine to `omlx` to keep it.

- The disk plan's picture and video rows moved (AIMODELS-DATA-01): "Change pictures (FLUX.2 Klein)" is now required on the 64 GB and 128 GB tiers and installs on the first run, "Make videos (Wan2.2)" on the 128 GB tier is recommended and enters the default selection, and "Detailed videos with sound (LTX-2.3)" on that tier is optional (unchecked, about 74 GB, the maker's licence accepted once during setup). The Recommended free-space figures are 117.2 GB on the 64 GB tier (up from 88.9 GB) and 148.3 GB on the 128 GB tier (down from 153.5 GB).

### Security

- The Python environments the Stack builds for Pocket TTS and ComfyUI
  moved to torch 2.13.0 and setuptools 84.0.0 (the Dependabot alerts
  on torch up to 2.12.1 and setuptools below 83.0.0), recompiled with
  hashes on 2026-09-20. torch 2.13 ships wheels for macOS 14 and later
  only, so those two engines now need macOS 14 or later on an Apple
  silicon Mac; the build refuses an older Mac with the reason.

### Added

- Chat and voice win over heavy jobs (ISOLATION-01): while a chat, transcription or speech request is in flight, plus a 4 s tail, the running picture, video, music or image-tools worker is paused (SIGSTOP) and then continued (SIGCONT), so a clip no longer slows a reply. The job deadline and the estimate leave the paused time out, the job card says "Paused while chat is working", and `GET /stack/v1/memory` carries an `isolation` counter block. See `docs/integrations.md`.

- Detailed video (VIDEO-LTX-01): LTX-2.3 on mlx-video, a sound track with speech made in the same pass, up to 10 seconds at 768 x 448. `POST /v1/videos/generations` takes `model` `quick` or `detailed`, answers `quality` and `audio`, and `GET /stack/v1/video` lists both kinds under `qualities`. An optional component (`ltx-2-3-distilled-mlx`, 73.6 GB with the Gemma text encoder, p128 only) installs only after an admin accepts the maker's licence once (`licence_required`, `accepted_licence`). Video LoRAs now name the model they are for (`ltx-2.3` or `wan2.2-ti2v-5b`) and a clip applies only its own kind's. A picture can start a Quick clip only (Detailed answers 422 `reference_unsupported`).

### Changed

- LoRA base detection reads Civitai-style files (kohya `lora_unet_layers_N` names for Z-Image, a header that declares its base) and names Pony, Illustrious, NoobAI, FLUX.1 and Chroma files in the refusal. FLUX.2 Klein 4B stays the default picture model on every tier; Z-Image-Turbo is optional and selected by name or by a LoRA made for it.

### Fixed

- The oMLX chat engine no longer returns tool names with a namespace or control token on them (`math.math`, `generate_image.generate_image`, `convert<|message|>`): the 4-bit Muse weights echo the namespace the chat template documents, and Home looked the dotted name up as an unknown tool. The Stack now rewrites a returned name that is not an offered tool, but whose halves name one, to that tool, streamed or not (ENGINE-MLX-02).

### Added

- Self-heal (ROBUST-01): an engine that exits on its own is restarted by the Stack (2 s, 10 s, 30 s, 2 min; 5 failures in 30 minutes stops it and leaves the Repairs item with the last 20 log lines), after an identity check and a one-token request, never during an install, an update, a graphics job or low memory. The crash item names the cause in plain words (out of memory, killed by the system, missing file, port in use, bad config). `GET /stack/v1/engines/self-heal` reports crashes per day and restart events; setting `stack.runtime.self_heal`. <!-- prose-lint: allow -->
- The media service (MEDIA-STACK-01): `media.probe`, `media.fetch`, `media.transcode`, `media.preview` and `media.setup`
  jobs on one idle-priority queue, quiet mode per site after four push-back failures, Home's folder declaration, and
  pinned ffmpeg, ffprobe (jellyfin-ffmpeg 8.1.3-1) and yt-dlp 2026.8.19. Home's media apps read and convert their files
  through it.

- Video clips are made messaging-ready: the stored mp4 carries a silent AAC track and a title (picture copied untouched), and
  `GET /v1/videos/generations/{job}/messages.mp4` and the stateless `POST /v1/videos/messages` prepare any clip for a text message (H.264
  yuv420p, 1280 pixel edge, 20 MB cap). Uses the ffmpeg bundled with the video environment (VIDEOSHARE-01).

- Disk plan (2026-10-17): `GET /stack/v1/install-plan` carries `disk`, what every install costs on disk per component and tier (Home itself, chat, projector, quick helper, memory search, speech to text, both voices, picture editing tools, FLUX.2 Klein, Z-Image Turbo, video, the search helper and the Python engine environments): download, installed and peak temporary bytes, marked required, recommended or optional, with the free space a plan asks for (installed size plus 20 percent plus temporary space). Sizes come from the pins' byte counts and `lib/diskPlanMeasured.json` (`bun run measure:disk-plan`); `tests/diskPlan.test.ts` fails when a pin's bytes change without it. `docs/disk-plan.json` is the same table for every tier, for clients that run before a Stack exists.
- `GET /stack/v1/components`, `POST /stack/v1/components/{id}/install` and `DELETE /stack/v1/components/{id}`: every installable part (chat models, voices, the wake word, picture and video models, picture tools, household LoRAs) as one list with size, state, tier requirement and last use, installed as a job and removed with the space freed reported; Z-Image-Turbo is an optional component on the largest computers (COMPONENTS-01).

- Memory watchdog (2026-10-17): samples the whole computer every 5 s (`GET /stack/v1/memory`), admits picture, video, image-tool and voice-engine starts only while available memory after the job's peak stays above a reserve (`stack.memory.reserve_gb`, default the larger of 8 GB and 8 percent), and walks a WARN and CRITICAL ladder with hysteresis: refuse new work, unload idle workers, cancel queued jobs, then cancel the running job (video first), evict the judge, and restart chat only after 60 s of critical. Names the biggest memory users, logs any non-Stack process above 40 GB, stops an orphaned engine of this Stack's own engines folder (parent launchd, older than 90 s, no client connected). Shutdown answers 503 `stack_restarting` with `Retry-After` instead of dropping requests. Settings `stack.memory.watchdog`, `stack.memory.reserve_gb`, `stack.memory.reap_orphans`.
- Likeness proofs (LIKENESS-01): a clip, picture or saved style that looks like a household adult is accepted only with a short-lived Ed25519 proof Home signed
  for that one thing (the picture's hash, or the style), checked on arrival and again when the job starts. New `household_photo` source for video and picture
  references, `likeness_subject` on both LoRA libraries, `PUT /stack/v1/likeness/trust`. A starting picture or edit now has to say where it came from.

- Chat on oMLX (ENGINE-MLX-01): on Apple silicon at p64 and p128 (macOS 15 or later) chat now runs on oMLX 0.7.0 with the MLX build of Muse Glimmer 30B:
  23 percent faster generation (32.5 against 26.1 tokens/s), 36 to 42 percent faster prompt processing, 2 GB less memory, level on tool calls and reasoning
  (Home's `docs/design/chat-engine-comparison-2026-10-17.md`). `stack.engines.chat.engine` is `auto` by default (`omlx`, `llama-server` and `mlx-serve` still
  name an engine); the environment (hashed requirements) and the pinned MLX model (11 files, sha256 each) are fetched in the background at start and chat moves
  over once both are verified; llama-server stays installed and takes over if oMLX fails to start twice (`chat.engine-fallback`). Rollback: set the engine to
  `llama-server`. The prompt cache lives on disk under the engine's state folder and is emptied at every launch.
- Picture generation (IMGGEN-STACK-01 and 02, IMGGEN-EDIT-01, IMGGEN-LORA-01): FLUX.2 Klein 4B and Z-Image-Turbo on mflux in an on-demand worker, `POST /v1/images/generations` with LoRAs, image to image, n up to 4, progress, cancel and a result store, the `edit` and `edit_masked` operations on `/v1/images/edits`, the LoRA library with install by Hugging Face link, `GET /stack/v1/image`, `POST /stack/v1/image/install`.

- Video generation (VIDEO-GEN-01 to 03): `POST /v1/videos/generations` makes a 5 s, 832 x 480, 24 fps clip (text to video, or picture to video) with
  Wan2.2 TI2V-5B FastWan on mlx-video, in about 132 s on an M5 Max with a 44.1 GB peak, on tier p128 only (p64 cannot hold the 44.1 GB clip beside chat). A job API with progress by phase,
  cancel, 202 past the deadline, and the clip (H.264 mp4 and a JPEG poster) fetched by URL; one on-demand worker that exits after ten idle minutes;
  pinned weights, tokenizer and mlx-video source; a household LoRA library (`/stack/v1/video/loras`) with hash, licence and all-ages or adult-only
  class; a reference picture must be one this Stack generated. `GET /stack/v1/video` reports state, limits and what to install.
- Image tools (IMAGETOOLS-01): `POST /v1/images/edits` removes a background (Apple's on-device foreground finder on a Mac, IS-Net ONNX elsewhere),
  erases an object under a mask (Big-LaMa), upscales 2x or 4x (Real-ESRGAN general x4v3) and resizes, on a picture the person already has. One
  on-demand worker in a managed Python environment (onnxruntime, no torch) that exits when idle; three pinned ONNX models (389 MB) in the install
  plan; `GET /stack/v1/image-tools` reports state, models and limits. Output is a fresh PNG with no metadata.
- The Stack builds, starts and restarts the DuckDuckGo web search service Home's search uses (STACK-DDGS-01): a managed Python 3.12
  environment (pinned `ddgs==9.16.0`, hashed requirements) and a loopback sidecar, supervised with a growing pause between restarts.
  `GET /stack/v1/search` returns its address and state; a failed build or a service that keeps stopping is a `search.ddgs` health
  item with a Try again fix. A failing sidecar never fails the Stack.
- Chatterbox Turbo on MLX as a second voice engine beside Pocket TTS (VOICE-STUDIO-01): laughs, coughs, sighs and other tags in
  speech; `stack.voice.engine` picks the engine (the default is Chatterbox Turbo on computers with 64 GB or more, Pocket TTS below),
  and a voice engine that will not start falls back to Pocket TTS with a health warning. The role and each voice carry `tts.tags`.

- `GET /stack/v1/install-plan` returns the pinned models to install for this computer's tier, ready to post to the pull route, starter chat model first, with sizes, what is already installed and whether they fit the disk. Sizing now follows one rule: system plus graphics memory on unified-memory computers, graphics memory only otherwise, and an unreadable graphics memory is unknown (the optional `vram_gb` query supplies it) instead of a guess.
- `POST /v1/tokenize` gives the chat engine's own token count for a
  list of messages (rendered with the engine's chat template) or a raw
  string, so Home sizes its chat window with real counts (2026-10-06).
- The voice engine runs offline always; the Stack fetches a voice a
  request names, or the voice-cloning weights when voice cloning is
  turned on with a token, once and verified, before the engine uses
  it, and refuses a voice it cannot pin or cloning it cannot serve
  with the reason (2026-09-20). New setting
  `stack.engines.tts.voice_cloning`.
- A second chat engine for Apple silicon Macs, mlx-serve v26.9.4, as a
  pinned release beside llama-server; `stack.engines.chat.engine`
  chooses which one serves the chat wire after a restart, and an MLX
  model installs as a directory of files, each checksummed
  (2026-09-20).

### Changed

- On macOS the governor counts memory the system can reclaim (the file
  cache, purgeable memory, the inactive and speculative queues) as
  available, the way Activity Monitor does, instead of free plus
  inactive pages alone, so the 8B chat starts on a 24 GB Mac with
  normal memory pressure. Kernel warn or critical pressure still holds
  every new load. A waiting load's reason now says "available" and names
  the margin the machine keeps back. (STACK-AVAIL-MEM-01)
- The Stack is MaiPai Home's engine foundation, not a product
  (2026-09-20, `.github/docs/DECISIONS.md`). The backend was started
  fresh on that design: the governor, the kernel memory readers, the
  model store and its on-disk layout, the resumable checksummed
  downloads, the engine catalog and install, the identity probe, the
  health list, the role declaration, the profiles, the engine swap and
  rollback, and the launchd service were kept with their tests; the
  supervisor is now per role (spawned, managed, or a read-only url
  binding) with the same lifecycle; the event feed is one typed
  server-sent stream that stays open and replays by sequence; every
  setting is declared once and served for Home's renderer; readiness,
  updates against the Catalog's signed index, the job queue shape, the
  privacy rows, the precious-state declaration and the diagnostics
  bundle are routes Home calls. Loopback is the only authentication.
- The shared helpers (log, withTimeout, paths, archive, the zip writer,
  the hardware probe, the openapi router) come from `@maipai/core` in
  `getmaipai/shared` (pinned `core-v0.1.0`); the local copies are gone.
- The state database has three tables (`meta`, `models`, `health`) and
  one migration. A data directory from before the refocus does not
  migrate (nothing was ever installed): the daemon refuses it with a
  message naming the path.

### Removed

- The console, the showroom, the library, the palette, the helper, the
  MCP server, the Tauri desktop app, the installer and docs site, the
  operator login, client keys, the alert channels, detection and
  adoption of other tools, model groups, the series and live samplers,
  the weekly digest, storage hygiene and accounting, the network probe,
  the licence sentences, the setup plan, the speed test, the
  maintenance scheduler (Home owns every schedule and calls the Stack's
  routes), the Stack-release update manifests, the user docs tier, the
  release workflows, and every test and script for them. The product
  era's history is in git at `d4e088e`.
