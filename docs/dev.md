# MaiPai Stack: design record

MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller.

Started 2026-09-17 as a product; refocused 2026-09-20 as Home's engine
layer (`getmaipai/.github/docs/DECISIONS.md`, both entries dated
2026-09-20, and the necessity review in
[plans/stack-necessity-review-2026-09-20.md](plans/stack-necessity-review-2026-09-20.md)).
This file is the dev-tier design record: what the Stack is, what it is
not, the architecture and the reasons. The contracts Home and Bot rely
on are in [integrations.md](integrations.md); what is built and what is
missing is in [BACKLOG.md](BACKLOG.md). The product-era surveys are
history in [plans/field-survey-2026-09-17.md](plans/field-survey-2026-09-17.md).

Nothing in this file is household content: every person in an example
is from the org's persona roster.

## Why the Stack exists

Local AI is a pile of parts. One program runs the chat model, a
different one turns speech into text, another turns text into speech, a
small model listens for the wake word, and a fourth draws pictures. Each
starts its own way, keeps its own files, needs its own slice of memory
and breaks in its own way. Home should never have to know any of that.
The Stack is the one interface between those raw parts and everything
MaiPai builds on top: Home asks for "chat" or "say this" at one address
and gets an answer, and the Stack decides which engine runs it, makes
sure the right model file is there and untampered, keeps every engine
fitting in memory at the same time, notices when one breaks and says how
to fix it, and swaps a new build in, or back out, without Home changing
a line. Swap an engine, add a role, move from the Mac to the robot's
Linux box: Home does not change. Without the Stack, every product would
carry its own copy of all that, and a kid asking for a picture could
crash the family's chat.

## What the Stack is

One daemon on the machine Home runs on (and on the robot, where Bot
runs Home's platform code). It owns the processes Home launches to
think, listen, speak, embed and generate, and nothing else. Home asks
for a role (`chat`, `embed`, `stt`, `tts`, `wakeword`, later `image`,
`video`, `music`) on an OpenAI-shaped endpoint and never names an
engine or a file; every reply says which engine and model answered.
The Stack sizes the machine, keeps one memory budget across every
process it started, pins every engine build and model file by URL,
revision and checksum with the licence recorded, keeps the previous
build for rollback, and reports its state honestly: "ready" means a
recent request through the public route succeeded with the expected
identity, health is a list of problems with one fix each, and an
update is "installed X, available Y, last checked at T, go back".

Home's installer installs the Stack; a person never installs the Stack by itself. It
updates with Home's releases, and runs as its own process under the OS
service manager (launchd on
macOS, systemd on Linux for the robot) because a separate process
survives a Home crash and is shared by Bot on the same box. Mac first,
Linux for the robot; the same config and the same API on both.

## What the Stack is not

- **No user interface.** No console, no dashboard, no tray, no desktop
  app, no palette, no try-it studio, no showroom, no library. Home's
  admin renders the Stack's state on one Engines page from the Stack's
  own declarations.
- **No people, no clients, no keys.** The Stack knows one caller: the
  Home process on the same machine. No operator login, no per-client
  keys, no role-scoped tokens, no LAN exposure. A developer's own tool
  reaching the engines is a Home feature; Home owns identity and
  permissions.
- **No second copy of any Home fundamental.** Notifications, the
  updates page, repairs, settings rendering, backups, the privacy page,
  log viewing and identity are Home's. The Stack declares its facts as
  data and Home renders them (the ownership table is in `AGENTS.md`).
- **No apps, no packages, no extension system.** A third-party thing
  enters through two seams: a pinned engine build in this repo's
  catalog, or a model with its provenance recorded.
- **No general model search as an install promise.** A curated, signed
  list of pinned models per role, indexed by the Catalog.
- **No public release, no standalone installer, no docs site, no brand
  pitch.** The README is a developer pointer.
- **No control of other tools.** Ollama, LM Studio, Msty and the rest
  are not governed, updated or adopted. Their model files may be
  imported by verified copy or safe link after an explicit choice; a
  server one of them runs may be bound to a role as a read-only URL,
  never started, stopped or updated by the Stack.

## Design principles

These sit under the org platform principles in
`getmaipai/.github/CLAUDE.md` and never weaken one.

1. **Roles, not models.** The API exposes named capability roles, each
   on a standard endpoint. Home asks for a role; the Stack maps role to
   engine to model. Home never names a binary and never needs to know
   which engine answered, though every reply says so in a header.
2. **Hosts are engines, never the platform.** llama-server, mlx-serve,
   oMLX, ComfyUI, whisper.cpp and the rest are spawned or managed
   behind one stable contract. Swapping an engine never changes Home.
3. **One caller, Home.** The Stack serves the Home process on the same
   machine and nothing else. Anything that needs to know who is asking
   belongs to Home and never appears here because it was convenient.
4. **One residency budget, owned here.** Hardware sizing, memory
   pressure, admission (one generator at a time; queue or refuse with a
   reason) and eviction live in the Stack and nowhere else, for the
   processes the Stack launched.
5. **Provenance before selection.** Source, revision, licence, checksum
   and engine identity are recorded before a model is selectable. The
   Catalog is the index; the Stack is the verifier.
6. **Honest state, one feed.** Every state the Stack reports is derived
   from a check it ran, never stored as a status. One typed event feed
   carries every change; Home's notification system subscribes to it
   and is the only thing that ever tells a person.
7. **Zero phone-home, with the outbound list as data.** Update checks
   and model downloads are opt-in; the Stack declares its outbound
   endpoints and Home's privacy page lists them. No MaiPai-operated
   service sits in the path.
8. **Same shape on every OS, Mac first.** The engine list per platform
   differs; nothing else does.
9. **Measured, not assumed.** Sizing and residency decisions come from
   observed process peaks and the kernel's own pressure signal, never
   from file sizes. A number the Stack reports is a number it measured
   on this machine.

## Architecture

One daemon, one loopback port, one data directory.

```
Home (the only caller)
        |  /v1/*        (OpenAI shape, by role)
        |  /stack/v1/*  (roles, engines, models, jobs, health, updates,
        |                events, hardware, budget, settings, privacy, backup)
        v
+----------------------------- maipai-stack -----------------------------+
|  router: role -> binding -> process        events (typed SSE feed)     |
|  governor: budget, pressure, admission     health: problems with a fix |
|  supervisor: spawned | managed | url       updates: swap and rollback  |
|  model store: provenance, checksums        engine catalog (pins)       |
|  hardware probe, profiles                  settings declaration        |
+------------------------------------------------------------------------+
        |               |                 |                |
   llama-server     mlx-serve / oMLX    ComfyUI        speech runtimes
   (spawned)        (spawned)           (managed)      (spawned)
```

### The daemon

`maipai-stack` is a Bun process (Hono, routes as Zod schemas through
`@hono/zod-openapi`, SQLite through Drizzle, per the org `STACK.md`)
serving the API on one loopback port (default 8770, configurable
through the settings declaration). Loopback is the only authentication:
`Bun.serve` binds `127.0.0.1` and nothing else; there is no LAN
setting. It runs under launchd on macOS (`com.maipai.stack`) and under
`systemd --user` on Linux, both with restart-on-failure, exit codes that
mean what they say, and logs under the data directory. Home's installer
installs the Stack and its service unit; Home's watchdog sits above it
(org `SERVICES.md`).

The backend imports `@maipai/core` from `getmaipai/shared` (pinned
`core-v0.1.0`, a `file:` dependency on the sibling checkout, the gate
failing loud when the sibling or its version is wrong) for the helpers
every product shares: `createLogger`, `withTimeout`, `ensureDataDir`,
`extractArchive`, the zip writer behind the diagnostics bundle, the
hardware probe and the openapi router. The Stack's own instances
(`lib/log.ts`, `lib/paths.ts`, `lib/hardware.ts`) bind them to this
product's data layout. `@maipai/spec` follows at RF-05 for the wire
shapes (the role reply headers, the event envelope, the health item,
the settings declaration, the precious-state declaration). The engine
and model catalogs stay product-side. `data/` holds everything runtime
and is never tracked.

### Roles and the router

A role is a stable string with a declared wire shape and a declared
residency class, in one `ROLES` constant in `backend/src/roles.ts`:

| Role | Wire shape | Residency default |
|---|---|---|
| `chat`, `coding`, `judge`, `router` | OpenAI chat completions, streaming, tools | `chat` resident; `judge` resident and small; `coding` and `router` share `chat`'s model unless sized otherwise |
| `embed`, `rerank` | OpenAI embeddings; a rerank endpoint in the same style | resident, small |
| `vision` | chat completions with image parts | resident when the chat model is multimodal, else JIT |
| `stt` | OpenAI audio transcriptions, plus a streaming session for live speech | resident, small |
| `tts` | OpenAI audio speech, plus phrase-level streaming and cancel | resident, small |
| `wakeword` | not served over HTTP; a model the Stack installs for a body process to load in-process | installed, not loaded |
| `image`, `video`, `music` | jobs, with a synchronous OpenAI-shaped wrapper for simple callers | JIT, one generator at a time |

The request `model` field carries a role id (`"chat"`) or a concrete
installed model id when Home must name one. A role name is the default
because OpenAI client libraries already send `model` and need no header
or per-role path. Generator roles accept `quality: fast | everyday |
best`, mapped to the tiered models the sizing profile installed.

Every reply carries identity headers: `x-maipai-engine` (which engine
build answered), `x-maipai-model` and `x-maipai-revision`. If no engine
answered, all three are `none`, including on a 503. An unbound role is
never a 404: it is a 503 with `{ error, role, state, offline_reason }`
so Home can explain the actual reason and retry when the state changes.
An unknown role or model is a 400 that lists the declared role ids; an
installed model whose provenance is incomplete is a 409 naming the
missing fields.

Role state is one enum, `notInstalled | installed | loaded | ready |
offline`, each with `since`. `ready` is claimed only while the last
real request or post-load check through the public route succeeded
within the last hour (`READY_TTL_MS`), and carries `checkedAt`; older
than that, a role is `loaded` at best. `offline` carries a reason.

### Engines and the supervisor

An engine is one of three kinds:

- **`spawned`**: the Stack downloads a pinned build (pinned version,
  pinned URL, a checksum recorded in this repo), extracts it under
  `data/engines/`, spawns it, watches it, restarts it and stops it.
  `llama-server` is the baseline everywhere; `mlx-serve`, `oMLX` and
  the speech runtimes are spawned candidates on the Mac.
- **`managed`**: a sidecar the Stack starts and stops but does not
  build (ComfyUI). Same lifecycle, its own process.
- **`url`**: a read-only binding to a server Home's person already
  runs, set as one URL per role in the settings declaration. The
  Stack probes its health and identity and reports `offline_reason`
  when it is gone; it never starts, stops, updates or governs it.

The supervisor holds one process per role binding and owns its
lifecycle: the generation guard (a request in flight is never cut by a
reload), the free-port probe before launch, the liveness wait with a
size-scaled load timeout (60 s floor plus 60 s per GB, 20 min ceiling),
the post-load check (a real completion with `enable_thinking: false`
before a role is `ready`; a model answering in `reasoning_content` is
still alive), the process watch with restart on exit, the measured
footprint after load (recorded on the model record, replacing the
estimate), idle unload after the declared idle minutes (shorter on
battery), and a drain on stop. A living engine's 5xx is returned as is;
a cancelled request is a normal end, not a retirement. Only an engine
whose health probe fails is retired and reported offline.

Bot's body keeps STT, TTS, wake word and voice activity in its one
speech process over `spec/voice/`; on the robot that process is a
`managed` engine holding `stt` and `tts` so the identity contract holds
and Home's platform code addresses speech the same way on both nodes.

### The model store and provenance

A model record is written the first time a model is known and is the
only place its facts live: `id`, the `roles` it can serve, `source` (a
Catalog package, a Hugging Face repo), `provenance`, `revision`,
`sha256`, `sizeBytes`, `licence`, `engineRequirements`, `installedAt`,
`verifiedAt`, `hostIdentity`, `firstBootAt`, `modelPath`,
`measuredFootprintBytes` and `measuredContextLength`. Every record
carries an id, provenance and a clock stamp from the first boot (the
org's no-data-debt rule).

A model is selectable for a role only when its checksum has been
verified and its licence recorded; the pull route refuses a request
without url, sha256, licence and revision before downloading a byte.
The Catalog's `model` packages are the preferred source because they
arrive signed with all of this filled in. An existing file is
hash-checked before it is trusted; a corrupt download is never marked
verified and raises `stored-blob-checksum-mismatch`.

**Qualification.** The Stack ships one chat pin and one engine pin,
and `backend/tests/qualification.test.ts` holds both to their
declarations offline. The chat pin is `Qwen/Qwen3-1.7B-GGUF`, Q8_0,
Apache-2.0, at Hub commit `90862c4b9d2787eaed51d12237eafdfe7c5f6077`,
sha256 `061b54da…590cb1a` verified against a live download of that
commit, declared size `1,834,426,016` bytes as the Hub reports it. The
engine pin is `llama-server` build `b10797` (macOS arm64 verified),
each archive carrying its own asset digest. The test asserts the
revision is an immutable commit, never `main`; digest, size and licence
are present; the declared footprint plus the default context and the
governor's working margin fits every tier at or above the pin's `p16`;
and every engine pin declares a build tag and an asset digest.

### The store on disk

Models use the Hugging Face cache shape so a spawned Python engine given
`HF_HUB_CACHE=data/models/hub` reuses the same bytes:

```text
data/models/hub/models--<org>--<repo>/
  blobs/<sha256>
  refs/main
  snapshots/<revision>/<file> -> ../../blobs/<sha256>
data/models/manifests/<id>.json
```

Engine builds use a versioned layout whose `current` link is the
selection and rollback pointer:

```text
data/engines/<name>/<tag>/
  manifest.json
  <extracted assets>
data/engines/<name>/current -> <tag>
```

Downloads land in a temporary file, verify before extraction or rename,
and become visible atomically. Ranged downloads split into eight parts
with a progress sidecar each, resume from the recorded offset, and
assemble under one full-file SHA-256; a server that answers `200` to a
range request falls back to the single-stream resumable downloader,
which retries six times with backoff and stops on a 403 or 404. Every
manifest lists the blobs it references; remove deletes the manifest
first and only blobs with no remaining reference, after a one-hour
grace period for interrupted pulls. Import from another tool's folder
is read-only against that tool: a same-volume file is hard-linked into
the store, otherwise symlinked, copied only where linking is impossible,
and never trusted until its own digest and licence are recorded.

### The governor

The governor is the sole owner of admission for the processes the Stack
launched. The profile names the resident set and the on-demand set;
until the first measured load, a model's peak is estimated as file size
times the engine's multiplier (1.3 for llama-server, 1.4 for the MLX
servers) and labelled estimated.

Admission reads free memory now and the requested peak. A load starts
only when free memory minus the requested peak leaves the profile's
working margin (4 GB on p16, 8 GB on p32, 12 GB on p64, 20 GB on p128)
and the loaded total stays under the cap (total memory minus the OS
margin, 8 GB by default, declared as `modelBudgetBytes`). Only one
generator runs at a time; a request that cannot be admitted enters a
queue of four with a position, or is refused with a reason. Three
refusals of the same request raise `admission-refused-repeatedly`.

Eviction reads idle time, pin state, kernel pressure and resident RSS. A
JIT model unloads after `idleTtlSeconds` (600) plus any `keep_alive`;
under pressure the least recently used unpinned JIT model unloads
first; a pinned model never unloads. A resident model restarts when its
process footprint exceeds 1.3 times its measured peak plus 500 MB for
three polls. Critical pressure aborts the in-flight generator. The poll
is every 5 s idle, every 1 s during a load. The governor keeps a bounded
in-memory ledger of its newest 200 decisions with the reason for each,
served on the budget route; nothing about decisions is persisted.

**The kernel's ledger.** The governor reads one `MemoryReader`:
`{ totalBytes, availablePercent, pressure: normal | warn | critical,
freeBytes, processFootprint(pid) }`. On macOS, `hw.memsize`,
`kern.memorystatus_level`, `kern.memorystatus_vm_pressure_level` (1
normal, 2 warn, 4 critical) and `host_statistics64` (free plus inactive
plus purgeable pages) through `bun:ffi` against `libSystem.B.dylib`,
and `proc_pid_rusage` with `RUSAGE_INFO_V4` for `ri_phys_footprint`;
every failure keeps the previous reading and raises a warning health
item. On Linux, `MemAvailable` from `/proc/meminfo`, PSI memory `some
avg10` above 10 as warn and above 50 as critical, `VmRSS` from
`/proc/<pid>/status`. Kernel warn or critical is always the soft or
hard watermark regardless of arithmetic; the arithmetic watermark is
free memory below 10 percent or 1 GiB for two polls. `os.freemem()` is
not used: it reported 0.09 GB on a Mac the kernel called 61 percent
free. Windows has no reader until it can be tested on Windows.

Before a first load, the dry-run path checks the pinned llama.cpp
archive for `llama-fit-params` (the b10797 macOS archive contains it)
and stores its fit result with the model and context; a model not yet
downloaded uses the GGUF header and the KV formula only as an explicitly
estimated number. After a successful post-load check, the measured
process footprint replaces the estimate.

On the robot, the body's power and thermal budget is an additional
admission input with the same thresholds and actions (Bot's GOV-01).

Rejected: a static reservation (ignores current pressure and measured
peaks); an OS-level cap (macOS gives no clean native RSS cap for a
spawned child); letting each engine decide (cannot enforce one budget
across engines).

### Jobs

Image, video, music and long TTS renders are jobs: `POST` returns a job
id, progress arrives on the event feed, cancel works, and the result is
fetched by id. ComfyUI's queue is the model and, for image editing, the
engine. `/v1/images/generations` is the job API with a wait, for simple
callers. Generator execution is a backlog item; the job shape is
declared in the spec at step 5 of the refocus.

### Health

Health is one keyed, durable list. An item has `code`, `severity`
(`critical | error | warning`), `title`, `text`, `since`, `cause` and
an optional `fix` with `label` and `action`. Raising a code updates the
existing item rather than duplicating it; resolving or ignoring removes
it from the active list; every change emits `health.changed`. Producers
are explicit and each resolves its own code when the condition clears:
the supervisor (`engine.crashed`, `post-load-check-failed`,
`managed-host-offline`), the governor (`memory-pressure-warn`,
`memory-pressure-critical`, `admission-refused-repeatedly`), the store
(`stored-blob-checksum-mismatch`, `disk-under-reserve`), updates
(`failed-swap`), the readiness check (`check-role.<role>`,
`check-fit-together`). Home shows the list, renders the fix button and
calls `POST /stack/v1/health/{code}/fix`; the Stack runs the repair
(restart the engine, free memory, roll back) and reports the result.

### Readiness

The readiness check walks every installed role, sends the smallest
real request for its wire through the public route, and records each
result with its duration and reason; a second fit-together pass runs
one generator while sampling kernel pressure every 250 ms and fails
before critical pressure can continue. Failures become health items
with the smallest useful fix; passing reruns resolve the old item. It
runs when Home calls it (Home owns every schedule) and on demand.

### Updates

Three things have versions: engine builds, models, and the Stack
itself. The Stack itself updates with Home's release; it has no update
channel of its own. For engines and models the Stack knows what is
installed and, when Home has switched update checks on, what is
available: one conditional `GET` (`If-None-Match`, the Stack user
agent, no query string or identifier) of the Catalog's signed index,
the same pinned-URL check for both. Where the Catalog does not yet
publish an engine index, the engines half reports installed and last
checked with available unknown. Nothing is fetched from a Stack
release; there are none.

Applying an engine update, when Home says so: the verified archive is
staged beside the current tag, the role drains under the generation
guard (no new requests, up to 60 s for in-flight work, then SIGTERM and
SIGKILL after 10 s), the `current` link flips, and `/health` plus the
post-load completion must pass before routing does. A failed swap
relinks the previous tag and raises `failed-swap` (critical, fix: roll
back); the previous build is kept until the next update. A model update
is a new revision beside the old under the same rule and is never
applied without Home's explicit call. Engine version state is derived,
never stored: the running build, the store's `current` tag and the
newest pin for this machine agree (`current`) or do not (`notCurrent`
with `newer installed` or `newer available`); `needsRestart` is true
while a pending setting differs from the one in effect.

### Settings

Every Stack setting is declared once, in `backend/src/settings.ts`,
with key, type, default, disclosure level (`basic | advanced |
developer`), `needsRestart`, section and range or options, and the
declaration is exported on `GET /stack/v1/settings` for Home's generic
renderer (org `SETTINGS.md`). Values are stored in the Stack's `meta`
table; a key marked `needsRestart` is held as pending until the next
start. Per-engine settings (llama-server's `contextLength`, `slots`,
`threads`, `cacheRamMb`, `flashAttention`; a `url` binding's `hostUrl`
and `expectedVersion`) are part of the same declaration under their
engine's section. Home never duplicates a Stack setting; it renders the
declaration and persists the person's choice through the Stack's route.

### Sizing and profiles

The hardware probe reports platform, arch, total RAM, CPU count, Apple
silicon and unified memory, CUDA devices with VRAM, free disk and OS
version, cached for five seconds. Four profile tiers (`p16`, `p32`,
`p64`, `p128`, by unified memory on Apple silicon and by VRAM
elsewhere) name each role as resident, on demand, installed only or not
available; `proposeProfile` picks the highest tier the machine clears.
Home words the tier for a person; the Stack reports the facts.

| Platform | Engines | First customer |
|---|---|---|
| macOS, Apple silicon | `llama-server` Metal (baseline), `mlx-serve`, `oMLX`, ComfyUI (managed), whisper.cpp or MLX Whisper, the chosen TTS runtime | MaiPai Home on the Mac Studio |
| Linux, ARM and x64 | `llama-server` (CPU, CUDA, or the accelerator the robot carries), sherpa-onnx for speech, ComfyUI where a GPU exists | MaiPai Bot |

### State on disk

One SQLite file, `data/stack.db`, holds state: the declared settings'
values and the last readiness run in `meta`, model records with their
provenance and measured peaks, and open health items. Nothing else is stored: the governor's
ledger and the event ring are in memory, and history a person reads
(usage, memory over time, speed results) is Home's to keep if Home
wants it. The earlier two-database plan (a `metrics.db` of samples) is
withdrawn with the console that read it. The precious state the Stack
declares for Home's backup is `stack.db` and `data/keys/`; model and
engine bytes are rebuildable from their pins and are declared
`exclude`.

## Third-party pieces, and how an outside update never breaks us

The org rule is "download, don't vendor" and "prebuilt over
hand-built". Taken, each behind one adapter module of ours:
`@huggingface/hub` (model info, file lists, the revision `sha`) in
`lib/hf.ts`; `@huggingface/gguf` (a GGUF's metadata over HTTP range
requests, so a model can be sized before download) in `lib/gguf.ts`;
llama.cpp's own fit dry run and `llama-server`; `bun:ffi` against
libSystem for the kernel's memory ledger.

The patterns: dependencies arrive through the package manager with a
committed lockfile and the gate installs frozen; engines and models are
pinned by tag and a checksum we recorded, and a new build is an update
we choose, kept beside the previous one; one adapter module per
library, so a breaking API change touches one file, and our tests drive
our interface with scripted stand-ins; a claim about a library is
verified in its installed source and cited; never a submodule, never a
vendored tree, never a fork we maintain. The backend suite runs under a
temp `STACK_DATA_DIR` set by `backend/tests/preload.ts` and refuses a
real one (2026-09-17 21:40: a gate from the main checkout emptied the
owner's live models table).

## Measured so far

On an Apple silicon Mac (2026-09-18, a temporary copy of the owner's
data on port 8772, killed by pid and the port verified free afterward):
the pinned `llama-server` b10797 archive (11 MB) downloaded and
verified in 0.44 s; the Qwen3 1.7B Q8_0 model (1,834,426,016 bytes)
downloaded, verified and installed in about 50 s; the first chat
completion after install answered in 17 s including the load and
identified build b10797 in its headers; `llama-bench` on the resident
model recorded 2,218 prompt tokens/s and 115 generated tokens/s, a
1,055 ms load and a 40 ms first token; the readiness check reported
chat and fit-together ok. The Studio bench (STACK-14) is the next
measurement and the first with the full resident set.

## Open questions for the owner

1. **Bot's split.** Recommended: wake word and voice activity stay in
   the robot's body process (sensor processing, like the camera); STT,
   TTS, chat, judge and embed are Stack roles on the robot's own Linux
   Stack. The robot design pass confirms or amends this in
   `bot/docs/dev.md`.
2. **The second engine.** `mlx-serve` and `oMLX` are the Mac
   candidates beside `llama-server`; the Studio bench decides which
   gets the second adapter.

## Battle-tested checklist (for 1.0, empty until earned)

The Stack leaves 0.x with Home: when it has run the household hub for
a season without an unplanned restart, survived every update with
rollback proven at least once, and its measured profiles have matched
what a fresh install sees on three machines it has never seen. The list
grows here.
