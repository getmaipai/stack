# MaiPai Stack: design record

Started 2026-09-17 from the platform decision recorded in
`getmaipai/.github/docs/DECISIONS.md` (same date): the hub's engine layer
becomes its own product. This file is the dev-tier design doc: what the
Stack is, the line it never crosses, the architecture, and the reasons.
The experience is in [`ux.md`](ux.md), the contracts other MaiPai products
rely on are in [`integrations.md`](integrations.md), and what is built and
what is missing is in [`BACKLOG.md`](BACKLOG.md).

Nothing in this file is household content: every person in an example is
from the org's persona roster.

## What the Stack is

MaiPai Stack is the local AI foundation: one service on a person's own
machine that installs, sizes, runs, watches, updates and tests the engines
and models behind every MaiPai product, and gives any local client one
stable address to use them. It is the part of MaiPai that a person who
only wants "local AI on my Mac, done right" can run alone, and it is what
MaiPai Home and MaiPai Bot are built on.

It delivers on the Mac first (Apple silicon, Metal, unified memory), with
Linux arriving for the robot and Windows for the CUDA catalogue. Same
shape on every OS: one config, one API, one set of docs; only the engine
list per platform differs.

## What the Stack is not: the line

The Stack knows **clients**, not **people**.

It has one operator login (the person who installed it) and per-client API
keys (Home, Bot, a developer's own tool). It has no Person record, no
household, no memory, no conversation history, no personality, no
packages, no apps. Its test surfaces are stateless: a chat box that
forgets, a picture box that draws once. The moment a second person in the
house wants a turn, that is MaiPai Home's job, and the Stack's own page
says so at exactly that moment (see `ux.md`, "Share with your family").

The reason is the org's no-data-debt and one-definition rules. Person is
the hub's master record, with memory, consent, kid-safety and provenance
hanging off it. A second identity store in the Stack would mean the day
Home installs, a child exists in two places with two permission models
and two safety paths. The precedent everyone already accepts: Ollama has
no users, the app on top does.

The worked case that fixed the line (2026-09-17): Oliver installs the
Stack, sets his operator login, tests chat, pictures and video as
himself. He wants his kid Sprout to try it, without pictures or video.
Sprout is a child profile in Home, restricted by default, opted in only
by an adult and never for generators; the Stack never learns Sprout's
name. What the Stack does offer Oliver is a client key scoped to roles,
so his own coding tool gets chat and embed and cannot spend memory on a
video job. That is least privilege for clients, not a person feature.

## Design principles

These are the standing rules for every decision in this repo. They sit
under the org platform principles in `getmaipai/.github/CLAUDE.md`, and
they never weaken one.

1. **Roles, not models.** The API exposes named capability roles (`chat`,
   `coding`, `judge`, `router`, `embed`, `rerank`, `vision`, `stt`,
   `tts`, `wakeword`, `image`, `video`, `music`), each on a standard
   endpoint. A client asks for a role; the Stack maps role to engine to
   model. A client never names a binary and never needs to know which
   engine answered, though every reply says so in a header.
2. **Hosts are engines, never the platform.** llama-server, mlx-serve,
   oMLX, ComfyUI, whisper.cpp and the rest are spawned or managed behind
   one stable contract. Swapping an engine never changes a consumer.
3. **Clients, not people.** One operator login, per-client keys scoped to
   roles, no Person, no memory, no history, no personality. Anything
   above that line belongs to Home and never appears here because it was
   convenient.
4. **One residency budget, owned here.** Hardware sizing, memory
   pressure, admission (one generator at a time; queue or refuse with a
   reason) and eviction live in the Stack and nowhere else. A client asks;
   the Stack answers yes, queued, or no, and says why.
5. **Provenance before selection.** Source, revision, licence, checksum
   and engine identity are recorded before a model is selectable. The
   Catalog is the index; the Stack is the verifier. A host-managed
   download does not silently become trusted.
6. **Complete without Home.** Install, sizing, test, monitoring, updates
   and notifications all work standalone, on pages a dad can read.
7. **Notifications and updates are native here, bridged by API.** The
   Stack is the one thing that knows engine versions, model revisions and
   memory pressure. It shows them in its own UI and publishes them on one
   event feed that Home's notification system subscribes to. One system
   per product, no duplicate.
8. **Zero phone-home, with the outbound table.** Update checks and model
   downloads are opt-in and listed on the privacy page; nothing else
   leaves the machine. No MaiPai-operated service sits in the path.
9. **Same shape on every OS, Mac first.** The engine list per platform
   differs; nothing else does.
10. **Measured, not assumed.** Sizing profiles and residency decisions
    come from observed process peaks, never from file sizes. A number the
    Stack shows is a number it measured on this machine.

## How others do it, and what we take

Surveyed 2026-09-17 while deciding whether to adopt one of these instead
of building. None covers the role table with the operating promises above
on Apple silicon, and the MaiPai-specific parts (provenance before
selection, the governor's admission decision, the operator-only safety
posture, the Home hand-off) are exactly what a generic host would never
own. Each one still taught something.

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

## Architecture

One daemon, one port, one data directory.

```
client (Home, Bot, a dev tool)          operator (browser, menu bar)
        |  /v1/* (OpenAI shape)                 |  admin UI
        |  /stack/v1/* (roles, jobs, events)    |
        v                                       v
+----------------------------- maipai-stack -----------------------------+
|  router: role -> engine -> model        clients & keys   events (SSE)  |
|  governor: budget, pressure, admission  updates          notifications |
|  supervisor: spawned | managed | url    hardware probe   try-it        |
|  model store: provenance, checksums     engine catalog   jobs queue    |
+------------------------------------------------------------------------+
        |               |                 |                |
   llama-server     mlx-serve / oMLX    ComfyUI        speech runtimes
   (spawned)        (spawned)           (managed)      (spawned)
```

### The daemon

`maipai-stack` is a Bun process (Hono, routes as Zod schemas through
`@hono/zod-openapi`, SQLite through Drizzle, per `STACK.md`) that serves
the API and the admin UI on one loopback port (default 8770,
configurable). It runs as a service: launchd on macOS (`com.maipai.stack`),
systemd on Linux, a Windows service later. It is loopback-only until the
operator explicitly exposes it on the LAN, and then only with a key.

The admin UI is React and Vite on `@maipai/ui`, the same kit as Home, so
the Stack's pages and Home's Admin pages look like one family. A native
macOS menu-bar item (start, stop, the board's state, "Open") is planned
after the web UI, not before it.

### Roles and the router

A role is a stable string with a declared wire shape and a declared
residency class:

| Role | Wire shape | Residency default |
|---|---|---|
| `chat`, `coding`, `judge`, `router` | OpenAI chat completions, streaming, tools | `chat` resident; `judge` resident and small; `coding` shares `chat`'s model unless sized otherwise |
| `embed`, `rerank` | OpenAI embeddings; a rerank endpoint in the same style | resident, small |
| `vision` | chat completions with image parts | resident when the chat model is multimodal, else JIT |
| `stt` | OpenAI audio transcriptions, plus a streaming session for live speech | resident, small |
| `tts` | OpenAI audio speech, plus phrase-level streaming and cancel | resident, small |
| `wakeword` | not served over HTTP; a model the Stack installs for a body process to load in-process | installed, not loaded |
| `image`, `video`, `music` | jobs (below), with a synchronous OpenAI-shaped wrapper for simple clients | JIT, one generator at a time |

The router resolves a request's role to the loaded engine and model. A
client selects a role by name in the `model` field (`"chat"`,
`"image"`), or names a concrete model id when it must. Generator roles
accept `quality: fast | everyday | best`, which the Stack maps to the
tiered models the sizing profile installed (the hub's Apple silicon plan
calls these instant, everyday and quality).

Every reply carries identity headers: `x-maipai-engine` (which engine
build answered), `x-maipai-model` and `x-maipai-revision`. This is the
hub's `engineIdentity` check promoted to a contract: a client can always
prove who answered.

### Engines and the supervisor

An engine entry in the engine catalog is one of three kinds, taken
directly from the hub's Apple silicon plan:

- **`spawned`**: the Stack downloads a pinned build (pinned version,
  pinned URL, a checksum this repo recorded), extracts it under `data/`,
  spawns it, watches it, and stops it. `llama-server` is the baseline
  everywhere; `mlx-serve`, `oMLX` and the speech runtimes are spawned
  candidates on the Mac.
- **`managed`**: a host the person installed themselves (ComfyUI, Ollama
  in local-only mode, a separately installed LM Studio server). The Stack
  probes health and identity, records the expected model revision and
  memory, and shows `offline_reason` when the host is gone. It never
  spawns or kills a managed host.
- **`url`**: a bare OpenAI-compatible endpoint the operator points at,
  for developers. Probed, identified, trusted only as far as its answers.

The supervisor owns the lifecycle of spawned engines: the generation
guard (a request in flight is never cut by a reload), the process watch
with restart, the post-load check (a real completion before a role goes
green), and the memory report the governor reads. The hub's
`llmSupervisor.ts`, `ttsSupervisor.ts`, `embedSupervisor.ts` and
`backgroundSupervisor.ts` are the hard-won logic to copy here when the
migration item runs; their restart semantics were paid for.

### The model store and provenance

A model record is written the first time a model is known and is the
only place its facts live: `id`, `role`s it can serve, `source` (a
Hugging Face repo, a Catalog package, a URL), `revision`, `sha256`,
`sizeBytes`, `licence` (SPDX where possible, the upstream text otherwise),
`engine` requirements, `installedAt`, `verifiedAt`, and the `hostIdentity`
that last served it. Every record carries an id, provenance and a clock
stamp from the first boot (the org's no-data-debt rule): pairing a robot
later is a transfer, never a translation.

A model is selectable for a role only when its checksum has been verified
and its licence recorded. The Catalog's `model` packages are the preferred
source because they arrive signed with all of this filled in; a bare
Hugging Face pull is allowed for the operator, and the Stack fills the
record itself before the model turns on.

The hub's `engineCatalog.ts` (pinned builds per platform, checksums
computed once and recorded) and `modelDownload.ts` (resumable,
checksummed, self-healing downloads) are the starting point.

### The governor: one residency budget

The governor is the one place that decides what may be loaded and what
may start. It reads the machine (total memory, current pressure, each
engine's observed peak) rather than a static reservation, and it applies
a small set of rules that the operator can see on the Hardware page:

- A **profile** names the resident set (for the Studio: the main model,
  judge, embed, STT, TTS) and the on-demand set (image, video, music).
  Profiles are proposed from the hardware probe and confirmed by a short
  first-run bench that records each resident model's real peak.
- **Admission**: a generator job starts only when the working margin the
  profile requires is free after the resident set. One generator at a
  time. A request that cannot be admitted is queued with a position or
  refused with a reason a client can show.
- **Eviction**: JIT-loaded models unload after an idle TTL; under
  pressure, least recently used first; a model the operator pinned is
  never evicted, and the UI says what pinning costs.
- **Cap**: a process-wide ceiling (default: total memory minus a margin
  the OS needs) that no combination may exceed.
- **`keep_alive`** from a client is a hint, never an override.

The vocabulary is oMLX's and LM Studio's, because operators already
understand it; the decisions are ours, because they span every engine on
the machine, not one process. The hub's `resourceGovernor.ts` is the
seed.

### Jobs

Image, video and music (and long TTS renders) are jobs: `POST` returns a
job id, progress arrives on the event feed, `cancel` works, and the result
is fetched by id. ComfyUI's queue is the model and, for image editing and
identity-preserving work, the engine. A synchronous OpenAI-shaped wrapper
(`/v1/images/generations`) exists for simple clients and for the try-it
page; it is the job API with a wait.

### Clients and keys

The operator signs in with a password (passkeys follow, reusing the hub's
pattern). A client is a named row with an API key (hashed at rest, shown
once), a set of allowed roles, per-client counters (requests, tokens,
seconds of audio, jobs) and a revoke button. Home gets one key. Bot on its
own hardware runs its own Stack and needs none from the hub's. A
developer's tool gets a key scoped to what it should be able to spend.

### Events and notifications

`GET /stack/v1/events` is a server-sent stream of typed events:
`role.state`, `engine.state`, `pressure`, `job.progress`, `job.done`,
`model.installed`, `update.available`, `update.applied`, `repair`. The
Stack's own Notifications page and its menu-bar badge read the same
stream. Home subscribes with its key and renders what matters through its
own notification system (`getmaipai/.github/docs/NOTIFICATIONS.md`); the
Stack never pushes to a phone itself, because that is Home's relationship
with the household.

### Updates

Three things update, each on its own schedule, each opt-in: the Stack
itself, engine builds, and models. The check is a single request to a
release index and it is listed on the privacy page. An update to a
spawned engine is downloaded and verified beside the current one, the
role is drained under the generation guard, the new build takes the
role, and the old build is kept for one-click rollback until the next
update. Model updates are a new revision beside the old with the same
rule. `getmaipai/.github/docs/UPDATES.md` is the standard.

### Hardware sizing

The probe reports CPU, GPU class, unified or discrete memory, free disk,
and OS. From that the Stack proposes a profile (the same tiers a person
would guess: 16 GB, 32 GB, 64 GB, 128 GB) that lists which roles it can
run resident and which on demand, with model choices per role. The
first-run bench measures, and the Hardware page shows measured numbers
with the model file and engine build beside each one. No number in the
UI is a file size pretending to be a memory footprint.

### Safety posture

The Stack is operator-only, and the operator is an adult who accepts the
one-time acknowledgment before the first generation: unrestricted
answers, their responsibility (the org's adult-acknowledgment rule, once,
no legalese). The AI-outputs disclaimer shows at first run. There are no
jailbreak presets, no harm-optimized prompt packs, and no feature whose
purpose is imagery of identifiable real people: reference-person
composition needs consent, consent needs people, and the Stack has none.

Child safety lives in Home, where children exist, deterministic and
non-removable, and the Stack has no setting that could weaken it; the
Stack is an engine layer with no idea who is asking. What it does provide
toward that end is role-scoped keys, so a client that should never reach
a generator cannot.

### Privacy

Loopback by default. Two outbound classes, both opt-in and both on the
privacy page: the update check and model or engine downloads, each
straight from the machine to the upstream host, never through a MaiPai
service. No analytics, no telemetry, no crash reports, no identifiers.

### Data layout

```
data/
  stack.db          the model store, clients, events, settings
  keys/             the secrets key (least-privilege permissions)
  engines/<id>/     extracted pinned builds, one dir per build
  models/<id>/      model files, one dir per revision
  jobs/<id>/        job outputs, pruned on a schedule
  logs/             rotating logs per engine
```

Everything under `data/` is ignored by git and readable only by the
service account. A copied `stack.db` holds no secret in plaintext.

## Platform profiles

| Platform | Engines | First customer |
|---|---|---|
| macOS, Apple silicon | `llama-server` Metal (baseline), `mlx-serve`, `oMLX`, ComfyUI (managed), whisper.cpp or MLX Whisper, the chosen TTS runtime | MaiPai Home on the Mac Studio |
| Linux, ARM and x64 | `llama-server` (CPU, CUDA, or the accelerator the robot carries), sherpa-onnx for speech, ComfyUI where a GPU exists | MaiPai Bot |
| Windows, x64 | `llama-server` CUDA, ComfyUI | The CUDA catalogue |

## What moves out of Home, later

Nothing migrates until the Stack's first milestone runs on the Studio
beside the hub. When it does, these are the hub files whose jobs become
the Stack's, so the list is fixed now:

`backend/src/lib/engineCatalog.ts`, `llmSupervisor.ts`,
`ttsSupervisor.ts`, `embedSupervisor.ts`, `backgroundSupervisor.ts`,
`resourceGovernor.ts`, `engineIdentity.ts`, `enginePostLoadCheck.ts`,
`engineStats.ts`, `engineAutotune.ts`, `modelDownload.ts`,
`modelDownloadJobs.ts`, the engine half of `stt.ts`, `sttAssets.ts`,
`updates.ts` (the engine and model part), and the routes `llm.ts`,
`openai.ts`, `stt.ts`, `tts.ts`, `host.ts` where they front an engine
rather than a person. Home keeps the turn engine, the guards, memory,
people, consent, packages, and everything a person can see.

## Open questions for the owner

1. **Name.** `stack` and "MaiPai Stack" are assumed; "Station" was the
   runner-up. Renaming costs nothing before the remote exists.
2. **Logo.** The brand set has no Stack mark yet; the README uses the
   MaiPai brand logo until one exists.
3. **Installer shape.** Recommended: Home's installer installs the Stack
   first and then itself; the Stack's own installer stands alone. Confirm.
4. **Bot's split.** Recommended: wake word and voice activity stay in the
   robot's body process (they are sensor processing, like the camera);
   STT, TTS, chat, judge and embed are Stack roles on the robot's own
   Linux Stack. The robot design pass confirms or amends this in
   `bot/docs/dev.md`.

## Battle-tested checklist (for 1.0, empty until earned)

The Stack leaves 0.x when it has run the household hub for a season
without an unplanned restart, survived every update with rollback proven
at least once, and its measured profiles have matched what a fresh
install sees on three machines it has never seen. The list grows here.
