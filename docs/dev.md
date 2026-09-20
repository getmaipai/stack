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
   oMLX, ComfyUI, sherpa-onnx, Pocket TTS and the rest are spawned or managed
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
setting. It runs under launchd on macOS (`com.maipai.stack`:
`RunAtLoad`, `KeepAlive { SuccessfulExit: false }`, `ThrottleInterval
30`) and under `systemd --user` on Linux (`maipai-stack.service`:
`Type=notify`, `Restart=on-failure`, `WatchdogSec=30`,
`StartLimitBurst=5` in 300 s, the daemon sending `READY=1`,
`WATCHDOG=1` at half the announced interval and `STOPPING=1` to
`$NOTIFY_SOCKET` itself over an `AF_UNIX` datagram through `bun:ffi`,
no libsystemd), both with exit codes that mean what they say and logs
under the data directory; `maipai-stack install-service`, `start`,
`stop`, `status` and `uninstall-service` pick the manager by platform.
Home's installer installs the Stack and its service unit; Home's
watchdog sits above it (org `SERVICES.md`).

The backend imports `@maipai/core` from `getmaipai/shared` (pinned
`core-v0.1.0`, a `file:` dependency on the sibling checkout, the gate
failing loud when the sibling or its version is wrong) for the helpers
every product shares: `createLogger`, `withTimeout`, `ensureDataDir`,
`extractArchive`, the zip writer behind the diagnostics bundle, the
hardware probe and the openapi router. The Stack's own instances
(`lib/log.ts`, `lib/paths.ts`, `lib/hardware.ts`) bind them to this
product's data layout. The wire shapes Home builds against (the role
request and reply headers, the event envelope, the health item, the
settings declaration, the precious-state declaration) are declared once
under `backend/src/spec/` in exactly `home/spec`'s shape (JSON Schema
2020-12, a Zod mirror the backend imports, fixtures, a round-trip test)
and move to `shared/spec` at step 0c, after which `@maipai/spec` is
imported and the local folder deleted. The engine and model catalogs
stay product-side. `data/` holds everything runtime
and is never tracked.

### Roles and the router

A role is a stable string with a declared wire shape and a declared
residency class, in one `ROLES` constant in `backend/src/roles.ts`:

| Role | Wire shape | Residency default |
|---|---|---|
| `chat`, `coding`, `judge`, `router` | OpenAI chat completions, streaming, tools | `chat` resident; `judge` resident and small; `coding` and `router` share `chat`'s model unless sized otherwise |
| `embed`, `rerank` | OpenAI embeddings; a rerank endpoint in the same style | resident, small |
| `vision` | chat completions with image parts | resident when the chat model is multimodal, else JIT |
| `stt` | `spec/voice`'s transcribe form at the OpenAI audio path, plus the `SttWireEvent` streaming session for live speech | resident, small |
| `tts` | `spec/voice`'s speech form and streaming WAV at the OpenAI audio path, phrase by phrase with cancel; an OpenAI-shaped request only when the spec carries it | resident, small |
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
within the last hour (`READY_TTL_MS`) and the process reports the
expected identity (a spawned engine names the selected model's file; a
url binding with an `expected_version` reports a build carrying it),
and carries `checkedAt`; otherwise a role is `loaded` at best, with
the reason (no recent request, or which identity it reported
instead). `offline` carries a reason. Beside the state, the roles
route says what the last readiness run found for the role (`not
checked`, `passed`, `failed` with the reason, `skipped`) and whether
that finding is stale: every change to what the Stack runs (a model
installed or removed, an engine installed or swapped, a model pinned
or preferred for a role, a setting whose in-effect value changed or a
pending one applied) bumps a generation counter in `meta`, a run
records the generation it started at, and a run from an earlier
generation is reported stale with the change that made it so; a save
that changes nothing, or that only sets a pending value, stales nothing
(STACK-87).

### Engines and the supervisor

An engine is one of three kinds:

- **`spawned`**: the Stack downloads a pinned build (pinned version,
  pinned URL, a checksum recorded in this repo), extracts it under
  `data/engines/`, spawns it, watches it, restarts it and stops it.
  `llama-server` is the baseline everywhere; `mlx-serve` and `oMLX`
  are spawned candidates on the Mac; the `stt` worker over
  sherpa-onnx is spawned on the Mac and on any Linux host that is
  not the robot, where the robot's own design record puts speech in
  the body's one process, which its Stack would hold as a `managed`
  engine serving the roles (STACK-94b, STACK-17, open question 1).
- **`managed`**: a sidecar the Stack starts and stops but does not
  compile: a Python program in an environment the Stack assembles
  from pinned wheels (Pocket TTS through a pinned `uv`, STACK-94c),
  or a server it starts where it finds it (ComfyUI, whose install
  STACK-13 decides). Same lifecycle, its own process.
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
selection and rollback pointer; the tag is the upstream build tag
(`b10797`), the same one the Catalog's engine index names, so
installed and available compare directly (a store from before the
tags were upstream build tags is renamed once at start):

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
margin, 8 GB by default, declared as `stack.memory.model_budget_bytes`). Only one
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

Every Stack setting is declared once, in `backend/src/settings.ts`, in
the spec's `StackSetting` shape: a `SettingsKey` (`home/spec`) with
`key` under `stack.`, `selector`, `default`, `label`, `help`,
`section`, `level` (`basic | advanced | expert`), `lives_in: stack`,
plus `needs_restart`, `in_effect` and `pending`. The declaration is
served on `GET /stack/v1/settings` for Home's generic renderer (org
`SETTINGS.md`), which draws it the way it draws Home's own keys. Values
are stored in the Stack's `meta` table; a key marked `needs_restart` is
held as pending until the next start. Per-engine settings
(`stack.engines.llama_server.context_length`, `.slots`, `.threads`,
`.cache_ram_mb`, `.flash_attention`; a `url` binding's
`stack.engines.<role>.host_url` and `.expected_version`) are part of
the same declaration under their engine's section. Home never
duplicates a Stack setting; it renders the declaration and persists the
person's choice through the Stack's route.

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
| macOS, Apple silicon | `llama-server` Metal (baseline), `mlx-serve`, `oMLX`, ComfyUI (managed), sherpa-onnx for `stt` and Pocket TTS for `tts` (STACK-94b, 94c) | MaiPai Home on the Mac Studio |
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

## Components inventory

[components.md](components.md) is the generated inventory of every
engine build and model the Stack pins, per role and per machine
profile: the engine per platform with its build tag and status, and for
each profile the role's stance, the pinned model, its quantization,
file size, the measured footprint and context once a bench (STACK-74)
has recorded them on the pin itself with a sanitized hardware line,
licence, source repo and revision, and whether it is pinned, a
named candidate, or not yet. `bun run gen:components-doc` in `backend/`
writes it from `roles.ts`, `engineCatalog.ts`, `profiles.ts` and
`modelCatalog.ts` (the pins and the `ROLE_CANDIDATES` list), and
`scripts/check.sh` regenerates and fails on drift the way it does for
`docs/api/openapi.json`. The Catalog's signed index replaces the
generator's source at STACK-97.

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

## Pin and rollback, proven live (STACK-96, 2026-09-20)

`scripts/prove-pin-rollback.sh` drives the whole proof through the
public routes on loopback with a clean `data-scratch/` directory (pid
recorded, stopped by pid, port verified free, scratch removed): install
the pinned engine and model with real downloads, get a chat answer,
stage the same build under a second tag (no engine index exists
upstream yet, so the staged archive is the pin's own; the swap
mechanics are what is under proof), swap with the drain and the
post-load check, roll back, break a staged build and prove the failed
swap relinks and the health fix repairs it, refuse a wrong checksum,
refuse removing the current build.

Run 1, an Apple silicon laptop with 24 GB (tier `p16`), engine
`llama-server` b10797 (macOS arm64, `b10797-832fd6f17` by its own
`/props`), model `Qwen3-1.7B-Q8_0.gguf` at Hub commit
`90862c4b9d2787eaed51d12237eafdfe7c5f6077`:

| Step | Result | Time |
|---|---|---|
| Install the pinned engine (11 MB) | job done, `current` link `b10797-macos-arm64` | 1.15 s |
| Install the pinned model (1,834,426,016 bytes) | job done, sha256 `061b54da…` verified, record `verifiedAt` set | 29.35 s |
| First chat answer through `/v1/chat/completions` | HTTP 200, `x-maipai-model: Qwen3-1.7B-Q8_0.gguf`; role `ready` with `checkedAt`; measured footprint 417,450,288 bytes at context 4096 | 1.52 s including the load |
| Stage the same archive as `b10797-proof` | job done, `current` unchanged | 0.59 s |
| `PUT /engines/llama-server/current` to `b10797-proof` | ok, `current` relinked, chat HTTP 200 | 0.53 s |
| Roll back to `b10797-macos-arm64` | ok, chat HTTP 200 | 0.07 s |
| Stage `b10797-broken`, truncate its binary, swap to it | **wrong**: ok and chat still 200 | 0.63 s |
| Stage `b10797-bad` with a zero checksum | refused: `sha256 474a788ec73d != expected 000000000000, the partial file was removed`; no ready marker | |
| Remove the current build | **wrong**: HTTP 200 | |

Run 1 exposed two real bugs, fixed in the same commit with regression
tests. The supervisor launched the binary from the machine pin's own
directory and never from the store's `current` link, so the swap and
the rollback flipped a link nothing read, a broken build "worked"
because the old one was still what ran, and delete-current removed the
build that was not actually running; the supervisor now launches the
build the link names (`currentEngineBinaryPath`), and only once that
build finished installing. And the identity headers carried the host in
`x-maipai-engine` and the engine build in `x-maipai-revision`; they now
carry the host and build, the model file, and the model's pinned
revision. The review of that fix found the next layer: a swap only
checked that the tag's directory existed, which a failed or unfinished
download also leaves behind, and the launcher fell back to the machine
pin's binary when the link named an unready build, so `current` could
name a build that was not what ran. A swap now requires the ready
marker, a link at an unready build is a refusal to start rather than a
fallback, a staged tag that already exists with a different checksum is
refused (409), and a staged build emits no `engine.state`. The swap's
failure path (`swapEngine` relinking the previous tag, `failed-swap`
critical with the `rollback_update` fix, the previous tag remembered
for the fix) and the refusals (a tag that is not installed or never
finished installing, a wrong checksum, removing the current build,
staging without a full pin, re-describing a staged tag) are each a
regression test in `engineSwap.test.ts`, `engineInstall.test.ts` and
`routes.test.ts`.

Run 2, with the fixes, installed the engine (0.59 s) and the model
(29.28 s) and then answered every chat request 503 "chat admission is
queued at position 1": the laptop had 5.5 to 5.7 GB free with normal
kernel pressure, the unmeasured model is estimated at 1.3 times its
1.83 GB file (the run-1 measurement was wiped with the scratch
directory), and free minus that estimate is under `p16`'s 4 GB working
margin. That is the governor doing its job on a busy machine, not a
defect, and the margin was not loosened for the proof.

Run 3 (STACK-96b), the same laptop later the same day with more memory
free at the daemon's start, as the rehearsal step of the Studio bench
(`data-bench/20260920T092047Z/rehearsal.log`), with every fix in place:

| Step | Result | Time |
|---|---|---|
| Install the pinned engine | job done, `current` link `b10797` (the upstream build tag, after STACK-97) | 0.61 s |
| Install the pinned model | job done, sha256 verified | 40.69 s |
| First chat answer | HTTP 200, `x-maipai-engine: local b10797-832fd6f17`, `x-maipai-model: Qwen3-1.7B-Q8_0.gguf`, `x-maipai-revision: 90862c4b…`; measured footprint 414,501,240 bytes at context 4096 | 15.69 s including the load |
| Stage the same archive as `b10797-proof` | job done, `current` unchanged | 0.61 s |
| Swap to `b10797-proof` | ok, `current` relinked, chat HTTP 200 from the staged build | 14.95 s including the drain and the post-load check |
| Roll back to `b10797` | ok, chat HTTP 200 | 0.07 s |
| Stage `b10797-broken`, truncate its binary, swap to it | refused: the build could not be started; `current` relinked to `b10797`; `failed-swap` critical with the `rollback_update` fix; chat HTTP 200 again at once from the relinked build | 0.08 s |
| `POST /stack/v1/health/failed-swap/fix` | ok, "Rolled back to b10797", chat HTTP 200 | 0.07 s |
| Stage `b10797-bad` with a zero checksum | refused, no ready marker | |
| Remove the current build | HTTP 400 | |
| Remove the staged proof tag | HTTP 200 | |

The item is closed by that run.

## The Studio bench protocol (STACK-74, 2026-09-20)

[plans/studio-bench-protocol-2026-09-20.md](plans/studio-bench-protocol-2026-09-20.md)
fixes what STACK-14 measures on the Studio before it runs: the
machines, the engine builds, the model files by id, repository,
revision and sha256, the contexts (4096 and 16384, a 64k row once a pin
allows it), the request mix (`llama-bench` at 512 prompt and 128
generated tokens over three repetitions, run with nothing loaded; eight
streamed route requests of a fixed prompt timed to the first content
chunk; an embeddings request when an embed model is installed; the
readiness check's fit-together pass), the pressure samples (the budget
route every 250 ms), the pass thresholds (post-load ok, no critical
pressure, readiness and fit-together ok, median first token under
1,000 ms, generated tokens/s within 10 percent of the latest previous
report for the same model, context and build), and the rollback
rehearsal that ends every run. `scripts/bench/studio-bench.sh` is the
protocol's one command: it installs the pins into a scratch directory
through the public routes, runs every row, judges it against the
previous report under `data-bench/`, and writes `report.md` and
`report.json` there; `DRY_RUN=1` prints the plan.

Rehearsed twice on the laptop on 2026-09-20 (Apple M4 Pro, 24 GB,
tier `p16`), `qwen3-1.7b-q8-0` at context 4096, build
`b10797-832fd6f17`, the model file cached by the OS. The first run
(09:20 UTC) is the baseline: load 814 ms, 2,221 prompt tokens/s and
114.8 generated tokens/s from `llama-bench`, measured footprint
414,239,048 bytes, minimum free 5.54 GB, worst pressure normal,
readiness ok, fit-together ok, the rollback rehearsal passed (its
transcript is run 3 above): pass. The second run (09:23 UTC), judged
against that baseline and the first with the first-token timing as the
protocol defines it: load 832 ms, median first token 15 ms over three
requests of the same prompt (69 ms for the first; the engine's prefix
cache serves the repeats), 2,222 prompt tokens/s and 112.5 generated
tokens/s (within the 10 percent), measured footprint 414,550,392
bytes, minimum free 5.42 GB, worst pressure normal: pass. The pin's
`measured` block in `modelCatalog.ts` carries the second run's
footprint, so the components inventory prints it.

## The speech roles: `stt` and `tts`, designed (STACK-94a, 2026-09-20)

The design note the backlog item asked for, so 94b (`stt`) and 94c
(`tts`) build against decisions already made. `stt` runs on
sherpa-onnx behind a thin worker of ours, spawned like `llama-server`;
`tts` runs on Pocket TTS, the owner's live pick, as a managed engine
through a pinned `uv`. Both keep every rule the other engines keep:
pinned, checksummed, under `data/`, governed, identity-bound. 94b
landed on 2026-09-20 with one amendment, marked below: the sherpa-onnx
runtime arrives as upstream's own binding, `sherpa-onnx-node`, pinned
exactly in `backend/package.json`, not as an engine archive over
`bun:ffi`.

### `stt`: sherpa-onnx, and why

**sherpa-onnx v1.13.8** (k2-fsa, released 2026-09-10, Apache 2.0).
One upstream release publishes prebuilt bundles for every machine the
Stack runs on: `sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2` (20.3 MB),
`sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2` (28.1 MB) and
`sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2` (28.2 MB), each with the
same C API in `lib/libsherpa-onnx-c-api` (`.dylib`, `.so`) and its
header `include/sherpa-onnx/c-api/c-api.h`, plus `libonnxruntime`.
Verified in the macOS archive on 2026-09-20. The one library holds
what `stt` needs: offline recognizers for Moonshine and Whisper
models and the Silero voice activity detector. It also holds offline
TTS for Kokoro and Piper voices, with a generate callback that stops
early when it returns 0 (c-api.h, "Return 1 to continue generation.
Return 0 to stop early."); that is what the robot's body speech may
use under STACK-17, not the Stack's `tts` pin (below).

**Amendment at 94b (2026-09-20): the runtime arrives as
`sherpa-onnx-node` 1.13.8**, upstream's own Node-API binding of that
same prebuilt library, pinned exactly in `backend/package.json` with
the lockfile (the org's code-dependency rule; its platform package,
`sherpa-onnx-darwin-arm64` here, `linux-arm64` and `linux-x64` on the
robot and a Linux host, carries the identical `libsherpa-onnx-c-api`
and `libonnxruntime`). Driving the C API over `bun:ffi` meant
hand-packing `SherpaOnnxOfflineRecognizerConfig`, a dozen nested
structs of pointers and integers whose layout moves with every
upstream release and that nothing type-checks; the binding gives the
same calls as typed configuration, it is the exact binding Home's
`stt.ts` uses today, and it loads under Bun (the spike transcribed
the bundled clip word for word in 17 ms before a line of the worker
existed). Prebuilt over hand-built points the same way. What it
changes: the runtime's version rides the Stack's own release and the
monthly dependency sweep, never the engine index, so `engineCatalog.ts`
carries no sherpa-onnx rows (its selector changes below are for the
`uv` pins only) and the components inventory prints the version from
`package.json`; `x-maipai-engine` reads `local sherpa-onnx-node-1.13.8`.

The reasons, in the order they decided it: prebuilt over hand-built
(an upstream release we download and checksum, no build pipeline of
our own for a Mac binary); one upstream release pinned on both
platforms, so the Mac and the robot run the same code at the same
version; the runtime the robot already uses (`bot/docs/dev.md`:
Moonshine tiny and Silero through sherpa-onnx, CAM++ speaker
embedding) and the one Home's current `stt.ts` binds in-process
through `sherpa-onnx-node`, so Home's adoption is a move, not a
translation.

**Rejected: whisper.cpp's server.** Its releases (build tag b5130,
2026-09-11) ship `whisper-server` in Linux arm64 and x64 tarballs and
Windows zips, and for Apple only an xcframework, a library with no
server binary. Running it on the Studio means compiling it from the
pinned tag and hosting the result as a Catalog release asset: a build
and signing pipeline we would own for one platform, beside a different
upstream artifact on the robot, and a second speech runtime next to
the one the robot already has. Whisper the model is not lost by this:
sherpa-onnx loads `sherpa-onnx-whisper-tiny.en` (118 MB) and
`base.en` (209 MB) from the same release, and either is the named
alternative for `stt` if the Studio bench shows Moonshine's English
accuracy is not enough. MLX Whisper is out for the same reason as
whisper.cpp's server plus a Python runtime.

### The `stt` worker: a spawned engine in every respect

`backend/src/speech/worker.ts`, a subcommand of the Stack's own
executable, `speech-worker --role stt --port <free> --model <dir> --vad
<file>`.
The supervisor builds the command the way the daemon itself was
started: under the installed service, where `launchd.ts` and
`systemd.ts` register the compiled binary and no source tree exists,
it is `process.execPath speech-worker ...`; from a checkout under
`bun run`, where `process.execPath` is `bun` itself and knows no
subcommand, it is `process.execPath Bun.main speech-worker ...`. One
helper in the supervisor decides, and the suite covers both branches,
because the dev-machine live pass runs the checkout branch and the
household runs the other. The worker loads the
runtime through `sherpa-onnx-node` (one adapter module,
`backend/src/speech/sherpa.ts`, the only file that names it), loads
the role's model package and the detector, and serves the role's wire
on loopback. To the supervisor it is exactly `llama-server`: a pid and
a port, the free-port probe, the liveness wait with the size-scaled
load timeout, `GET /health` answering `status: ok` and `GET /props`
with `build_info` and `model_path` (llama-server's own shape, so the
one identity reader serves both engines: `host: local`, `build:
sherpa-onnx-node-1.13.8`, `model: <package directory name>`), the
post-load check as a real request (the bundled clip), the measured
footprint after load recorded on the model record, the process watch
with restart on exit, a drain on stop that waits for a live session
too, and the governor's admission before launch with the 1.3 times
file-size estimate until measured. The worker's stdin is a pipe the
daemon holds; its end is the daemon gone, and the worker exits on it,
so a daemon that dies never leaves a worker on its port. A crash in
the worker takes one role's process and nothing else. A `url` binding
still works when a person runs a server of their own that speaks the
wire and the identity shape.

The worker is the only code we write for speech, and it stays thin: no
audio processing of its own beyond what the runtime provides. Two
facts from the earlier bench work are rules here. Moonshine tiny
returns an empty transcript when the buffer it gets starts with
roughly half a second of silence, so the worker keeps at most 0.3 s
of pre-roll before the onset the detector reports and, on an empty
result for a segment the detector called speech, retries once from
the onset. The robot's microphone array does echo cancellation on
chip and the Mac's browser capture does it in `getUserMedia`, so the
worker never adds its own; a speaker-loop echo reaching it is a
capture bug upstream, not something to mask here.

### `tts`: Pocket TTS, the owner's pick, as a managed engine

**Kyutai Pocket TTS** (`pocket-tts` 3.1.0 on PyPI, MIT, CPU only,
Python 3.10 to 3.14, torch 2.5 or later) is Home's `tts` by the
owner's own ear: `home/docs/dev.md`'s TTS model decision of
2026-09-04 live-tested it against Kokoro-82M, Chatterbox Turbo and
Nano, Dia-1.6B and CSM-1B, with Jesse judging the listening tests
himself, and it won on speed and quality (real-time factor 0.09 to
0.10 on the Mac's CPU against Kokoro's 0.57, and audio streaming from
its `/tts` route before the utterance finishes). **Kokoro is rejected
for the Stack's pin for the reason recorded there**, "no feel, doesn't
sound lifelike" on the legacy hub's shipped voice, and a better
benchmark score is not the question a person answers when they
listen. A design note here does not reverse a call that was his; if
he does, the pin is a one-line change and sherpa-onnx's Kokoro
package (`kokoro-en-v0_19.tar.bz2`, 319.6 MB, Apache 2.0) is the
alternative already loadable by the `stt` worker's runtime.

Pocket TTS is a Python package, and the Stack's own runtime rules do
not bend for it: no install outside `data/`, a pinned version, a
checksum, an update we choose. The way through is the one
`home/spec/voice/README.md` named for this design pass: **`uv` as a
pinned engine build.** astral-sh/uv 0.12.17 publishes
`uv-aarch64-apple-darwin.tar.gz`, `uv-aarch64-unknown-linux-gnu.tar.gz`
and `uv-x86_64-unknown-linux-gnu.tar.gz`; the Stack downloads the
machine's one into `data/engines/uv/<tag>` with its sha256 recorded in
`engineCatalog.ts`, and builds the engine's environment once under
`data/engines/pocket-tts/<version>/`: `uv venv --python 3.12`, then
`uv pip sync --require-hashes` from a requirements file we commit,
`backend/src/speech/pocket-tts.<platform>.requirements.txt`, compiled
with `uv pip compile --generate-hashes` on that platform (the Mac's
at 94c from the environment that passed the live check; a Linux
host's the first time one runs `tts`, because torch resolves to
different wheels and extra packages there and one file cannot serve
both with hashes on). That file is the environment's pin: every
dependency (torch is the bulk, a few hundred MB) by version and hash,
so two households on a platform install the same set and a rebuild
after the sweep cannot change behaviour; an update to it is a change
we make and release. The exact flags are verified against uv 0.12.17
by the commit that runs them, never copied from this note. The engine
is then `<venv>/bin/pocket-tts serve --port <free>`.
`UV_PYTHON_INSTALL_DIR`, `UV_CACHE_DIR`, `HF_HUB_CACHE` and `HOME` for
the child all point under `data/` (the last because Pocket TTS caches
any `http(s)://` voice it is handed under `~/.cache/pocket_tts`, which
Home's cloned voices reach it as), so the managed Python, the wheels,
the weights and the voice cache land in the data directory and
nowhere else, and the sweep and the uninstall find them.

The weights, and what the engine fetches on its own: the package pins
its own files in its config, each `hf://` path at its own revision
(`kyutai/pocket-tts` for the weights, gated behind a token, with an
ungated twin `kyutai/pocket-tts-without-voice-cloning` at its own
revision that it falls back to when the gated download fails; the
tokenizer from the ungated repository at that same revision; every
preset voice, `alba` and the rest, as a precomputed embedding in the
ungated repository at a third revision, which is why presets keep
working with no token, or with a wrong one once the files are cached;
a wrong token on a cold cache is a load failure the Stack reports,
because the hub refuses invalid credentials on the ungated fetch
too), and a community voice Home hands it as an
`hf://kyutai/tts-voices/...` WAV is downloaded and encoded through
the cloning path, which needs the gated weights and answers 500 when
the fallback loaded instead; the engine keeps a small cache of
encoded voices in memory on top of the hub cache.

**As landed at 94c:** the three ungated files the default English
config needs (the weights at `d29db797…`, the tokenizer at the same
revision, the `alba` embedding at `e81d79e8…`) are store pins in
`modelCatalog.ts` with their sha256, licence (CC BY 4.0, from the
repositories' own cards) and size, installed through the models
route like any model and placed by the store in the Stack's hub cache
at the pinned repository, revision and path (`download.hub_file`,
moved into the cache and held once), so the engine reads them there
and downloads nothing at first start; verified on 2026-09-20 with
huggingface_hub 1.32, which resolves a commit-hash revision from that
layout without a request. Stated exactly: the package tries the gated
weights first at every start, so each start is one ask to Hugging Face
for `kyutai/pocket-tts` (a HEAD with the token when one is set, refused
without one, then the pinned ungated file from the cache; bounded to
three seconds by `HF_HUB_ETAG_TIMEOUT` so a machine with no connection
starts in that time, not ten); that ask is the privacy row. Running
the engine offline would remove it but would also stop every preset
but the pinned one and every community voice, so the engine is never
run offline: with a token set it fetches the gated weights itself into
the same cache, and it fetches any preset or community voice on first
use. After the post-load check the supervisor reads which weights
snapshot the cache holds (the gated repository first when a token is
set) and the identity headers name that repository and revision, not
the config's first choice; the pinned record's repository and its
gated twin both satisfy the identity check, anything else does not.
The tokenizer and the voice are components of the role, installed
beside the weights and never selected. The first start on a machine
builds the environment (`POST /stack/v1/engines/pocket-tts/install`,
a job whose status is the phase: uv, python, packages) and the
engine's own load is inside the load timeout; the sweep keeps one
previous environment.

To the supervisor it is a `managed` engine, the ComfyUI shape: the
Stack starts it, waits for `GET /health` to say `healthy`, runs the
post-load check (one short phrase through `/tts`, the first bytes
back within the load timeout), records the measured footprint,
watches the process and restarts it on exit, drains and stops it, and
admits it through the governor first. Identity: `x-maipai-engine` is
`local pocket-tts-3.1.0`, `x-maipai-model` the weights repository,
`x-maipai-revision` the revision recorded from the cache. A `url`
binding to a `pocket-tts serve` a person already runs needs its own
probe, because the supervisor's reads `llama-server`'s `/health`
(`status: ok`) and `/props`, while Pocket TTS answers
`{"status": "healthy"}` and exposes no version or model route at all
(`/`, `/health`, `/tts`). 94c gives the identity reader a per-wire
probe for `speech` (a `/health` that says `healthy` counts, as
`ok` does), and the honest claim for such a binding is that its
identity cannot be verified: it is `ready` on health alone, its reply
headers carry the host alone (`x-maipai-engine: local`, model and
revision `none`), and a `stack.engines.tts.expected_version`
declaration is reported as unmet against an unknown build, never as
a match.

### The wire, from the spec, never a second definition

`stt` serves `POST /v1/audio/transcriptions`, the address the roles
table gives the role, with the form `spec/voice`'s transcribe route
takes (multipart `file`, nothing else), answering
`SttTranscribeResponse` (`{ text }`) from `spec/voice/ts/sttTypes.ts`:
16-bit mono PCM WAV in, resampled to 16 kHz by the worker when it is
not already. The streaming session is `WS
/v1/audio/transcriptions/stream` with that file's `SttWireEvent`
contract unchanged: the client sends binary frames, each a
little-endian `Float32Array` of 16 kHz mono samples with no envelope,
and may send one text frame `{"t":"end"}` to flush the utterance in
progress; the server sends only JSON events, `ready`, `vad` with
`speaking` and `rms`, `partial`, `final`, `no_speech` and `error`.
Home's `/api/stt/stream` becomes a pass-through to this session when
Home adopts the Stack. The Stack's Zod mirror of the event union lives
under `backend/src/spec/` with the other wire shapes until RF-05b
moves them to `shared/spec`, and the fixtures round-trip it the same
way.

`tts` serves `POST /v1/audio/speech`, the address the roles table
gives the role, with exactly the request and result `spec/voice`
already defines: `TtsSynthesizeRequest` as Pocket TTS's own multipart
form (`text`, optional `voice_url` naming a preset voice or a voice
URL), and `TtsSynthesizeResult`, a chunked `audio/wav` body whose
44-byte header carries the format (sample rate, channels, bits per
sample) with a placeholder data size because the length is unknown at
the first byte, then raw PCM until the stream ends. The Stack forwards
the form to the engine's `/tts` and streams the body back with the
identity headers added; no request shape is invented here, and an
OpenAI-shaped `model`, `input`, `voice` request is offered only if
the spec gains it first. `routes/v1.ts` today declares both audio
routes with a JSON `RoleRequest` body (`model`, `quality`, `stream`,
`timeout_ms`, plus `file` or `input`), a placeholder from the fresh
backend that no caller uses (Home still runs its own speech); 94b and
94c replace that declaration with the spec's forms before the first
caller exists, so the additive rule is kept. The `RoleRequest`
fields that mean something on these paths, `model` and `timeout_ms`,
travel as text fields of the same multipart form, the way the spec's
own form carries `voice_url` beside `text` and OpenAI's transcription
form carries `model`; `model` is optional here because each audio
path serves one role: `role-request.schema.json` requires it today
and the Zod mirror has `min(1)`, so 94b scopes that requirement to
the JSON wires in the schema, the mirror and the fixtures together,
not in a description (`quality` has no meaning here; both roles
declare none). Home's `PocketTtsClient` moves to the Stack by changing its
paths and its health probe (`/tts` becomes `/v1/audio/speech`, the
engine's `{ status: "healthy" }` becomes the Stack's role state), the
form and the streaming reply unchanged, with one seam to name: voice
cloning
needs the household's Hugging Face token, which Home today passes as
`HF_TOKEN` to the child it spawns and restarts on change. Once the
Stack owns the process, the token is a secret-kind setting on the
`tts` engine, `stack.engines.tts.hf_token`, encrypted at rest by
`@maipai/core`'s secrets and never returned by the settings route, a
`needs_restart` change the Stack applies with a restart; Home's
`/api/voice/hf-token` becomes a write to it. That line goes in the
adoption hand-off with the `SettingsKey` restriction. Home's
`streamingWavPlayer.ts` reads nothing but the format from the header,
so the first phrase is audible before the last is generated.
Phrase-level streaming is Home's sentence scheduler sending each
completed clause as its own request, with the text already through
Home's `normalizeForSpeech` (the Stack never normalizes; one
implementation, in Home). Cancel is the client aborting the request:
the Stack closes its side to the engine and the reply ends as a
normal end, never a retirement. Stated honestly: Pocket TTS does not
stop generating when the connection drops, so the rest of that
phrase's CPU is spent; on the Mac that is under a second per clause
at its measured real-time factor. The next phrase starts at once
(the server runs requests in parallel threads) but shares the CPU
with the abandoned generation and is not isolated from it: the
package documents its generator as not thread-safe on one model
instance, and the server holds one. 94c measures whether a
barge-in followed by the next clause stays under the first-audio
budget on the Mac; if it does not, the route stops closing its side
on abort and instead drains the abandoned reply to its end, dropping
the bytes, and starts the next phrase after it, because the engine's
wire (`/`, `/health`, `/tts`) offers no other signal that a
generation finished; the cost is at most that same sub-second. A
cancel that stops the runtime itself is the property sherpa-onnx's
callback has and Pocket TTS does not, and it is recorded here as the
one thing the owner's pick gives up.

Every reply from both roles carries the identity headers of
`spec/role-reply-headers`. For `stt`, `x-maipai-engine` is `local
sherpa-onnx-1.13.8`, `x-maipai-model` the model package name,
`x-maipai-revision` the package archive's sha256, because sherpa-onnx
publishes its model archives on rolling release tags (`asr-models`)
where an asset can be replaced under the same name: the checksum is
the pin, and a mismatch at download is a refusal and a deliberate
re-pin, never a quiet update. `ready` for these roles is time-bound
and identity-bound like every other (STACK-87).

### The pins

| Role | Package | Size | Where | Notes |
|---|---|---|---|---|
| `stt` runtime | `sherpa-onnx-node` 1.13.8 | 20 MB per platform package | `backend/package.json` and the lockfile | upstream's binding of the prebuilt library; rides the Stack's release and the monthly sweep (the 94b amendment) |
| `stt` | `sherpa-onnx-moonshine-tiny-en-int8.tar.bz2` | 107.6 MB | release tag `asr-models`, sha256 `d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2` | Moonshine tiny English, int8, MIT; Home's plan keeps this path; extracts to a directory the store keeps beside the archive |
| `stt` | `silero_vad.onnx` | 0.6 MB | release tag `asr-models`, sha256 `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` | the voice activity detector the session and the endpointer use, MIT; a component of the role, never a model a person selects |
| `stt`, alternative, named not pinned | `sherpa-onnx-whisper-tiny.en`, `base.en` | 118 MB, 209 MB | release tag `asr-models` | same runtime; pinned only if the Studio bench asks for it |
| `tts` runtime | `uv-<platform>.tar.gz` | 16.9 MB (macOS arm64), 19.0 MB (Linux arm64), 19.8 MB (Linux x64) | astral-sh/uv release `0.12.17`, sha256 `85f00cbd…`, `d636d1b6…`, `fa82fd8d…` in `engineCatalog.ts` | builds the venv (a managed Python 3.12, the hashed requirements) under `data/engines/pocket-tts/3.1.0/` |
| `tts` environment | `pocket-tts.darwin-arm64.requirements.txt` | 820 lines, 772 hashes | `backend/src/speech/` | pocket-tts 3.1.0, torch 2.11.0, numpy 2.5.3 and the rest by version and hash; the Linux files land with the first Linux `tts` run |
| `tts` | `languages/english/model.safetensors` | 219.0 MB | `kyutai/pocket-tts-without-voice-cloning` @ `d29db797…`, sha256 `be9c6b48…` | the weights, placed in the hub cache; the gated twin is fetched by the engine when a token is set |
| `tts`, component | `languages/english/tokenizer.model` | 59 KB | the same repository and revision, sha256 `d461765a…` | the tokenizer |
| `tts`, component | `languages/english/embeddings/alba.safetensors` | 6.2 MB | the same repository @ `e81d79e8…`, sha256 `69c32db6…` | the default voice; other presets and community voices are fetched by the engine on first use |
| `tts`, alternative, rejected by the owner's ear | `kokoro-en-v0_19.tar.bz2` | 319.6 MB | release tag `tts-models` | Kokoro 82M through the `stt` worker's runtime, if the owner ever reverses 2026-09-04 |
| `tts`, robot, not the Stack's pin | Piper or Kokoro through sherpa-onnx | | release tag `tts-models` | the robot's body speech process under STACK-17 decides; `bot/docs/dev.md` names Piper today and Pocket TTS on the Pi as the measured candidate |

`engineCatalog.ts` today holds one engine: its selectors
(`selectEngineBinary`, `installedEnginePin`, identity's
`installedEngineForMachine`) pick the first pin by platform and
architecture with no name filter, and `platform` knows `darwin` and
`win32` only. 94b adds `linux` and a `name` parameter to every
selector before the first sherpa-onnx row, and 94c the `uv` rows
after that, so a new pin can never be launched as `llama-server`.
The sha256 of every archive is recorded in `modelCatalog.ts` (and
`engineCatalog.ts` for `uv`) at the commit that first downloads it
(94b for the `stt` packages, 94c for `uv` and the weights), from the
bytes that commit verified, and each package's licence is read from
the file the archive carries, never assumed from the project's (the
Moonshine archive ships its MIT `LICENSE`). Memory: the estimate
before the first measurement is the 1.3 times rule on the file size;
the `stt` worker measured 239,387,872 bytes resident on the p16 laptop
after its post-load check (bun, onnxruntime and the int8 model
together; 300 MB before the entry point stopped loading the daemon's
own modules into the worker), recorded on the pin and in the
components inventory, and
Pocket TTS is estimated at 1 GB with torch resident until 94c
measures it. Both roles are `resident, small`, as the roles table
says.

### The chunks

94b (landed 2026-09-20): `sherpa-onnx-node` pinned in `package.json`;
the `speech-worker` subcommand with `--role stt`; the two `stt`
packages in the store (a package archive extracts beside itself, its
`modelPath` the directory); the route with the spec's form, the
streaming session and the Stack's websocket pass-through; the bundled
clip `backend/src/speech/fixtures/clover-two-seconds.wav` (16 kHz,
mono, 16-bit, 2.13 s of one persona-roster sentence, synthesized on the
dev machine with `say` and `afconvert` as its README records, checked
in, never household audio) transcribing in the suite through scripted
engines and live on this laptop through the real worker; the
readiness check probing `stt` with that clip.
94c (landed 2026-09-20): the `uv` pins per platform with sha256 and
the name-filtered selectors; the environment builder and its hashed
requirements file; the three hub-file pins; the `hf_token` secret
setting (encrypted at rest through `@maipai/core`'s secrets with a
keystore under `data/keys`, redacted to `set` on the settings route,
handed to the engine as `HF_TOKEN`); the managed launch with the
per-wire probe and the identity read from the cache; `POST
/v1/audio/speech` forwarding the spec's form and streaming the body
with cancel; the readiness check rendering the probe sentence; the
engines routes acting on each engine's own role. Out of scope for all
three: the wake word (installed, not served; its
own S item when a wake-word package exists in the Catalog), the
robot's managed body process (STACK-17), Home's sentence scheduler
and normalization (Home's), and speaker identification (the robot's
body, `bot/docs/dev.md`).

### `stt` proven live (94b, 2026-09-20)

`scripts/prove-stt.sh` on the p16 laptop (Apple M4 Pro, 24 GB), a
clean scratch data directory on port 8771, through the public routes:

| Step | Result | Time |
|---|---|---|
| Install `silero-vad` | job done, sha256 verified | 0.60 s |
| Install `moonshine-tiny-en-int8` (107.6 MB, real download) | job done, sha256 verified, extracted to `models/moonshine-tiny-en-int8/sherpa-onnx-moonshine-tiny-en-int8/` | 5.89 s |
| `stt` before the first request | `installed` | |
| `POST /v1/audio/transcriptions` with the bundled clip | HTTP 200 `{"text":"Clover, the kitchen light is on."}`, `x-maipai-engine: local sherpa-onnx-node-1.13.8`, `x-maipai-model: sherpa-onnx-moonshine-tiny-en-int8`, `x-maipai-revision: d5fe6ec4…` | 1.10 s including the worker's load on the first run of the day (0.49 s on a warm OS cache) |
| The same request, loaded | HTTP 200, the same transcript | 0.04 s |
| `stt` after it | `ready`, identity ok (expected and actual `sherpa-onnx-moonshine-tiny-en-int8`), measured footprint 239,387,872 bytes | |
| `POST /stack/v1/check` | ok, `stt` ok (the clip's transcript), fit-together ok | 0.05 s |
| `WS /v1/audio/transcriptions/stream`, 0.5 s of silence, the clip in 1024-sample frames, 1 s of silence | `ready` at 7 ms; `vad speaking` at 16 ms; `vad` off and `final` "Clover, the kitchen light is on." at 34 ms (an earlier run, with the frames paced by a slower decode, showed the partials "Clover.", "Clover, the kitchen lighting," and the full sentence on the way) | |
| The worker | the Stack's own child, `speech-worker --role stt`, 308,128 KB resident | |
| Stop | port free, scratch removed | |

The first run of the script found the readiness check skipping the
transcription wire (a "skipped" result the run counted as not green);
the check now probes it with the clip like a completion, with a
regression test.

### `tts` proven live (94c, 2026-09-20)

`scripts/prove-tts.sh` on the p16 laptop (Apple M4 Pro, 24 GB), a
clean scratch data directory on port 8771, through the public routes:

| Step | Result | Time |
|---|---|---|
| `POST /stack/v1/engines/pocket-tts/install` | job done: uv 0.12.17 downloaded and verified, a managed Python 3.12, the 772 hashed wheels synced (`engines/uv` 647 MB with its cache, `engines/pocket-tts` 535 MB) | 6.2 s |
| Install the tokenizer, the `alba` voice and the weights (219 MB, real downloads) | jobs done, sha256 verified, each placed in `models/hub/models--kyutai--pocket-tts-without-voice-cloning/snapshots/<revision>/languages/english/...` | 0.60 s, 0.59 s, 3.27 s |
| `tts` before the first request | `installed` | |
| `POST /v1/audio/speech` with the probe sentence | HTTP 200, `audio/wav`, 24 kHz mono 16-bit, the placeholder data size 2,000,000,000 in the header and 105,600 bytes of audio (2.2 s), `x-maipai-engine: local pocket-tts-3.1.0`, `x-maipai-model: kyutai/pocket-tts-without-voice-cloning`, `x-maipai-revision: d29db797…` | first byte 11.9 to 14.3 s across three runs, the engine's start (torch and the model) inside it, total about 0.2 s more |
| The same sentence with `voice_url=alba`, loaded | HTTP 200 | first byte 2 ms, total 183 ms |
| `tts` after it | `ready`, identity ok (the pinned repository loaded), measured footprint 828,868,000 bytes | |
| A render aborted by the client after 50 ms, then another | the abort a normal end; the next render HTTP 200 with first byte 2 ms; `tts` `ready` | |
| An unknown voice | the engine's own 400 passed through (`voice_url must start with http://, https://, or hf://`) | |
| `POST /stack/v1/check` | ok, `tts` ok (the probe sentence rendered), fit-together ok | 0.20 s |
| A second `POST /stack/v1/engines/pocket-tts/install` | a job that finds the environment built and finishes at once (a request during a build joins the build's job; the suite covers the guard) | |
| The engine | the Stack's own child, `pocket-tts serve` from the venv, 976,752 KB resident; its caches under `data/home/.cache` and `data/models/hub` | |
| Stop | port free, scratch removed | |

The first run of the script found the models route ignoring a shipped
pin's `hub_file` placement when the body left it out, so the files
landed in the plain store and the engine fetched its own copies (the
first byte then 15.7 s); the route now completes a body from the
Stack's own pin as it does from the Catalog's index, with a test.

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
   Stack. `bot/docs/dev.md` today keeps STT and TTS in the body's one
   sherpa-onnx process; the two agree if that process is the `managed`
   engine serving the `stt` and `tts` roles, which is how the speech
   design note (STACK-94a) reads it, and STACK-17 settles it. The
   robot design pass confirms or amends this in `bot/docs/dev.md`.
2. **The second engine.** `mlx-serve` and `oMLX` are the Mac
   candidates beside `llama-server`; the Studio bench decides which
   gets the second adapter.

## Battle-tested checklist (for 1.0, empty until earned)

The Stack leaves 0.x with Home: when it has run the household hub for
a season without an unplanned restart, survived every update with
rollback proven at least once, and its measured profiles have matched
what a fresh install sees on three machines it has never seen. The list
grows here.
