# MaiPai Stack

MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller. Home's installer installs the Stack; a person never installs the Stack by itself.

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

Org standards apply and are auto-loaded from the parent directory
CLAUDE.md (source:
[getmaipai/.github](https://github.com/getmaipai/.github)). Refocused
2026-09-20 from a standalone product to Home's engine layer
(`.github/docs/DECISIONS.md`, both 2026-09-20 entries):
[docs/dev.md](docs/dev.md) is the design record,
[docs/integrations.md](docs/integrations.md) the contract Home and Bot
build against, and [docs/BACKLOG.md](docs/BACKLOG.md) what is built and
what is missing.

## Goals (what the Stack is for)

1. **One address by role.** Home asks for `chat`, `embed`, `stt`, `tts`,
   `wakeword`, later `image`, `video`, `music`, on an OpenAI-shaped
   endpoint, and never names an engine or a file. Every reply says which
   engine and model answered, in a header.
2. **The processes Home launches, and only those.** Spawned engines and
   managed sidecars behind one supervisor with post-load identity checks
   and restart. No adoption or governance of engines Home did not start;
   a server the person runs is at most a read-only URL binding.
3. **One residency budget on one machine.** Chat, embed, TTS, STT and
   wakeword coexist; a generator queues or is refused with a reason;
   admission is decided from kernel pressure and measured peaks, never
   file sizes.
4. **Provenance before selection.** Every engine build and model file is
   pinned by exact URL, revision and checksum, with licence recorded, and
   the previous build is retained so an update can roll back. The
   Catalog is the index; the Stack is the verifier.
5. **Honest state.** "Ready" means a recent request through the public
   route succeeded with the expected identity. Health is a list of
   problems with one fix each. An update is "installed X, available Y,
   last checked at T, go back".
6. **Same shape on every OS, Mac first, Linux for the robot.** One
   config, one API; service manager and engine builds differ per OS as
   org `SERVICES.md` lists.
7. **Nothing leaves the house.** Loopback only. Update checks and model
   downloads are the only outbound calls, opt-in, declared as data for
   Home's privacy page.

## Limits (what the Stack is not, and never grows into)

No user interface of any kind (Home's admin renders the Stack's state
from its declarations). No people, no clients, no keys, no LAN
exposure: the one caller is the Home process on the same machine. No
second copy of any Home fundamental. No apps, packages or extension
system. No general model search as an install promise. No public
release, standalone installer, docs site or brand pitch. No control of
other tools (Ollama, LM Studio, Msty are never governed, updated or
adopted; their files may be imported by verified copy after an explicit
choice). The moment something needs to know who is asking, it belongs
to Home.

## Ownership of fundamentals (one definition, one place)

Libraries live once in `getmaipai/shared` (`ui`, `core`, `spec`) and
every product imports them; the Stack houses no library. Services are
each owned by one product on the machine: Home owns every human-facing
one, the Stack owns the engines. This table is that rule applied.

| Fundamental | Stack owns | Home owns |
|---|---|---|
| API | The role routes (`/v1/*`) and the control routes (`/stack/v1/*`), Zod-typed, OpenAPI generated | Calling them; exposing anything to people or packages |
| Notifications | One SSE event feed | The notification system, its audiences and channels |
| Updates | Knowing engine and model versions; the drain, swap, post-load check and rollback when told to | The Updates page, the notice, the button, release notes, the schedule |
| Health | The problem list with one fix action per item, as data | Showing it, the Repairs list, the fix button |
| Settings | The declaration of every Stack setting, once | The generic renderer, the page, persistence of the person's choice |
| Sizing | Hardware probe, profiles, measured fit, the admission decision | Wording it for a dad, the "what your computer can run" page |
| Jobs | The generator queue (submit, progress, cancel, result) | Any UI over it |
| Backups | Declaring which state is precious | Taking, encrypting and restoring the backup |
| Privacy page | The list of its outbound endpoints, as data | The page |
| Install and service | Its own launchd/systemd unit, exit codes that mean what they say | Installing the Stack as part of installing Home; the watchdog above it |
| Auth | Loopback only | Everything |
| Logs and tracing | Structured logs to its own file, trace ids passed through | Log viewing, retention |

## Layout

`backend/` (Bun, Hono with `@hono/zod-openapi`, Zod, Drizzle/SQLite;
imports `@maipai/core` from a sibling `getmaipai/shared` checkout
pinned by tag, `core-v0.1.0` today, as a `file:` dependency in
`backend/package.json`; `@maipai/spec` joins it at RF-05), `docs/` (dev tier only:
`dev.md`, `integrations.md`, `BACKLOG.md`, `api/` generated, `plans/`
history), `scripts/check.sh` (the gate: the backend's typecheck, API
docs drift, tests, then the pinned `@maipai/standards` core, which
needs a sibling `getmaipai/.github` checkout at `../.github` or
`MAIPAI_STANDARDS_DIR`). A docs-only commit runs
`bash scripts/check.sh --docs`. `docs/api/openapi.json` is generated by
`bun run gen:api-docs` in `backend/` and checked for drift by the gate;
never hand-edit it.

Runtime data lives under `data/` and is never tracked. Every model or
engine the Stack uses is downloaded on demand, pinned and checksummed,
never vendored. The backend test suite runs under a temporary
`STACK_DATA_DIR` set by `backend/tests/preload.ts` and refuses a real
one.

## Safety posture

The Stack does not know who is asking, so it holds no safety policy of
its own and cannot weaken Home's: child safety, the adult
acknowledgment and the AI-outputs disclaimer live in Home, where people
exist. Nothing here may add a path around them, and nothing here can,
because every request reaches the Stack through Home.

## Privacy

Loopback only. The Stack's outbound endpoints (the opt-in update check
against the Catalog index, model and engine downloads) are declared as
data on `GET /stack/v1/privacy` and listed in
[docs/integrations.md](docs/integrations.md); Home's privacy page
renders them. Adding or changing an outbound endpoint updates the route,
that table and its guarding test in the same commit.
