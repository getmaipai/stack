# MaiPai Stack: integrations

What each MaiPai product needs from the Stack, what it stops doing once
the Stack exists, and the contract between them. The API itself is
self-documenting (Hono routes as Zod schemas, the OpenAPI explorer at
`/api/docs`); this file is the design of the seams. Every change to a
seam is additive (org compatibility rule): a field or endpoint a client
relies on is never removed or repurposed without a versioned path and a
changelog note.

## The contract, in one place

| Surface | Path | Who uses it | Status |
|---|---|---|---|
| OpenAI-shaped inference | `/v1/chat/completions`, `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/audio/speech`, `/v1/images/generations`, `/v1/images/edits` | every client, by role name in `model` | partly (chat and streaming chat, embeddings, audio, images; no image edits) |
| Streaming speech sessions | `/stack/v1/stt/session` (live words), `/stack/v1/tts/stream` (phrase-level, cancel) | Home's voice path, Bot's household runtime | planned |
| Roles | `GET /stack/v1/roles` (state, engine, model, residency per role) | Home's Admin, Bot's runtime at boot, the board | built |
| Jobs | `POST /stack/v1/jobs`, `GET /stack/v1/jobs/:id`, `DELETE` to cancel, result by id | Home's picture, video and music packages | planned |
| Events | `GET /stack/v1/events` (SSE) | Home's notification bridge, the board, the menu bar | planned |
| Hardware and budget | `GET /stack/v1/hardware`, `GET /stack/v1/budget` | Home's Admin (read-only view), Bot's runtime | partly (hardware; no budget yet) |
| Models and engines | `GET /stack/v1/models`, `/engines`; install, pin, unload, remove | the operator; Home's Admin as a view with links | partly (engines; no models yet) |
| Clients | `/stack/v1/clients` (operator only) | the operator; Home's installer registers Home once | built |
| Updates | `/stack/v1/updates` (check, apply, roll back) | the operator; Home shows availability through events | planned |
| Identity headers | `x-maipai-engine`, `x-maipai-model`, `x-maipai-revision` on every reply | every client's identity check | built |

The Status column is derived from `docs/api/openapi.json` and refreshed whenever a row's paths land; a row that says built has its paths in the generated document.

Authentication: the operator uses `/stack/v1/operator/setup`, `/login`,
`/logout` and the state route; clients use keys created and revoked through
`/stack/v1/clients`. Inference and streaming speech use a client key as a
bearer token, and loopback needs one too, so a stray local process cannot
spend the household's memory. The roles, hardware and engines reads accept
either a client key or the operator session.

## MaiPai Home

Home is the Stack's first client and the reason it exists. Home installs
on top of a running Stack (Home's installer installs the Stack first when
it is absent, then registers itself as a client with the roles it needs,
then runs its own first run). Nothing in the household ever touches the
Stack's pages; Home renders what its people may see.

**What Home calls.** Every model request the turn engine, the judge, the
embedder, the voice path and the generation packages make goes to the
Stack by role. Home's `engineIdentity` check reads the identity headers
instead of probing a process. Home's Admin gets an "Engines and models"
section that is a view of `/stack/v1/roles`, `/hardware` and `/budget`
with links into the Stack for actions, never a second copy of the facts
(one definition, one renderer).

**What Home stops doing.** Spawning, downloading, checksumming,
supervising and budgeting engines. The migration list is in `dev.md`
("What moves out of Home, later"); it runs only after the Stack's first
milestone is proven on the Studio beside the hub, and nothing moves
before that.

**What Home keeps.** The turn engine and the guards, the safety floor
(deterministic, in the path, non-removable), consent and provenance on
household people, memory, packages, the notification system and its
relationship with phones, and every screen a person sees. Child safety
stays in Home because children exist only in Home.

**Notifications.** Home subscribes to the event feed with its key and
maps `role.state`, `engine.state`, `pressure`, `job.progress`, `job.done`,
`model.installed`, `update.available`, `update.applied` and `repair` to its
own notification types (`NOTIFICATIONS.md`): an `update.available` becomes
an admin notification, a `repair` becomes a Repairs entry in Home's Admin
with a link, and `pressure` warnings become a quiet status. The Stack never
notifies a phone; Home does.

**Settings.** Stack settings are declared and rendered in the Stack.
Home's settings never duplicate them; Home's Admin links across. The one
Home-side setting is the Stack's address and key, declared once in
Home's settings definition, filled by the installer.

**Failure.** When the Stack is unreachable, Home's roles go to an honest
offline state (the same `offline_reason` shape the Stack uses for managed
hosts), the turn engine answers "I can't think right now" in the
companion's voice with a Repairs entry for the admin, and nothing else
in Home stops.

## MaiPai Bot

Bot builds on the Stack and never requires Home. This follows from the
robot's design record (`bot/docs/dev.md`, section 2 and section 4): two
processes on the robot, the household runtime (the hub's own TypeScript
on Bun) and the Python body that owns every piece of hardware, with
three llama-server processes for chat, embed and judge, and one governor
across all of it (GOV-01) whose admission budget the body computes from
power and thermal state.

The Stack's place in that design, proposed here and to be confirmed or
amended by the robot design pass:

- **The robot runs its own Stack**, the Linux ARM profile, holding the
  `chat`, `embed` and `judge` roles as spawned `llama-server` processes
  with the pins and flags section 4 names (`taskset`, `--cache-reuse`
  on chat and not on the judge, `enable_thinking: false`). The household
  runtime's "engine supervisors and their launch adapter" port
  (RUNTIME-01) is satisfied by a Stack client instead of an in-process
  supervisor, which is the same code on the hub and the robot, per
  principle 1.
- **Speech stays the body's.** STT, TTS, wake, voice activity and
  speaker evidence run in the body's one speech process over
  `spec/voice/`, exactly as designed; the Stack registers that process
  as a `managed` engine holding `stt` and `tts` so the board shows it,
  the identity contract holds, and the household runtime addresses
  speech the same way on both nodes. The Stack never spawns or kills it.
- **One governor, the Stack's, fed by the body.** GOV-01 is met by the
  Stack's governor reading the body's power and thermal budget as an
  input to admission, so Bun, Python, Deno, llama-server and the Hailo
  pipelines are admitted by one policy. The judge's preemption on an
  interactive arrival (abort the in-flight request, lower CPU weight) is
  a governor rule the Stack carries for the `judge` role on any
  platform.
- **Generation is unavailable on the robot** and the Stack says so per
  role (`Not installed` on this profile); when paired, the household
  runtime offers the hub's generator, which is a Home-to-Home link
  matter, not a Stack one.
- **Pairing is unchanged.** The link, the replica and the household
  records are between the two household runtimes. The two Stacks never
  talk to each other; each serves its own node.

The measurements that decide the robot's engine set (M-01 through M-10)
stay in the robot's design record and are unchanged by this split; what
changes is which process runs them, and the answer is the Stack for the
three language roles.

## MaiPai Go

Go never talks to the Stack. It talks to Home (or to Bot, when Home is
unreachable), which owns identity and renders the UI schema. A future
"Stack status" tile in Go is data Home already has from the event feed.

## MaiPai Catalog

The Catalog's `model` packages are the Stack's preferred model source:
signed, with source, revision, checksum, licence and role declared in the
manifest, so a model arrives with its provenance record complete. The
Stack installs `model` packages and, for `voice` and `wakeword` packages,
installs the model half and hands the runtime half to the client that
loads it (Home's voice sidecar, the robot's body). Engine pins are the
Stack's own catalog, per platform, not Catalog packages, because an
engine build is not something a community contributes and signs.

## MaiPai Desktop (part of `home`)

Desktop shows Home. It may show the Stack's board state in its dock badge
using the same event feed Home already consumes, so there is no second
subscription. The Stack's own menu-bar item is separate and stack-only,
for a person who runs the Stack without Home.

## A developer's own tool

The case the Stack serves alone: a key scoped to the roles the tool may
spend, the explorer at `/api/docs`, the OpenAI-shaped endpoints so an
existing client library works unchanged, and the identity headers so the
tool can log which model answered. Role-scoped keys are what let an
operator run a coding agent against `chat` and `embed` without giving it
the power to start a video job on the family's machine.
