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

The household chat pin is Qwen3 8B on p16 (a 16 or 24 GB machine). From
p32 upward it is Muse Glimmer 30B (STACK-MUSE-01 below, owner's rule
2026-10-16): the 17 GB Q4_K_M on p32, the KQuant-Dynamic Q4_K_XL on p64
and p128. On p16 the judge uses the chat model and process because a
separate 4B judge would need about 3.76 GiB after chat, leaving less
than the 4 GiB working margin under the governor's free-memory check.
From p32 the judge has its own Qwen3 4B pin and process; profiles below
p16 keep the shared 1.7B chat.

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
- **No people, no clients, no keys.** The Stack listens on loopback only. Its one caller is the household's paired Home, on the same machine or on another computer in the same home that reaches this machine's loopback through the SSH link Home's installer sets up, with a key that can open this one port and nothing else. That other computer is on the household's home network or, only when an admin turns it on, on the owner's own Tailscale network; the SSH key and the pinned host key are the only authentication either way, never Tailscale access rules. Those keys belong to the operating system's SSH service and to Home, never to the Stack.
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
settings declaration, the precious-state declaration) are pinned in
`@maipai/spec` (tag `spec-v0.1.2` in `getmaipai/commons`) and imported
by the backend from the package; the only Stack-local wire shape is the
voice (`backend/src/wire/voice.ts`). The engine and model catalogs
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

On p16 and larger profiles, chat uses the household's pinned Qwen3 8B
and judge runs the pinned Qwen3 4B in its own llama-server process.
Without a detected p16 profile, judge shares chat's Qwen3 1.7B process.
The profile bindings live in `backend/src/profiles.ts`; Studio bench
results can later select different models for other machines.

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
  STACK-13b decides). Same lifecycle, its own process.
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
process memory after load (recorded on the model record, replacing the
estimate, and raised while the run's peak rises), idle unload after the declared idle minutes (shorter on
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

The `embed` role uses Nomic's `nomic-embed-text-v1.5` Q4_K_M GGUF,
pinned to the Hugging Face revision and checksum for the file Home
already runs. Like speech, it is a regular catalog model: once installed
and verified, the role selects its first compatible model automatically.

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
and never trusted until its own digest and licence are recorded. File
digests use one SHA-256 helper that streams 16 MiB chunks, so hashing a
large local model never reads the whole file into memory.

### The governor

The governor is the sole owner of admission for the processes the Stack
launched. The profile names the resident set and the on-demand set;
until the first measured load, a model's peak is estimated as file size
times the engine's multiplier (1.3 for llama-server, 1.4 for the MLX
servers) and labelled estimated.

Admission reads available memory now (free memory plus what the kernel
gives back without compressing a working set; one definition, below)
and the requested peak. A load starts only when available memory minus
the requested peak leaves the profile's working margin (4 GB on p16, 8 GB on p32, 12 GB on p64, 20 GB on p128)
and the loaded total stays under the cap (total memory minus the OS
margin, 8 GB by default, declared as `stack.memory.model_budget_bytes`). Only one
generator runs at a time; a request that cannot be admitted enters a
queue of four with a position, or is refused with a reason. Three
refusals of the same request raise `admission-refused-repeatedly`.

The cap is the smaller of total memory minus the OS margin and Metal's
recommended working set, read once at daemon start from
`llama-server --list-devices` (the first number on the Metal line, MiB).
On a measured 24 GB Apple silicon laptop it was 18,186 MiB (74 percent),
which llama.cpp and MLX agree on; there, the OS-margin rule is smaller.
An unreadable value leaves the OS-margin rule in effect.

The queue drains on a memory change: after each poll the governor
re-admits its queue head, and only when the reading moved in the
direction that can admit, pressure back to normal or free memory
rising above the low-water floor it was below, and never on a poll
where nothing changed. One re-admission per poll; a head that still
cannot be admitted stays at the head. A queued request returns a
promise the caller can await instead of watching the loaded set, and
`withdraw` removes it before admission and settles the promise
refused.

Eviction reads idle time, pin state, kernel pressure and process
memory. A JIT model unloads after `idleTtlSeconds` (600) plus any
`keep_alive`; under pressure the least recently used unpinned JIT model
unloads first; a pinned model never unloads. A resident model restarts
when its process memory exceeds 1.3 times this run's own post-load
reading plus 500 MB for three polls (the runaway watch); a figure an
earlier run stored never arms the watch, and the restart waits for the
engine's requests in flight to finish unless the kernel reports critical
pressure. The pressure event names the reading and the limit
(`process_bytes`, `limit_bytes`). A healthy reading above the run's
peak raises the admission peak, and each rise of 64 MiB or more is
written to the model record, so the next admission and fit plan start
from the latest run. Critical pressure aborts the in-flight generator. The poll
is every 5 s idle, every 1 s during a load. The governor keeps a bounded
in-memory ledger of its newest 200 decisions with the reason for each,
served on the budget route; nothing about decisions is persisted.

**The kernel's ledger.** The governor reads one `MemoryReader`:
`{ totalBytes, availablePercent, pressure: normal | warn | critical,
freeBytes, processMemoryBytes(pid) }`. On macOS, `hw.memsize`,
`kern.memorystatus_level`, `kern.memorystatus_vm_pressure_level` (1
normal, 2 warn, 4 critical) and `host_statistics64` (available memory,
defined below) through `bun:ffi` against `libSystem.B.dylib`,
and `proc_pid_rusage` with `RUSAGE_INFO_V4` for process memory (below);
every failure keeps the previous reading and raises a warning health
item. On Linux, `MemAvailable` from `/proc/meminfo`, PSI memory `some
avg10` above 10 as warn and above 50 as critical, `VmRSS` from
`/proc/<pid>/status` (which already counts mapped files). Kernel warn or critical is always the soft or
hard watermark regardless of arithmetic; the arithmetic watermark is
free memory below 10 percent or 1 GiB for two polls. `os.freemem()` is
not used: it reported 0.09 GB on a Mac the kernel called 61 percent
free. Windows has no reader until it can be tested on Windows.

Before a first load, the dry-run path checks the pinned llama.cpp
archive for `llama-fit-params` (the b10797 macOS archive contains it)
and uses its fit result for admission on a model's first load, for
llama-server and GGUF files only, with a 30 second limit and null on any
failure; admission prefers measured peak, then dry run, then file size
times the engine multiplier. After a successful post-load check, the
measured process memory replaces the estimate.

**Process memory, one definition (STACK-PROCMEM-01, 2026-10-06).** Every
measured peak, the post-load measurement and the runaway watch read one
figure, `MemoryReader.processMemoryBytes(pid)`: the process's resident
set including the model weights it memory-maps, never less than the
kernel's own charge for it. On macOS that is the larger of
`ri_resident_size` and `ri_phys_footprint` from the same
`proc_pid_rusage` call (one syscall, no spawn); if that call fails, the
fallback is `ps -o rss=`, the same resident size at the cost of a spawn.
The footprint alone, used before this date, leaves out the clean
file-backed pages of an mmap'd GGUF: the live chat engine (Qwen3-8B
Q4_K_M, context 40,960, llama.cpp b10797, the p16 laptop: Apple M4 Pro,
24 GB) had recorded 3,379,206,840 bytes while about 7.9 GB was resident,
and the watch restarted it twice on ordinary use. Read on the same engine
on 2026-10-06, read only:

| Reading | Bytes | What it counts |
|---|---|---|
| `ri_phys_footprint` (the old figure; `footprint -p` 3,333 MiB) | 3,495,172,816 | dirty and compressed anonymous memory, Metal buffers; not the mapped GGUF |
| `ri_resident_size` (`ps -o rss=` 8,186,352 KiB) | 8,382,824,448 | everything resident, the mapped weights included |
| `vmmap --summary` resident, a minute later | 8.1 GiB, of which mapped file 4.7 GiB and shared memory (Metal) 3.0 GiB | the same, by region |
| `vmmap` swapped (compressed) | 219 MiB | in the footprint, not the resident size |

The larger of the two rusage figures is the resident size whenever the
weights are mapped, and the footprint whenever the kernel has compressed
more than the mapped weights hold (a Metal or MPS process with nothing
mapped, ComfyUI among them). It still misses the compressed part while
weights are resident (219 MiB here); the exact sum (footprint plus the
resident mapped-file pages) needs a per-region walk or `task_info` on
another task, which an unprivileged process cannot get, so the cheap
figure is the one used. Figures stored under the old definition are
upgraded once at start (`models.measured_memory_definition` in `meta`
names the definition in force): a GGUF model's figure gains its file
size, the mapped weights it left out (the 8B chat: 3,379,206,840 plus
5,027,783,488 is 8,406,990,328 bytes, against 8,382,824,448 read live),
so its next admission is near the truth instead of falling back to the
11.5 GB dry run, which with the p16 working margin of 4 GB would need
15.5 GB free to start; other figures are kept (those engines hold their
weights in their own memory, which the footprint counted). Each model is
measured again at its next load. The 1.7B chat pin's 414,550,392-byte
figure was withdrawn for the same reason.

**Available memory, one definition (STACK-AVAIL-MEM-01, 2026-10-06).**
`MemorySnapshot.freeBytes` (the name is older than the definition) is the
memory a new load can have without the kernel compressing or swapping
memory something is using. On macOS it is computed from one
`host_statistics64` call as free pages plus the larger of two exact counts:

- the file-backed cache (`external_page_count`: clean file pages on the
  active, inactive or speculative queue, which the kernel drops and can
  read back) plus purgeable pages (volatile anonymous memory it
  discards). This is Activity Monitor's "Cached Files", the count XNU's
  own available-pages figure is built on, and the macOS twin of the
  `MemAvailable` the Linux reader uses;
- the inactive and speculative queues, the next pages the kernel
  reclaims under pressure, file-backed or not.

The two are not added, since file pages on the inactive and speculative
queues are in both (speculative pages are always file-backed: on the live
machine active + inactive + speculative was 506,226 pages and internal +
external 506,226). Active anonymous memory and the compressor are never
counted: admitting against them means compressing a working set, which is
memory pressure. `kern.memorystatus_level`, the "free percentage" that
`memory_pressure` prints, counts active memory too (free + active +
inactive + speculative, checked page for page), so it is shown as
`availablePercent` and never used to admit. The pressure guard is unchanged:
kernel warn or critical, or the arithmetic watermark, queues every
admission whatever the figure says.

The reader before this date added free, inactive and word 13 of
`vm_statistics64_data_t`, which is the high half of the 64-bit `faults`
counter (purgeable is word 22, speculative word 23), so it missed the file
cache on the active queue and all speculative pages. On 2026-10-06, with
the honest 8B chat figure from STACK-PROCMEM-01 (8,436,858,360 bytes), the
p16 laptop could not start chat: "needs about 7.9 GB with 8.2 GB free",
while `memory_pressure` said 69 percent free, pressure was normal and about
16 GB of file cache was reclaimable. The chat needs 8,436,858,360 bytes
plus the 4 GiB p16 margin, 12.73 GB available, to start.

| Reading on the p16 laptop, 2026-10-06 | Old figure (free + inactive + word 13) | Available (this definition) | `memory_pressure` free |
|---|---|---|---|
| The event (chat stopped, sums from the coordinator's reading) | 8,800,010,240 B (8.2 GiB): chat queued | 16,449,994,752 B: chat admitted, 7.5 GiB left after it, 3.5 GiB over the margin | 69 percent |
| Live, chat (8B) and embed loaded, Home's gate running | 4,832,559,104 B | 4,867,653,632 B (the inactive queue is larger: the file cache, 2.8 GB, is smaller than the 4.7 GiB of weights the chat holds resident, so Metal has wired them out of it) | 35 percent |
| Live, 20 minutes later, same load | 4,154,212,352 B | 4,370,923,520 B | 30 percent |

Figures stored by an older build after the definition mark (a rollback)
are caught at start too: on macOS a GGUF model's figure below its own file
size cannot be a process-memory figure (the resident set holds the mapped
weights), so it gains its file size. The rolled-back Stack stored
3,406,895,800 bytes for the 8B chat under the mark; the next start on this
build reads 8,434,679,288. A Linux figure is never second-guessed, since
`VmRSS` always counted mapped files.

Both rules lean on one fact of the Apple silicon launch: llama-server runs
with `-ngl all`, so Metal wires a loaded model's weights and they leave the
file cache. An engine whose mapped weights stay unwired (a CPU-only or
partial-offload launch on a Mac) would leave them in the file cache, where
available memory counts them as room for another load, and its resident
figure could sit below the file size and be raised at the next start.
Neither path runs on a supported Mac today; STACK-AVAIL-MEM-02 holds the
fix for when one does.

On the robot, the body's power and thermal budget is an additional
admission input with the same thresholds and actions (Bot's GOV-01).

A failed probe is a degraded reading, never a fake full-memory event:
every reader flags it with `degraded: true` on the snapshot (the last
good reading's numbers, or all memory free before any success, and the
probe's error), and the governor treats it as no reading at all. A
degraded poll changes no state that an admission or an unload decision
reads; free bytes, the breach count and the pressure keep their previous
values. It sets a `memoryReadingDegraded` flag on the status object and
raises the warning health item `memory-reading-unavailable` once, which
the next successful read resolves. While the reading is degraded the
governor refuses admission of a new load with the reason "The memory
reading is unavailable." and touches nothing already running; a release
during a degraded reading frees the handle's accounting but leaves the
queue untouched, so the next good read drains it through the c-84 path
rather than refusing the head.

Rejected: a static reservation (ignores current pressure and measured
peaks); an OS-level cap (macOS gives no clean native RSS cap for a
spawned child); letting each engine decide (cannot enforce one budget
across engines).

### Jobs

Image, video, music and long TTS renders are jobs: `POST` returns a job
id, progress arrives on the event feed, cancel works, and the result is
fetched by id. ComfyUI's queue is the model and, for image editing, the
engine. `/v1/images/generations` is the job API with a wait, for simple
callers. The job shape is the spec's `StackJob`
(`@maipai/spec`, STACK-13a): id, kind, role, state, percent, the
byte counts, optional smoothed bytes per second and per-file progress,
a status phrase, the queue position, the input, the result, the reason,
the clocks. Model and engine downloads report each pinned file through
the same job and event feed; a stalled transfer keeps its `.part` file
and can be resumed by restarting the download.

The queue (STACK-13a, 2026-09-20): a generator kind registers its
runner with its role and a memory estimate for a job; a submit for it
creates the job `queued` in that role's queue, one job in flight per
role, in submission order, each queued job carrying its 1-based
position and renumbered as the queue moves. When a job's turn comes the
queue asks the governor to admit it as a `generator` request (the
estimate, or the measured peak once one exists): the governor holds
one generator at a time across every role and the memory budget's say.
A peak the budget can never hold (more than the models cap, computed
the way the governor computes it: the measured peak, else the model
file times the engine's multiplier, else the requested bytes) is
refused at once with both numbers in the reason and the job fails,
never waits. A request the governor queues (another generator running,
pressure, no room now) leaves the job `running` with the status
`waiting for memory (n ahead)`, told on the feed as the position
moves; the governor admits a queued request on a later release without
telling anyone, so the queue watches the governor's loaded set for the
job's admission every 250 ms. A job cancelled while waiting frees its
role at once (the next job runs) and leaves a watcher behind that
releases the admission if the governor grants it later, so a phantom
generator never blocks the roles. A request the governor refuses (its
queue full, the Stack paused) fails the job with the governor's own
recorded reason. The run itself gets the job, an abort signal (cancel
aborts it) and a progress callback, and its admission is released
however it ends; then the next job in the role's queue runs. Downloads
and installs created by other modules are jobs too, driven by those
modules, never queued here.

One governor fact the queue works around rather than owns: the
governor drains its queue only inside a release, so a request it
queued for pressure or the working margin, with nothing loaded, would
wait forever after memory freed. The wait (`backend/src/lib/admission.ts`,
shared with an engine start since STACK-13b) therefore, when its
request sits in the governor's queue, nothing it waits on is loaded
and pressure is normal, releases a handle the governor does not hold,
its one public way to re-run the queue head, no more often than the
governor's own poll interval, so the "work is waiting for memory"
warning the governor raises after three refusals still means a real
wait; a given-up wait's watcher kicks only while a live wait sits
behind its phantom, so a phantom at the head never holds a live
request and a lone phantom never raises the warning. A kick that
still cannot admit the head moves that request to the back of the
governor's queue, so the order among waiting requests rotates until
one fits: a known limit of the workaround. The governor draining on
memory changes itself, with a callback the caller can wait on, is
STACK-06c in the backlog; when it lands the kick and the poll go.

`/v1/images/generations` submits and waits up to `timeout_ms` (two
minutes unsaid) and answers in OpenAI's image shape with the job id,
`data` holding one `{ b64_json }` per image from the runner's result;
past the deadline it answers 202 with the id and the render goes on
(Home fetches it by id); a render that failed inside the generator
answers 500 with the reason (the generator's error, never the
no-engine 503 a client backs off from), a cancelled one 499. With no generator installed the route is the
honest 503 and a submit is refused with the reason. The scripted
sidecar in `tests/generatorQueue.test.ts` drives all of it; ComfyUI as
the real image generator is STACK-13b.

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
back; for an engine other than llama-server the code is
`failed-swap.<name>` and the fix rolls that engine back, STACK-93);
the previous build is kept until the next update. A model update
is a new revision beside the old under the same rule and is never
applied without Home's explicit call. Engine version state is derived,
never stored: the running build, the store's `current` tag and the
newest pin for this machine agree (`current`) or do not (`notCurrent`
with `newer installed` or `newer available`); `needsRestart` is true
while a pending setting differs from the one in effect.

The chat engine setting `context_length` defaults to `0`, which selects the largest context admitted by the fit plan up to the model's trained context. A positive owner setting is used as-is; the governor still makes the final memory admission decision.

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
`.cache_ram_mb`, `.flash_attention`; a llama-server role's
`stack.engines.<role>.gpu_layers`; a `url` binding's
`stack.engines.<role>.host_url` and `.expected_version`) are part of
the same declaration under their engine's section. Home never
duplicates a Stack setting; it renders the declaration and persists the
person's choice through the Stack's route.

#### Where a role runs: `gpu_layers` (STACK-EMBED-02)

`stack.engines.chat.gpu_layers`, `.embed.gpu_layers` and
`.vision.gpu_layers` are one declaration (`GPU_LAYER_ROLES` in
`settings.ts`), a select of `all` (the default, `-ngl all`, which the
Apple/Metal path keeps) or `0` (`-ngl 0`, the processor). A restart key.
A role set to `0` is planned against system memory (the governor's model
budget), never against the graphics card's free memory: `placedOnProcessor`
in `fitPlan.ts` clears the device budgets and `contextForLaunch` reads the
processor-side gguf-parser estimate. That estimate is taken for any dense
architecture, because the `VERIFIED_ARCHITECTURES` list vouches for the
graphics-side figure only (the embed model is `nomic-bert`, which is not on
it). The governor's dry-run peak for such a role is the same processor-side
figure. Cause of the original refusal on the Stack box: free graphics memory
(1.9 GB) was the budget, the architecture was unlisted so the estimate was
dropped, and the installed record's `size_bytes` was 0 so the file-size
fallback had nothing to read. The size is now filled on install (the
catalog's figure, else the file on disk) and `reconcileModelSizes()` repairs
a null or 0 record at every start. Refusals come from `fitRefusalMessage`:
what went wrong, then the next step.

### Sizing and profiles

The hardware probe reports platform, arch, total RAM, CPU count, Apple
silicon and unified memory, CUDA devices with VRAM, free disk and OS
version, cached for five seconds. Four profile tiers (`p16`, `p32`,
`p64`, `p128`, by unified memory on Apple silicon and summed total VRAM
across supported CUDA cards elsewhere) name each role as resident, on demand, installed only or not
available; `proposeProfile` picks the highest tier the machine clears.
Home words the tier for a person; the Stack reports the facts. The
tier is also the governor's: the daemon sets it from the hardware
profile at start (`setMachineTierFromHardware`) and every memory watch
a spawned process gets carries it, so the working margin the governor
keeps back for the rest of the computer is the tier's own (4 GB on
p16, 8 on p32, 12 on p64, 20 on p128; STACK-06e, 2026-09-20; before it
nothing passed a tier and every machine ran the p16 margin). A machine
whose profile is unknown keeps the p16 margin, the smallest.

| Platform | Engines | First customer |
|---|---|---|
| macOS, Apple silicon | `llama-server` Metal (baseline), `mlx-serve`, `oMLX`, ComfyUI (managed), sherpa-onnx for `stt` and Pocket TTS for `tts` (STACK-94b, 94c) | MaiPai Home on the Mac Studio |
| Linux, ARM and x64 | `llama-server` (CPU, CUDA, or the accelerator the robot carries), sherpa-onnx for speech, ComfyUI where a GPU exists | MaiPai Bot |

### Fit planning versus admission (2026-09-30)

Two different questions are both called sizing, and they must never
share a number source. **Admission** asks "may this process start now",
and a wrong yes takes down the family's chat, so it is answered from
measured facts. **Planning** asks "would this model fit this machine at
this context, before anything is downloaded", and can only be answered
from what a file's header says, so it is an estimate and is labelled as
one. If the two are mixed, a header estimate leaks into admission and
the "never file sizes" rule quietly stops being true (it already has,
see "Where the docs and the code disagree" below).

Owner decision, 2026-09-30: a person gets a fit verdict for any model,
including one the Catalog has not pinned and measured, before they
download it. Planning therefore has to work from headers alone.

**Sources, in order.** Admission reads, first, the measured peak of the
last load; second, for a GGUF file already on disk, `llama-fit-params`
(llama.cpp's own dry run, shipped in the pinned b10797 archive); third,
only for an engine with no dry run, file size times the engine's
multiplier, labelled estimated. Planning reads a measured record when
the Catalog carries one for that pin, and otherwise a header estimate
with its source, a range and a date. A planning number never enters
admission.

**GGUF planning tool.** `gguf-parser-go` (MIT, GPUStack) reads a GGUF's
header from a local file or over HTTP range requests and estimates RAM,
VRAM and KV cache at a chosen context, KV cache type, flash attention
setting and offload. The Stack runs a pinned release as a subprocess,
the way it runs `llama-server`: exact tag and URL, our own recorded
sha256 (the project publishes no checksum file), an MIT line in
NOTICE, and its JSON output parsed, never its text table. Its one
outbound call, the range request to the model's host, is declared on
`GET /stack/v1/privacy` like the model download it precedes.

The route `POST /stack/v1/fit-plan` takes a Hugging Face `.gguf` URL or
a path in the model store, a context length and a KV cache type, and
returns the spec's `StackFitPlan`. A fit-plan request with no estimator
installed answers unknown and raises the health item
`engine-missing.gguf-parser`, whose one fix installs the pinned tool. The
privacy row names the content host Hugging Face redirects to,
`us.aws.cdn.hf.co`.

When a Hugging Face repository has no safetensors but has GGUF files,
the plan skips names containing mmproj or imatrix, later shards of split
models, and draft-head files ending in -mtp.gguf when another candidate
exists. A draft-head file is allowed when it is the only candidate. Files
under 100 MB are never candidates. It prefers the first whole-segment
match in this order: Q4_K_M, Q4_K_S, IQ4_XS, Q4_0, Q5_K_M, Q5_K_S,
Q3_K_M, IQ3_S, Q8_0, IQ3_XXS, IQ2_S. If none match, it uses the smallest
remaining file, and if no candidate remains it returns unknown. The
selected file is checked the same way as a direct GGUF link.

Every fit plan also carries `model_file_bytes` when the Stack knows the
file's size: from the GGUF parser, the selected repository file listing,
the MLX weights total, or the size of a file already in the store. It
omits that field when the size is unknown, including when the model
family has no verified memory estimate.

The first GGUF plan on a fresh Stack installs `gguf-parser` itself. If it
cannot, the plan is all unknown and its `tool` says `not-installed`. An
MLX repository that does not exist is a 404; everything else that cannot
be read stays unknown.

**The KV cache type.** `full` means f16, `quantized` means q8_0, and
`auto` means the platform default: q8_0 on macOS and f16 elsewhere. The
plan defaults to the type the Stack really launches. The person-level
setting `chat.kv_cache_override` is not read by the Stack yet;
`mlxKvQuantFor` and `mlxServeArgs` hold the MLX rule and flag plumbing,
and the setting is wired at STACK-16.

The plan judges capacity: the governor's first condition, the loaded roles plus the candidate within the cap, with the current chat model unloaded. Free memory right now is admission's second condition and is not in the plan, because a plan that changed with every open browser tab would tell a person a small model "won't fit" (SIZER-E2E-01, the first real run, found exactly that). A "yes" can still queue at admission on a busy computer. A full every-role-of-the-profile sum waits until each role has a pinned model and STACK-SIZE-01's per-role choice.

The spec vocabulary in spec-v0.1.60 now names all thirteen Stack roles. A
loaded role the spec does not name yet still counts toward the total but is
not listed in the plan, so the response always fits the schema.

**MLX planning.** The plan's high figure is exactly what admission uses
(file size times 1.4 plus the headroom); the low figure uses the measured
idle factor 1.27 and the low KV factor 1.9. Weights are the sizes of the
repository's top-level safetensors files from Hugging Face's tree API; the
KV term comes from the repository's `config.json`. Only verified
architectures (`qwen3` today) get a number, and every non-Apple machine is
unknown. The tokenizer and other small files are not counted (about 14 MB
for the pinned model).
`POST /stack/v1/fit-plan` also takes `{ source: { repo, revision? } }` for a
Hugging Face MLX repository; its plan always uses an unquantized f16 KV
cache until STACK-SIZE-11; an MLX request never raises the estimator health
item.

Measured against `llama-server` b10797 on a 24 GB Apple silicon laptop
(Metal, `gguf-parser-go` v0.26.4, Qwen3 1.7B Q8_0 and Qwen3 4B Q4_K_M,
contexts 4096 to 32768, KV f16 and q8_0, flash attention on and off, 12
runs): the estimator's KV cache matched the server's KV buffer to within
0.4 percent (exact to the byte in most runs, and equal to the formula
layers x KV heads x (key length + value length) x context x bytes per
element); its full GPU footprint ran 4 to 13 percent above the
server's real total, never below; its RAM figure ran about 330 MiB
above, near constant. All twelve are dense models. Mixture-of-experts,
sliding-window, multi-GPU and CUDA are unmeasured.

**MLX and safetensors planning.** `gguf-parser-go` reads GGUF only. For
an MLX model the Stack computes the same arithmetic itself: weight bytes
from the safetensors headers (or the file sizes), KV bytes per token
from `config.json` (layers x KV heads x head dimension x 2 x element
size). The measurements say this cannot be a flat multiplier. With
`mlx-serve` v26.9.4 and Qwen3 1.7B 4-bit, idle memory was 1.23 GB
(1.27 times the weights file) at every context setting, because MLX
allocates as the context fills instead of at load; while answering, the
peak footprint reached 2.37 GB at 3,460 prompt tokens, 4.99 GB at
13,876 and 7.36 GB at 27,736, which is 1.9 to 2.9 times the simple KV
formula and 7.6 times the file size at the longest. The 1.4 multiplier
in "The governor" above was checked at short context only.

An isolating run (nine loads, same model, same requests) separated the
causes. Turning the hot prefix cache off (`--prefix-cache-entries 0`)
did not change the peak (within 0.1 GB at 4K and 16K, 26 MB higher at
32K), and a smaller prefill chunk (`--prefill-chunk 2048`) changed
nothing measurable, so neither is the peak's cause. The cache does
change what stays resident after a request: at 32K the footprint five
seconds after the response was 5.47 GB with the default cache and 3.32
GB with it off, so the cache's 2 GiB budget sits in memory between
requests. `--kv-quant 8` cut the peak growth by 1.17 GB at 16K and 1.47
GB at 32K (about a quarter). With the cache off the peak growth was
still 1.9 to 2.7 times the simple KV formula, falling as context grew,
which points at a transient during prompt processing that this one
model cannot explain. Until more models are measured, an MLX plan for a
Qwen3-class dense model uses idle at 1.27 times the weights plus the
observed peak (up to 2.9 times the KV formula), labelled estimated with
that range, and any other MLX architecture is unknown. The launch
now caps the prefix cache at 1 GiB (`--prefix-cache-mem 1024MB`), and an
MLX model is admitted at its base estimate plus a headroom (the cache
cap plus 2.9 times the f16 KV formula at the launch's context length,
from the model's own `config.json`; a model whose architecture is not
verified gets the cache cap plus 2 GiB), and the process watcher's
baseline includes the same headroom. All constants come from one
measured model and the Studio bench (STACK-14) confirms them for other
architectures.

**Verdict shape.** RigSpark (MIT, github.com/shashankswe2020-ux/rigspark,
read for design only, none of its code or data used) gave the shape of
a useful answer, and it is adopted: a verdict of yes, slow, no or
unknown with the bottleneck named (memory, disk or context); the
shortfall in bytes when it does not fit; one plan per execution path
(unified memory, one GPU, several GPUs, CPU offload, CPU); every
figure carrying its source, a range and a date; unknown stays unknown.
Its memory rules (a 2 GiB reserve and 15 percent headroom) are not
adopted: the governor's OS margin and the tier's working margin are
the one definition. "Slow" means the CPU-offload path.

**Architectures.** `qwen3` and `llama` are verified for dense files.
Llama was measured on Llama 3.2 3B Q4_K_M in six real loads at 4096,
16384 and 32768 with f16 and q8_0 KV; the plan's high ran 7.0 to 17.1
percent above the real total. A mixture-of-experts file of any
architecture stays unknown. Larger llama models are still to be measured
on the Studio (SIZER-BENCH-01, row D3). Other unverified architectures
get the verdict unknown, unless a measured record or a dry run exists.
A downloaded GGUF of any architecture can use the dry run.

**One fit across roles.** A set of role choices fits when the resident
roles' peaks, plus the largest single on-demand or generator peak, stay
within the cap. The planner mirrors the capacity condition in the
governor's admission arithmetic (`canAdmit`, with `governorPeak`
mirroring `peakFor`); free memory and the working margin remain an
admission-time condition, so a plan it accepts can still queue at
admission. Wakeword adds nothing (installed only in every profile).
STACK-SIZE-01 owns the per-role choice; STACK-SIZE-03 adds the plan and
the verdict on top of it.

**Where the docs and the code disagree.** "Admission is decided from
kernel pressure and measured peaks, never file sizes" (Goals, item 3)
is not what `governor.ts` and `admission.ts` do before a first load:
they use file size times a multiplier. "The governor" above describes
the `llama-fit-params` dry run as if it runs, but `dryRunFootprint` and
`estimateFootprint` in `lib/supervisor.ts` have no callers. The
estimator also takes the KV element size from the weight quantization
(a different thing), fetches `resolve/main` (a branch, against the
pin-a-revision rule), and makes an undeclared outbound request.
Home keeps its own copy of the sizing arithmetic
(`fitsWithin`, `recommend` and `kvCacheBytes` in Home's
`lib/modelCatalog.ts`), which counts a q8_0 KV element as 1 byte where
ggml's block layout gives 34/32; that copy is frozen and retires when
Home moves onto the Stack (STACK-16). Three memory
reserve rules also exist (the governor's OS margin plus tier margin,
the operations design's mode-dependent reserve capped by Metal's
recommended working set, and Home's 96 percent minus 0.7 GB); the
governor's is the one kept, plus Metal's recommended working-set cap
(STACK-SIZE-05).

**Shared shapes come first.** The spec (commons) gains: a KV cache type
(`f16`, `q8_0`, `q4_0`) wherever a size is quoted, a footprint entry
(bytes, context, KV type, source of `measured`, `dry-run` or
`estimated`, tool and version, date, a sanitized hardware line), the
engines `mlx-serve`, `sherpa-onnx-node` and `pocket-tts` in the engine
enum, and a Stack fit-plan wire shape (per-role line, total, cap,
margin, path, verdict, bottleneck, shortfall). The KV cache type
becomes a setting the Stack declares. STACK-SIZE-03 waits on that.

Measurement records: the reports behind the numbers above are kept in
the Stack checkout's untracked scratch folder (SIZER-BAKE-01 to 05);
the hardware is a 24 GB Apple silicon laptop running the hub beside the
runs, on macOS, with `llama-server` b10797, `gguf-parser-go` v0.26.4
and `mlx-serve` v26.9.4. Multi-model, MoE and Studio-class numbers
belong to the Studio bench (STACK-14).

**First live run (2026-09-30).** Everything above was first verified with stubbed networks and fake estimator binaries, so the fit plan was run once for real: a scratch Stack built from `main` on a 24 GB Apple silicon laptop (macOS, `llama-server` b10797, `gguf-parser-go` v0.26.4, `mlx-serve` v26.9.4), its own data directory and port, the household's running hub untouched. The health item `engine-missing.gguf-parser` appeared on the first GGUF request and its one fix installed the pinned binary through the Stack's own installer (9,130,434 bytes, checksum equal to the pin); the plans for a real Hugging Face Llama 3.1 8B, Qwen3 30B-A3B and Gemma 3 12B file read "unknown" (architectures not verified), the plan for the local Qwen3 1.7B Q8_0 and for the MLX Qwen3 1.7B 4-bit at 4096 and 32768 carried real ranges, all nine responses parsed with the generated `StackFitPlan` schema, the four bad sources answered 400, and no request took longer than 1.6 seconds (0.47 seconds in the second run). Every real measurement sat at or below the plan's high figure: the real `llama-server` GPU total (2,239.78 MiB) against a plan of 2,513.77 to 3,172.22 MiB, and the MLX peaks (2,261 MiB at 4096, 7,017 MiB at 32768) against plans of 3,047.71 to 3,615.73 MiB and 9,006.11 to 12,710.13 MiB, so the plan's high end ran 41.6, 59.9 and 81.1 percent above the real numbers (loose, and on the safe side). The run found one defect: the plan judged against free memory at that second and answered "no" for both small models because about 4.2 GB was free against a 4 GB working margin. STACK-SIZE-12 made the plan judge capacity only (the governor's first condition), and a rerun on the fixed `main` answered "yes" for all three with figures identical to the first run.

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
scratch `STACK_DATA_DIR` of its own set by `backend/tests/preload.ts`
and refuses a real one (2026-09-17 21:40: a gate from the main checkout
emptied the owner's live models table). The scratch is
`backend/data-test/run-<pid>`, git-ignored, one per run; every run
starts by sweeping the directories of runs whose process is gone, so a
run leaves at most its own and the next takes it away (issue #7:
3,084 directories had piled up under the OS temp dir, because Bun's
test runner fires neither `exit` nor `beforeExit` for a handler a
preload registers, measured on 2026-09-20). The same change fixed the
suite's detection-scan roots, which were written with `=` where the
parser reads `:`, so the scans had been reading the real home caches.

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

Each prove script (`scripts/prove-stt.sh`, `scripts/prove-tts.sh`,
`scripts/prove-pin-rollback.sh`) and the bench script
(`scripts/bench/studio-bench.sh`) shares the same daemon start-and-stop
block: source `scripts/lib/daemon.sh` and call `daemon_port_free`,
`daemon_base`, `daemon_start <port> <data_dir> <log>` (the setsid
launch, sets `DAEMON_PID`, prints the pid line, waits on `/healthz`
up to 10 s and fails loudly with the log's tail), and `daemon_stop`
(kill, wait, group kill, port check line; the script owns its scratch).
One definition, one implementation, instead of four hand-copied blocks.

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
but the pinned one and every community voice, so at 94c the engine was
never run offline. (Superseded at 94d, below: the engine now runs
offline always and the Stack fetches what a request needs first.) After the post-load check the supervisor reads which weights
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
Home adopts the Stack. The Stack imports the event union and the other
wire shapes from `@maipai/spec` (tag `spec-v0.1.2`).

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
| `tts` environment | `pocket-tts.darwin-arm64.requirements.txt` | 817 lines, 768 hashes | `backend/src/speech/` | pocket-tts 3.1.0, torch 2.13.0, setuptools 84.0.0, numpy 2.5.3 and the rest by version and hash (recompiled 2026-09-20 for the Dependabot alerts on setuptools below 83 and torch 2.12.1; torch 2.13 ships macOS 14 wheels only, so the file is compiled with `MACOSX_DEPLOYMENT_TARGET=14.0` and needs macOS 14 or later); the Linux files land with the first Linux `tts` run |
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

### The voice engine online only when needed (STACK-94d, 2026-09-20)

The rule, superseding the "never run offline" paragraph of 94c above:
the engine runs with `HF_HUB_OFFLINE=1` always and no token in its
environment, and the Stack fetches, through its own pinned and
checksummed download path into the hub cache, exactly what a request
needs and does not have, before the engine uses it. The only outbound
calls are the Stack's declared downloads, on an explicit need, never on
the engine's start. What the engine reads, checked in the installed
package (3.1.0, `utils/utils.py` and `models/tts_model.py`): every
`hf://` path goes through `hf_hub_download`, which offline resolves a
commit-hash revision from the cache layout and raises otherwise; the
config tries the gated weights first (`kyutai/pocket-tts` at
`39592ff…`) and falls back to the ungated pin on any failure, so with
the gated file in the cache the engine loads it offline and has
cloning, and without it loads the pin; a preset name maps to the
precomputed embedding `languages/english/embeddings/<name>.safetensors`
in the ungated repository at `e81d79e8…`, never to cloning; anything
else (an `hf://` audio file, an `http(s)://` file, an upload) is
encoded through the cloning weights, and `_cached_get_state_for_audio_prompt`
does not cache in this version, so a cloned voice costs its encoding
on every request (1.9 s on the laptop, below).

`backend/src/speech/voices.ts` does the fetching. The 26 preset voices
of the English catalog are pinned by name, size and sha256 from the
hub's listing at the embeddings revision (`POCKET_TTS_PRESET_VOICES`);
`prepareVoice` resolves a request's `voice_url` before the engine sees
it: a preset name, or the engine's own `hf://` spelling of one,
becomes the name once its embedding is in the cache at the pinned
digest (installed through the store as a voice component, the same
path as the `alba` pin, once; served from disk after); an `hf://`
path to a community voice is resolved through the hub's API to a
commit and the file's own LFS digest (`resolveHuggingFace`, one
metadata call), installed as a voice component at that commit, and
handed to the engine as `hf://repo/path@commit`, so the engine finds
it offline; an `http(s)://` voice is allowed only on the household's
own network (loopback, the private ranges, `.local`, `.home.arpa`:
Home's cloned voices), which the engine reads over the LAN, and a
public host is refused as not pinnable; a file the hub publishes no
digest for, a repository that declares no licence, and a name that is
no preset are refused with the reason (400, `voice-not-pinnable`).
`kyutai/tts-voices` declares no licence as a repository and states
each folder's in its README (read 2026-09-20), so
`VOICE_FOLDER_LICENCES` pins those: `voice-donations/` and
`voice-zero/` CC0, `vctk/`, `cml-tts/` and `alba-mackenna/` CC BY 4.0,
`expresso/` and `ears/` CC BY-NC 4.0; `unmute-prod-website/` is mixed
and refused.

Cloning is a setting, `stack.engines.tts.voice_cloning` (off by
default, needs a restart), beside the token. The gated weights
(`pocket-tts-english-cloning`, `kyutai/pocket-tts` at `39592ff…`,
219,029,196 bytes, sha256 `473f47d9…` read from the hub's listing with
a token on 2026-09-20; the same size as the ungated twin, different
bytes) are fetched by the Stack once, with the token as the request's
Authorization header and nowhere else, when cloning is on and a token
is set: at the engine's start (a fetch that fails raises
`voice-cloning-weights.tts` and never stops the start) or at the first
cloning request, after which the engine, if it loaded the ungated
twin, is restarted onto them. A request that needs cloning while the
weights are not on disk and cannot be fetched is refused with the
reason before the engine (409, `voice-cloning-unavailable`: cloning
off, or no token). The identity read after load is unchanged in
substance: the gated repository first when the cache holds both,
which is the engine's own order. The privacy row `tts-voices` says
all of this in the dad's words.

Proven live (`scripts/prove-tts.sh`, two runs on the p16 laptop, the
second with the operator's own token in the script's environment for
that run only; the machine was under a parallel gate's memory load
during the second, so its steps 4 to 6b were the governor refusing
the engine at 3.1 GB free and pressure warn, and the numbers below
are the first run's for those steps and the second's for 6d):

| Step | Result | Time |
|---|---|---|
| The engine's start, its sockets sampled every second with `lsof` through the first render | the loopback listener only; no outbound connection | first byte 14.6 s |
| `voice_url=nobody`, `voice_url=https://example.com/v.wav` | 400 `voice-not-pinnable` with the reason, before the engine | |
| `voice_url=anna`, not on disk | HTTP 200; `anna.safetensors` fetched once by the Stack (7.8 MB, sha256 verified) into the hub cache beside `alba`, the record `pocket-tts-voice-anna` installed; first byte 2.26 s (the fetch inside it) | |
| `voice_url=anna` again | HTTP 200, first byte 8 ms: read from disk | |
| `hf://kyutai/tts-voices/alba-mackenna/casual.wav`, cloning off | 409 `voice-cloning-unavailable`, "turned off" | |
| The same, cloning on, no token | 409 `voice-cloning-unavailable`, "keeps behind a token" | |
| The same, cloning on, token set | HTTP 200, 2.28 s of audio; the Stack fetched `casual.wav` (958,542 bytes, at commit `323332d3…`, the hub's digest) and the gated weights (219 MB) and restarted the engine onto them; `x-maipai-model: kyutai/pocket-tts`, `x-maipai-revision: 39592ff2…`; the hub cache then holds the three repositories | first byte 23.8 s (the two fetches and the restart inside it) |
| The same again | HTTP 200, first byte 1.90 s: the engine encodes the voice each time (no cache in 3.1.0) | |
| `tts` identity after the restart | ok: the pinned repository's gated twin, as allowed | |
| `POST /stack/v1/check` | ok | 0.23 s |

### The second voice engine: Chatterbox Turbo on MLX (VOICE-STUDIO-01 slice 1, 2026-10-17)

Why: Jesse wants laughs, coughs, sighs and hesitations in conversation mode on the Studio. Measured on the Studio (M5 Max, 128 GB; the
home repo's `docs/design/studio-voice-2026-10-17.md`): Chatterbox Turbo through the MLX port in `mlx-audio` has 0.45 s to first audio, a
real-time factor of 0.27, a 4.8 GB peak, chunked streaming and tag support, with no watermark code in the port. Orpheus 3B MLX 4-bit
(0.75 s, 0.42, 3.2 GB) is the alternate and slots into the same interface later. Pocket TTS stays: the small-machine engine and the
fallback.

- **One setting picks the engine.** `stack.voice.engine`: `auto` (default), `chatterbox-turbo`, `pocket`; applies at the voice
  engine's restart (`needs_restart`). `auto` is the tier default in `speech/ttsEngines.ts`: Chatterbox Turbo on p64 and p128, Pocket TTS on
  p16 and p32 (p32's budget is spent by the 17 GB Muse 30B pin). Choosing it by hand on a smaller tier is allowed; the governor refuses a
  load that does not fit and the voice falls back.
- **Registry and resolution.** `ttsEngines.ts` holds the engines (id, catalog engine name, runtime, tags, planned footprint, repo) and
  `resolveTtsEngine`: the requested engine, unless it is not built (Orpheus), not installed, or failed to start this run, in which case
  Pocket TTS with the reason in words. `supervisor.activeTtsChoice()` applies it to the live state; `engineForRole("tts")` returns the
  engine's catalog name, so `selectedModel("tts")` picks that engine's records and the install plan adds Chatterbox's pins beside Pocket's on
  p64 and p128.
- **Fallback.** `startVoiceWithFallback` wraps the voice start: if a non-Pocket engine cannot start (exit before health, a memory
  refusal, a load that never finishes) it is marked failed for the run, the health item `tts.engine-fallback` (warning, with the reason) is
  raised and Pocket TTS starts. A restart of the voice engine clears the mark and tries again. Chat and the Stack are never touched.
- **Runtime.** `mlx-audio` 0.5.9 is a managed runtime (`speech/mlxAudio.ts`) built by the same `uvEnvironment.ts` as Pocket TTS and ComfyUI
  (requirements written to disk before uv syncs them): a hashed requirements file compiled for Python 3.12 on macOS 14 arm64, about 36
  packages, no torch. The engine is `speech/mlx_tts_server.py`, written next to the venv at each launch: `GET /health`, `GET /tags` and
  `POST /tts` (the same multipart form and chunked 24 kHz mono 16-bit WAV with the placeholder data size as Pocket TTS), so
  `/v1/audio/speech` and Home's voice session are unchanged. It loads the model and synthesizes one short sentence before it reports
  `ok` (the first synthesis costs 6 to 14 s of kernel compile), runs all MLX work on one thread, frees MLX's buffer cache after each
  request, and runs with `HF_HUB_OFFLINE=1`.
- **Pins.** `mlx-community/chatterbox-turbo-fp16` at commit `b2d0a13a...`: `model.safetensors` (2,985,990,960 bytes) as the model and seven
  small files (config, tokenizer files, `conds.safetensors`, the default voice's conditioning) as components, each by sha256 and size,
  placed in the hub cache like Pocket's. Licences: the weights card says Apache-2.0 (the upstream ResembleAI card says MIT), the
  `mlx-audio` code is MIT; the MLX port has no watermark code. Weights are downloaded at install, never vendored, so permissive weights sit
  cleanly under AGPL-3.0 code. The reference-clip tokenizer (S3TokenizerV2, 472 MB) is not pinned: cloning from a clip is a later slice.
- **Voices and the capability flag.** With Chatterbox in effect `GET /stack/v1/voices` lists one voice, `chatterbox-turbo-voice-default`;
  `/v1/audio/speech` ignores `voice_url` for it (a voice Home saved from Pocket's list is not an error). Every voice entry carries
  `tts: { engine, tags }` and `GET /stack/v1/roles` gives the `tts` role `tts: { engine, requested, tags, fallback_reason }`. `tags` is the
  list the engine renders as sounds; Home's composer writes only those into `reply.speech` (REG-02).
- **Tags verified.** Each tag was synthesized alone three times and compared with spoken words ("banana", "laugh", "Hello there.")
  by voiced-frame fraction and spectral flatness (speech: voiced 0.82 to 0.99, flatness 0.0025 to 0.0033). [laugh] 0.42 / 0.053,
  [chuckle] 0.72 / 0.019, [cough] 0.21 / 0.019, [sigh] 0.23 / 0.015, [gasp] 0.20 / 0.029, [clear throat] 0.66 / 0.0085 (weakest: about 3x
  speech flatness) render as non-speech sound. [sniff] and [shush] also render as non-speech but are not offered; [groan] measures like
  speech (not a sound) and an unknown tag ([banana]) is read aloud as a word, which is why only measured tags are listed. Measured by
  numbers, not by ear: Jesse's ear is the final judge.
- **Memory.** Planned 5.2 GB until measured (4.8 GB MLX peak on the Studio); the keep-warm set loads it with the other roles only where
  `planWarmSet` says it fits, and it never loads on a tier that does not.
- **Orpheus.** Not built. The slot is the `orpheus` row in the registry (`built: false`), a class in `mlx_tts_server.py` with `load`, `stream`
  and `tags`, and its pins in the catalog; then the setting gains its option.

## The image role: ComfyUI as a managed engine (STACK-13b, 2026-09-20)

ComfyUI is the `image` role's engine, managed the way Pocket TTS is
(one builder for both, `backend/src/lib/uvEnvironment.ts`): its
release `v0.36.0` (2026-09-15) arrives as an engine archive, the tag's
source tarball from GitHub (12.5 MB, sha256 `ab0d2f14…`, the same
file on every platform, pinned per machine so the selectors stay one
shape; a tarball GitHub regenerated with different bytes would be a
checksum refusal and a deliberate re-pin), extracted to
`data/engines/comfyui/v0.36.0/` with `main.py` at its root; the
environment is a venv beside it, built by the pinned uv from
`backend/src/generators/comfyui.darwin-arm64.requirements.txt`
(2,143 lines, 2,057 hashes, compiled from the release's own
`requirements.txt`: torch 2.13.0, torchvision 0.28.0, torchaudio 2.11.0
(its last release, imports clean beside torch 2.13), transformers
5.17.0, setuptools 84.0.0, the ComfyUI frontend package 1.52.7 and the
rest; recompiled on 2026-09-20 for the Dependabot alerts on setuptools
and torch, with `MACOSX_DEPLOYMENT_TARGET=14.0` since torch 2.13 ships
macOS 14 wheels only). `POST
/stack/v1/engines/comfyui/install` is one job: the archive, uv, a
managed Python 3.12, the wheels; a second request joins it. ComfyUI's
own base directory (its model folders, inputs, outputs, temp, user
settings, the empty `custom_nodes` it lists before it serves) is
`data/generators/comfyui/`, never inside the source tree. The launch
is `<venv>/bin/python main.py --listen 127.0.0.1 --port <free>
--base-directory <base> --disable-auto-launch --disable-metadata
--dont-print-server`, with HOME and every cache under `data/` and no
manager, no API nodes and no telemetry; `GET /system_stats` is its
liveness (any 2xx), and the identity headers say `local
comfyui-v0.36.0` and the checkpoint file.

The checkpoint is a store pin: Stable Diffusion 1.5, the EMA-only
single-file `v1-5-pruned-emaonly.safetensors` (4,265,146,304 bytes,
sha256 `6ce01616…`) from the maintained mirror
`stable-diffusion-v1-5/stable-diffusion-v1-5` at revision `451f4fe1…`,
CreativeML Open RAIL-M from the repository's card. It is the smallest
mainstream file ComfyUI's plain checkpoint loader takes; the distilled
alternatives on the hub (`segmind/tiny-sd`, `nota-ai/bk-sdm-tiny`) ship
in the diffusers folder layout across several files, and `sd-turbo`'s
single file is 5.2 GB under a research licence. The launch links the
store's file into ComfyUI's checkpoints folder, so the file it loads
is the store's, with its provenance and checksum.

The render is a job (STACK-13a): the runner registered for `image`
gets the role's living process from the supervisor (started and
admitted like every engine, its checkpoint a resident at the file
times the engine's multiplier until measured, evicted by the
supervisor's idle unload like any role's), holds it as one request,
and runs one text-to-image graph through ComfyUI's own queue:
`CheckpointLoaderSimple`, two `CLIPTextEncode` (the prompt and the
negative prompt), `EmptyLatentImage` (the size, multiples of eight),
`KSampler` (steps, seed, cfg, euler), `VAEDecode`, `SaveImage`.
`POST /prompt` queues it, `GET /history/{id}` is followed every half
second until it completes (ComfyUI's step-by-step progress only
travels over its websocket; the job reports "rendering" until the
image exists), `GET /view` fetches the PNG, and the job's result is
`{ images: [{ b64_json, seed }] }`, which `/v1/images/generations`
answers in OpenAI's shape. Cancel removes a queued graph from
ComfyUI's queue and interrupts a running one (`/queue` with `delete`,
`/interrupt`). The generator's post-load check and readiness probe
ask `GET /object_info/CheckpointLoaderSimple` for the checkpoints the
engine can load and require the pinned one on the list; a render is a
job, never a probe. The job's own admission (STACK-13a) is the
render's transient set on top of the resident checkpoint, 1 GB at 512
by 512 and scaled by the pixel count asked for (a side is 64 to 2048,
a multiple of eight), until measured.

An engine start the governor queues no longer fails on the spot: it
waits up to fifteen seconds for memory through the same wait the job
queue uses (`backend/src/lib/admission.ts`, one loop for both: the
loaded set watched for the admission, the governor nudged when
nothing it waits on is loaded, a give-up leaving a watcher that
returns a late admission so no phantom ever blocks the next request;
a stop or a restart during the wait ends it at once), then fails with
the governor's words and numbers. The environment's ready marker is
its own (`.env-ready`), distinct from the source archive's
`.engine-ready` in the same directory, so a build that failed after
the archive extracted is not mistaken for an environment. One build
is in flight per engine.

### The graph proven, the governor's answer recorded (13b-live)

The graph and the wire were proven on 2026-09-20 on the p16 laptop
against a ComfyUI started outside the Stack from the same hashed
environment and the same checkpoint (the scratch run, no governor):
`/system_stats` answered after 25 s with ComfyUI 0.36.0, torch 2.11.0
and one `mps` device (the environment as first compiled; after the
2026-09-20 recompile the same start was repeated from the new file:
up in 20 s with torch 2.13.0, torchaudio 2.11.0 and torchvision 0.28.0
importing clean, the checkpoint loader listed); `/object_info/CheckpointLoaderSimple` listed
the checkpoint; the graph above at 512 by 512, 8 steps, seed 7,
rendered in 18.3 s to a 433,537-byte PNG of a lighthouse on a rocky
shore, fetched through `/view`; the process held 862 MB resident by
`ps` (Metal's allocations are outside RSS; the Stack's own reader
takes the larger of the resident size and `phys_footprint`, which
counts them).

Through the Stack (`scripts/prove-image.sh`, three runs, the last
with the bounded wait): the install job built the environment in
15.3 s (the archive, uv, the wheels; `engines/comfyui` 1.4 GB), the
checkpoint downloaded and verified in 75 s, `image` stood
`installed`, and the render was refused by the governor after the
start's wait: "The current memory budget cannot admit the request. It
needs about 5.2 GB with 7.1 GB free, after the working margin the
machine's tier keeps back; memory pressure is normal. The image engine
waited 15 s for memory and gave up." (the file's 4.27 GB times the
default 1.3, and 7.1 minus 5.2 is under the p16 margin of 4 GB; the
governor's decisions show the four nudges, one every five seconds).
The job failed with that sentence after 15.1 s, the route answered
500 with it, the readiness check reported `image` failed with it,
nothing loaded, nothing left in the governor's queue, the port came
free and the scratch directory was removed. That is the governor
doing its job on a busy laptop, not a defect; the margin was not
loosened for the proof. The live pass through the Stack is 13b-live,
to be run with about 2 GB more free or on the Studio.

## The second chat engine: mlx-serve (STACK-93, 2026-09-20)

**The pick: mlx-serve**, by the prebuilt rule, and the reason in the
facts checked on 2026-09-20. `ddalcu/mlx-serve` (MIT, native Zig, no
Python) publishes a release archive for Apple silicon,
`mlx-serve-bin-macos-arm64.tar.gz` (v26.9.4, 2026-09-17, 72.1 MB,
sha256 `5a8b1631…`), holding one binary and its libraries (libmlx,
libmlxc, mlx.metallib, libllama, libwebp): the same shape as
llama-server's archive, so it installs, swaps and rolls back through
the engine store and the Catalog engine index with no new machinery
and no environment to build. It speaks the OpenAI chat wire and, run
against the pinned MLX model, answers `GET /health` with
`{"status":"ok"}` and `GET /props` in llama-server's own shape (the
context length, the model info, its memory), so the supervisor's one
identity reader and post-load check serve it as they serve
llama-server; the build string is the pin's tag, since its `/props`
carries no `build_info`. It runs one model pinned for the life of the
process (`--model <dir> --serve --host 127.0.0.1 --port <free>
--ctx-size <n>`), which is the supervisor's contract. Verified live in
the scratch run below: health in 3 s, a completion in 0.56 s.

**Rejected for now: oMLX** (`jundot/omlx`, Apache 2.0, Python, the
larger project with continuous batching and SSD caching). Its releases
ship wheels for macOS 15 and later only, on GitHub rather than PyPI,
so it would need the uv environment pattern plus a raised macOS floor
for the chat role itself, where mlx-serve needs neither. It stays the
named alternative the Studio bench can call for when it measures both
against llama-server (STACK-14); the adapter's contract is the same
and its rows in the catalog would be the environment shape Pocket TTS
uses.

**The MLX weights pin**: `mlx-community/Qwen3-1.7B-4bit` at revision
`3b1b1768…` (Apache 2.0), the MLX build of the same model the
llama-server pin ships, so the Studio bench compares engines on one
model. An MLX model is a directory of files, not one file: the store
gains multi-file pins (`download.files`, each with its path, size and
sha256; the record's own sha256 is the weights file's), downloaded
one by one, each verified, into one directory that is the record's
`modelPath`. Nine files, 984 MB, the weights 968 MB.

**Choosing the engine**: `stack.engines.chat.engine` (`llama-server`
or `mlx-serve`, a `needs_restart` setting) names the chat role's
engine; a model record names the engine it is for, and the role's
selected model is the first verified one for the chosen engine, so the
switch is the setting plus a restart, both models installed side by
side. The supervisor's launch for the chat wire branches on the
chosen engine: the `current` link of that engine's store, its own
arguments, the same admission (the file times the `mlx-serve`
multiplier the governor already had, 1.4, until measured), the same
drain, restart and identity claims. HOME for the child is under
`data/` (mlx-serve keeps its logs and its own model folder there).
The engines list compares the running build with the row of the
engine whose process serves the chat role (each process records the
engine it is), so the other chat engine, installed or even chosen but
not running, is never "newer installed" against a build it is not
running; a pending `stack.engines.chat.engine` is the restart on the
chosen row; the start, restart and current routes for the chat engine
the setting has not chosen answer with the reason rather than driving
the chat role's process (a swap of that engine's `current` link moves
the link and proves nothing, since nothing of it runs), while a stop
is judged on what runs, so the engine holding the role's memory can
always be stopped, a start of the chosen engine while the other still
holds the role is a real start, and the scheduled engine update swaps
the link of a chat engine not chosen without draining or restarting
the process that runs (its proof comes when it is chosen); a failed
swap of mlx-serve raises `failed-swap.mlx-serve` and its rollback fix
moves mlx-serve's link, draining the chat role only when mlx-serve is
the engine it runs. The download's `directory` is confined to the
model's own store path, as each pinned file's path is. A staged
build of mlx-serve carries the engine's own binary name, as the
shipped pin does. The setting refuses an engine with no pinned build
for the machine, so a Windows or Linux box never applies a choice
that would leave the chat wire with no engine. A pull by id takes a
directory model's file list from the Catalog's entry when it carries
one (the index shape has `directory` and `files`) and from the
shipped pin otherwise (at the shipped revision only, whichever pin
the body's other fields came from: another revision's files are not
the shipped hashes), so an index entry without the
list never turns the model into one file; a pinned path that leaves
the model's directory is refused before it is written; a pin naming
both a hub file and a directory is refused, as is half of the
directory shape (files without a directory or the reverse), and a
pull of an MLX model that resolved no file list is refused at the
route rather than installing one lone file no engine launches; a
secondary file that fails its checksum raises the same
`stored-blob-checksum-mismatch` item the weights do. A model id is a plain
name (one path segment, letters, digits, dots, dashes, underscores)
that is never one of the store's own directories (`hub`,
`manifests`), refused at the pull and import routes, and the sweep on
remove never touches those directories whatever a record's id says. The setting's refusal
never applies to the value already in effect, so a client writing
every setting back, or the default on a machine with no chat pin,
is not a change to refuse. A re-install of a
directory model verifies the weights already placed in the directory
and fetches only the files that are missing or wrong, the same
promise the archive beside a package keeps; the job's progress counts
every file against the directory's total; a pull whose URL names a
file the pin does not list is refused before a byte moves (the URL's
path is the name, so Hugging Face's `?download=true` form is the same
file); and dropping a record sweeps the model's own directory under
the store, so weights placed by an install that stopped on a later
file never outlive the record.

**Proven live** (`scripts/prove-mlx.sh` on the p16 laptop, Apple M4
Pro, 24 GB, 8.3 GB free at the ask, a clean scratch data directory on
port 8771, two runs, the second recorded): the mlx-serve archive
downloaded, verified and installed in 2.2 s (`engines/mlx-serve` 220
MB extracted); the nine model files downloaded and each verified in
50.6 s, one directory of 984,013,244 bytes, the manifest holding nine
blobs; with llama-server not installed the chat role stood
`notInstalled`; the setting stored `mlx-serve` as pending with
`needs_restart` and the apply put it in effect, after which the role
stood `installed` on `qwen3-1.7b-mlx-4bit`; the first
`POST /v1/chat/completions` answered "OK." in 1.88 s including the
spawn, the load and the identity read (headers
`x-maipai-engine: local mlx-serve-v26.9.4`,
`x-maipai-model: Qwen3-1.7B-4bit`, `x-maipai-revision: 3b1b1768…`,
the identity claim `ok` against the expected name); the governor
admitted `chat` at the estimate (984 MB times 1.4, 1.38 GB) and the
process measured 1,244,874,360 bytes by `phys_footprint` after the
load (1,099,280 KB resident by `ps`), so the multiplier covers it with
10 percent to spare; a second completion on the warm process answered
"4" in 50 ms; the readiness check passed chat, coding, judge and
router through the one process; a restart through
`POST /stack/v1/engines/mlx-serve/restart` drained, respawned and
answered again with the same identity; the port came free and the
scratch directory was removed. The GGUF pin was not installed in the
run (llama-server's own proof is above); the Studio bench (STACK-14)
puts the two side by side on one model.

## The compiled binary (HOME-STACK-01, 2026-09-21)

`scripts/build-binary.sh` (new) compiles the Stack into one binary Home's installer can place and run: `bun build src/index.ts --compile`, which dispatches `serve`/`install-service`/`start`/`stop`/`status`/`uninstall-service --remove-data` (`daemon.ts`) from the one file. The script's output is a directory, not a bare file: the binary plus `migrations/` as a real sibling - `db/index.ts`'s migrations read a real folder from disk by a path relative to the binary's own location, which drizzle's migrator does with plain `node:fs`, invisible to `bun build --compile`'s virtual filesystem. `db/index.ts` (and `lib/paths.ts`'s own default data directory, the same bug class, caught by a code review before it shipped) now resolve relative to `process.execPath`'s own directory (a real path even inside a compiled binary, unlike `import.meta.dir`, which resolves to `/$bunfs/root`) whenever `lib/paths.ts`'s new `isCompiledBinary` flag is set - found live, the first time the compiled binary tried to open its own database and failed with `Can't find meta/_journal.json file`.

**The `stt` role needed a real fix, not a documented gap**: a compiled binary can never load `sherpa-onnx-node`'s native binding once the same binary also contains the daemon's own graph - a genuine Bun bundler bug (`getmaipai/stack#8`, filed with a minimal two-file, six-module reproduction: `require("sherpa-onnx-node")` in one file plus *any* other `require()` call anywhere else in the same compiled build, even `require("node:os")`, even one that only runs on Linux and is never reached on this machine, breaks the native module's own embedding entirely). Ruled out as workarounds, all documented in `speech/sherpa.ts`'s own `loadModule()` comment: requiring the native `.node` file directly by a literal path (loads, but exposes only the low-level C-style bindings, not the `OfflineRecognizer`/`Vad` classes that file actually needs), `--external`, a true `await import()` instead of `require()`, obfuscating the second file's own require specifier so it can't be read as a literal.

The real fix: the `stt` worker never runs as a re-invocation of the compiled binary at all. `lib/supervisor.ts`'s `speechWorkerCommand()` now branches on `isCompiledBinary` - uncompiled, unchanged (`bun run`'s own entry-file-in-between shape); compiled, a real `bun` (named by `STACK_BUN_BIN`, required in that case, a clear error rather than a silent fall-through to the broken path) running `backend-src/src/index.ts speech-worker ...` - `backend-src/`, a real, fully dereferenced copy of `backend/` (`cp -RL`, not a bare `cp -R`: bun's own install layout is symlinks into a content-addressed store that would dangle once moved) `scripts/build-binary.sh` ships as a sibling of the compiled binary. A plain `bun run` against that real source and its own real `node_modules` resolves `sherpa-onnx-node` exactly as dev already does today - no special env needed, so the `DYLD_LIBRARY_PATH`/`LD_LIBRARY_PATH` plumbing a first pass added for a different (wrong) fix came back out again. `STACK_BUN_BIN` reaches the daemon through the service unit's own `EnvironmentVariables` (`service/launchd.ts`'s `bunBinEnvironment()`, and `service/systemd.ts`'s matching `Environment=` line for parity, untested on Linux this session), the same mechanism `PORT` already uses - Home's installer sets it to the same `bun` it already installs for its own frontend build.

Verified live, not just "the daemon started": `scripts/build-binary.sh`'s own verify step serves the compiled binary on a scratch data directory, confirms `/healthz`, then installs the real Silero and Moonshine packages (real downloads, checksums verified) and transcribes the bundled clip through `POST /v1/audio/transcriptions` - `{"text":"Clover, the kitchen light is on."}`, HTTP 200, the stt worker actually running as `bun run backend-src/src/index.ts speech-worker ...` under a real `bun`. (`SKIP_VERIFY=1` skips all live checks for a compile-only run; `SKIP_STT_VERIFY=1` keeps the daemon/`healthz` check but skips the slower real download.) Every other role (chat, embed, judge, router, rerank, vision, tts, image - all external subprocesses, never a native Node addon loaded in-process) was already unaffected. Full backend suite green, 327/327, `bunx tsc --noEmit` clean.

Files: `scripts/build-binary.sh` (new, platform-agnostic - it compiles for whichever machine runs it, matching HOME-STACK-01's own design of a local build at install time, never a cross-compiled/central one; ships `migrations/` and `backend-src/`), `backend/src/db/index.ts` and `backend/src/lib/paths.ts` (the two migrations/data-dir fixes, `isCompiledBinary` exported from the latter), `backend/src/lib/supervisor.ts` (`speechWorkerCommand()`'s compiled-vs-bun-run branch), `backend/src/service/launchd.ts` + `systemd.ts` (`STACK_BUN_BIN` passthrough), `backend/package.json` (`sherpa-onnx-darwin-arm64` added as a direct dependency - previously only a transitive optional dependency of `sherpa-onnx-node`; no longer required for the fix itself now that the worker runs via a real `bun run`, but still useful so `bun install` alone proves the native package is present rather than discovering that live). Tests: `speech.test.ts` (the worker-command test rewritten for the new signature, the compiled-with-no-`STACK_BUN_BIN` error), `service.test.ts` + `systemd.test.ts` (`STACK_BUN_BIN` present and absent). Out of scope: Home's own `install.sh`/`uninstall.sh` wiring (HOME-STACK-01's home-side half, a separate item, which now also has to keep `backend-src/` beside the binary and set `STACK_BUN_BIN`, not just place a single file); an actual Linux build (`sherpa-onnx-darwin-arm64` only, for now - the robot's own speech process never goes through this file at all, so nothing here blocks it).

## The vision role (VISION-01b, 2026-10-06)

`vision` is its own model and process. It no longer shares chat's
text-only process, which cannot read a picture. The pin is Qwen's own
GGUF of Qwen3-VL-4B-Instruct (`Qwen/Qwen3-VL-4B-Instruct-GGUF` at
revision `1cd86afb9a95c410a6038ab3b40d8b578c892266`): the language model
at Q4_K_M (2,497,281,664 bytes) and its multimodal projector at Q8_0
(453,974,304 bytes), both Apache-2.0 from the pinned revision's card.
The projector is a `component: "projector"` record, installed and
verified through the same model job, never selectable alone. The model
names it in `imageInput` (the spec's `ModelCapabilities.image_input`,
spec-v0.1.83), and the vision role selects only a record that declares
picture input, never a model id. `scripts/install-pin.ts` installs a
shipped pin on a running Stack through its own model job.

The launch is llama-server b10797 (its `qwen3vl` text architecture and
mtmd projector graph are in the build) with `--mmproj`, one slot, the
record's own 8,192-token context whatever the chat settings say, and no
`--cache-reuse` (the multimodal path does not take it). The post-load
check and the readiness probe send a 16 by 16 red PNG, so ready means
the projector reads a picture. Sampling comes from the model card's VL
settings on the pin (temperature 0.7, top_p 0.8, top_k 20, presence
penalty 1.5), filled in only where a request said nothing.

Residency: the governor admits vision as `jit`, its peak the fit tool's
dry run plus the projector (or a measured whole-machine peak on the
pin once one exists), and a request restarts its idle clock. Only a
watch that can unload evicts a `jit` item, only once its process runs,
and without blocking the watch while requests drain; an entry is removed
by its own admission's token, never a newer one under the same id. An
admission never evicts a resident. A resident role about to start
unloads any `jit` role first: a picture start still queued for memory
is withdrawn at once, one already admitted and loading is retired
before the resident is sized, and no picture request starts while a
resident starts. So chat is never sized with a picture model counted and
never starts at a smaller context because of one (rule 4).

### Measured on the 24 GB machine, 2026-10-06

Apple silicon laptop, 24 GB unified memory; the live chat
(Qwen3-8B Q4_K_M, context 40,960, about 7.9 GB resident) plus the
owner's usual desktop apps; a scratch Stack on another port with its
own data directory.

- The governor's available reading (free, inactive and speculative
  pages) was 3.3 to 5.5 GB across the session.
- Through the scratch Stack, a picture request was refused: "It needs
  about 4.5 GB with 5.5 GB free, after the working margin the machine's
  tier keeps back." 4.5 GB is the dry run plus the projector, and p16
  keeps 4 GB back, so admission needs about 8.5 GB available.
- The same launch run once outside the governor, with a watchdog: the
  available reading fell from 4.1 GB to 2.1 GB while it loaded, the
  kernel reported warn pressure (level 2) before the first picture, and
  the watchdog stopped it at 2.76 GB resident with both files loaded.
  Chat's context stayed 40,960.

So the vision role does not fit beside the 8B chat on this machine as
it is used today under the governor's rules, and p16 keeps `vision` in
`notAvailable`. No whole-machine peak with a picture encoded was
recorded, so the pin carries no `measured` entry. The levers are the
owner's: a vision-capable chat model, so one resident process reads
pictures (VISION-01f's last arm, a change to the chat model's settings
and tool bench); the per-role allocation (`engines.<role>.choice`); or
a machine with more memory. A smaller chat context is not one.

## The chat model reads pictures (VISION-02b, 2026-10-06)

The owner chose one resident process that reads pictures over a second
vision model (Home's VISION-02). The Stack ships Qwen's own GGUF of
Qwen3-VL-8B-Instruct as a selectable chat model
(`Qwen/Qwen3-VL-8B-Instruct-GGUF` at revision
`f982a07559d4a2f6c8744d840bf6fccab30eea96`, Apache-2.0 on that card): the
language model at Q4_K_M (5,027,784,800 bytes) and its projector at Q8_0
(752,289,728 bytes), a `component: "projector"` record of role `chat`
that the model names in `imageInput`. Qwen3-8B stays pinned, installed
and bound on every tier; p16's binding moves only on the owner's go
after Home's VISION-02e report, and Qwen3-8B stays as the rollback for
one release.

**Launch.** A chat record that declares picture input loads its
installed projector beside it (`--mmproj`). A missing projector starts
chat text-only; a picture check after load (the vision probe's red
square, sent to the chat process) decides whether the role row says
`imageInput: true`; a failed check raises `picture-check-failed.chat`
and chat keeps serving text. The pin declares `launch.imageMaxTokens:
2560` (`--image-max-tokens`): the engine scales a larger photo down
itself, so one picture costs at most 2,560 tokens of the window (a
12-megapixel phone photo would otherwise take about 12,000), and the
chat role row reports it as `picture_tokens_max` for Home's window. The
pin's card sampling (the VL set: temperature 0.7, top_p 0.8, top_k 20,
presence penalty 1.5) fills what a request leaves out; Home sends its
own temperature 0.7 and samplers on every chat turn.

**The two chat settings a projector used to drop.** VISION-01b's launch
forced `--parallel 1` and left out `--cache-reuse 256` whenever a
projector was passed. A chat process with a projector now keeps the
slots its settings declare (the vision role alone is pinned to one
slot). Chunk reuse is not asked for, because b10797 turns it off itself
once a projector loads (`cache_reuse is not supported by multimodal, it
will be disabled`, its own log). Measured on b10797 with the VL-8B:
`n_slots = 2` held with `--parallel 2`; plain longest-prefix caching
stays on (a second request with the same 926-token system prefix
evaluated 10 tokens and took 916 from the cache; a repeated picture
question evaluated 13 of 2,419 tokens). What is lost is only the
shifted reuse of a prefix that moved (a window that dropped its oldest
turn): those turns are evaluated again.

**Sizing.** gguf-parser v0.26.4 gives byte-identical estimates for the
qwen3vl and qwen3 Q4_K_M files at 40,960 and 65,536, so `qwen3vl` is a
verified architecture; the fit plan adds the projector's bytes to every
estimate. A measured footprint now holds only up to the context it was
read at: the VL-8B's own maximum is 262,144, and a figure measured at
40,960 read as the cost of 262,144 would have planned a launch the
machine cannot hold. The admission dry run (`llama-fit-params`) is now
asked at the launch's KV cache type and flash attention; it used to
size an f16 cache, about twice the q8_0 cache a macOS launch runs (the
VL-8B at 40,960: 8,312 MiB at q8_0 against 10,904 MiB at f16).

### Measured on the 24 GB machine, 2026-10-06

Apple silicon laptop, 24 GB unified memory, the owner's usual desktop
apps and other sessions' gates running; llama-server b10797; the live
Stack's chat was idle and unloaded during the run (never touched).

| | Qwen3-8B Q4_K_M | Qwen3-VL-8B-Instruct Q4_K_M + Q8_0 projector |
|---|---|---|
| Resident at 40,960, q8_0 KV | 7.63 GB after a text turn (8.38 GB recorded live after use) | 8.43 GB after load; 9.73 GB after one picture |
| Cold load (weights cached) | | 4.1 s |
| Picture turn, first text | | 3.7 s cold (976 prompt tokens), 43 ms repeated |
| Pressure at the peak | normal | normal (available 3.3 GB) |
| Fit plan's chosen context (stt and tts resident) | 40,960 (its own maximum) | 108,544 (16.0 GB estimated peak) |

The fit plan's 108,544 is a finding for the owner, not a launch: the
plan sizes against the tier's 16 GB model budget, while admission also
needs free memory minus the 4 GB working margin, so that context would
need about 20 GB free and chat would wait and be refused on this
machine. Qwen3-8B never shows this because its own maximum is 40,960.
The p16 flip needs the owner's choice first (Home's VISION-02e report:
a 40,960 ceiling for the chat record, or a launch plan that never picks
a context admission cannot admit).

## The chat pin above 24 GB: Muse Glimmer 30B (STACK-MUSE-01, 2026-10-16)

Owner's rule, 2026-10-16: the Qwen3 8B chat entries are for machines
with 24 GB or less; every larger machine runs Muse Glimmer 30B
(`meta-models/Muse-Glimmer-30B-GGUF`, Apache-2.0, dense 29.6B, 52
layers, 2 KV heads, 131072 context, pinned at revision `70bf1b6`).
Nothing is chosen in the wizard: the tier decides, through
`PROFILE_MODEL_BINDINGS` in `profiles.ts`, and Home mirrors the same
ids in its own catalog for thinking mode and turn budgets.

| Tier | Memory | Chat pin | File |
|---|---|---|---|
| p16 | 16 to 24 GB | `qwen3-8b-instruct-q4-k-m` | 5.0 GB |
| p32 | 32 GB | `muse-glimmer-30b-q4-k-m` (KQuant 17GB) | 16.8 GB |
| p64, p128 | 64 GB and up | `muse-glimmer-30b-q4-k-xl` (KQuant-Dynamic) | 19.7 GB |

p32 takes the smaller file because Q4_K_XL (19.7 GB) plus the 4B judge
(3.76 GiB) plus context would leave a 32 GB machine under the
governor's 4 GiB free-memory margin; the 17 GB build keeps it above.
A 24 GB machine stays on the 8B for the same reason: either Muse file
plus its context is most of the memory, with nothing left for the
judge, vision or the household.

Reasoning: Muse's chat template reasons on every turn and takes a
`reasoning_strength` kwarg (`low`, `medium`, `high`, `xhigh`; default
`high`) with no off switch, so `--reasoning off` (which sets
`enable_thinking=false`) does nothing for it. The catalog record now
carries `launch.chatTemplateKwargs`, which the supervisor passes as
`--chat-template-kwargs` (new in `engineArgs.ts`); Muse launches with
`reasoning_strength: "low"`. llama-server merges a request's
`chat_template_kwargs` over the launch defaults key by key
(`server-common.cpp` in b10797), so Home's per-request
`enable_thinking` leaves the launch's `reasoning_strength` in place.
b10797 parses Muse's `<atem:function_calls>` tool calls natively and
returns the `to=self` reasoning as `reasoning_content`
(`common_chat_params_init_muse_glimmer` in `chat.cpp`), so the turn
pipeline sees the same shapes it sees from Qwen3. Sampling is the model
card's recommendation (temperature 1.0, top_p 0.95, top_k 64).

Not measured yet: tokens per second, load time and the tool-calling
bench on the Studio are STUDIO-EVAL-01's job in Home. Follow-ups once
measured: `--reasoning-budget` as a hard cap on reasoning tokens, the
repo's `mmproj` for vision, and its DFlash draft model.

## Keep-warm: no cold start for the first chat (STACK-WARM-01, 2026-10-17)

Measured on the Mac Studio (M5 Max, 128 GB, chat Muse Glimmer 30B q4, 19.7 GB): the first chat after install took about 23 s to
answer "hello", the next reply 1 s, then the memory notice appeared. Cause, from `stack.log`: every role loaded on its first request.
Chat went `loaded` to `ready` in 17 s, embed in 14 s (100 MB model; the fit dry run plus a first read from disk), the judge in
15 s, one after another. With the files already in the page cache the same loads take 4.6 s (chat), 0.2 s and 1.0 s. A warm 16 token
reply takes 0.7 s. A one token prime was not enough: a mixture-of-experts model maps its weights lazily, and the first real reply after
it still ran at 15 tokens/s before settling at 25; the prime is now a short varied prompt with a 48 token reply (first real reply
3.6 s after warm-up, warm-up 30 to 36 s in the background at start). So the cost is the first load of 20+ GB from disk plus the first kernel compile, paid by the person.

Design (`lib/warmup.ts`): `warmUp(trigger)` runs at daemon start, after a model install job finishes, after an engine update, and
on `POST /stack/v1/warmup` (Home calls it when setup ends). It reads the installed roles in `WARM_ORDER` (chat, embed, judge, stt,
tts), keeps those that fit (`planWarmSet`: running total within the model budget less the tier's working margin, resident bytes
counted first), loads each through the normal `getProcess` (so the governor still admits it) and sends a one token request that
primes Metal. A role that does not fit stays on-demand; nothing is evicted for it. State is `GET /stack/v1/warmup`, and a role being
loaded already reads `loaded` on `GET /stack/v1/roles`, which Home shows as "getting ready" (its Welcome warming-up art).
The setting `stack.runtime.keep_warm` (default on) makes the idle unload skip the warm set while plugged in; on battery the
battery idle limit still applies. The launchd unit is `ProcessType` Interactive so the system does not throttle it like a
background agent.

Cost: the warm set's RAM all the time (about 22 GB chat, 6 GB judge, 0.2 GB embed on the Studio) and the idle power of resident
models (the GPU is idle between requests; a fan-less laptop will notice the RAM, not the power). Rejected: a periodic completion
ping, because the chat engine has one slot and a ping would replace the person's cached prompt prefix; the weights stay paged in
by being resident and unloaded only by the idle rule.

## The chat engine on Apple silicon: oMLX (ENGINE-MLX-01, 2026-10-17)

**Verdict (ENGINE-MLX-02, owner ruling 2026-10-17): llama-server is the default chat engine on every tier; oMLX is opt-in.**
`auto` resolves to llama-server even when oMLX and its model are installed; `stack.engines.chat.engine` = `omlx` is the only way to
run it, and only then does the Stack build its environment and pull the 19.4 GB model (the first-run plan and the default disk
totals no longer carry them; the Models and storage page offers "Faster chat engine (oMLX)" as an optional row on p64 and p128).
Why: the quality benches against Home's tool turns. Tool-name defect 15 of 70 right on oMLX against 65 of 70 on llama-server before the
namespace fix, 58 of 70 after it; fewer tool calls on math and unit conversion; 1 of 60 replies leaked raw tool markup into the visible
text; search 26 of 30 against 28 of 30. Speed does not outweigh that. The text below is the oMLX design, still true for the opt-in.

**The oMLX pick: oMLX 0.7.0** (Apache-2.0, `jundot/omlx`) for the chat role when chosen (Apple silicon, macOS 15 or later, best at p64 and p128), with llama-server kept installed as the fallback and as the engine everywhere else. Why, with
the numbers, the alternative that lost (Rapid-MLX) and what was not verified: Home's
`docs/design/chat-engine-comparison-2026-10-17.md`. In short, on the Studio with Muse Glimmer 30B at the same size, oMLX generates
32.5 tokens/s against llama-server's 26.1 and reads a prompt 36 to 42 percent faster, 2 GB smaller resident, level on tool calls
(136 of 160 against 137 sampled), on the 60 reasoning prompts (60 of 60) and in a 200-request soak.

- **The setting is the existing one**, `stack.engines.chat.engine`, now `auto` (the default), `omlx`, `llama-server` or `mlx-serve`.
  `auto` is llama-server on every tier (`lib/chatEngines.ts`); a named engine wins. Rollback is `llama-server` and a restart; nothing is
  deleted. The embed role, the vision role and a judge with a model of its own stay on llama-server.
- **oMLX runs only when it can.** `resolveChatEngine` returns llama-server, with the reason, when the Mac is not Apple silicon on
  macOS 15 or later, when the environment or the verified MLX model is missing, or when oMLX failed to start twice in a row this run
  (`chat.engine-fallback` health row, one fix: restart the chat engine, which clears the memory). A start is tried twice before it
  falls back; a failed chat engine never leaves the household without chat.
- **Install.** The environment is `data/engines/omlx/0.7.0/venv`, built by the same uv builder as Pocket TTS and Chatterbox from one
  hashed file (`chat/omlx.darwin-arm64.requirements.txt`: 112 PyPI packages and the oMLX release wheel by sha256). Not in it, on
  purpose: torch (xgrammar declares it; oMLX ships a stub and never runs its torch paths) and oMLX's five git-pinned dependencies,
  which cannot carry hashes. The model is `muse-glimmer-30b-mlx-4bit`, an 11-file directory pinned by path, size and sha256 at
  `mlx-community/Muse-Glimmer-30B-4bit` revision `3e7677d7`. The install plan no longer adds it (ENGINE-MLX-02); with the setting on `omlx`,
  `ensureChatEngineAssets` (daemon start) builds the environment and pulls the model in the background, then moves an idle
  llama-server chat onto oMLX (`restartForNewChatEngine`), retrying every 30 s while chat is busy. Chat answers on llama-server the whole time.
- **Launch.** `omlx serve` on loopback, a random API key per launch (the engine also serves an admin dashboard on its port), `--no-hf-cache`,
  offline and tokenless environment, a model folder holding one symlink to the pinned directory, and a prompt cache under
  `data/engines/omlx/0.7.0/state/cache`, capped at 20 GB and **emptied at every launch**: the engine's cache reuse needs a disk cache, so
  the promise is that a conversation's cached state never outlives the engine process, as with llama-server's RAM cache.
- **The client adapts the wire** (`chat/omlxClient.ts`, tested): the role name in `model` becomes the folder name; the record's
  `reasoning_strength: low` rides with every request under the request's own template variables; `cache_prompt` and `id_slot` are dropped;
  the usage chunk gains llama-server's `timings` object (speed, cache share) so Home's turn stats are unchanged; `/v1/tokenize` is answered
  by one-token requests that read the engine's own `usage.prompt_tokens` (exact, cheap with the prefix cache) because the engine has no
  `/tokenize`.
- **Memory.** One process, 19.4 GB resident idle, 19.9 GB after a 16k prompt; the record carries a measured 22 GB (adds the 128k context's
  cache). The governor admits it at that figure, then at the first post-load reading.
- **Not done here:** the repo's own quality benches against the engine (Home row ENGINE-MLX-02, to run once a release carries this), 5 and 6 bit weights, and
  a Linux or Intel path (llama-server remains the engine there).

## The media service (MEDIA-STACK-01, 2026-10-17)

Home's media apps (Videos, Shows and Films, Music, Podcasts, Books) need ffprobe to read a file's streams, ffmpeg to make a
playable copy, thumbnails, storyboards and preview clips, and yt-dlp to save a link a person chose. Home never runs those
tools itself: the Stack owns them, the same way it owns every engine binary, because it already pins and checksums downloads,
runs jobs on a queue and publishes its outbound hosts for the privacy page (Home design note
`docs/design/media-apps-blend-2026-10-17.md` sections 3, 8 and 14). Code: `backend/src/media/`; the contract Home builds against
is `docs/integrations.md`, "Media service (MEDIA-STACK-01)".

- **One lane.** `media.probe`, `media.fetch`, `media.transcode`, `media.preview` and `media.setup` share one idle-priority
  first-in-first-out queue (one job at a time, 64 waiting at most). FileTube's heavy-gate lessons are the tests in
  `backend/tests/mediaLane.test.ts`: a cancelled or crashed job never blocks the next, and every kind has a deadline.
- **Quiet mode.** Four push-back failures in a row from one site (a 429, a sign-in wall) rest that site for 30 minutes. Background
  fetches are refused while it rests; a fetch a person started still runs. State survives a restart.
- **Folders.** Home declares the folders the Stack may read and write; every path in a job is checked against them after
  symlinks are resolved.
- **Pins.** ffmpeg and ffprobe 8.1.3 from jellyfin-ffmpeg 8.1.3-1 (a GPL build with no nonfree parts; sha256 and size pinned per
  platform); yt-dlp 2026.8.19 from a hashed PyPI requirements file in a uv environment, the image tools' recipe. Records in
  `backend/src/media/pins.ts` and `docs/components.md`.
- **No live video requests.** Nothing in the Stack or its tests contacts YouTube or any other video service (Home RULES.md V1).
  `backend/tests/mediaReal.test.ts` runs the real tools against a localhost fixture server only, and only when `STACK_MEDIA_*`
  point at installed tools.
- **Measured on 2026-10-17** (scratch data dir, M-series Mac under load): probe about 52 ms; transcode of a 60 s 720p HEVC clip
  25.4 s; preview of that clip 3.2 s; a localhost fetch 1.7 s; first-time install 108 s for ffmpeg and ffprobe, 31 s for the yt-dlp
  environment.

## The coding role: its own model (CODE-STACK-01, slice S1, 2026-10-18)

Home's local-coding design (`local-coding-2026-10-17.md` in `getmaipai/home`, phase 1 scope `local-coding-phase1-2026-10-18.md`)
gives `coding` its own model. S1 is the role and its per-tier binding only; there is no process, lease, idle unload or wire yet.

**What S1 did.**

- `coding` is now an on-demand (`jit`) role with no `sharesModelWith`. It no longer runs on chat's process or model.
  `processRoleFor("coding")` is `coding`. Chat, the judge and the router are unchanged.
- Tiers: `coding` is `notAvailable` on p16 and p32 and `onDemand` on p64 and p128 (it was resident on p16, p32 and p64).
- Pin and binding on p64 and p128: `qwen3.8-27b-ud-q4-k-m`, Unsloth's `Qwen3.8-27B-UD-Q4_K_M.gguf` from
  `unsloth/Qwen3.8-27B-GGUF` at commit `4ca720788d1e01f1bff70c033e0d0028fd02e502`, 16,464,440,224 bytes, sha256
  `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482` (the repository's git-lfs oid, and re-hashed from the copy
  benchmarked on the Studio). Apache-2.0 (the repository metadata and the Qwen/Qwen3.8-27B card). Sampling is the Qwen card's
  Thinking Mode set (temperature 1.0, top_p 0.95, top_k 20, presence_penalty 0.0); the card has no coding-only set.
- The first-run plan (`/stack/v1/install-plan`) includes the model on p64 and p128 with `removable: true`, never on p16 or p32.
  Components treat it as optional, not required, so an admin can remove it in Settings; the disk plan has a `coding` row
  (`recommended`, so on by default and unticked to skip), and `diskPlanMeasured.json` carries its size.
- Honest state until S2: with the model installed the role reports `installed` (not loaded), and a request is refused with
  "No engine can be started for coding on this machine yet." because `coding` is not in the supervisor's `SPAWNABLE_ROLES`.
  Without the model it reports `notInstalled`. `engineArgs.ts` and the launch path are untouched.

**Decisions recorded by the owner, 2026-10-18.** The default coding model on p128 and p64 is Qwen3.8-27B UD-Q4_K_M. The keep-warm
default is 15 minutes (`coding.keep_warm_minutes`, S2). The 64 GB tier uses Splash in a later slice, unmeasured there, with the
memory governor refusing when it does not fit and llama-server as the fallback. The Splash engine kind is a later slice too.

**Still owed after S1.** S2 (below, done). S3: the wires `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses` (when the pinned
build serves it) and `GET /v1/models` for the role (closes STACK-60 and STACK-61). S4 and S5 per the Home backlog row.

### Slice S2: the coding engine on demand (CODE-STACK-01, 2026-10-18)

Stack only; no wires added. The coding role now has its own llama-server process.

**The planner's findings, checked in the code.** Confirmed: `lib/engineArgs.ts` line 90 hardcodes `"--reasoning", "off"` in
`llamaServerArgs` for every llama-server process; `lib/supervisor.ts` had `SPAWNABLE_ROLES` (line 132), `JIT_ROLES = ["vision"]`
(line 145) and `processRoleFor` (line 150), and the vision role is the pattern (jit admission, `yieldJitRolesTo`, unload callback);
`daemon.ts` line 100 used only the global `stack.runtime.idle_unload_minutes` (default 30); `lib/governor.ts` has `idleTtlSeconds: 600`
(line 10) and the idle limit `idleTtlSeconds + keepAliveSeconds` (line 448); the per-slot setting
`stack.engines.llama_server.slots` is shared by every llama-server role; `warmedRoles()` could not hold coding (`WARM_ORDER` is
chat, embed, judge, stt, tts), and S2 also filters it out. The S1 warning was right: the readiness check probed every role in state
`installed`, and a probe is a real request, so coding would have been started by every check and kept warm by it. One finding went the
other way: a resident engine's start unloads every loaded jit role first (`yieldJitRolesTo`, rule 4), coding included, so a chat
restart or heal unloads a loaded coding engine (it waits for a request in flight to finish). That is the existing resident-first rule
and is left alone.

**What S2 did.**

- `coding` joins `SPAWNABLE_ROLES` and `JIT_ROLES` (`processRoleFor` needed no change: the role has no `sharesModelWith`). It starts on the
  first request through the normal `getProcess`, with the same post-load check as every role (its probe sends
  `enable_thinking: false`, so a reasoning-on launch still passes).
- Launch: `codingServerArgs` in `lib/engineArgs.ts`, a separate builder; `llamaServerArgs` and every other role's args are
  unchanged (a test pins chat's exact list). The exact list, with the default settings on a 128 GB Mac:
  `--model <gguf> --port <free port> --host 127.0.0.1 -c 131072 -fa on -ngl all --reasoning on --reasoning-budget 2000 -ub 1024
  --no-webui --metrics --jinja --parallel 2 --kv-unified -ctk q8_0 -ctv q8_0 --offline`.
- **Flags verified against `llama-server` b10797 `--help`** (read only): `-c/--ctx-size`, `-fa [on|off|auto]`, `-rea/--reasoning
  [on|off|auto]`, `--reasoning-budget N` (-1 unrestricted, 0 immediate end, N>0 budget; env `LLAMA_ARG_THINK_BUDGET`), `-np/--parallel`,
  `-kvu/--kv-unified`, `-ctk/-ctv` (q8_0 allowed), `--offline`, `--jinja`, `--metrics`, `--no-webui`, `-ub`, `-ngl`, `--host`.
  **Not verifiable without loading a model:** (1) whether a per-request thinking budget is accepted by this build (`--help` lists only
  the launch-level `--reasoning-budget`), so the launch-level budget carries the ceiling and S3's per-request clamp is a clamp on what
  the client asks (a lower request budget is S3's to prove against the build); (2) that `--kv-unified` with `-np 2` gives one shared
  128k pool as the help text says ("single unified KV buffer shared across all sequences"): without it, an explicit `-np 2` splits
  `-c` into two 64k windows, because the help says unified is only the default when slots are automatic; (3) `--cache-reuse` is left
  out of the coding launch (chat uses 256) because KV shifting is unmeasured on this model, and the engine's prompt cache and context
  checkpoints stay at their defaults; S4's bench decides whether to add it; (4) that Qwen3.8-27B starts and answers with `--reasoning on`
  under this build: the Studio trial used Splash and a different llama.cpp build, so the first real run is still owed (CODE-BENCH-01).
- Settings, declared in `settings.ts` under a new section `engines.coding` ("Coding engine"): `stack.engines.coding.keep_warm_minutes`
  (15, 1 to 1440, advanced, live), `.thinking_budget_ceiling` (2000, 0 to 32768, advanced, needs restart), `.slots` (0 = tier default:
  2 on p128, 1 on p64; advanced, needs restart) and `.context_length` (131072, expert, needs restart; the window the start asks for).
  The generic `engines.llama_server.*` settings are not read by the coding launch.
- **Window fit.** The start asks for `context_length`, then steps down 98304, 65536, 49152, 32768 until the engine's own dry run
  (`llama-fit-params` at q8_0 and flash attention, the same `peak-source` dry run every start logs) fits what the governor can admit now
  without evicting anything (`admissionRoomBytes()`: the model budget less what is loaded, and free memory less the tier's margin). With
  no dry run it falls back to the file size times the governor's 1.3.
- **Lease.** A request in flight counts in `activeRequests`; the governor's unload callback (`unloadJitForGovernor`) declines while it is
  above zero, so neither the keep-warm clock, a pressure eviction nor a generator job can cut a coding answer off. The governor idle
  clock is touched at the start and at the end of every coding request, so keep-warm counts from the end of the last one.
- **Keep-warm arithmetic.** `stack.engines.coding.keep_warm_minutes` x 60 is set as the coding item's own idle limit in the governor
  (`setIdleTtlSeconds`), which replaces the 600 s jit limit for that item only; its `keepAliveSeconds` is 0, so the governor evicts when
  `now - lastUsedAt >= minutes x 60 s` (15 min = 900 s), found by a poll every 5 s: exactly the setting, at most 5 s late. The daemon's
  60 s idle tick gets `roleIdleMinutes: { coding: minutes }` and uses it in place of both runtime-wide limits (30 minutes, 10 on
  battery), so a keep-warm longer than 30 minutes is not cut short and battery does not shorten it; it is a backstop at the same limit
  (at most 60 s late). Changing the setting moves the loaded item's limit at once.
- **Governor.** A coding item is admitted as `jit` with `yieldsToGenerators`. While a generator job (picture, clip, song) is the head of the
  governor's queue and would be admitted if the yielding items were gone, the governor asks to unload them; coding declines while busy, so
  the job waits (its existing "waiting for memory" line) and goes in on the poll after the request ends. Residents are never asked: only
  items that declared `yieldsToGenerators` are. A job that coding's memory would not help is not made to evict it. Coding's own start is
  queued behind residents and running generators for up to 15 s, never evicts anything, then fails with
  `The coding model needs about X GB to load, and this computer has Y GB free after keeping Z GB back. Chat and the other always-on models
  stay loaded. Wait for the picture, video or song job to finish, or close a large app, then send the request again.` (or the model-budget
  variant naming "Memory for models"). A refusal leaves the role `installed` with that reason, not `offline`, retries after 3 s, and
  self-heal never restarts it (`coding` joins vision and the picture engine as on-demand).
- **Readiness and status.** The readiness check never probes coding (`runCheck()` skips it; an explicit `roleIds: ["coding"]` reports it
  skipped), so it is neither started nor kept warm by the check. `GET /stack/v1/roles` is unchanged for every role and the coding row
  gains an additive `coding: { state, keep_warm_minutes, idle_seconds, slots, slots_busy, cannot_fit_reason }`; `state` is `notInstalled`,
  `installed` (on disk, unloaded), `loading`, `ready`, `busy` or `offline`, and the role's own `state` keeps the spec's enum (`loading`
  shows as `loaded`). `cannot_fit_reason` (also the row's `reason` while `installed`) is the last memory refusal, or a model whose
  estimated peak is over the model budget outright. `warmedRoles()` excludes coding.

**Still owed.** S3: the wires `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses` (when the pinned build serves it),
`GET /v1/models` role-scoped, and the per-request thinking clamp against `thinking_budget_ceiling`. S4: Home's side (the settings rows,
keys and the gateway) and the first real load on the Studio, which settles flags (1) to (4) above and measures the real peak so the pin
can carry a measured footprint. S5: the Splash engine kind. Not done in S2 and noted: the proactive fit hint does not run a dry run (it
is the file-size estimate against the model budget until a start has been refused); the memory watchdog's refusal text for guarded
starts still says "picture and video work" when it is what refuses a coding start, but the coding message replaces it for the person.

### Slice S3: the coding role's wires, model list and thinking clamp (CODE-STACK-01, 2026-10-18)

Stack only. The Home gateway (`/code/v1`, CODE-API-01) calls what this slice built.

**Which wires the pinned build serves, and how that was checked.** llama-server b10797 (`engines/llama-server/b10797`, read only; no model
was loaded). The `llama-server` file is a 33 KB launcher; the server code is `libllama-server-impl.dylib`. `strings` on it lists the route
literals `/v1/messages`, `/v1/messages/count_tokens`, `/v1/responses`, `/v1/responses/input_tokens`, `/v1/chat/completions`,
`/v1/chat/completions/input_tokens`, `/v1/models`, plus the converter strings "Request converted: Anthropic -> OpenAI Chat Completions",
`server_chat_convert_responses_to_chatcmpl`, the Anthropic block names (`tool_use`, `tool_result`, `tool_use_id`, `input_schema`,
`thinking`, `budget_tokens`) and the Responses events (`response.created`, `response.output_text.delta`,
`response.function_call_arguments.delta`, `response.completed`, `response.reasoning_text.delta`). So **all three are served**: Messages,
its count_tokens, and Responses. `--help` lists no flag for any of them (they are always on). Responses refuses `previous_response_id`
("llama.cpp does not support 'previous_response_id'") and skips tool types it cannot run ("unsupported Responses tool type ... skipped"),
so a Responses client must send its whole history each time. What `strings` cannot prove: that a real Claude Code or Codex CLI turn
completes, and what the engine does with Qwen3.8's template (still owed, below).

**The routes** (all in `routes/v1.ts`, all `model`-routed: `coding` or the coding model's id, the same mechanism as `chat` and `embed`;
there is no role header in the existing mechanism and none was added):

| Route | What it does |
|---|---|
| `POST /v1/chat/completions` | unchanged; for `coding` it now also gets the thinking clamp |
| `POST /v1/messages` | Anthropic Messages, streaming and not |
| `POST /v1/messages/count_tokens` | Anthropic token count (no sampling, no clamp) |
| `POST /v1/responses` | OpenAI Responses, streaming and not |
| `GET /v1/models?role=coding` | the coding role's one served model: `id`, `owned_by`, `role`, `context_length` (the running engine's window, else the one the next start asks for), `thinking_budget_ceiling`; `data: []` when none is installed; never starts the engine. Another `role` is a 400; no `role` is the old list. |

`ROLES.coding.endpoints` lists the four POST paths. A role other than `coding` on the three new paths is a 400 naming `coding`.

**Pass-through.** The Stack does not translate. A stream is the engine's bytes through `streamRole` (a test cuts the frames mid-line and
asserts byte equality for Messages, Responses and chat completions, thinking blocks, tool calls, usage and finish reasons included); the
engine's content type is kept, so an engine error on a stream is JSON, not mislabelled SSE. A non-stream reply is the engine's JSON
through `requestRole`, which parses and re-serialises it (equal in value, not guaranteed in whitespace; the existing client does this for
every role). The Stack maps only: the coding lease and heavy-job gate, cancellation (a dropped client aborts the engine request; 499),
errors (an engine that cannot start or cannot fit is a 503 with `offline_reason`, as for every role), and a wire the engine does not
serve. Engine-supplied 4xx pass through unchanged.

**An unserved wire is a 501.** `lib/codingWire.ts` holds `ENGINE_CODING_WIRES` (llama-server: all three). The route asks
`codingEngineName()` and answers 501 with "The coding engine (X) on this computer does not serve ... Use /v1/chat/completions instead, or
ask an admin to update the coding engine." before the engine can start; an engine that answers 404 for a path is mapped to the same 501.
S5 adds the Splash row when its wires pass the contract suite.

**Sampling (item 3, fixed).** `samplingFor` in `supervisor.ts` replaces the two inline `withPinSampling` calls. For the coding role, on
`/v1/chat/completions`, `/v1/messages` and `/v1/responses`, streaming or not, the client's sampling is dropped and the pin's is set. Dropped
fields: `temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `frequency_penalty`, `repeat_penalty`, `repeat_last_n`, `typical_p`,
`mirostat`, `mirostat_tau`, `mirostat_eta`. Set from the pin (Qwen card thinking set): `temperature` 1.0, `top_p` 0.95, `top_k` 20,
`presence_penalty` 0.0. Not touched: `seed`, `stop`, `logit_bias`, `max_tokens` and the other output limits, `tools`. The token-count paths
carry no sampling. Every other role keeps its old rule exactly (pin fills only gaps; non-streaming only on `/v1/chat/completions`, streaming
on any path), pinned by a test: applying it to `/v1/tokenize` or `/apply-template` would have put sampling on bodies that take none.

**The thinking clamp (item 4).** First, what the build does: `strings -a` on `libllama-server-impl.dylib` shows the Anthropic converter
reading `thinking` / `enabled` / `budget_tokens` and writing `thinking_budget_tokens`, and the chat parser reading `enable_thinking`,
`chat_template_kwargs`, `reasoning_effort` and `reasoning_budget_tokens` beside `reasoning_budget_start_tag` and `_end_tags`. So the build
has a per-request thinking budget field (`thinking_budget_tokens`), in addition to the launch flag. Whether a request value below the launch
value is honoured, and whether Qwen3.8's tags make the budget sampler end thinking cleanly, only a real run settles. So the design is
safe either way: the launch-level `--reasoning-budget` is the ceiling (S2), the Stack clamps what the request asks, and no request can
exceed the launch budget even if the field were ignored. Behaviour of `clampThinking` (`lib/codingWire.ts`, applied by the route on
chat completions, Messages and Responses for `coding`):

- `thinking_budget_tokens` and Anthropic `thinking.budget_tokens` become `min(requested, ceiling)`; `-1` (unrestricted) becomes the ceiling;
  0 stays 0; a non-number is a 400 ("... must be a number of tokens ...") and never reaches the engine.
- An absent budget stays absent. The Stack never adds a budget, a `thinking` block or `enable_thinking: true`. (S3 passed
  `thinking: {type: "disabled"}` untouched; the real run showed the engine ignores it, so S3b adds `enable_thinking: false` as a
  kwarg in that case, below.) A request cannot turn thinking on where the caller turned it off.
- If the clamped budget would reach the request's own `max_tokens` / `max_completion_tokens` (Anthropic needs budget < max_tokens), the
  budget is lowered to one under it. The output limit itself is never changed. (The task text said to clamp `max_tokens` to `min(requested,
  ceiling)`; that would cut a long code answer to the thinking ceiling, so the budget moves instead of the limit.)
- The ceiling is `stack.engines.coding.thinking_budget_ceiling` as in effect, which is also what the engine was launched with: the setting
  needs a restart, and a change is pending until the coding engine next starts. The clamp and the launch budget therefore always agree.
- **Minors.** The Stack has no age signal and must not guess one. Home sends thinking off for a minor (`thinking: {type: "disabled"}` or
  `enable_thinking: false`); the Stack makes an explicit off real (S3b) and never raises a budget. Home's gateway (CODE-API-01) owns sending it.
  An omitted `thinking` on an engine launched with `--reasoning on` means thinking runs under the ceiling, so the gateway must always send
  the explicit off for a minor rather than rely on omission.
- Not clamped: `reasoning_effort` and Responses `reasoning.effort` (they pick a template level, not a token count; the launch budget still
  bounds the answer).

**Tests.** `tests/codingWires.test.ts` (31 tests, scripted engine only): each wire streaming and not, byte equality of frames, tools and
thinking blocks, the first request starting the engine and the second not, abort of a non-stream and of a stream reaching the engine and
releasing the lease, 503 for an engine that cannot start or fit, 501 without starting, 404-to-501, the scoped model list, the sampling fix on
all three paths both ways, the other roles' sampling unchanged, the clamp (above, below, absent, disabled, -1, 0, the live ceiling, the
output-limit rule, a bad type), chat untouched. `tests/roles.test.ts` pins the coding endpoint list.

**Still owed.**

- **S4:** remove a whole engine build (Home's "remove" for the coding engine).
- **S5:** the Splash engine kind, with ENGINE-SPLASH-01's contract suite; then a Splash row in `ENGINE_CODING_WIRES`.
- **C1 and C2:** the catalog engine-index entry and the catalog model package for coding.
- **Home slices H1 and H2** (settings rows, keys, the `/code/v1` gateway, CODE-API-01 and -02), including always sending thinking off for a minor.
- **The live run with the real 27B on a scratch Stack** (never on the live Mac's ports). It settles, from S2: the `--reasoning on` start of
  Qwen3.8-27B under this build, `--kv-unified` with `-np 2` giving one shared 128k window, the real peak. From S3: that a real Claude Code
  turn and a real Codex CLI turn complete against `/v1/messages` and `/v1/responses` (tool_use round trips, thinking blocks, usage);
  that a per-request `thinking_budget_tokens` below the launch budget is honoured and one above it is not; that the Anthropic converter
  carries `thinking.budget_tokens` to `thinking_budget_tokens` as the strings suggest; that Responses with `reasoning.effort` and no
  `previous_response_id` works; that the 128k window holds with `/v1/messages` prompt caching fields ignored; and that `count_tokens` is
  accurate for the Qwen template.

### Slice S3b: defects found by the first real-model run (CODE-STACK-01, 2026-10-18)

A scratch Stack on its own port loaded the real Qwen3.8-27B UD-Q4_K_M (llama-server b10797) and exercised the S1 to S3 code. What it
measured: a cold start of 2.3 s with the weights in the page cache (first token of a streamed chat completion at 2.29 s), decode at
27.6 tokens/s on llama-server Q4 (Splash measured 124 tokens/s on the Studio, which is why S5 exists), a 21.8 GB footprint (the dry run
said 21,916,286,976 bytes), and live chat latency up 57 percent (median 0.86 s to 1.35 s) while the coding engine generated. The run
also found six defects, all fixed here; the tests use the scripted engine only.

1. **Thinking off was ignored on `/v1/messages`.** The engine's Messages converter does not read `thinking: {type: "disabled"}`, but
   `chat_template_kwargs: {enable_thinking: false}` works on `/v1/messages` and `/v1/chat/completions`. `clampThinking` now merges
   `enable_thinking: false` into the caller's `chat_template_kwargs` (the caller's other keys stay) when the caller turned thinking off:
   Messages `thinking.type: "disabled"`, `chat_template_kwargs.enable_thinking: false`, `reasoning_effort: "none"` (chat) or Responses
   `reasoning.effort: "none"`. Everything else in the request is untouched; the Stack still never adds `enable_thinking: true`, never adds
   a budget or a `thinking` block, and a conflicting `enable_thinking: true` beside an explicit off loses to the off. This protects minors:
   Home sends an explicit off for them and the Stack makes it real. `strings` on `libllama-server-impl.dylib` shows `enable_thinking`,
   `chat_template_kwargs`, `reasoning_effort` and `effort`, but not which route reads which, so **whether the Responses converter carries
   `chat_template_kwargs` through, and whether `reasoning.effort: "none"` alone turns thinking off, is unproven until a real Responses
   request is made**; the Stack forwards the kwarg on all three wires and the live check must confirm the Responses one.
2. **The coding engine yields to chat.** See "How the yield works" below.
3. **`--alias`.** The engine reported the model file's path as the model in Anthropic and Responses replies. The coding launch now carries
   `--alias <pin id>` (`-a, --alias STRING` in `--help`), so replies say `qwen3.8-27b-ud-q4-k-m`. The exact-args test pins the flag.
   `/props` `model_path` (the Stack's identity check) is a different field and is not changed by the alias; confirm in the live run.
4. **`GET /stack/v1/roles` filled the context fields for chat only.** The loaded coding row now carries `context_length`,
   `context_per_slot`, `context_total`, `slots` and `context_scope` from the running engine: window 131072, one KV pool shared by the slots
   (`--kv-unified`), so `context_scope` is `"total across slots"`, `context_per_slot` is the window (one request may use all of it) and
   `context_total` is the window, not the window times the slots. They are null while the engine is not loaded, as chat's are.
5. **Admission was skipped for a model path without `.gguf`.** The store keeps an imported model at
   `.../imports/<pin id>/<sha256>` with no extension, so `codingContextFor` never ran the dry run (`llama-fit-params`) and sized the
   start from the file size alone. The dry run now runs for any model path the pin resolves to. (The same extension test remains in the
   fit hint and the chat launch; those are other roles and unchanged.)
6. **`previous_response_id`.** The engine refuses it with a sentence naming llama.cpp. The Stack now refuses a non-null
   `previous_response_id` on `/v1/responses` itself, before the engine is started: HTTP 400, "This coding service does not keep earlier
   responses. Send the whole conversation with every request."

**How the yield works.** The coding engine reuses the isolation gate (ISOLATION-01, `lib/heavyGate.ts`), the mechanism that stops a
music or picture worker while chat runs. While a coding request is in flight, the supervisor holds one gate lease on the coding
process (one lease however many requests run at once; it exists only while at least one is in flight). The lease asks the gate for
three things the job workers do not use: it yields to every interactive request except coding's own (`chat`, `vision`, `router`,
`stt`, `tts`), with its own tail, so a coding request never holds the engine stopped; its pause is bounded at 120 s
(`STACK_ISOLATION_CODING_MAX_PAUSE_MS`); and it can be turned off live. Mechanics:

- A chat request starts: the gate sends SIGSTOP to the coding process (`isolation.paused`, role `coding`). The process keeps its memory
  and its KV cache; the answer in flight stalls and the client's connection stays open.
- Chat ends and stays quiet for the 4 s tail (`STACK_ISOLATION_TAIL_MS`): SIGCONT (`isolation.resumed`). A chat inside the tail keeps
  it stopped, so the gaps between the rounds of one turn do not flap it.
- **Bound.** One pause lasts at most 120 s. Then the process is continued by force (`isolation.resume_forced`), runs for 60 s
  (`STACK_ISOLATION_FORCED_RUN_MS`, the music rule) and is stopped again if chat is still busy. In a long chat burst coding therefore
  runs about a third of the time; it is slowed, never starved.
- **Splash bound (2026-10-19, real run).** Splash probes its native child every 10 s and restarts it, failing the in-flight request, when the child is stopped for about 30 s. So while Splash serves coding the pause is bounded at 20 s (`STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS`), then the forced resume and the 60 s run follow as above. llama-server keeps 120 s. A real run showed a 20 s stop recovers and a 45 s stop fails the answer.
- **A request that arrives while chat is busy** follows the music rule: the engine starts if it was not loaded (the start is not
  paused, because the lease attaches after the post-load check), the request attaches the lease and the process is stopped at once, then
  continued at chat's quiet moment. An already loaded engine is stopped before it works.
- **No timeouts, no false failures.** The 10-minute completion limit on a non-streaming coding request counts only the time the process
  could run (`withActiveTimeout`); a stream has no limit. Every path that checks the engine's health after an error continues the
  process first, because a stopped process cannot answer `/health` and a failed check retires an engine. A client that cancels a stopped
  stream ends the request, which detaches the lease and continues the process at once.
- **Keep-warm and the lease.** The lease exists only while a request is in flight, and an in-flight request already blocks every unload
  (S2), so a stopped answer is never unloaded, and the keep-warm clock, which restarts when the request ends, never runs through a pause.
  `lastRealRequestAt` and the governor's idle clock are set at the end of the request, as before.
- **Safety.** The gate still never stops an engine the supervisor runs: the protected-pid list shields them all. Only the handle the
  supervisor makes for the coding process (`new PausableProcess(pid, exited, { engine: true })`) is allowed, and the supervisor's `stop`
  continues it before the SIGTERM (a stopped process holds a signal). Every way out of the gate continues it first: the request ending,
  `heavyGate.resumeEverything` at the Stack's shutdown and exit, the pause bound, and `isolation-paused.json` for a Stack that was
  killed while the engine was stopped (the next start continues it if the pid is still the same command).
- **Setting.** `stack.engines.coding.yield_to_chat` (boolean, default true, advanced, live, section "Coding engine"). Off: the engine is
  never stopped, and turning it off continues an engine that chat has stopped at once. `STACK_ISOLATION=off` also turns the yield off.
- **Not changed:** chat, the other roles, music/picture/video behaviour, S2's keep-warm arithmetic, the model pin. A coding request is
  still interactive for the heavy jobs (it stops a music job, as before). Observability is the existing mechanism: the `isolation.*` log
  lines and the `isolation` object on `GET /stack/v1/memory`; the role row stays `busy` while the engine is stopped mid-answer.

**Tests.** `tests/codingYield.test.ts` (23, fake workers, short real timers through the gate's own environment knobs, plus `sleep`
children for the signal safety test): stop on chat start and continue after the tail; each interactive role yields it and the
background roles do not; coding's own requests never stop it and never hold it stopped; overlap and tail without flapping; arrival
during chat; the pause bound, the forced run and the second stop; a long burst leaves coding a share; the setting off, off while
stopped, and its declaration; paused time is not idle time; the completion limit ignores paused time and still fires otherwise; two
requests share one lease; stream cancel while stopped; health after an error; chat and idle coding untouched; `STACK_ISOLATION=off`;
shutdown continues it; the protected-pid rule with and without the coding handle. `tests/codingWires.test.ts` gained the thinking-off
tests for each wire, the merge, the never-on rule, the non-object kwargs 400, and the `previous_response_id` refusal;
`tests/codingEngine.test.ts` the exact args with `--alias`, the roles-row context fields and the extension-less dry run.

**Known and left alone (client-compatibility items to test with real Claude Code and OpenCode).** `/v1/messages` accepts a request
without `max_tokens`; the Messages `id` prefix is `chatcmpl-` and thinking blocks carry an empty `signature`; both are the engine's own
output and passed through as the Stack's S3 rule says.

**Only a real run can settle.** That the stop-and-continue of a llama-server that is generating on Metal brings live chat back within
10 percent of its idle latency (the design bar; 57 percent before this slice) and that decode resumes without a stall or error after
a pause of up to 120 s; that the Responses converter honours `chat_template_kwargs.enable_thinking: false` (item 1); that `--alias`
leaves `/props` `model_path` and the identity check alone (item 3); that the dry run's figure for the extension-less path matches the
21.9 GB seen (item 5); the Splash decode speed against 27.6 tokens/s (S5).

### Slice S5a: Splash is the coding engine on Apple silicon (CODE-STACK-01, 2026-10-18)

Stack only; tests use the scripted engine and a stand-in for Splash's process tree, never a real model. Catalog C1 (Splash 1.3.2 in
`engines/index.json`) had landed. The measured reason: Splash serves the same Qwen3.8-27B weights at about 124 tokens/s against 27.6 on
llama-server b10797, 10 of 10 on the coding suite, and it ran clean offline (home `docs/plans/local-coding-phase1-2026-10-18.md`).

**What was found about Splash's store (the hard question).** Read from the release archive's `install/*.py` and `server/*.py`, then
proved once on this Mac. Splash can run entirely from files the Stack lays out; it needs no Splash-managed download, so the Stack's pin
rule holds.

- (a) **A Stack-laid hub cache works.** `install/hub.py` reads `huggingface_hub.constants.HF_HUB_CACHE`, so `HF_HUB_CACHE` (or `HF_HOME`)
  names the cache. It reads `models--<owner>--<repo>/snapshots/<commit>/<file>`. A target named with `--revision <40-hex commit>` needs no
  `refs/` entry and no Hub request (`Repository.resolve` returns the cached snapshot when `HF_HUB_OFFLINE` is set; `_cached_commits`
  returns a hex revision as it is). The draft is found by `refs/main` (`_cached_commits` with no revision reads `refs/main`). A blob that
  sits at `blobs/<64-hex sha256>` is described by that name; Splash does not hash it (`assembly._digest`), so a 16 GB model is not read
  again. A blob under any other name is hashed once, when the assembly is built.
- (b) **State is relocatable.** `install/paths.py` puts everything at `Path.home() / "Library/Application Support/Splash"` (`models/`,
  `runtime/`), `server/thinking.py` puts `thinking.key` there too, `server/crash_trace.py` writes `Library/Logs/Splash`. All follow `$HOME`.
  The SSD cache's temporary files follow `TMPDIR` (the start line printed the folder). `--cache-dir` only applies to `--persistent-cache`,
  which the Stack leaves off.
- (c) **A fresh state folder assembles and starts with `--offline`.** `--offline` sets `HF_HUB_OFFLINE=1`; the first start assembles the
  model from the cache into `HOME/Library/Application Support/Splash/models/.resolved/<hash>` (links to the snapshot files, a record,
  the GGUF's metadata and tokenizer, which Splash derives from the GGUF itself, so no second repository is needed). It does not need an
  already assembled install.
- (d) **The draft.** `incoai/Qwen3.8-27B-DFlash2` at commit `015e795645c74b1a0eeef3b570031fb62e769bc5`, Apache-2.0 (HF API, 2026-10-18),
  two files: `config.json` (1,239 bytes, a git blob, sha256 `873e3556509b…` hashed from the download and the local copy) and
  `model.safetensors` (3,848,817,896 bytes, sha256 `67fc76d68dc5…` = the LFS oid, confirmed by the HEAD request's `x-linked-etag`).
  `README.md` and `assets/` are not needed.

**The one real test** (scratch folders under the session scratchpad; the Stack's pinned GGUF and the draft hardlinked into a hub cache laid
out as above; `HOME`, `TMPDIR`, `HF_HUB_CACHE` pointing there; `HF_HUB_OFFLINE=1`, `DO_NOT_TRACK=1`; run under `sandbox-exec` with a profile
that denies every network operation except loopback; port 8895; 128 GB Mac with about 40 GB free). `python3 -u install/launcher.py serve
--model unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M --revision 4ca72078… --offline --host 127.0.0.1 --port 8895 --language-only
--served-model-name qwen3.8-27b-ud-q4-k-m --default-reasoning-effort medium --thinking-token-budget 2000 --max-cache-disk 8G --no-webui`:
the log said "Could not reach the Hub (HF_HUB_OFFLINE is set); installing … from the Hub cache", selected the GGUF, "Installing …
draft incoai/Qwen3.8-27B-DFlash2; vision disabled", loaded the weights in 2.5 s and reached `Ready` in 8 s from a fresh state folder, with
the SSD cache in the scratch `TMPDIR`. `/v1/models` listed the loaded id and the served name, owned by `splash`; a chat request answered 391 for
17 times 23 with the reasoning separated; a second request ran at 112 tokens/s (284 tokens); `/v1/messages`, `/v1/responses` and
`/v1/messages/count_tokens` each answered 200 to a plain request. With the server and its native child stopped (SIGSTOP to both pids) a
request timed out and `/health` answered again after SIGCONT. SIGTERM to the server ended both processes within 3 seconds. The process
tree is two processes: the Python launcher, which `exec`s into the server, and `engine/splash serve-native` as its child (the child's parent
is the server). Nothing was left running afterwards. What the test did not cover: the governor's memory reading of the tree, the Splash tool
turns, thinking blocks and streaming shapes on the wires (the engine contract suite is still owed).

**What the Stack lays out** (`lib/splashStore.ts`). Under `data/splash/`: `hub/` (the cache Splash reads), `home/` (Splash's `HOME`) and
`tmp/` (its `TMPDIR`, emptied at every launch). At every Splash launch `layOutSplashCache()` checks the pins and links them in, cheap and idempotent:

- The target is `models--unsloth--Qwen3.8-27B-GGUF/blobs/<sha256>`, a **hardlink** of the file the Stack verified (`data/models/imports/<id>/<sha256>`),
  with `snapshots/<commit>/Qwen3.8-27B-UD-Q4_K_M.gguf -> ../../blobs/<sha256>` and `refs/main`. The draft is `models--incoai--Qwen3.8-27B-DFlash2/`
  with both files the same way. Never a copy: if the volume refuses a hardlink a symlink is used (Splash then hashes the file once at
  assembly); if that fails too, the launch is refused in plain words and the request goes to llama-server.
- It refuses, in plain words naming the next step, when the coding model or the draft is not installed and verified, is not the pinned
  sha256 or revision, or a file is not the pinned size. Splash never sees a file the Stack has not pinned. Hashes are the Stack's downloader's
  (`installCatalogModel` verifies every file of the draft; a wrong byte fails the install and raises the existing checksum health item).
- Anything else in the two repository folders (an earlier pin's snapshot or blob) is removed, so the cache holds exactly the pins.
- `removeModel` of the coding model or the draft removes `data/splash/` (`releaseSplashLayoutFor`), so the disk is freed (a hardlink keeps the
  bytes alive otherwise). The pinned file itself is never removed by that.

**The pins.** `SPLASH_PIN` in `engineCatalog.ts` (name `splash`, tag `1.3.2`, darwin arm64, the Catalog entry's url, sha256 `c3deb1dd…` and
74,590,927 bytes; `tool` is `engine/splash`, which proves the install; the installer flattens the archive's one top folder, leaving
`engine/`, `python/`, `install/`, `server/` in `data/engines/splash/1.3.2/`), installed by the existing installer
(`POST /stack/v1/engines/splash/install` with no body) with the sha256 verified by the downloader. `STACK_CODING_DRAFT_MODEL`
(`qwen3.8-27b-dflash2-draft`, role `coding`, `component: "draft"`, engine `splash`, a directory model of the two files above) is named by the
coding model's new `companions` field. The first-run plan and the components list add it beside the coding model, removable with it, where
Splash can run: Apple silicon on p64 and p128 and not a chip known to be older than an M3 (an unread chip counts as possible, so
`docs/disk-plan.json` is the same everywhere). The disk plan's `coding` row grows from 16.5 to 20.3 GB and its note says why. The draft is a
component: never selected, never the role's model, and only Splash reads it.

**Which engine runs** (`lib/splash.ts`, `activeCodingChoice()` in the supervisor). `engineForRole("coding")` is `splash` when all of these hold
and `llama-server` otherwise: the setting `stack.engines.coding.engine` is not `llama-server`; the machine is darwin arm64 with an M3 or newer
chip (`detectAppleChip()` reads `machdep.cpu.brand_string` once at the daemon's start, because core's `HardwareInfo` has no chip field), at
least 36 GB, macOS 26.4 or later, and the tier is p64 or p128; the Splash build is installed; the coding model and the draft are installed;
no Splash start has failed this run. Unread facts (no daemon start) refuse Splash. `ENGINE_ROLE` and `engineRole` map `splash` to `coding`
(both needed the entry; `engineRole` defaults unknown names to `chat`). The model records are chosen without an engine filter for `coding`,
because one GGUF serves both engines (`recordEngineFor`).

**The launch** (`splashArgs()` in `engineArgs.ts`, `splashLaunchPlan()` and `splashEnv()`): the bundled `python/bin/python3 -u install/launcher.py serve`
with `--model <repo>:<variant from the pin> --revision <commit> --offline --host 127.0.0.1 --port <free> --language-only --served-model-name
<pin id> --announce-served-name --default-reasoning-effort medium --thinking-token-budget <ceiling> --max-context <window> --max-cache-disk
<splash_cache_gb>G --idle-release off --no-webui`. No `--api-key` (loopback), no `--persistent-cache`, no `--draft-model` (Splash pairs the
Qwen3.8-27B family with the draft in the cache, the one tested), the Neural Engine left on (the benchmark's setting; it is local compute).
`--max-context` can only lower Splash's own limit and keeps the window the `/v1/models?role=coding` route reports. `--idle-release off` leaves
keep-warm to the Stack (Splash's default frees the weights after 10 minutes while the Stack would still count them). The environment is the
Stack's minus its secrets, `HF_TOKEN`, `HF_ENDPOINT`, `SPLASH_API_KEY` and any `PYTHON*`, plus `HOME`, `HF_HOME`, `HF_HUB_CACHE`, `TMPDIR`,
`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`. The llama-server coding launch is unchanged.

**Readiness and identity.** The health path is `/ready` (503 until the model is loaded; the server binds first and accepts only when the runtime
is ready). Then `verifySplashServes()` reads `/v1/models` and requires the pin id, owned by `splash`; then the existing one-token post-load
completion; then the existing identity check against the file the Stack linked (Splash has no `/props`, so the plan carries the identity,
as oMLX's does). Splash answers 404 to a model name it does not serve and the coding wires carry the role name, so every request to it goes
through `ServedNameClient`, which renames `model` to the pin id. An engine that answers a wire path with 404 is still mapped to the 501; the
Splash row of `ENGINE_CODING_WIRES` is true for all three wires from the smoke test above.

**Memory.** There is no `llama-fit-params` for Splash, so the governor's figure is an **estimate** (`splashFootprintEstimateBytes`): the weights plus
the draft times 1.08, plus 8,192 bytes per window token (23,012,060,594 bytes at 131,072 tokens, 21.4 GiB), calibrated on the one reading
(the 27B Q4 with its draft ran at about 21 to 23 GB on the Studio). It is not measured on a 64 GB Mac. It enters the governor as the dry-run
figure (the log's `governor.peak-source` says `splash-estimate`), the request is admitted as a `jit` item that yields to generators like
llama-server's, and after the post-load check the governor's figure becomes the reading of the whole process tree, which is never stored on the
model (the stored footprint belongs to the llama-server run of the same pin). The governor's runaway watch reads the tree too.

**Fallback and health** (`startCodingWithFallback`, the voice and chat fallback pattern). A Splash start that fails (a crash, a layout it cannot
make, an engine that does not serve the model, a refusal for memory) goes to llama-server for the same request, raises the warning
`coding.engine-fallback` ("Splash did not start; coding is on llama-server": the reason, that coding is using the slower engine, and what to do),
and, unless it was only a refusal for memory, keeps coding on llama-server until the coding engine is restarted (`recycleRole` clears the
memory). A refusal for memory is not held against Splash. A forced `splash` on a Mac that cannot run it gets one warning with the reason; `auto` on
such a Mac says nothing. The warning clears when a Splash start works. `GET /stack/v1/roles` `coding` gains `engine`, `engine_requested` and
`engine_reason`. The engine list marks the running Splash build; the rollback fix and `PUT /engines/splash/current` drain the coding engine and leave
the next request to start the new build.

**Yield, keep-warm and the process tree** (`lib/processTree.ts`). Only the server's pid is the Stack's child, but only its native child works, so
the signals go to the tree: `PausableProcess({ engine: true, tree: true })` sends SIGSTOP to every descendant (deepest first) and the pid, and SIGCONT
to the pid and everything it holds at the resume (the paused pids are written to `isolation-paused.json` for a crashed Stack). The engine's
`stop` continues the tree, asks the root to stop, waits 8 s, then `TreeSnapshot.stopAll()` signals every remembered member that is still the
same command (SIGTERM, 5 s, SIGKILL); an unexpected exit of the root and a failed start do the same, so no orphan holds 20 GB. Keep-warm, the
lease and the 120 s pause bound are the S2 and S3b mechanisms, unchanged.

**Settings.** `stack.engines.coding.engine` (`auto`, `splash`, `llama-server`; advanced; needs a restart; section "Coding engine") and
`stack.engines.coding.splash_cache_gb` (0 to 64, default 8; expert; needs a restart). `slots` is reported for Splash and not enforced (Splash
queues 32 requests itself).

**Found along the way.** (1) The update check's `EngineIndexEntrySchema` accepted only `b<digits>` tags, so the whole engine index would have been
rejected ("did not match its declared shape") as soon as the Catalog published Splash (`1.3.2`); uv and ComfyUI already used version tags in the
Catalog's source. The pattern now matches the Catalog's own schema. `POST /engines/{name}/install`'s staging body still takes `b<digits>` tags
only, so a staged Splash build by URL is not possible yet. (2) Splash's 404 for an unknown model name (above). (3) Splash's default idle release (above).

**Tests.** `tests/codingSplash.test.ts` (33): the machine rules (M2, 32 GB, old macOS, wrong tier, unknown chip, forced engine), the choice and its reasons, the
failure memory, the pins, the exact launch list and environment, the estimate, the layout (hardlinks, refs, idempotence, stale pruning, refusals,
removal), the draft's hash verification through the real installer with a fake downloader, the readiness identity check, the renaming client, the
fallback (a failed start, a refusal for memory, both engines failing, a forced Splash on a Mac that cannot run it), the settings, the engine index.
`tests/splashTree.test.ts` (18): real `sh` and `sleep` trees for the pause, the resume, the gate's yield to chat, the kill and the no-orphan rules
(a root killed by SIGKILL, a member that ignores SIGTERM, a reused pid), and the real start path (`getProcess("coding")`) with a stand-in for
Splash (`tests/helpers/fake-splash.ts`, started through a fake bundled `python3`): the launch line and environment as Splash receives them,
the offline switches, the renamed model, the pause and stop of the whole tree, the stop of a started-but-wrong engine with no orphan, the
fallback warning, the governor admission by the estimate.

**Still owed.** S4 (remove a whole engine build). The real Splash engine contract suite (ENGINE-SPLASH-01: tool turns, timing fields, and the
remaining real-engine checks) and the Splash row of `ENGINE_CODING_WIRES` becoming a contract result. The Stack-side scripted contract in
`tests/splashContract.test.ts` now exercises scripted JSON and streaming responses for chat completions, Messages, count_tokens and Responses,
and verifies the served-name rename that avoids Splash's unknown-model 404 and the configured 20 s pause bound; `tests/splashTree.test.ts`
continues to cover real supervisor startup, readiness, pause/resume and fallback. These tests do not replace the real Splash run below. Client
compatibility checks (real Claude Code, OpenCode). Home H1 (Settings install and remove for the Splash engine and the coding model together,
calling `POST /stack/v1/engines/splash/install`) and H2 (push the settings). The privacy page row for the install-time downloads
(CODE-PRIVACY-01: the Splash archive from github.com, the draft from Hugging Face through the Stack's downloader). `docs/BACKLOG.md` in the home
repo records S5a as landed when the coordinator lands it.

**Only a real scratch-Stack run on Splash can settle.** That `--announce-served-name`, `--max-context 131072` and `--idle-release off` are accepted
by 1.3.2 as read from its option parser (the one real test did not pass them); that the real Splash answers the Stack's own probe, sampling fields
(`top_k`, `presence_penalty`), `chat_template_kwargs.enable_thinking: false` and a thinking budget on all three wires (it validates the fields it
receives); that `/ready` stays 503 until the model is loaded, so the start waits for it; the memory the governor reads for the tree (against the
23.0 GB estimate), on a 64 GB Mac and on the 128 GB one; the yield bringing chat back to its idle latency with Splash stopped mid-answer, and
decode continuing after a pause of up to 120 s; the fallback end to end by a Splash that cannot start for a real reason; and
that a hardlinked pin assembles without hashing (the blob name is its sha256).

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
2. **The second engine.** Settled 2026-10-17 (ENGINE-MLX-01): oMLX is the chat engine on p64 and p128, llama-server the fallback and the
   engine elsewhere; mlx-serve stays installable by name.

## Battle-tested checklist (for 1.0, empty until earned)

The Stack leaves 0.x with Home: when it has run the household hub for
a season without an unplanned restart, survived every update with
rollback proven at least once, and its measured profiles have matched
what a fresh install sees on three machines it has never seen. The list
grows here.

## An optional chat model: Qwen3.6-35B-A3B (MODEL-SWITCH-01, 2026-10-21)

Muse stays the chat pin on every tier above 24 GB (STACK-MUSE-01). Beside it
the Stack pins one optional chat model that no tier installs and Home offers
in Settings, AI models: `unsloth/Qwen3.6-35B-A3B-GGUF` at revision
`a483e9e` (Apache-2.0; mixture of experts, 35B stored and 3B active, 40
layers of which 10 hold a KV cache, 262144 context), file
`Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` (22,360,456,160 bytes) and the picture
file `mmproj-F16.gguf` (899,283,680 bytes), both with the repository's
git-lfs hashes. Ids: `qwen3-6-35b-a3b-ud-q4-k-xl` and
`qwen3-6-35b-a3b-mmproj-f16`.

- **Thinking.** The template reasons by default. Every chat launch already
  passes `--reasoning off`, so it answers at once; a request that sends
  `chat_template_kwargs: { enable_thinking: true }` thinks for that turn.
  There is no `/nothink` soft switch, so the record pins no template
  variable.
- **Sampling.** The card's non-thinking set (temperature 0.7, top_p 0.8,
  top_k 20, presence_penalty 1.5) fills what a request leaves out.
- **Launch.** The ordinary chat launch fits: every layer on the GPU, flash
  attention, `--jinja`, q8_0 KV cache, the projector with
  `--image-max-tokens 2560`. Measured on a 128 GB Mac Studio: 262144 context
  admitted, 27.0 GB resident, loaded in 8 s from a warm file cache.
- **Template check.** `/apply-template` shows the system message and the
  tools reach the model and tool calls parse. The template drops a system
  message that follows the first user message, so a caller must fold late
  system messages into the first (Home does: `foldLateSystemMessages`).
- **The chosen model survives a restart.** `POST /stack/v1/models/{id}/actions`
  with `load` now also writes `stack.engines.chat.model`; `selectedModel`
  reads it after the session's own preference. An uninstalled or unservable
  id falls back to the tier's model.

## An optional uncensored chat model: HauhauCS Qwen3.6 (2026-10-26)

A second optional chat model beside Qwen3.6-35B-A3B, installed only when an
admin chooses it in Home Settings, AI & Models, Chat, where Home shows an
"Uncensored" badge. No tier binds or downloads it, and the Stack adds no
screening code: Home's age and surface gates run in front of every model.
Replaced 2026-10-27 with HauhauCS's Qwen3.8-27B Aggressive GGUF, pinned to
revision `993a5971` (Apache-2.0 on the model card). The Q4_K_P weights are
17,923,393,664 bytes (SHA-256
`ba36dc3c2b2ff5e0aa5d71092a8894546996a6a119ae391803dda07cdc08516d`); the
BF16 image projector is 931,146,624 bytes (SHA-256
`5681b690bcb8eb10cd28d62d078cb4e01521a3ea4880a3fc7d54de72de2dd142`). The
model id is `qwen3-8-27b-uncensored-hauhaucs-q4-k-p`; its template defaults
thinking off, and the per-request switch can enable it. The publisher describes
this Aggressive variant as direct-answer with minimal preamble and no refusal
behavior. Tool use in Home remains to be measured.

## Diagnosing a failed picture (2026-10-27)

A picture that fails inside the worker used to leave only "The picture engine failed on that request": the worker's stderr is drained and never kept, because a traceback can carry a prompt (rule 6a). Now the worker sends a `diag` object with its failure reply (the exception type, the last eight frames as `file:line in function`, and the message only for missing-module, missing-file and missing-attribute errors, with the prompt blanked), and the Stack writes one `image.worker_failed` line to `data/logs/stack.log` with the family, the operation, the code and that `diag`. Find it with `grep image.worker_failed <data>/logs/stack.log | tail`. Nothing a person typed is in it. The 2026-10-27 outage (every ERNIE picture failing on a missing mflux module) would have read `ModuleNotFoundError ... mflux_worker.py:181 in build` there.
