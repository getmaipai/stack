# MaiPai Stack

MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller. Home's installer installs the Stack, and since 2026-11-21 a person may also
install and run the Stack by itself, with no Home (owner decision, below).

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
7. **Nothing leaves the house.** When Home runs on another computer at home, requests cross the home network, or the owner's own Tailscale network when an admin allows it, only inside that encrypted link.

## Standalone and admin exception (Owner-approved: 2026-11-21)

Jesse approved two changes to the limits below:

1. **A local admin interface.** One web page served by the Stack, one
   admin account (password set at first run, reset only by a local
   command on the machine), reachable on loopback and, when the admin
   switches it on, on the owner's own Tailscale address. Sign-in is
   always required; the network is never the login. It shows what runs,
   the configuration, restarts, settings and updates, through the same
   `/stack/v1/*` routes Home uses. It is for when Home is down or absent.
2. **Standalone use.** People who do not want MaiPai Home can install and
   run the Stack alone: choose which features (roles) run, which models,
   their priority and the tier, from the admin page. This allows a public
   release, a standalone installer, a README and docs site for the Stack,
   and a model picker over the pinned catalog. Pinning, checksums,
   loopback-by-default and "nothing leaves the house" still apply.

The limits below still hold except where this section says otherwise.
Open design questions (client keys for other apps, LAN exposure, model
search beyond the pinned catalog) are decided in
[docs/plans/admin-and-standalone-2026-11-21.md](docs/plans/admin-and-standalone-2026-11-21.md).

## Limits (what the Stack is not, and never grows into)

No user interface beyond the admin page above (Home's admin renders the Stack's state
from its declarations too). No people beyond the one admin, no end-user clients, no key material, no LAN exposure: the Stack listens on loopback only. Its one caller is the household's paired Home, on the same machine or on another computer in the same home that reaches this machine's loopback through the SSH link Home's installer sets up, with a key that can open this one port and nothing else. That other computer is on the household's home network or, only when an admin turns it on, on the owner's own Tailscale network; the SSH key and the pinned host key are the only authentication either way, never Tailscale access rules. Those keys belong to the operating system's SSH service and to Home, never to the Stack. The Stack keeps one record per connection, a paired Home or a custom MCP server (name, kind, how it reaches the Stack, state, last used; for a Home the key fingerprint), and can add, test, pause or remove one; it never stores a private key, and an MCP token goes only through its secrets mechanism, never into the record. (Owner-approved 2026-11-25.)
No second copy of any Home fundamental. No apps, packages or extension
system. No general model search as an install promise. No brand pitch
(the public release, standalone installer and docs site are allowed by the exception above). No control of
other tools (Ollama, LM Studio, Msty are never governed, updated or
adopted; their files may be imported by verified copy after an explicit
choice). The moment something needs to know who is asking, it belongs
to Home.

## Ownership of fundamentals (one definition, one place)

Libraries live once in `getmaipai/commons` (`ui`, `core`, `spec`) and
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
imports `@maipai/core` from a sibling `getmaipai/commons` checkout
pinned by tag, `core-v0.1.0` today, as a `file:` dependency in
`backend/package.json`; `@maipai/spec` joins it at RF-05), `docs/` (dev tier only:
`dev.md`, `integrations.md`, `BACKLOG.md`, `api/` generated, `plans/`
history), `scripts/check.sh` (the gate: the backend's typecheck, API
docs drift, tests, then the pinned `@maipai/standards` core, which
needs a sibling `getmaipai/.github` checkout at `../.github` or
`MAIPAI_STANDARDS_DIR`). A docs-only commit runs
`bash scripts/check.sh --docs`. `docs/api/openapi.json` is generated by
`bun run gen:api-docs` in `backend/` and checked for drift by the gate;
never hand-edit it. The same goes for `docs/components.md`, generated
by `bun run gen:components-doc` from the role, engine, profile and
model declarations.

Runtime data lives under `data/` and is never tracked. Every model or
engine the Stack uses is downloaded on demand, pinned and checksummed,
never vendored. The backend test suite runs under a scratch
`STACK_DATA_DIR` of its own, `backend/data-test/run-<pid>` (git-ignored),
set by `backend/tests/preload.ts`, which sweeps the directories of
finished runs at every start and refuses a real data directory.

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

## Landing and archiving

Work is not done until it is landed on main (`bash scripts/wt.sh land`). Never tell the owner a session can be archived, or that
the work is finished, while any commit is unlanded: say "not landed" and name what blocks it. A branch pushed to origin is not
landed. If the gate cannot pass in the session's environment (a Linux container fails the Mac-only tests), say so before the
owner asks, and do not bypass the gate to land.
