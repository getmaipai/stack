# MaiPai Stack: design record

Started 2026-09-17 from the platform decision recorded in
`getmaipai/.github/docs/DECISIONS.md` (same date): the hub's engine layer
becomes its own product. This file is the dev-tier design doc: what the
Stack is, the line it never crosses, the architecture, and the reasons.
The experience is in [`ux.md`](ux.md), the contracts other MaiPai products
rely on are in [`integrations.md`](integrations.md), and what is built and
what is missing is in [`BACKLOG.md`](BACKLOG.md).

The admin ships as one responsive dashboard shell: a persistent desktop
sidebar becomes an off-canvas phone rail, the command palette is available
from the Cmd/Ctrl-K and slash shortcuts, and every section has a stable
route even when its backend capability is still an honest empty state.
Registry-generated UI is copied under frontend/src/kit/blocks/dashboard/
and reskinned to the Stack's orange primary token.

The first shipped proof surface is `frontend/src/pages/TryItPage.tsx`.
It uses the copied chat primitives in
`frontend/src/kit/ui/{message-scroller,message,bubble,attachment,marker}.tsx`
and the stateless SSE client in `frontend/src/lib/useStackChat.ts`.
The copied kit also includes reusable `property-panel` and `things-table`
blocks for detail panels and console tables, with `KeyValueList` for compact
panel metadata, plus `FilterColumn` and `ThingsPage` for searchable things
tables with responsive filters.
Chat uses the operator session, sends the `chat` role through the stable
OpenAI-shaped route, and shows engine identity plus first-token and
throughput measurements. Speak and Listen stay offline until their roles
are bound; generator tabs use the one-time operator acknowledgement stored
in Stack metadata and remain job-shaped until the jobs surface exists. The
page never creates people, memory, or conversation history.

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
shape on every OS: one config, one API, one set of docs; service manager, notification
transport and engine builds differ by platform as listed in org SERVICES.md.

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

## What the Stack is not: the line

The Stack knows **clients**, not **people**.

It has one operator login (the person who installed it) and per-client API
keys (Home, Bot, a developer's own tool). It has no Person record, no
household, no memory, no conversation history, no personality, no
packages, no apps. Its test surfaces are stateless: a chat box that
forgets, a image box that draws once. The moment a second person in the
house wants a turn, that is MaiPai Home's job, and the Stack's own page
says so at exactly that moment (see `ux.md`, "Share with your family").

The reason is the org's no-data-debt and one-definition rules. Person is
the hub's master record, with memory, consent, kid-safety and provenance
hanging off it. A second identity store in the Stack would mean the day
Home installs, a child exists in two places with two permission models
and two safety paths. The precedent everyone already accepts: Ollama has
no users, the app on top does.

The worked case that fixed the line (2026-09-17): Oliver installs the
Stack, sets his operator login, tests chat, images and video as
himself. He wants his kid Sprout to try it, without images or video.
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
the Stack's pages and Home's Admin pages look like one family. The Tauri 2 desktop shell and menu-bar item are present in `desktop/`
(STACK-18); lifecycle installation, full tray status and release packaging
remain STACK-66 through STACK-68 and RELEASE-STACK-01.

The current release script builds a `maipai-stack-darwin-arm64` executable
with Bun's compile mode. The app bundle and release manifests remain
RELEASE-STACK-01. The built frontend and migration files are
embedded, so the binary can serve the board without a checkout. On macOS,
`install-service` writes `~/Library/LaunchAgents/com.maipai.stack.plist`
with `RunAtLoad`, `KeepAlive { SuccessfulExit: false }`,
`ThrottleInterval 30`, and logs under the Stack data directory; `start`,
`stop`, `status`, `open`, and `uninstall-service` operate that agent.
Linux `systemd --user` and Windows service support remain named TODOs with
the same restart-on-failure design.

Releases are built from a clean clone with `scripts/build-release.sh`, which
writes the daemon, desktop bundle, checksums, update manifests, and installer.
The changelog section is reviewed, then the owner tags the commit and creates
the GitHub Release with those assets; the site's `install.sh` is updated to
the pinned checksums. Cutting a release remains the owner's word.

The Stack's `frontend/` is built into `frontend/dist/` and served by this
same daemon on its API port, with Vite proxying the API paths in development.
Asset names carry content hashes served `immutable` while `index.html` is
served `no-cache`, so a rebuilt UI is never served stale.
Until KIT-01 extracts `@maipai/ui`, it carries a copied subset of Home's kit
under `frontend/src/kit/`; those copied files are not edited in the Stack.

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
`"image"`), or names a concrete installed model id when it must.
`coding` shares the chat binding on smaller tiers only after STACK-60;
`profiles.ts` currently marks it unavailable below p128. Generator roles
accept `quality: fast | everyday | best`, which the Stack maps to the
tiered models the sizing profile installed (the hub's Apple silicon plan
calls these instant, everyday and quality).

Every reply carries identity headers: `x-maipai-engine` (which engine
build answered), `x-maipai-model` and `x-maipai-revision`. This is the
hub's `engineIdentity` check promoted to a contract: a client can always
prove who answered.

## Roles and the wire contract (STACK-07, 2026-09-17)

The role declaration is one `ROLES` constant in `backend/src/roles.ts`,
keyed by the thirteen `RoleId` values above. Each entry declares its wire
kind (`chat`, `embeddings`, `rerank`, `transcription`, `speech`, or
`job`), residency (`resident`, `jit`, or `installed`), the OpenAI-shaped
paths it answers, its supported quality choices, and one sentence for its
board tile. `router` and `judge` are distinct roles because they have
different policy and telemetry even when they use the same engine model;
both declare `sharesModelWith: "chat"` by default. This keeps the role
table honest and lets a later supervisor bind them separately without
making clients learn an implementation detail.

The request `model` field accepts either a role id such as `chat` or a
concrete installed model id. A role name is the default because existing
OpenAI client libraries already send `model` and need no MaiPai header,
custom SDK, or per-role path. The router resolves that name to a role,
then to its binding. Headers and per-role paths were rejected because a
header is easy for generic clients to drop and a path duplicates the wire
contract that the role already declares.

Role state is one enum: `notInstalled`, `installed`, `loading`, `ready`,
`busy`, `stopped`, or `offline`, with a reason alongside `stopped` and
`offline`. A `spawned` engine moves through installed, loading, ready and
busy, then stopped or offline on an operator stop or failed health check.
A `managed` engine starts at installed or ready after a probe and becomes
offline with the probe reason when it vanishes. A `url` engine uses the
same installed, ready, busy and offline states, but the Stack never starts
or stops it. The board, event feed, and `GET /stack/v1/roles` use this one
state vocabulary.

Every engine-produced reply carries `x-maipai-engine`,
`x-maipai-model`, and `x-maipai-revision`. These promote Home's
`EngineIdentity` into a cross-product wire contract: `host` maps to the
engine header, the model file name maps to the model header, and
`build` maps to the revision header. If no engine answered, all three are
`none`, including on a 503. An unbound role is never a 404. It returns 503
with `{ error, role, state, offline_reason }` so a client can explain the
actual reason and retry when the state changes. An unknown role or model is
400 and includes the declared role ids.

Chat roles accept `stream: true` and pass the engine's OpenAI-shaped SSE
bytes through unchanged, including the final `[DONE]` marker; the
supervisor keeps the binding busy until the stream ends and treats a
client cancellation as a normal request end. Speech keeps its
phrase-level streaming contract for a future bound TTS engine: chunks
will be playable as they arrive and cancellation will stop the upstream
request, while an unbound TTS role remains an honest 503 with `none`
identity headers.

The profile tiers from STACK-02 are reconciled here. `router` and `judge`
share `chat`'s model, so they are available wherever chat is. `rerank` is
on demand on p32 and resident-small on p64 and p128. `wakeword` is an
installed-only model for a body process and is not loaded by the Stack.
The four profile lists are therefore `resident`, `onDemand`,
`installedOnly`, and `notAvailable`, which remain disjoint and cover every
role. The declaration and the router are intentionally limited to
selection, state, and the no-engine response. Engine binding, streaming,
jobs, and keys belong to later items.

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

### Qualification (STACK-86, 2026-09-18)

The Stack ships one chat pin and one engine pin, and qualification is the
test that holds both to their declarations. The chat pin is
`Qwen/Qwen3-1.7B-GGUF`, Q8_0, Apache-2.0, at the Hub commit
`90862c4b9d2787eaed51d12237eafdfe7c5f6077`, a file whose sha256
(`061b54da…590cb1a`) was verified against a live download of that
commit, and whose declared size (`1,834,426,016` bytes) is the size the
Hub reports for it. The engine pin is `llama-server` build `b10797`
(macOS arm64 verified), each archive carrying its own asset digest.
`backend/tests/qualification.test.ts` asserts all of it offline: the
revision is an immutable commit, never `main`; the digest, size, and
licence are present; the declared footprint plus the default context and
the governor's working margin fits every tier at or above the pin's
declared `p16`; and every engine pin declares a build tag and an asset
digest. A loosened pin fails that test before it reaches a customer.

## The store (STACK-04b, 2026-09-17)

The Stack owns one store under its data directory while preserving the
layouts that local engines already understand. Models use the Hugging Face
cache shape:

```text
data/models/hub/models--<org>--<repo>/
  blobs/<sha256>
  refs/main
  snapshots/<revision>/<file> -> ../../blobs/<sha256>
```

`refs/main` contains the resolved revision, snapshots are immutable views,
and the snapshot files link to content-addressed blobs. Spawned Python
engines receive `HF_HUB_CACHE` pointing at `data/models/hub`, so HF-aware
engines can use the same bytes without a second download. The Stack keeps
the model record's licence, source, repository, revision and digest beside
the manifest and treats a model as installed only when every manifest blob
exists and hashes correctly.

Engine builds use a separate versioned layout:

```text
data/engines/<name>/<tag>/
  manifest.json
  <extracted assets>
data/engines/<name>/current -> <tag>
```

The engine manifest records the asset URL, byte size, GitHub digest, Stack
SHA-256 and extraction time. Downloads land in a temporary directory,
verify before extraction, and become visible with an atomic rename. The
`current` link is the rollback and selection pointer; the former flat
`data/engines/<id>` layout is migrated once and then remains idempotent.

Import is read-only against other tools. The first-run and on-demand scan
covers the HF cache, Ollama, mlx-serve, oMLX and LM Studio directories.
Ollama's `blobs/sha256-<hex>` names provide a digest directly; other files
are hashed once. A same-volume file is hard-linked into the Stack store,
otherwise it is symlinked, with a copy only where linking is impossible.
The manifest records `source: <tool>` and the original path. The Stack
never writes into another tool's tree and never treats an imported file as
trusted until its own digest and licence are recorded.

Model and engine downloads split ranged responses into eight parts. Each
part has a `.partial-N` file and a progress sidecar, and a retry resumes
from that part's recorded offset. Parts assemble into a temporary file; the
full SHA-256 gates the manifest write. A server that returns `200` to a
range request uses the existing single-stream resumable downloader as the
fallback.

Every manifest lists the blobs it references. Remove deletes the manifest
first and removes only blobs with no remaining references. An imported link
loses the Stack link without deleting the source file. A one-hour grace
period keeps a newly orphaned blob through interrupted pulls; a scheduled
prune removes expired orphans. Storage accounting counts physical bytes,
not symlink directory entries, reports shared imported bytes separately,
and groups model bytes by the abilities served by each model, alongside
engines, logs, backups, other and the total. The storage response is
computed on request with a 30-second cache and invalidated after install or
remove.

Boot migration moves existing `data/engines/<id>` directories into the
versioned engine layout and computes a manifest from the pinned engine.

## Model groups (STACK-04c, 2026-09-17)

Models may have a nullable nickname for display, but inference accepts only
the declared model id or role id. A nickname is never an alias: it is allowed
to collide, which keeps the model identifier stable for clients and logs.

Each model belongs to exactly one group or to the ungrouped default. Groups
form a tree and rollups walk descendants while keeping a model in one set, so
bytes, memory, status and usage are never counted twice. Moving a group below
one of its descendants is refused as an ancestry cycle. Removing a group
reparents its models and child groups to the removed group's parent; it never
deletes a model.

`model_usage` stores requests, input and output tokens, seconds loaded, peak
memory and last use per model. The router records a successful served request;
the supervisor records load and unload timing and measured footprints. Group
actions fan out through the governor and return one result per model, so a
single admission refusal does not hide the outcomes for its siblings.

## Detect and adopt (STACK-34, 2026-09-17)

Detection is a local sweep, never a network scan. It probes only `127.0.0.1`
and `::1`, with a two-second timeout per well-known host: Ollama's
`GET /api/version` on 11434, LM Studio's `GET /v1/models` on 1234, ComfyUI's
`GET /system_stats` on 8188, oMLX and mlx-serve's `/v1/models` on their
defaults, and llama-server's `/health` plus `/props`. It also looks in the
installed-app, binary, and model-folder locations already named by the
store/import scanner on macOS; it never starts, stops, or modifies another
tool.

The `detected` record keeps `id`, `kind`, `name`, `version`, `where`,
`couldHold: RoleId[]`, `firstSeen`, `lastSeen`, and `forgotten`, along with
the adoption target. A sweep upserts the last-seen record and emits
`detected.changed`; a forgotten row stays hidden until a changed version is
seen, and a row absent for seven days is dropped. Adoption probes again,
reads identity, compares the version with a tested floor recorded in
`engineCatalog.ts`, and raises `host.belowTestedVersion` when it is below the
floor. An engine is then registered as a managed local host for the roles the
operator chose; a folder is imported by link through the existing import
scanner. Forget only hides the detected record and removes its registration;
it never changes the host process or source folder.
Existing model records gain manifests for their current files. Each move
is logged, uses an atomic temporary path, and is safe to repeat after a
partial or already-completed first boot.

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

## The governor's rules (STACK-06, 2026-09-17)

The profile input names the resident set and the on-demand set. The
first-run bench fills each resident model's measured peak; until then the
governor estimates the peak as the model file size times the declared
multiplier for its engine and labels that number `(estimated)`.

Admission reads free memory now and the requested peak. An on-demand load
or generator job starts only when free memory now minus the requested peak
leaves the profile's `workingMarginBytes`: 4 GB on p16, 8 GB on p32, 12 GB
on p64, and 20 GB on p128. Only one generator runs at a time; a request
that cannot be admitted enters the queue with a position, or is refused
with a reason when the queue of four is full.

Eviction reads idle time, last use, pin state, system pressure and resident
RSS. A JIT model unloads after `idleTtlSeconds`, 600 by default; under
pressure, defined as free system memory below 10 percent or 1 GiB for two
polls, the least recently used JIT model unloads first. A pinned model
never unloads and the Hardware page shows its memory cost. A resident model
restarts when its process RSS is above 1.3 times its measured peak plus
500 MB for three polls.

The cap input is total memory minus the OS margin, 8 GB by default. No
admission may exceed that cap.

The `keep_alive` input extends a model's idle TTL, but never beyond the cap
and never for a generator.

On the robot, the body's power and thermal budget is an additional input
to admission. It uses the same thresholds and actions; this is named here
for GOV-01 and is not built in STACK-06.

The rejected alternatives are a static reservation, which ignores current
pressure and measured peaks; an OS-level cap, which the hub's governor
header rejects because macOS and Windows do not provide a clean native
RSS cap for a spawned child; and letting each engine decide, which cannot
enforce one budget across engines. The poll-and-act decision keeps one
owner for the machine-wide budget and reuses measured process memory.

## Memory: the kernel's ledger (STACK-06b, 2026-09-17)

## Visible memory governor (STACK-113i, 2026-09-18)

The governor remains the sole owner of admission. Its operator controls are
declared Stack settings, so the Settings page, API reference, stored values,
and live governor all agree about the same value. `modelBudgetBytes` is the
cap itself, rather than an OS margin: its default is the current rule of
total physical memory minus the 8 GiB Mac margin, and the range is zero to
the detected total. This makes the slider's complementary label, "kept for
your Mac", truthful on every supported hardware size.

The low-memory percentage, absolute floor, and sustained-poll count are
advanced settings. The idle unload time is left for STACK-23, which owns the
usage and warm-up behavior. Settings apply live: the governor reads the
stored values at each decision, without a second mutable configuration path.

The governor keeps its own bounded, in-memory decision ledger of the newest
200 admissions, queues, refusals, evictions, and pressure actions. The
Monitoring page reads that ledger with the current budget status. It can then
say both what the Stack decided and why, while `RelativeTime` supplies the
time without inventing history or retaining a person record.

Alternatives rejected: exposing an OS-margin slider would make the Settings
label describe an indirect subtraction, not the actual model budget;
persisting the decision ledger would turn transient operating detail into a
history store; and deriving decisions from events would omit fast-path
admission outcomes. The bounded governor ledger keeps the source of truth
next to the rule it explains.

The governor reads one `MemoryReader` interface rather than asking each
engine or the JavaScript runtime for a guess:

```text
{ totalBytes, availablePercent,
  pressure: "normal" | "warn" | "critical", freeBytes,
  processFootprint(pid) }
```

On macOS, `hw.memsize` supplies `totalBytes`,
`kern.memorystatus_level` supplies the available percentage,
`kern.memorystatus_vm_pressure_level` supplies the dispatch mask (1
normal, 2 warn, 4 critical), and `host_statistics64` combines free,
inactive, and purgeable pages for `freeBytes`. `proc_pid_rusage` with
`RUSAGE_INFO_V4` supplies `ri_phys_footprint` for a process. These calls
use Bun's `bun:ffi` against `libSystem.B.dylib`, and every failure keeps
the previous reading and raises a warning health item.

The Linux reader uses `MemAvailable` from `/proc/meminfo`, PSI memory
`some avg10` above 10 as warn and above 50 as critical, and
`VmRSS` from `/proc/<pid>/status`. The Windows reader uses
`GlobalMemoryStatusEx` and `GetProcessMemoryInfo`; its FFI surface is a
named TODO until it can be tested on Windows. The interface and scripted
reader keep the governor portable. `os.freemem()` is removed because the
research probe saw its 0.09 GB reading on a Mac that the kernel reported
as 61 percent free.

The soft watermark evicts the least recently used unpinned JIT model and
pauses admission. The hard watermark aborts the in-flight generator and
raises a critical health item. Kernel warn or critical pressure is always
the corresponding soft or hard watermark, regardless of arithmetic. The
poll is every 5 seconds while idle and every second during a load.

Before a first load, the dry-run path checks the pinned llama.cpp archive
for `llama-fit-params`; the b10797 macOS archive contains it. That tool's
fit result is stored with the model and context. If it is absent, the
adapter uses `llama-server --fit-print`, then its buffer log lines in the
same shape as Ollama. A model not yet downloaded uses the GGUF header and
the KV formula only as an explicitly estimated badge. After a successful
post-load check, the measured process footprint and context length replace
the estimate on the model record.

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

Operator passwords and sessions are implemented in `backend/src/lib/operator.ts`.
Role-scoped key issuance, revocation and usage counters are implemented in `backend/src/lib/clients.ts`.

### Events and notifications

`GET /stack/v1/events` is a server-sent stream of typed events:
`role.state`, `engine.state`, `pressure`, `job.progress`, `job.done`,
`model.installed`, `update.available`, `update.applied`, `repair`. The
Stack's own Notifications page and its menu-bar badge read the same
stream. Home subscribes with its key and renders what matters through its
own notification system (`getmaipai/.github/docs/NOTIFICATIONS.md`); the
Stack never pushes to a phone itself, because that is Home's relationship
with the household.

The declarations and in-memory ring are in `backend/src/events.ts` and
`backend/src/lib/events.ts`; durable notifications are in the same bus,
Repairs are in `backend/src/lib/repairs.ts`, and redacted daemon and engine
logs are in `backend/src/lib/log.ts`.

### The daemon-owned health list (STACK-09b, 2026-09-17)

Health is one keyed, durable list shared by the daemon, board, tray and
future CLI. An item has `code`, `severity` (`critical | error | warning`),
`title`, `text`, `since`, `cause`, an optional `fix` with `label` and
`action`, and an optional `learnMore` link. Raising a code updates the
existing item rather than creating a duplicate. Resolving or ignoring it
removes it from the active list while keeping the resolved timestamp for
history, and every change emits `health.changed` on the event feed.

Severity controls presentation only: critical may badge the tray and post a
native notification, error badges the tray, and warning stays on the Health
page. Producers are explicit. The supervisor raises engine-crashed,
crash-loop, post-load-failed and managed-host-offline items. The governor
raises memory-pressure warn and critical items and repeated-admission-
refused items. The store raises stored-blob-checksum-mismatch and
disk-under-reserve items. Updates raise failed-swap, and alert channels
raise unverified-channel. Each producer resolves its code when the
condition clears. Repairs is now the compatibility name for health items
that have a fix, so the existing route remains an alias rather than a
second source of truth.

### Updates

Three things update, each on its own schedule, each opt-in: the Stack
itself, engine builds, and models. The check is a single request to a
release index and it is listed on the privacy page. An update to a
spawned engine is downloaded and verified beside the current one, the
role is drained under the generation guard, the new build takes the
role, and the old build is kept for one-click rollback until the next
update. Model updates are a new revision beside the old with the same
rule. `getmaipai/.github/docs/UPDATES.md` is the standard.

## Updates (STACK-10, 2026-09-17)

The Stack reads three static manifests published as GitHub release assets
by the release skill: `app.json`, `engines.json`, and `models.json`. Each
has `version`, `notes`, `pub_date`, and `platforms[<target>]` entries with
`url`, `sha256`, `size`, and an inline minisign `signature`. The URLs are
declared in `backend/src/updates/manifests.ts`; RELEASE-STACK-01 will
generate and publish them.

Update checks are offered once on the second launch and stay off until the
operator accepts. Accepted checks run daily by default, never more often
than hourly. The request is exactly a `GET` with `If-None-Match` and
`User-Agent: maipai-stack/<version> (<os>-<arch>)`, with no query string,
profile or identifier. ETags are stored locally. Engine pins remain on
`bNNNN`, resolved from a semver tag's `nightly-tag.txt`; the recorded SHA is
cross-checked with GitHub's asset digest.

An engine update stages beside the current tag, marks the role draining,
routes no new requests, waits up to 60 seconds for in-flight work, sends
SIGTERM and SIGKILL after 10 seconds, then starts the new tag. `/health`
and the post-load completion must pass before routing flips. A failed swap
automatically relinks the previous tag and raises a critical health item;
the previous release is kept for rollback. The weekly model watch stores
the Hub `sha` and `x-linked-etag` at install, uses a conditional GET, and
only reports a newer revision. It never auto-applies a model update.

### Automatic engine updates (STACK-31, 2026-09-19)

The operator may turn on `autoUpdateEngines` in Settings > Updates. It is
off by default. During an eligible maintenance window, after the normal
engine manifest check has found a platform build, the Stack stages that
verified archive beside the current build and uses the same drain, swap,
restart, and post-load completion check as a deliberate engine change. A
failed check restores the prior link before the window continues. The
operator receives one durable result: either the chat engine moved to the
new build, or the update was undone and the prior build remains current.
Models are explicitly excluded from this setting and never update
automatically.

Decision: reuse the existing verified engine-update path so unattended work
has the same checksum, drain, health-check, and rollback guarantees as an
operator-initiated swap. The durable update events carry the precise outcome
text so the notification feed can explain the overnight change without a
second record type. Rejected: updating when a manifest is fetched, because
it ignores the maintenance safety conditions; a separate automatic-model
switch, because model revisions need an explicit choice; and a new update
notification record, because the event feed already owns durable update
outcomes.

## Engine management (STACK-19, 2026-09-17)

Engine version state is a derived fact, never a stored status. The daemon
combines the running build, the engine store's `current` tag, and the newest
pinned build selected for this machine. It returns `current: true` with
`notCurrent: false` when they agree, or `notCurrent: true` with a reason of
`newer installed` or `newer available` when they do not; `needsRestart` is
true whenever pending configuration differs from the in-effect values.

Each engine kind declares its settings once. `llama-server` declares
`contextLength` (number, default 4096, advanced, restart), `slots` (number,
default 1, advanced, restart), `threads` (number, default 0, developer,
restart), `cacheRamMb` (number, default 0, developer, restart), and
`flashAttention` (boolean, default true, advanced, restart). Managed engines
declare `hostUrl` (text, default empty, basic, restart) and `expectedVersion`
(text, default empty, advanced, restart). Every declaration carries its type,
default, group, disclosure level, restart requirement, and optional enum
options. The configuration API
shows both in-effect and pending values until the next start, when pending
values become in effect.

The Stack settings page is driven by the declaration index at
`/stack/v1/settings/index`. It groups the declared keys into section cards,
keeps search and `@modified` filtering in the shell, and renders controls
through the generic settings form. A key applies as soon as it changes; keys
marked `needsRestart` remain pending in the database and are collected by a
sticky restart bar with Apply now and Discard actions.

## The showroom

`STACK_SHOWROOM=1` is a development-only mode that feeds the normal routes a
believable 128 GB household fixture: engines, model groups, clients, health,
notifications, updates, usage, memory pressure, and storage. It is in-memory,
never enabled by default, and is refused when `NODE_ENV=production`. The
switch exists to let the UI be judged before downloads and external engines
are present; it is not a demo dataset shipped to users. Run it with
`bun run showroom`, or use `bun run scripts/screenshot.ts --showroom` for the
full-page captures.

### Hardware sizing

The probe reports CPU, GPU class, unified or discrete memory, free disk,
and OS. From that the Stack proposes a profile (the same tiers a person
would guess: 16 GB, 32 GB, 64 GB, 128 GB) that lists which roles it can
run resident and which on demand, with model choices per role. The
first-run bench measures, and the Hardware page shows measured numbers
with the model file and engine build beside each one. No number in the
UI is a file size pretending to be a memory footprint.
`backend/src/profiles.ts` is the single declaration for the four profile tiers and their role lists.

The live sampler (`backend/src/lib/live.ts`) reads one external command
per reader, so every command is scriptable in a test: `ps` for engine
process CPU and start time, `system_profiler` for the Mac GPU model
name, `ioreg` for Mac GPU utilization, `nvidia-smi` for discrete GPU
memory and utilization on non-Mac hosts, and `df` for free disk. A
value the platform does not expose is `null`, never 0 and never a
guess: on a Mac the GPU memory line is `null` because the computer's
unified memory carries it, and GPU utilization is `null` when `ioreg`
reports no `Device Utilization %` key.

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

Loopback by default. Alert channels are a third outbound class, explicitly
opt-in and listed on the privacy page: Telegram and ntfy receive only
urgent notifications and serious health changes after a successful test.
The update check and model or engine downloads are also opt-in, each
straight from the machine to the upstream host, never through a MaiPai
service. No analytics, no telemetry, no crash reports, no identifiers.

### The Library

The Library keeps fetched model cards and pinned engine documentation under
`data/library/`, with one Markdown page and a small metadata file per
installed thing. Its local Pagefind index is rebuilt after a fetch and the
read-only `stack-library` MCP server exposes the same pages over stdio.
Fetching is allowed only with the existing Updates switch enabled and only
after the operator chooses Fetch the docs; requests carry only the
conditional ETag and the Stack user agent.

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

## Platform profiles

| Platform | Engines | First customer |
|---|---|---|
| macOS, Apple silicon | `llama-server` Metal (baseline), `mlx-serve`, `oMLX`, ComfyUI (managed), whisper.cpp or MLX Whisper, the chosen TTS runtime | MaiPai Home on the Mac Studio |
| Linux, ARM and x64 | `llama-server` (CPU, CUDA, or the accelerator the robot carries), sherpa-onnx for speech, ComfyUI where a GPU exists | MaiPai Bot |
| Windows, x64 | `llama-server` CUDA, ComfyUI | The CUDA catalogue |

## Try it's chat surface: shadcn's chat components (2026-09-17)

Decided on Jesse's direction to use a prebuilt, minimal chat surface
the household hub can adopt later if it makes sense (Home's current
assistant-ui thread is not a constraint on the Stack). Candidates
graded: shadcn/ui's own chat components (June 2026: `message-scroller`,
`message`, `bubble`, `attachment`, `marker`; MIT; installed by the same
registry and copy-into-repo model as the kit); Vercel AI Elements
(Apache-2.0, richer, tied to the AI SDK's `useChat`; the natural
upgrade path for reasoning and tool-call displays); deep-chat (MIT web
component whose built-in speech uses the browser's Web Speech API,
which sends audio to a cloud recognizer on Chrome, so its headline
feature breaks the promise); assistant-ui (MIT, complete, a framework
rather than a minimal set).

The Stack's Try it uses shadcn's chat components on the kit, a small
hook of its own that reads `/v1/chat/completions` server-sent events
(a fetch and a `data:` line parser), a mic button recording with
`MediaRecorder` to `/v1/audio/transcriptions`, and `/v1/audio/speech`
played through an `<audio>` element. Nothing leaves the machine. Home
may later adopt the same primitives, add AI Elements on top, or keep
assistant-ui; that decision belongs to Home's next design pass.

## Third-party pieces, and how an outside update never breaks us (2026-09-17)

The org rule is "download, don't vendor" and "prebuilt over
hand-built". These are the pieces the Stack takes and the seven
patterns that keep them from breaking it.

**Taken (each behind one adapter module of ours):** `@huggingface/hub`
(the official client: model info, file lists, the standard cache
layout writer, the revision `sha`) in `lib/hf.ts`; `@huggingface/gguf`
(reads a GGUF's metadata over HTTP range requests, so a model can be
sized before it is downloaded) in `lib/gguf.ts`; `@stepperize/react`
(a headless, one-kilobyte step-state library for the first run;
markup stays the kit's); shadcn/ui's chat components (copied into the
kit by its registry); llama.cpp's own fit dry run and `llama-server`;
`bun:ffi` against libSystem for the kernel's memory ledger.
`systeminformation` is held for Windows and Linux GPU detection later
(it shells out to `system_profiler` on the Mac, which is slow).

**The patterns:**

1. Dependencies arrive through the package manager with a committed
   lockfile, and the gate installs with `--frozen-lockfile`: a new
   upstream release changes nothing until the lock is updated on
   purpose and the suite is green. Dependabot alerts on, its pull
   requests off, the monthly sweep updates and re-verifies.
2. Copy-into-repo components are ours after the copy. The shadcn
   registry drops source into the kit; there is no runtime
   dependency, and an upstream change cannot reach us until the
   registry is re-run deliberately. The kit is the boundary for UI.
3. Engines and models are pinned by tag and by a checksum we recorded;
   a new build is an update we choose, verified and kept beside the
   previous one for rollback.
4. One adapter module per library, so a breaking API change touches
   one file, and our tests drive our interface with scripted
   stand-ins, never the library's internals.
5. A claim about a library is verified in its installed source and
   cited; a smoke script runs the real thing (`engine-verify.ts` is
   the pattern), so an upgrade that changes behavior fails a named
   check.
6. A managed host the person installed (Ollama, ComfyUI) is probed for
   its version and flagged below the one we tested against.
7. Never a submodule, never a vendored tree, never a fork we maintain.
8. The backend suite runs under a temp `STACK_DATA_DIR` set by
   `backend/tests/preload.ts` and refuses a real one, and
   `clearModelsForTests` refuses a data dir outside the OS temp
   directory: a checkout's `data/` is never read or written by a gate
   (2026-09-17 21:40: a gate from the main checkout emptied the
   operator's models table, plan, and left test clients, a test
   operator password and fixture update notices in the live database).
   A copied snippet carries its licence, a NOTICE entry, a source
   comment and a reason here.

## The shipping shape: daemon, web UI, tray on Tauri, one command to install (decided 2026-09-17)

Decided with Jesse after the survey of Ollama, LM Studio, oMLX,
mlx-serve, Tailscale and Syncthing, which all ship the same three
pieces. No Docker anywhere: Docker Desktop on the Mac runs a Linux VM
with no Metal, so a containerized engine loses the GPU and the unified
memory; it also means a second thing a person must install, ports and
volumes to explain, and no clean path to notifications or the menu
bar. Docker stays a packaging option for a Linux server someday, not
the architecture.

1. **The daemon** (`maipai-stack`, the Bun service compiled to one
   binary with the web UI embedded) runs under the OS service manager
   as the user: a launchd LaunchAgent on macOS, a systemd user service
   on Linux, a Windows service later. The service manager is the
   outer watchdog with the settings in `plans/operations-design-2026-09-17.md`
   section 2; the daemon's supervisor is the inner one. Logs are
   rotating files under `data/logs`, one per engine plus the daemon's.
2. **The web UI**, served by the daemon on localhost, is the whole
   admin surface (the dashboard shell in `ux.md`). Cross-platform for
   free, nothing to install, the same kit as Home.
3. **The desktop app is Tauri 2**: one codebase for macOS, Linux and
   Windows, a console window, tray icon, native notifications and
   sidecar management; it holds no engine logic and reads
   the same event feed Home reads, opens the web UI in its own window,
   offers Start, Pause and Resume, and is the independent observer
   that turns red and offers Start when the daemon is down. It is the
   only process that posts native notifications (a bare daemon cannot
   on macOS). This is a written deviation from STACK.md's Electron for
   Desktop: the shell reuses the daemon's console, and a Chromium
   process sitting in the menu bar all day beside a 70 GB model is the
   wrong tool; Rust joins the toolchain for this one small app.
4. **Install**, when released, has one native app path for a person using
   a Mac and one command for a headless machine or developer. Both
   install the same daemon, register its service and open the console
   (`ux.md`, "Install and first open"). The app adds the tray and
   native pickers.

The Tauri shell lives in `desktop/`. It loads the daemon's console in its
main window, keeps the daemon under the OS service manager, and owns only
the tray, native notifications, native pickers and the down-state Start
screen. Run `bun run desktop:dev` for the local shell and
`bun run desktop:build` for a release bundle. The web browser remains a
complete client, with typed paths and no native notification dependency.
The app has no Tauri updater and no telemetry; updates stay in the Stack's
own update flow, and the privacy page is unchanged.

## The desktop app is Tauri around the console; the daemon stays the hands (decided 2026-09-18, 05:30)

The owner, going to bed: "we probably need this entire thing as Tauri
because we will need access to the local system for install, scan,
delete." Two things are true at once. The system access already exists:
the daemon is a native Bun process on the machine and does every
install, scan, delete and spawn today; the web console only asks it
over loopback. What the console lacks is what a browser tab cannot do:
a real window with the app's name and icon, a tray item, native file
and folder pickers ("Import from a folder" must not be a typed path),
native notifications, launch at login, and the feeling of an installed
program. That is Tauri's job, and it is the same Tauri 2 shell the tray
item already planned.

Decisions:

1. **STACK-18 grows from "the tray app" to "the desktop app"**: a Tauri 2
   app whose main window is the console (loading the daemon's own URL,
   so there is exactly one frontend), with the tray item and its menu,
   native notifications, the dialog plugin for file and folder pickers
   (the Add sheet's Import tab and the backup target use it when the
   console runs inside Tauri and fall back to a typed path in a plain
   browser), launch at login, and single-instance. The daemon remains a
   separate service process; the app installs or starts it through the
   service manager and then attaches (org SERVICES.md), so a
   closed window never stops the Stack and a phone on the LAN still
   works.
2. **Not Tauri-only.** Moving the daemon's work into the Tauri process
   would make the Stack stop when the window closes, tie the API to a
   GUI session, and lose the headless install on a Linux box or a robot
   (Bot builds on the Linux Stack with no display). The daemon is the
   product; the app is its front.
3. **The console detects its host**: `window.__TAURI__` present means
   native pickers and notifications; absent means browser fallbacks.
   One code path per capability behind one `host` adapter in the kit,
   never a fork of the pages.

## The desktop program: from the WIP to a release (decided 2026-09-18, 07:00)

The owner's instruction for the next 36 hours: a fully functioning
desktop app with notifications and a tray that shows status and pauses
and resumes everything, clear help docs in the repo and in the app, and
releases in the repo with clear instructions once the app is ready. The
program, in landing order, each an item with its brief in the queue:

1. **The app** (STACK-18, resumed from the WIP): window, tray, pickers,
   notifications, single instance, launch at login, the `host` adapter.
2. **The app owns the daemon's lifecycle on this computer** (STACK-66):
   the compiled daemon (`bun build --compile`, built and copied into
   `desktop/src-tauri/binaries/` by `scripts/build-release.sh`) ships inside the app bundle as a Tauri
   sidecar; on first launch the app installs the LaunchAgent that runs
   the sidecar (SERVICES.md), on later launches it attaches; the
   fallback page's Start asks launchd; Quit never stops the daemon;
   uninstall is one menu item that removes the agent and, on request,
   the data directory.
3. **Tray status in depth** (STACK-67): the menu shows each role's one
   line with its dot, memory used of the budget, the last check's
   sentence, "Open", "Pause everything" or "Resume", "Check my Stack",
   "Open Logs", "Quit the app (the Stack keeps running)"; the icon's
   color follows the worst health severity within five seconds of a
   change (events feed, with a poll fallback).
4. **Notifications that a person wants** (STACK-68): native, from the
   durable events only (installed, updated, check failed, health
   opened and resolved, paused and resumed), each with an action (Open
   the page), a per-kind switch in Settings > Alerts, quiet during the
   maintenance window when STACK-22 lands.
5. **Help in the app** (STACK-69): a Help page (from the profile menu
   and the palette) that renders the user docs in the console from the
   shipped knowledge index, with the same pages the docs site serves;
   "Learn more" everywhere lands there when offline and on the site
   when online.
6. **The user docs, complete for a release** (STACK-70): Install (the
   app download and the one-line installer), Update, Uninstall, the
   Tray, the phone, Connect a coding tool, Privacy (current), Fix a
   problem, each grade-6, each with a generated screenshot judged.
7. **The release** (RELEASE-STACK-01): `scripts/build-release.sh` builds
   the compiled daemon and the app bundle (`.dmg` for macOS, notarized
   later), writes `SHA256SUMS`, the three update manifests and the
   changelog section from commits since the last tag; the release skill
   cuts the tag and the GitHub Release. The release notes open with
   install instructions for each shipped platform (the `.dmg` and the
   one-line command for macOS), followed by **What changed** from the
   changelog. This owner instruction differs from the org's current
   one-line-links preamble rule; the coordinator updates that org rule.
   The org site hosts
   `install.sh` (SITE-STACK-01). Cutting a release stays the owner's
   word, in the moment.

**Nothing is ever installed by hand on the owner's machine** (the
owner, 2026-09-18 09:20: "I should never have to make manual changes
for Stack; one command, like every other user"). The desktop app and
the daemon are built by the release workflow on GitHub's macOS runners,
which carry Rust; a developer who wants to build the app locally runs
`scripts/dev-setup.sh` once, explicitly (it installs the toolchain the
build needs and nothing else, and says what it did); `check.sh` never
installs anything and skips `cargo check` with a stated reason when
cargo is absent. The person installs the Stack the way every user does:
the `.dmg`, or `curl -fsSL https://getmaipai.github.io/stack/install.sh
| sh`. This is the one exception the org allows to "no push-triggered
Actions": a tag-triggered release workflow in a public repo.

After the program: the maintenance window (STACK-22), ready when you
sit down (STACK-23), storage hygiene (STACK-24), connect a coding tool
(STACK-60), licences in plain words (STACK-28), guided fixes and the
diagnostics bundle (STACK-29), engines kept current (STACK-31), What's
new (STACK-21), and the two databases (STACK-50) once the owner
confirms it.

### Maintenance (STACK-22, decided 2026-09-18)

Maintenance has one local scheduler rather than a timer in each feature.
It reads the declared local start and end times, defaults to 02:00 through
05:00, and runs the registered work in a fixed order only while the window
is open. Before starting, and between heavy jobs, it requires five minutes
without input, AC power, and normal memory pressure. A person returning to
the computer pauses the current cooperative job; it resumes when the machine
is quiet again. Work outside the window is deferred with its next local run
time, which is shown in Settings and Overview.

The scheduler uses ports for the clock, activity reader, battery reader,
pressure reader, and jobs. That keeps macOS `pmset` at one adapter boundary
and makes the timing rules offline-testable. We rejected independent cron
timers because they could overlap, ignore a returned person, and leave no
single next-run answer. We also rejected treating the window as permission to
start work on battery or under pressure: quiet hours reduce interruption,
but do not make resource pressure safe. Downloads receive the configured
cap at the streaming seam through a token bucket, rather than callers trying
to pace individual requests.

### Known advisory: glib 0.18 in the desktop lockfile (2026-09-18)

Dependabot alert 3 flags `glib < 0.20` in `desktop/src-tauri/Cargo.lock`.
`cargo tree -i glib` shows it is pulled only by `gtk 0.18`, which Tauri
2.11 pins (`glib ^0.18`); `cargo update -p glib --precise 0.20.0` cannot
select it. The crate compiles only for Linux targets, the Mac build never
touches it, and the first release ships for the Mac. The alert is
dismissed as tolerable risk with this note; the monthly dependency sweep
covers `Cargo.lock` and re-checks it on every Tauri bump.

## Native console authentication (decided 2026-09-18 review)

The Tauri process is a local observer, not a second privileged API
client. Today its Rust poll calls `/stack/v1/roles`, `/health` and
`/events` without credentials and its Pause and Resume POST calls
`/stack/v1/run-state` without the operator session
(`desktop/src-tauri/src/main.rs`). Those routes require a client or
operator, and run-state changes require the operator
(`backend/src/routes/roles.ts`, `events.ts`, `runState.ts`). The tray
therefore cannot truthfully claim those actions after a password is set.

STACK-76 moves protected reads and commands through the console webview's
existing operator session. The native side may poll public `/healthz`
for down-state observation; the webview supplies role and health status
and handles protected commands, then sends display-only state to the tray.
When the operator is signed out, the tray shows "Sign in to see status"
and opens the console for a protected action. The window can hide without
ending the webview session; Quit still ends the app but leaves the daemon.
A changed port comes from the service's active address, not a Rust
constant (STACK-71). No auth bypass endpoint, raw administrator key in
the app bundle or plaintext token file is added. A daemon-down state
still works without a session. Rejected: treating loopback as implicit
administrator authority, which conflicts with the client-key rule.

## Scope by what is reliable, capability by capability (decided 2026-09-18, 10:45)

The brand sentence in the org's copy stays the ambition; the release copy
(README and release notes) for each version states what that version's
capability matrix says it does, and nothing more (2026-09-18 11:00).


The achievability review recommended a chat-only v0.1.0. The owner's
answer: the MVP delivers what is reliable, but reliability is judged per
capability, not per modality, and nothing is excluded wholesale. If
models can be searched, downloaded, installed, managed, updated and
uninstalled reliably, v0.1.0 ships all of that for every model kind the
catalog carries; if engines can only be monitored reliably, v0.1.0 ships
engine monitoring and shows install and update as disabled with one
sentence. The rule:

1. **A capability matrix decides the release**: rows are the things
   (models, engines, clients and keys, updates, health and checks, the
   tester, settings, backups, the desktop app, the phone), columns are
   the capabilities (see, search, download, install, manage, update,
   uninstall, monitor), each cell one of: reliable now (a live check
   passed on a clean account), reliable with bounded work (an item
   named), monitor only in v0.1.0, or not in v0.1.0. The matrix lives in
   `docs/plans/v0.1.0-capability-matrix.md` and is the release's scope.
2. **A cell ships only with its live check**; a cell that is not in
   v0.1.0 is a disabled control with its one sentence, never a missing
   feature and never a working-looking button.
3. **The field audit feeds the matrix**: where a mechanism is unreliable
   today because our implementation is weak, the audit's best
   implementation is what makes the cell reliable, not a narrower
   promise.

The [v0.1.0 capability matrix](plans/v0.1.0-capability-matrix.md)
records 30 rows and the clean-account check for each bounded cell. The
decision is to build complete, verified model operations for each
qualified role while limiting unqualified engine and media operations
to observed state. The temporary-data live walk proves useful existing
actions but cannot stand in for a fresh-account installation. Rejected:
the chat-only cut, because it leaves feasible model and operations work
out of the first release; and a universal installer promise, because
unqualified engines, file sets and role wires have no recovery proof.

## The field audit: learn each mechanism from the best implementation (decided 2026-09-18, 10:30)

The owner, after the product review: for the products that do parts of
what the Stack does, audit their features, review their code, and bring
the features and mechanisms into the Stack; where several do the same
thing, determine the best implementation; this includes the UI. The
rules that shape how:

1. **Study, then depend or re-implement; never copy.** Other projects'
   code is read to learn the mechanism (how LM Studio estimates fit,
   how Ollama resolves and pulls a model, how Open WebUI lays out a
   model list). What comes back is a design in our words and, where a
   maintained library exists, a dependency through the package manager.
   A copied snippet follows the org's exception rules (AGPL-compatible
   licence, NOTICE entry, source comment, justification) and is rare.
   Proprietary products (LM Studio, Msty) are studied from their
   behaviour and documentation only.
2. **One audit per mechanism, across projects**, not one per project:
   first run and onboarding; model discovery, metadata and download;
   engine management and updates; memory, residency and eviction;
   status, health and repairs; per-client access and accounting;
   the console's information architecture and the things pages. Each
   audit names the implementations compared, the winner and why, what
   the Stack adopts, and the items that build it, with "mirror" pointing
   at the studied source by URL and path.
3. **Licences are checked before anything is learned from code**: the
   project's licence is recorded in the audit; AGPL, MIT, Apache and
   BSD sources may be read; a snippet may only ever come from an
   AGPL-compatible one.
4. The audits are docs (`docs/plans/field-audit-<mechanism>.md`), then
   items; the items are built like any other, with the audit as their
   design note.

## The API boundary: what is the Stack's and what is Home's (2026-09-17)

The foundational API moved out of Home into the Stack. Home keeps an
API of its own for everything that is not foundational. These rules
decide which side a thing lands on, and how the two talk, so the
boundary never drifts into two copies.

1. **The ownership test.** An endpoint, a record or a setting is the
   Stack's when it can be served knowing nothing about who is asking
   beyond a client key: engines, models, hardware, memory, the
   machine's health, updates of those, a raw inference by role. It is
   Home's when it needs a person, a household, a conversation, memory,
   consent, a companion, a package, a schedule, a device, or a
   notification to a phone. When a thing needs both, it is split at
   that line and the split is written in the contract table in
   `integrations.md` (a voice package: the model half is the Stack's,
   the runtime binding is Home's).
2. **One fact, one API.** A fact the Stack owns is read from the
   Stack's API and nowhere else. Home never re-exposes a Stack fact in
   its own shape: its Admin pages read the Stack through a
   pass-through (`/api/stack/*` on Home forwards to `/stack/v1/*` on
   the Stack, adding Home's one client key and Home's own role check,
   changing nothing else). Go reads through Home or Bot. Bot's own
   runtime calls its local Stack directly; it does not require Home.
   A translation layer is a bug.
3. **Same wire, different meaning, never confused.** Both products
   speak the OpenAI shape on `/v1`. The Stack's `/v1/chat/completions`
   answers as the model: no memory, no guards, no person. Home's `/v1`
   answers as the household's assistant: through the turn engine,
   the guards, memory and the companion, for a signed-in person or a
   per-person token. Home's `/v1` is never a raw pass-through to the
   Stack, and the Stack's `/v1` never learns a person. A client that
   wants the model uses the Stack; one that wants the companion uses
   Home.
4. **Keys and people never cross.** The Stack knows clients; Home is
   one client with one key, held server-side, scoped to the roles
   Home needs. A person never holds a Stack key, a browser signed in
   to Home never talks to the Stack directly, and the Stack never
   stores a person id, not even as a label on a request.
5. **Stack first, additive always.** A capability Home needs from the
   engines is added to the Stack's API first, then consumed; it is
   never re-implemented in Home "for now". Both APIs are additive
   under the org compatibility rule; the Stack's is versioned under
   `/stack/v1`, and Home pins a minimum Stack version it checks at
   boot against `/healthz`.
6. **One feed, one producer per event.** The Stack's event feed is
   the only source of engine, model, memory, health and update
   events; Home bridges them into its notification system and never
   produces a second copy. Home's own events (a person joined, a
   backup ran) stay Home's.
7. **References, not copies.** Home's database holds Stack ids (a
   model id, an engine tag) and its own facts about them (which
   companion uses which voice); it never mirrors a Stack record. A
   Stack fact shown in Home is fetched, cached briefly if at all, and
   attributed.
8. **Failure passes through verbatim.** When the Stack is down or a
   role is offline, Home shows the Stack's `offline_reason` and health
   items as they are, with its own one line of context, and raises a
   Repairs entry pointing at the Stack; it never guesses a different
   cause.
9. **The contract is tested from both sides.** The Stack ships a
   contract test suite (every route, its shapes, the identity
   headers, the 503 and 409 forms) that Home runs against the pinned
   Stack version in its own gate, the way the spec's round-trip
   fixtures work for records.
10. **Docs follow the owner.** A Stack capability is documented in
    the Stack's docs; Home's docs link there and describe only what
    Home adds on top.

## The seams: how a third-party thing enters the Stack (decided 2026-09-18)

The owner asked whether the Stack needs apps, plugins, or something
like them. The design-resolver read the platform documents; the answer
is no extension system, no packages, no sidebar row, and the word for
what exists is **seams**. Everything a person or a third party can add
to a Stack already arrives through one of four:

1. **The engine catalog**: a new engine kind (a vLLM build, a TTS
   server) is a pinned build in this repo's per-platform catalog,
   chosen by declaration ("Engines and the supervisor"; the pins are
   the Stack's own catalog, never Catalog packages, integrations.md).
2. **A host the person points at**: a server they run (`managed` or
   `url` engine kinds) is configuration. The Add sheet (ux.md "Things
   pages, second pass") gains a fourth tab for it, "A server you run".
3. **A model with its provenance recorded**: from the Catalog, from
   Hugging Face, or from a folder by link (a NAS is a folder). A private
   mirror is one declared setting, `huggingFaceEndpoint`, honored by
   the store and the supervisor, with the privacy row saying "or the
   mirror you chose".
4. **A channel or target the person configures**, each with a privacy
   row in the same commit: alert providers are code here (Telegram,
   ntfy; a `webhook` provider would cover Discord, Gotify and Home
   Assistant with one privacy shape), backup targets likewise.

Nothing is ever installed as code into the Stack from a catalog, and
the Stack never consumes MCP: tools a model calls on someone's behalf
need a person to authorize them and a turn engine to run them, which
is Home's Connector kind; a developer's own tools already pass through
the OpenAI-shaped `chat` wire. The Stack *serves* MCP (`stack-library`).
Themes are Home's (per-person objects); the Stack has one operator and
a light or dark toggle. A metrics exporter, if wanted, is a read-only
route (`GET /stack/v1/metrics` in Prometheus text), not an extension.

Rejected: a Stack "add-on" kind in the Catalog (a second package system
with its own review path, and outside code inside the one process that
holds the memory budget; contradicts AGENTS.md "no packages"); UniFi's
"applications" on the console (UniFi's are whole products; ours are
Home and Bot, clients with their own consoles); the helper consuming
third-party MCP servers (no person to authorize a tool; breaks the
read-only registry). Console: nothing new. The channel seam gets a
mechanical guard: a test that fails when a channel type exists without
a privacy-page row. Items: STACK-56 (the docs and the guard), STACK-57
(the mirror setting), STACK-58 (`webhook`, the owner's call), STACK-59
(the metrics route, the owner's call).

## Agents and harnesses: clients, never residents (decided 2026-09-18)

The owner asked whether the Stack should have agents or harnesses. An
agent is a loop that drives a model through tool calls until a task is
done; a harness is the program that runs that loop (Claude Code, Codex
CLI, OpenCode, Aider). The design-resolver read the platform documents;
they agree three times over. The Stack never runs an agent loop and
never shows an "Agents" surface: an agent or harness is a **client**, a
named key scoped to roles, pointed at one address. A loop needs a
person to authorize tools and a turn engine to run them, and the Stack
has neither by design ("The line"; "The API boundary" rules 1 and 3;
"The seams": the Stack never consumes MCP, it serves it). The platform's
three places for a loop are all outside the Stack: Home's bounded turn
engine, a harness the developer runs, or a Catalog package. The one loop
inside the Stack, the helper's optional third tier, is deliberately not
an agent (read-only tools, proposal cards, stateless, off by default) and
stays named "the helper".

What the Stack owes the agents beside it, and where it stands
(2026-09-18): the tool-capable `chat` and `coding` wire exists (`tools`,
`tool_choice` and `response_format` pass through; `--jinja` is pinned;
streaming with usage; embeddings) but has no contract test proving it;
`GET /v1/models`, which most OpenAI-compatible harnesses call first, is
missing; `coding` is `notAvailable` below p128 in `profiles.ts` while
`roles.ts` says it shares chat's model, so the `coding` address 503s on
three of four tiers (a contradiction to resolve toward sharing chat's
binding wherever chat runs, its own model only on p128); the default
context of 4096 is unusable for a harness; the key dialog shows a key
once with no address or config snippet; there is no per-client rate or
concurrency control (deferred until per-client usage shows a need: no
rule without a counter). Rejected: a Stack-hosted agent runtime, an
Agents row, a client `kind` on the record (a preset in the dialog is
UI, not a record), an Anthropic-Messages or Responses translation layer
written by us (pass-through only when a bound engine serves the shape
natively, mlx-serve does). Naming: "a coding tool" in every
person-facing string; "client" is the record; "agent" and "harness"
appear only here. Items: STACK-60 (connect a coding tool), STACK-61
(the coding role's context and model, sized by a bench), STACK-62
(Anthropic pass-through, the owner's call), STACK-63 (per-client caps,
only when usage shows a need).

## The helper: a local answer surface (decided 2026-09-18, 02:05)

The owner revised the 2026-09-17 helper proposal: no model is bundled
for the helper. Ask first opens pages and live machine facts, then local
user docs and the Library. The shipped docs index holds setting help,
health causes and fixes, and page descriptions. An answer card presents
the matched fact or passage with one Open action. The optional open-question
path uses the operator's already loaded chat model, only after the operator
enables it; it has read-only tools and proposes actions for a click. It
keeps no history and cannot change the machine. When chat is offline, the
local facts and docs still work. The Stack never runs an agent loop.

This supersedes the earlier pinned `qwen3-1.7b-q8-0` helper process,
`helper` role, and 2 GB fallback. They would create an unavoidable
download and memory cost. `roles.ts` has the thirteen declared roles and
no helper role. STACK-37 and STACK-55 must implement this revised shape.
The search source is local by default; fetching the public docs site
requires an explicit outbound setting and a privacy-page row. A static
index may use Pagefind, already used by `docs/site/`, but the implementation
must prove its answer quality on a small question corpus before adding
phrase templates. Each deterministic text rule needs a hit counter and a
corpus row; a third phrasing in a week is a classifier candidate under
the org rule, not another matching rule.

**Built (STACK-55 and STACK-37 tiers 1 and 2).** Ask is the sparkles door in the shell and the middle phone tab. Its palette answers the declared live intents, searches the local Library and the shipped knowledge index, and opens a stateless helper panel for open questions. The helper endpoint uses only the read-only registry in `backend/src/lib/helperTools.ts`; it does not download or select a model. Remote docs-index search is gated by the existing update switch and named on the privacy page.

## What moves out of Home, later

The migration inventory below is a boundary, not a removal order.
STACK-14 must prove the Studio profile first; STACK-16 then specifies
Home registration, dual-running, parity checks, rollback and the final
supervisor removal in Home.

## Live walk 2026-09-18

This walk used a temporary copy of the owner's Stack data on port 8772.
The copied model metadata was rewritten inside that temporary copy so its
absolute path pointed at the copied model; the owner's data was never used
as the server's writable data directory.

| Action | HTTP calls | Result | Status |
| --- | --- | --- | --- |
| Add from the catalog | `POST /stack/v1/models` | Existing resident Qwen catalog entry was accepted as a resumable local job; no new job remained after the existing verified model was reconciled. | Pass |
| Import a folder by link | `POST /stack/v1/models/import` with the temporary fixture path | Returned an installed imported model, then the temporary record was removed. | Pass |
| Scan | `POST /stack/v1/detected/scan` | Returned one detected folder, one tool, one model file, and a scan timestamp. | Pass |
| Adopt a detected tool | `POST /stack/v1/detected/{id}/adopt` with `chat` | No Ollama model store was present on the Mac, so a scripted detected folder was adopted; the response returned an imported-model target. | Pass |
| Rename | `PATCH /stack/v1/models/{id}` | Resident model nickname changed to “Live Qwen”. | Pass |
| New group | `POST /stack/v1/groups` | Created “Live walk”. | Pass |
| Move to group | `PATCH /stack/v1/models/{id}` | Resident model moved into the new group; group rollup counted one model. | Pass |
| Load | `POST /stack/v1/models/{id}/actions` with `load` | Returned `ok: true`. | Pass |
| Unload | `POST /stack/v1/models/{id}/actions` with `unload` | Returned `ok: true`. | Pass |
| Pin | `POST /stack/v1/models/{id}/actions` with `pin` | Returned `ok: true`. | Pass |
| Remove | `DELETE /stack/v1/models/{imported-id}` | Removed the temporary imported model with `ok: true`. | Pass |
| Start an engine | `POST /stack/v1/engines/llama-server/start` | Returned `ok: true`. | Pass |
| Stop an engine | `POST /stack/v1/engines/llama-server/stop` | Returned `ok: true`. | Pass |
| Restart an engine | `POST /stack/v1/engines/llama-server/restart` | Returned `ok: true`; the engine was running again afterward. | Pass |
| Speed test | `POST /stack/v1/speed-test` | Recorded a real resident-model result: 2,218 prompt tokens/s, 115 generated tokens/s, 1,055 ms load, and 40 ms first token. | Pass |
| Check my Stack | `POST /stack/v1/check`, then `GET /stack/v1/check/latest` | The first poll arrived while the role was loading; the completed rerun reported chat `ok: true` and fit-together `ok: true`. | Pass |
| Pause everything | `POST /stack/v1/run-state` with `paused`, then `GET /stack/v1/run-state` | Returned and reported `paused`. | Pass |
| Resume | `POST /stack/v1/run-state` with `running`, then `GET /stack/v1/run-state` | Returned and reported `running`. | Pass |
| Create a client key | `POST /stack/v1/operator/login`, then `POST /stack/v1/clients` | Created a chat-scoped tester key and returned its metadata once. | Pass |
| Chat in Tester | `POST /v1/chat/completions` with the tester key | Returned HTTP 200 with a real local response and usage counts. | Pass |
| Revoke a client key | `DELETE /stack/v1/clients/{id}`, then `POST /v1/chat/completions` with the old key | Revocation returned `ok: true`; reuse returned HTTP 401. | Pass |
| Set and change a setting | Two `PUT /stack/v1/settings` calls for `stackName` | Changed the temporary copy from “Live walk” to “Live walk changed”. | Pass |
| Send a test to a channel | `POST /stack/v1/channels`, then `POST /stack/v1/channels/{id}/test` | A local scripted ntfy receiver returned 200; the channel became verified with a last-sent timestamp. | Pass |
| Fetch the docs in Library | `PUT /stack/v1/settings` for updates, `POST /stack/v1/library/fetch`, then `GET /stack/v1/library` | Fetched one local engine page; the Library listed one page and search returned one result. | Pass |
| Palette intents | `GET /stack/v1/library`, `/stack/v1/settings`, `/stack/v1/updates`, `/api/docs`, and Library search | Section routes, settings/update destinations, API docs, and Library search all returned HTTP 200. | Pass |
| Browse the catalog | `GET /stack/v1/catalog/search?kind=engine`, then `?kind=model` | Listed the pinned native llama-server b10797 build and the qualified Qwen3 1.7B Q8 catalog model. | Pass (under 1 s) |
| Install an engine | `POST /stack/v1/engines/llama-server/install` with `b10797` | Downloaded and verified the 11 MB native archive in 0.44 s; `/stack/v1/events` carried byte progress and the Engines row showed Current. | Pass |
| Add a catalog model | `POST /stack/v1/models` with the Qwen3 1.7B catalog record | First walk returned 202 without downloading anything. Fixed the route to start the verified worker and emit live byte progress; the repaired walk downloaded 1,834,426,016 bytes, verified its checksum, and installed the model. | Pass (after fix, about 50 s) |
| Chat after install | `POST /v1/chat/completions` | Returned HTTP 200 from the installed Qwen model; the response identified llama-server build b10797. | Pass (17 s) |
| Remove the model | `DELETE /stack/v1/models/qwen3-1.7b-q8-0` | Returned `ok: true` and removed the installed record and local model file. | Pass |
| Remove the current engine build | `DELETE /stack/v1/engines/llama-server/builds/b10797` | Returned HTTP 400, “The current engine build cannot be removed.” The refusal is intentional; selecting another installed build is required first. | Pass |

The temporary server was killed by PID, port 8772 was verified free, and
the temporary copy was moved to Trash after the walk.

## Speed test

The Stack runs the pinned archive's `llama-bench` for the resident chat
model with 512 prompt tokens, 128 generated tokens, and three repetitions.
It records prompt and generation throughput, the model footprint, the
context length, and the supervisor's load and first-token timers. A run is
available on Overview, and model installs and engine updates can use the
same local runner during maintenance. A generation result more than ten
percent below the previous result for the same model and context raises a
warning that names the engine update and offers Go back. No benchmark data
leaves the machine.

## Check my Stack

Check my Stack walks every ready role, sends the smallest local request
for its wire, and records each result with its duration and reason. A
second fit-together pass runs one generator while sampling the kernel
pressure every 250 milliseconds, failing before critical pressure can
continue. Failures become health items with the smallest useful fix, and
passing reruns resolve the old item. The nightly entry skips when local
activity was seen in the last five minutes. Progress is local on the
events feed, and no privacy-page row is needed.

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

## Pause everything

The run-state control is shared by the header and future tray and palette
actions. Pausing enters `pausing`, drains in-flight chat through the
supervisor, refuses new admissions with a 503 reason, unloads governor
work, and settles on `paused`; resuming restarts the chat engine and
returns to `running`. The daemon and UI remain available throughout.

## Backups for the first release (decided 2026-09-18 review)

The Stack's state must be restorable before v0.1.0. STACK-72 declares the
current `stack.db` as hot state and model and engine bytes as rebuildable,
creates an encrypted, signed archive with its key outside the archive,
and stages restore beside live data before a health-checked swap. The
emergency recovery kit is shown once. STACK-77 adds local and SMB targets,
a nightly schedule before updates, retention and failure health; STACK-78
runs the org's headless restore drill before each release and backs up
before an update or restore. When STACK-50 separates measurements, the
new `metrics.db` becomes excluded by default and included only on the
operator's explicit "with history" choice. No backup target is a
MaiPai-operated service. Remote targets get privacy-page rows in the
same commit. This follows org `docs/BACKUPS.md`; a plain SQLite copy
would miss encryption, key recovery, target durability and restore proof.

## Two databases: state and measurements (decided 2026-09-18, night)

The owner asked, looking at the Overview's charts, whether all this
data logging should be in a database, whether settings should be in a
database, and whether settings and logging belong together. Where it
stands: everything is already in SQLite through Drizzle, in one file,
`data/stack.db`, seventeen tables: the state (models, model groups,
clients, sessions, operator, channels, detected, the declared settings
in `meta`) and the measurements (usage_samples, memory_samples,
speed_results, check_runs, model_usage, notifications, health). Text
logs are files under `data/logs/`.

The decision is to split by what the data is for, not by table count:

- **`stack.db` holds state**: what the person decided and what the
  Stack owns (settings, models and their provenance, groups, clients
  and keys, channels, the operator, detected things, open health
  items). Small, precious, backed up whole, migrated carefully, never
  vacuumed under load.
- **`metrics.db` holds measurements**: the sample rings
  (usage_samples, memory_samples), speed_results, check_runs,
  model_usage counters and the notification feed. Large, rebuildable
  from the next hour of running, retention-trimmed on a schedule
  (VACUUM there never touches state), excluded from the default backup
  (the org BACKUPS standard lists it as `exclude`, with "history is
  rebuilt as the Stack runs" on the page) and included only when the
  person asks for "with history".

Settings stay in a database, `stack.db`'s `meta`, because a setting is
state with a clock stamp and a declared default, read by both the
daemon and the UI through one route; a file would be a second store.
Both files open through Drizzle with their own migration journal
(`backend/src/db/state/` and `backend/src/db/metrics/`), the metrics
writer batches inserts per five seconds, and a missing or corrupt
`metrics.db` is recreated empty with one health item, never a boot
failure. This is STACK-50 in the backlog. The Overview second pass is complete,
so the split can proceed after the release-critical work. The default
backup and the "with history" option need their own implementation item.

The Overview reads a complete selected time window from the series endpoint,
including empty buckets, so a quiet Stack keeps its time axis honest. Recent
activity requests durable notifications only; progress events stay in the
live event stream and do not become history.

## Things pages and the catalog sheet

Things pages keep one declared action list per kind in `frontend/src/lib/actions.ts`.
The property panel and each row menu consume that list, so a destructive action
has one confirmation path and the same wording in both places. The Add sheet
uses three sources: the signed local catalog, an opt-in Hugging Face search, and
local imports or an upload staged for provenance assignment. Hugging Face search
is gated by the existing outbound switch and is recorded in the privacy page.

The phone surface is a second renderer over those same page declarations and
routes, selected by the shell from the measured viewport width below 640 px.
It changes navigation and density to a bottom tab bar, list rows, grouped
detail cards and a phone Overview, but it does not create a second data path.
The phone renderer stays in the shared kit blocks so desktop and phone keep the
same action labels, statuses and route ownership.

## Open questions for the owner

1. **Name.** Decided 2026-09-17: `stack`, "MaiPai Stack". The public
   repo is `github.com/getmaipai/stack`.
2. **Logo.** Done 2026-09-17: `maipai-stack-{icon,logo}-{light,dark}.png`
   in `getmaipai/.github/brand/` (orange accent, three stacked layers).
3. **Installer shape.** The Stack stands alone through the `.dmg` or
   one-line installer; Home installs it first when absent, then registers
   itself as a client. The shared install contract still needs a test.
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
