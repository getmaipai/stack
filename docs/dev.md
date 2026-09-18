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
shape on every OS: one config, one API, one set of docs; only the engine
list per platform differs.

## Why the Stack, against the alternatives (2026-09-17)

The question the project has to answer, in the owner's words: why
would people use this instead of downloading and installing on their
own, or using another project. The user-facing answer is the README's
"Why the Stack" section; this is the same answer checked against the
field, so every claim points at something built or designed here.

| Alternative | What it gives you | What it does not, and the Stack does |
|---|---|---|
| Doing it yourself (Ollama plus LM Studio plus ComfyUI plus a speech server) | Each piece is good at its job | Five ports and configs; no one governs memory across them; no shared health, alerts or updates; every tool you use is bound to a specific engine |
| Ollama | The best single-model chat server, one-command install | Chat only (no voice, images, video, music); a guessed memory estimate; no health or update page; a vendor updater that sends a device id |
| LM Studio | A polished desktop app, model discovery, headless mode | Closed source; update checks and model searches leave the machine with no named opt-out; one person's app, not a service others build on; loads refused that would have fit |
| LocalAI | One OpenAI-compatible engine over many backends, model gallery | No memory governor across backends, no health list, no updates with rollback, OCI packaging on a Mac service; its speech and image backends are not the strongest ones |
| Harbor | A one-command Docker playground for fifty services | Docker first, a developer's tool; no supervisor, governor, notifications or updates |
| Jan, Open WebUI, LibreChat, LobeChat | A chat app with users and history | An app, not a foundation: their own people and storage, licence terms in two cases; nothing a household hub can sit on |
| oMLX, mlx-serve | Excellent single-purpose Apple silicon servers | No provenance, no management, no health, no updates; the Stack runs them as engines |

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

The release build is a single `maipai-stack-darwin-arm64` executable made
with Bun's compile mode. The built frontend and migration files are
embedded, so the binary can serve the board without a checkout. On macOS,
`install-service` writes `~/Library/LaunchAgents/com.maipai.stack.plist`
with `RunAtLoad`, `KeepAlive { SuccessfulExit: false }`,
`ThrottleInterval 30`, and logs under the Stack data directory; `start`,
`stop`, `status`, `open`, and `uninstall-service` operate that agent.
Linux `systemd --user` and Windows service support remain named TODOs with
the same restart-on-failure design.

The Stack's `frontend/` is built into `frontend/dist/` and served by this
same daemon on its API port, with Vite proxying the API paths in development.
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
`"image"`), or names a concrete model id when it must. Generator roles
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
default, disclosure level, and restart requirement. The configuration API
shows both in-effect and pending values until the next start, when pending
values become in effect.

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

## Block B review, 2026-09-17

1. Model re-registration preserves installed state: fixed at <hash>, test `re-registering an installed catalog model preserves its install`.
2. Existing model files are hash-checked before verification: fixed at <hash>, tests `an incorrect existing model file is replaced and verified by hash` and `a corrupt downloaded model is never marked verified`.
3. Spawned engine loading waits on liveness with a size-scaled timeout: fixed at <hash>, test `waitHealthy accepts a delayed loading response within the tuned timeout`.
4. Streaming chat is refused with an honest 400: fixed at <hash>, test `streaming chat is refused honestly`.
5. Living engine 5xx responses and cancellations do not retire the backend: fixed at <hash>, tests `a living engine's 500 is returned without retirement` and `an aborted completion is a cancellation and does not retire the engine`.
6. Incomplete model provenance throws a typed error: fixed at <hash>, test `an incomplete Hugging Face provenance record throws before writing`.
7. Post-load and completion calls have bounded timeouts: fixed at <hash>, test `post-load checks time out instead of hanging`.
8. Spawned launches probe a free port and race process exit: fixed at <hash>, test `a free spawned port is selected before engine launch`.
9. Unverified model ids return a 409 with missing fields: fixed at <hash>, test `an unverified model is a 409 with its missing provenance`.
10. Model download size estimates are advisory while engine archive sizes stay strict: fixed at <hash>, test `a model size estimate is advisory when its hash matches`.

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
3. **The tray app is Tauri 2**: one codebase for macOS, Linux and
   Windows, 5 to 10 MB, tray icon, native notifications, updater and
   sidecar management as first-party plugins; it holds no logic, reads
   the same event feed Home reads, opens the web UI in its own window,
   offers Start, Pause and Resume, and is the independent observer
   that turns red and offers Start when the daemon is down. It is the
   only process that posts native notifications (a bare daemon cannot
   on macOS). This is a written deviation from STACK.md's Electron for
   Desktop: the tray shell has no UI of its own, and a Chromium
   process sitting in the menu bar all day beside a 70 GB model is the
   wrong tool; Rust joins the toolchain for this one small app.
4. **Install** is one command hosted by us that downloads only our
   own binary from our own release, registers the service and opens
   the board (`ux.md`, "Install and first open"); the app bundle with
   the tray is the second path and runs the same steps.

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
   changing nothing else). Go and Bot reach the Stack the same way,
   through their Home. A translation layer is a bug.
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

## The helper: an assistant inside the console (research, 2026-09-17)

The owner's question: a chatbot in the app that helps a person
troubleshoot and configure ("how many engines do we have", "are all
our models up to date"), and what runs it when the person's own
engines are down. Not a priority to build; this records what the
field does and the shape we would build, so the item is pickup-ready
when its turn comes.

**How others do it.** Home Assistant's Assist is the closest match
and the best design: a deterministic sentence matcher answers first
(no model involved), and only what it cannot match falls through to
a conversation agent. That agent, when it is a local model, gets the
"Assist API" as tools scoped to the entities the person exposed, and
Home Assistant's own guidance is a tool-calling Qwen3-class model with
thinking off, at least a 10k context, and a warning that thirty
exposed entities already cost about 1,300 tokens per request (the
2026.8 release added a native llama.cpp client:
[llama.cpp integration](https://www.home-assistant.io/integrations/llama_cpp/),
[LLM API docs](https://developers.home-assistant.io/docs/core/llm/),
[hybrid intents then LLM](https://www.home-assistant.io/blog/2025/09/11/ai-in-home-assistant/)).
Docker Desktop's Gordon is the other useful pattern: an assistant
beside the object, an icon next to a failed container that analyses
the error and proposes the fix, plus a CLI form; its flaw for us is
that it sends the context to Docker's cloud
([Gordon docs](https://docs.docker.com/ai/gordon/)). Nextcloud's
Assistant runs where the person hosts it with a pluggable model
backend and per-task entry points rather than one chat box
([Nextcloud Assistant](https://nextcloud.com/blog/first-open-source-ai-assistant/)).
The consoles we otherwise model on (UniFi, Synology, TrueNAS,
Proxmox) ship no built-in assistant; they answer with a repairs list
and a help centre, which is what our health list and Library already
are. So the field's answer is: deterministic answers and a docs search
first, a model only for the open-ended question, and the model
proposes rather than acts.

**Three tiers, in order, and most questions never reach the model.**

1. *Answered by the console.* "How many engines" is the Engines page
   count; "are my models up to date" is the Updates page. The
   command palette (the header search) grows a small intent table,
   Assist's sentence matcher in miniature: a typed question that
   matches routes to the page or widget that holds the answer, with
   the number in the palette row ("3 engines, 1 detected and not
   adopted"). Each intent carries a hit counter, per the org's rule
   that no rule lives without a counter and a row; an intent with no
   hits in a month is retired.
2. *Answered by the Library.* "How do I" and "what is" go to the
   Library search (STACK-32/33): the docs of what is installed plus
   the user docs, one index. No model.
3. *Answered by the helper.* Only the open-ended question ("why is
   chat slow today", "what should I install for homework help on this
   Mac", "what does this alert mean for me") reaches a model. The
   helper answers through read-only tools over the Stack's own API:
   `health` (the one list, its primary evidence), `engines`, `models`,
   `updates`, `storage`, `series` (the Overview's numbers) and the
   Library's `search`. Every tool returns a summary sized for a small
   context (counts and the health rows, never a whole record), the
   lesson from Assist's entity budget. The helper never performs an
   action: an adopt, install, restart or setting change is rendered
   as a proposal card the person clicks, the same card the page would
   show, so the learned component stays out of the paths that change
   the machine (the org's rule for learned components, and Gordon's
   "suggest the fix" shape).

**What runs it.** The helper is its own role, `helper`, never a
person's ability and never counted in their tiers. Two sources, in
order: the person's loaded `chat` engine when it is up and its model
supports tool calling (free, already resident); otherwise the Stack's
own pinned small model, `qwen3-1.7b-q8-0` (1.8 GB, the same pin Try
it uses, thinking off, `--jinja` for tool calls), on a separate
llama-server the governor spawns at the lowest priority and unloads
after a few idle minutes. It is never resident. That answers the
owner's "separate small thing": a separate process, not a separate
download. When the person's engines are down because of a bad flag, a
crashed process or a failed update, the helper's own process still
loads and can read the health list that explains it. When they are
down because memory is exhausted, the helper will not load either;
tiers 1 and 2 still answer, and the palette says plainly "the helper
needs 2 GB free; here is what the health list says", which is the
honest state rather than a spinner.

**Where it lives in the UI.** No floating chat bubble. The palette is
the front door (a question typed into search is the first tier, and
"Ask the helper" is the last row when nothing matched), and an "Ask
about this" action sits on each health row and alert, the Gordon
pattern, so the question arrives with its object attached. The reply
renders in the property panel (STACK-35), beside the thing it is
about, on Try it's chat components (one chat surface, not two).

**One tool surface, three consumers.** The read-only tools are
declared once and served three ways: to the helper, as the
`stack-library` MCP server's neighbours (STACK-32 already plans
`list_installed`, `get_doc`, `search`; the status tools join it), and
to Home's own assistant, which asks the Stack over the same API and
never gets a second implementation. Home's assistant knows the
person; the Stack's helper knows the machine; the line holds.

**Privacy.** Nothing leaves the machine: the helper's context is the
Stack's own state and the Library, both local, and the Stack holds no
person data to leak. The privacy page gains no row, because no
outbound connection is added. The helper is listed on the Abilities
page as what it is, "the helper, 1.8 GB, loads only when asked".

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

1. **Name.** Decided 2026-09-17: `stack`, "MaiPai Stack". The public
   repo is `github.com/getmaipai/stack`.
2. **Logo.** Done 2026-09-17: `maipai-stack-{icon,logo}-{light,dark}.png`
   in `getmaipai/.github/brand/` (orange accent, three stacked layers).
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
