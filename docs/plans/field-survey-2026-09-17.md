# Field survey history (moved from dev.md on 2026-09-20)

These tables were the product-era "why the Stack" argument and the
2026-09-17 survey of the field. They moved here unchanged when the
Stack stopped being a product (`.github/docs/DECISIONS.md`,
2026-09-20); the product comparison no longer has a reader, and the
survey is the record of what each project taught. The 2026-09-20
necessity review ([stack-necessity-review-2026-09-20.md](stack-necessity-review-2026-09-20.md))
is the current field check. The Block B review list at the end is
kept because its test names still exist in the backend suite.

## Why the Stack, against the alternatives (2026-09-17)

The question the project has to answer, in the owner's words: why
would people use this instead of downloading and installing on their
own, or using another project. The user-facing answer is the README's
"Why the Stack" section; this is the same answer checked against the
field, so every claim points at something built or designed here.

| Alternative | What it gives you | What it does not, and the Stack does |
|---|---|---|
| Doing it yourself (Ollama plus LM Studio plus ComfyUI plus a speech server) | Each piece is good at its job | Five ports and configs; no one governs memory across them; no shared health, alerts or updates; every tool you use is bound to a specific engine |
| Ollama | A local API, model downloads, a desktop app, vision, embeddings and experimental image generation on macOS | It does not provide the Stack's role-scoped client contract, one measured admission budget across independent engines, or the Home hand-off; verify these distinctions against each release |
| LM Studio | A polished desktop app, model discovery, headless service, JIT loads and idle eviction | It overlaps much of the standalone experience; the Stack must prove a better shared operating layer across engines and clients, rather than claim that service operation is unique |
| LocalAI | One OpenAI-compatible API, a model gallery and backends for text, speech, images, video and music | It overlaps the modality list; the Stack's proposed difference is measured machine-wide admission, verifiable provenance and tested recovery across independently managed engines |
| Harbor | A prewired Docker playground for many AI services | Useful for exploration; Stack must prove a stable role API and measured native Mac operation to earn a different job |
| Jan, Open WebUI, LibreChat, LobeChat | Chat and agent frontends with their own workflows | Better places for a conversation workspace; Stack offers a local service beneath clients and leaves people and history to Home |
| oMLX, mlx-serve | Apple silicon servers with strong model management; mlx-serve also covers several media roles | Strong engine candidates; Stack must prove machine-wide admission and recovery across independent hosts rather than claim more modalities |

The Stack's claim is the operating layer: one address by role, one
measured memory budget, provenance before selection, health with a
fix, updates with rollback, alerts without a vendor, private by
construction, and a household hub that can install on top. Where
another project does a piece better, the Stack uses it as an engine
rather than competing with it, and says so on the Engines page.

## How others do it, and what we take

Surveyed 2026-09-17 while deciding whether to adopt one of these instead
of building. Product capabilities in this table change quickly; the
2026-09-18 field check and source links are in
[`plans/stack-product-review-2026-09-18.md`](plans/stack-product-review-2026-09-18.md).
The proposed Stack difference is the measured admission decision across
independent engines, verifiable provenance, recovery and the Home
client contract. Each still needs release evidence.

| Project | What it is | What we take | Why not adopt |
|---|---|---|---|
| [LocalAI](https://github.com/mudler/localai) (MIT) | One engine, OpenAI-compatible API, per-backend OCI images pulled on demand, a model gallery, Metal and MLX backends on macOS | The one-address, many-backends shape; backends as separately fetched units; an ElevenLabs-shaped speech endpoint is worth matching for TTS clients | Its speech and image backends are not the ones chosen (Piper, diffusers); gallery provenance is theirs; OCI packaging fights launchd; no pressure-based admission |
| [Harbor](https://github.com/av/harbor) (Apache-2) | A CLI over Docker Compose wiring Ollama, llama.cpp, Open WebUI, Speaches, ComfyUI, with host-native MLX on macOS | The "everything pre-wired to one frontend" first-run feeling; `eject` to a plain config is a good escape hatch | Docker-first developer playground; no supervisor, governor, updates or notifications |
| [mlx-serve](https://github.com/ddalcu/mlx-serve) (MIT) | A ~7 MB Zig binary serving text (MLX and GGUF), FLUX.2 Klein, LTX-Video 2.5, Qwen3-TTS, ACE-Step, Hunyuan3D on one port with OpenAI, Anthropic and Ollama-shaped endpoints; launchd; Hugging Face pulls | Five of our roles in one process on the Mac; the strongest `spawned` engine candidate for the Studio profile and the first-day bench | Young (1.4k stars, one maintainer), macOS 26.2 or newer, no STT, no image editing, memory policy across loaded models undocumented; provenance is "whatever repo you named" |
| [oMLX](https://github.com/jundot/omlx) (Apache-2) | MLX language server: LLM, VLM, OCR, embed, rerank; continuous batching; RAM plus SSD paged KV cache; LRU eviction; per-model idle TTL; a process memory cap defaulting to RAM minus 8 GB; pin-always-loaded; `brew services`; menu-bar app | The residency vocabulary (cap, pin, TTL, LRU, pressure) and the SSD prefix cache that brings a long companion context back in seconds | Language only; the menu-bar app has Sparkle auto-update (the bare server under brew does not); its governor knows its own process, not the machine |
| [Ollama](https://ollama.com/blog/mlx) (MIT) | `pull`, `run`, `ps`, `keep_alive`, one local API, MLX backend since 0.19 | The verbs a person expects (`pull`, `list`, `run`), and `keep_alive` as the client-side hint for residency | Cloud features that must be disabled; not a checksum or identity authority; one model family |
| [LM Studio and `llmster`](https://lmstudio.ai/docs/developer/core/headless) (closed) | Headless daemon (`lms daemon up`), JIT load on first request, auto-unload after idle TTL, `/v1/models` lists downloaded not loaded | JIT load with TTL as the default residency behavior for non-resident roles | Closed; update checks and model searches are outbound events with no named opt-out |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) (GPL-3) | Workflow graphs for image, edit, video; a queue API with job ids, progress and cancel | The job model (submit, progress events, cancel, result) for every generator role; the image-edit workflows nothing else provides | Not a language host; a `managed` sidecar, never the platform |
| [Home Assistant Supervisor](https://developers.home-assistant.io/docs/supervisor/) | Runs the core, add-ons, updates with rollback, backups, hardware, repairs | The appliance posture: a board with green lights, updates with release notes and rollback, "Repairs" as a named list of things the system noticed and how to fix each | A different product entirely; the shape, not the code |

The decision that follows: build the Stack as the operating layer, and use
these as engines under it. `mlx-serve` and `oMLX` are the two new
candidates the Studio bench measures beside `llama-server` and `mlx-lm`
(the bench list is in the hub's
`docs/plans/hub-on-apple-silicon-2026-09-17.md`, section 7).

## Block B review, 2026-09-17

1. Model re-registration preserves installed state: fixed in the Block B review, test `re-registering an installed catalog model preserves its install`.
2. Existing model files are hash-checked before verification: fixed in the Block B review, tests `an incorrect existing model file is replaced and verified by hash` and `a corrupt downloaded model is never marked verified`.
3. Spawned engine loading waits on liveness with a size-scaled timeout: fixed in the Block B review, test `waitHealthy accepts a delayed loading response within the tuned timeout`.
4. Streaming chat is refused with an honest 400: fixed in the Block B review, test `streaming chat is refused honestly`.
5. Living engine 5xx responses and cancellations do not retire the backend: fixed in the Block B review, tests `a living engine's 500 is returned without retirement` and `an aborted completion is a cancellation and does not retire the engine`.
6. Incomplete model provenance throws a typed error: fixed in the Block B review, test `an incomplete Hugging Face provenance record throws before writing`.
7. Post-load and completion calls have bounded timeouts: fixed in the Block B review, test `post-load checks time out instead of hanging`.
8. Spawned launches probe a free port and race process exit: fixed in the Block B review, test `a free spawned port is selected before engine launch`.
9. Unverified model ids return a 409 with missing fields: fixed in the Block B review, test `an unverified model is a 409 with its missing provenance`.
10. Model download size estimates are advisory while engine archive sizes stay strict: fixed in the Block B review, test `a model size estimate is advisory when its hash matches`.
