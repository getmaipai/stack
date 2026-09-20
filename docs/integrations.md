# MaiPai Stack: the contract with Home

This is the central document for anything that talks to the Stack. Home
is the only caller; Bot calls it by running Home's platform code on the
robot. The API itself is self-documenting (Hono routes as Zod schemas,
the generated `docs/api/openapi.json`, the explorer at `/api/docs`);
this file is the design of the seams and the shapes Home builds
against. Every change to a seam is additive (org compatibility rule): a
field or endpoint Home relies on is never removed or repurposed without
a versioned path and a changelog note. The wire shapes named below are
declared once, in exactly `home/spec`'s shape, under `backend/src/spec/`
(a JSON Schema 2020-12 file per shape with the `$id` it carries once
moved, a hand-written Zod mirror the backend imports, fixtures, and
`backend/tests/spec.test.ts` proving schema and mirror agree on every
fixture) and defined nowhere else in the backend. They move to
`shared/spec` at the refocus's step 0c as a copy, after which the
backend imports `@maipai/spec` and the local folder is deleted. The
files: `role-request.schema.json`, `role-reply-headers.schema.json`,
`stack-event.schema.json`, `health-item.schema.json`,
`stack-setting.schema.json`, `precious-state.schema.json`. The org rule
"shared record changes go through the spec first" applies to them.

## Authentication: loopback, nothing else

The daemon binds `127.0.0.1` on its declared port (default 8770) and
nothing else. There is no LAN setting, no key, no session, no operator.
A process on the same machine is the caller by definition; on the
household's machine that is Home, installed by Home's installer, with
the Stack's port declared once in Home's own settings. Anything a
person or a package should reach passes through Home, which owns
identity and permissions, and Home never proxies the Stack raw: its
Admin pages read the Stack's facts through Home's own routes with
Home's own role check.

## The role contract (`/v1/*`)

OpenAI-shaped, so an existing client library works unchanged.

| Path | Roles | Wire |
|---|---|---|
| `POST /v1/chat/completions` | `chat`, `coding`, `judge`, `router`, `vision` | chat completions; `stream: true` passes the engine's SSE bytes through unchanged including `[DONE]`; `tools`, `tool_choice`, `response_format` and `chat_template_kwargs` pass through |
| `POST /v1/embeddings` | `embed` | embeddings |
| `POST /v1/audio/transcriptions` | `stt` | transcription (multipart audio) |
| `POST /v1/audio/speech` | `tts` | speech; phrase-level streaming and cancel |
| `POST /v1/images/generations` | `image` | the job API with a wait |
| `GET /v1/models` | all | role ids plus installed model ids in OpenAI's list shape |

The request's common fields are spec `RoleRequest`: `model` carries a
role id (`"chat"`) or an installed model id; generator roles accept
`quality: fast | everyday | best`; `stream` and `timeout_ms` are
optional; everything else passes to the engine unchanged.

**Every reply** carries the identity headers, spec `RoleReplyHeaders`:

| Header | Value |
|---|---|
| `x-maipai-engine` | the engine host and build that answered (`local b10797-832fd6f17`), or `none` |
| `x-maipai-model` | the model file that answered (`Qwen3-1.7B-Q8_0.gguf`), or `none` |
| `x-maipai-revision` | the model's pinned revision (`90862c4b…`) when the process knows its model record, the engine build otherwise, or `none` |

**Failure shapes**, never a 404 for a known role:

| Status | Body | When |
|---|---|---|
| 503 | `{ error, role, state, offline_reason }` | the role has no ready engine; `state` is the role state and `offline_reason` the supervisor's reason |
| 409 | `{ error, model, reason: "unverified", missing: [...] }` | a named model whose provenance is incomplete |
| 400 | `{ error, roles: [...] }` | an unknown role or model id, with the declared ids |
| 499 | `{ error: "Request cancelled" }` | Home cancelled the request |
| 504 | `{ error }` | the engine timed out on a request while still healthy |

Home's `engineIdentity` check reads the headers instead of probing a
process. Home's own `/v1` is never a raw pass-through: the Stack's
`/v1/chat/completions` answers as the model (no memory, no guards, no
person); Home's answers as the household's assistant through the turn
engine. A client that wants the model is Home's business to authorize.

## Three calls, worked

```bash
curl -s http://127.0.0.1:8770/stack/v1/roles | jq '.roles[] | {id, state}'
```

The `state` values are `notInstalled`, `installed`, `loaded`, `ready`, and `offline`, describing how available each role is.

```bash
curl -si http://127.0.0.1:8770/v1/chat/completions -H 'content-type: application/json' -d '{"model":"chat","messages":[{"role":"user","content":"Say OK."}]}'
```

The three identity headers come back on every reply, and a 503 carries `offline_reason` when the role is not ready.

```bash
curl -s http://127.0.0.1:8770/stack/v1/health | jq '.items[] | {code, severity, fix}'
```

Each item has one fix action that Home renders as a button.

## The control API (`/stack/v1/*`)

| Surface | Path | What Home does with it |
|---|---|---|
| Roles | `GET /stack/v1/roles` | the Engines page: per role, its declaration; the derived state (`notInstalled`, `installed`, `loaded` with the reason it is not ready, `ready` with `checkedAt`, `offline` with `reason`) and `since`; the bound model with its measured or estimated footprint; `check` (what the last readiness run said: `not checked`, `passed`, `failed` with the reason, `skipped`; `stale` once a model, engine or setting changed after the run); `identity` (whether the process reports the expected model file or build) |
| Engines | `GET /stack/v1/engines`; `POST /stack/v1/engines/{name}/install` (no body: this machine's pin; `{ tag, url, sha256, size }`: stage a build beside the current one without activating it); `POST /stack/v1/engines/{name}/{start,stop,restart}`; `PUT /stack/v1/engines/{name}/current` (drain, relink, post-load check, relink back on failure); `DELETE /stack/v1/engines/{name}/builds/{tag}` (never the current one) | pinned builds and their install and version state (`current` / `notCurrent` with the reason, `needsRestart`); the actions behind Home's buttons |
| Models | `GET /stack/v1/models`; `GET /stack/v1/models/catalog` (the pins this build ships); `POST /stack/v1/models` (pull by pin); `POST /stack/v1/models/import`; `DELETE /stack/v1/models/{id}`; `POST /stack/v1/models/{id}/actions` (`load`, `unload`, `pin`, `unpin`) | the model list with provenance, install state, runtime state and measured footprint; install from the Catalog index or import a verified local file |
| Jobs | `POST /stack/v1/jobs`; `GET /stack/v1/jobs/{id}`; `DELETE /stack/v1/jobs/{id}`; result by id | Home's picture, video and music packages |
| Health | `GET /stack/v1/health`; `POST /stack/v1/health/{code}/{fix,resolve,ignore}` | Home's Repairs list: the problem list as data, the fix button calls `fix` and shows the result |
| Readiness | `POST /stack/v1/check`; `GET /stack/v1/check/latest` | the check Home schedules and the "Check now" button; the latest run carries `stale` and `staleReason` once a model, engine or setting changed after it ran |
| Updates | `GET /stack/v1/updates`; `POST /stack/v1/updates/check`; `POST /stack/v1/updates/engines/{name}/{apply,rollback}` | the Updates page: installed, available, last checked, notes, go back |
| Events | `GET /stack/v1/events` (SSE) | Home's notification bridge, below |
| Hardware and budget | `GET /stack/v1/hardware`; `GET /stack/v1/hardware/budget`; `GET /stack/v1/hardware/budget/decisions` | the facts behind "what your computer can run", the memory picture, the governor's last 200 decisions |
| Settings | `GET /stack/v1/settings` (the declaration with values); `PUT /stack/v1/settings`; `POST /stack/v1/settings/apply` | Home's generic settings renderer, below |
| Storage | `POST /stack/v1/storage/sweep` | the prune Home schedules (orphaned blobs past their grace period) |
| Privacy | `GET /stack/v1/privacy` | the outbound endpoint rows for Home's privacy page, below |
| Backup | `GET /stack/v1/backup` | the precious-state declaration for Home's backup, below |
| Diagnostics | `GET /stack/v1/diagnostics` | a redacted zip (log tail, health, hardware without the computer name, settings, versions) Home hands to the person; nothing is sent anywhere |
| Liveness | `GET /healthz` | `{ ok, version, uptimeSeconds }`; Home checks its pinned minimum Stack version here at boot |

Home calls every maintenance action; the Stack keeps no schedule of its
own. Every route is Zod-typed and the generated `docs/api/openapi.json`
is the reference; a row above whose path is not yet in that document is
not built, and BACKLOG.md carries its item.

## The event feed

`GET /stack/v1/events` is a server-sent stream that stays open. Each
event is `id: <seq>`, `event: <id>` and `data: <envelope>`, where the
envelope (spec `StackEvent`) is `{ id, at, seq, data }` and `data`'s
shape per id is fixed by the schema. A reconnect with `Last-Event-Id`
replays from the in-memory ring (500 events), then continues live. The
ids and what `data` carries:

| Event | `data` | Home maps it to |
|---|---|---|
| `role.state` | `{ role, state, since, reason? }` | the Engines page live state |
| `engine.state` | `{ engine, state, reason? }` | the Engines page; an `offline` becomes a Repairs entry |
| `pressure` | `{ pressure, free_memory_bytes, floor_bytes, available_percent }`, or `{ pressure, reason, id }` when the governor acted on one process | a quiet admin status |
| `job.progress` | `{ job, kind, state, percent, completed_bytes, total_bytes, status }` | the package's progress; also model and engine downloads |
| `job.done` | `{ job, kind, ok, reason? }` | the package's result |
| `model.installed` | `{ model, path }` or `{ model, removed: true }` | an admin notification |
| `update.available` | `{ kind: "engine" or "model", name, installed, available }` | an admin notification with the Updates link |
| `update.applied` | `{ kind, name, tag }` | an admin notification |
| `update.failed` | `{ kind, name?, reason }` | an immediate admin notification plus the `failed-swap` health item (`failed-swap.<name>` for an engine other than llama-server) |
| `health.changed` | `{ code, severity, title, open }` | a Repairs entry opened or closed |

The Stack never notifies a person; Home's notification system (org
`NOTIFICATIONS.md`) is the only thing that does, and it is the one
subscriber. Progress events are live only and never become history.

## Health items

Spec `HealthItem` (`health-item.schema.json`): `{ code, severity:
critical | error | warning, title, text, since, cause, fix?: { label,
action } }`. `code` is stable and unique per condition; Home keys its
Repairs list on it. `fix.action` is one of `restart_engine`,
`free_memory`, `retry_download`, `rollback_update`, `reinstall_engine`,
`reinstall_model`; Home renders
the label and calls `POST /stack/v1/health/{code}/fix`, which returns
`{ ok, result }`. A code that needs a human (a host to plug back in)
has no `fix` and Home shows the cause.

## The settings declaration

Spec `StackSetting` (`stack-setting.schema.json`): a `SettingsKey` from
`home/spec` (`key`, `scope: device`, `selector: number | select | text |
boolean`, `range`, `default`, `label`, `help`, `section: { id, order }`,
`level: basic | advanced | expert`, `secret`, `needs`, `lives_in:
stack`, `honoured_by`) plus the Stack's value half: `needs_restart`,
`in_effect`, `pending`. One shape, so Home's generic settings renderer
(org `SETTINGS.md`) draws the Stack's keys the way it draws its own.
`GET /stack/v1/settings` returns every declaration with its values;
`PUT` validates against the declaration and stores; `POST .../apply`
promotes pending values (Home restarts the service through the service
manager). Home never declares a Stack key of its own; the one Home-side
setting is the Stack's port, declared once in Home's settings definition
and filled by the installer.

Keys as declared today, all under `stack.`: `memory.model_budget_bytes`,
`memory.low_water_pct`, `memory.low_water_floor_bytes`,
`memory.sustained_polls`; `updates.enabled`, `updates.model_host`;
`runtime.idle_unload_minutes`, `runtime.idle_unload_on_battery_minutes`,
`runtime.download_cap_mbps`, `runtime.port`;
`engines.llama_server.context_length`, `.slots`, `.threads`,
`.cache_ram_mb`, `.flash_attention`; and per role a `url` binding,
`engines.<role>.host_url` and `engines.<role>.expected_version`, for a
server the person already runs.

## The privacy rows

`GET /stack/v1/privacy` returns the Stack's outbound endpoints as data
in the org's "what leaves the house" shape (`{ what, when, carries,
receiver, setting }`), and Home's privacy page renders them beside its
own. The rows the Stack declares:

| What | When it happens | What it carries | Who receives it | Setting |
|---|---|---|---|---|
| Checking for engine and model updates | Only when Home has switched update checks on, then when Home's schedule calls the check | A `GET` with `If-None-Match` and `User-Agent: maipai-stack/<version> (<os>-<arch>)`, no query string or identifier | The Catalog's signed index on GitHub | `stack.updates.enabled` |
| Downloading a model or an engine build | Only when Home installs one or applies an update | The name of the pinned file | Hugging Face or the mirror declared in `stack.updates.model_host`, and GitHub for engine archives, straight from this computer | none: an explicit action |
| Reading a model's provenance before install | Only when Home asks to install a model by repository | The repository name, then its immutable revision and file list | Hugging Face or the declared mirror | none: an explicit action |
| Building a Python engine's environment (the packages Pocket TTS and ComfyUI run on) | Only when Home installs the voice or image engine, and again when the Stack updates it | The names of the pinned packages and their hashes; uv, the tool that fetches them, comes from GitHub and sends nothing else | The Python Package Index, straight from this computer, and GitHub for the uv build | none: an explicit action |
| The voice engine asking Hugging Face for its weights and voices | Each time the voice engine starts (it asks for the voice-cloning weights, and reads the pinned copy on this computer when the ask is refused without a token), and when a person picks a voice the computer does not hold yet | The file's name, and the Hugging Face token from settings when one is set, so the cloning weights can be read | Hugging Face, straight from this computer | `stack.engines.tts.hf_token` |

Nothing else leaves the machine. Adding or changing an outbound
endpoint adds or changes a row here and in the route in the same
commit, and the backend suite (from the step 4 rewrite of the refocus)
carries a test that fails when a fetch target exists without a row.

## The precious-state declaration

`GET /stack/v1/backup` returns spec `PreciousState`
(`precious-state.schema.json`): `{ data_dir, paths: [{ path, mode:
include | exclude, what, why }] }`, the paths Home's backup takes and the
reason for each. Today: `data/stack.db` (settings
values, model provenance, measured peaks, open health items:
`include`), `data/keys/` (`include`), `data/models/` and `data/engines/`
(rebuildable from their pins: `exclude`, with the sentence Home shows).
Home takes, encrypts, schedules and restores the backup (org
`BACKUPS.md`); the Stack only declares.

## Install and service hand-off

Home's installer installs the Stack; a person never installs the Stack by itself.

What Home's installer does, in order: it places the `maipai-stack`
binary for the platform; it creates the Stack's data directory
(`STACK_DATA_DIR`, owner-only) beside Home's own; it runs
`maipai-stack install-service` (launchd `com.maipai.stack` on macOS,
`systemd --user` on Linux) with `STACK_DATA_DIR` and `PORT` set, which
writes the unit file (a LaunchAgent plist, or a `systemd --user` unit
of `Type=notify` the daemon answers with `READY=1` and the watchdog
beat) and starts the service; it waits for `/healthz`
to answer with the version it shipped; and it runs the first readiness
check (`POST /stack/v1/check`) after the first engine and model are
installed, so the Engines page opens with a real result rather than a
guess. The service
unit has `RunAtLoad`, restart on failure with a 30 s throttle, and logs
under `<data>/logs/`. `maipai-stack start`, `stop`, `status` and
`uninstall-service` (optionally `--remove-data`) operate the unit. Exit
codes: 0 clean stop, 1 fatal error (logged), so the service manager's
restart policy is the outer watchdog and Home's watchdog is the one
above it (org `SERVICES.md`). The Stack updates when Home's release
ships a new binary; Home stops the service, replaces the binary, starts
it, and reads `/healthz` for the new version.

## MaiPai Bot

Bot runs Home's platform code on the robot, so it consumes the Stack
exactly as Home does, against its own local Stack on the Linux ARM
profile: `chat`, `embed` and `judge` as spawned `llama-server`
processes with the pins and flags Bot's design names (`taskset`,
`--cache-reuse` on chat and not on the judge, `enable_thinking:
false`). Speech stays the body's: STT, TTS, wake word, voice activity
and speaker evidence run in the body's one speech process over
`spec/voice/`; the Stack registers it as a `managed` engine holding
`stt` and `tts` so the identity contract holds and the household
runtime addresses speech the same way on both nodes. The body's power
and thermal budget is an admission input to the robot's governor
(GOV-01). Generation is unavailable on the robot and the Stack says so
per role. The two Stacks never talk to each other; pairing is between
the two household runtimes.

## MaiPai Catalog

The Catalog's `model` packages are the Stack's model source: signed,
with source, revision, checksum, licence and role declared, published
as the signed index at
`https://github.com/getmaipai/catalog/releases/latest/download/model-index.json`.
The Stack reads it only through the opt-in update check and installs
nothing without Home's explicit call. Engine builds are not community
packages, so the Catalog carries them as one hand-maintained index
(`engines/index.json`: name, upstream build tag, platform, arch, url,
sha256, size, licence, extra archives, notes), published at
`https://github.com/getmaipai/catalog/releases/latest/download/engine-index.json`
as a signed envelope in the package index's shape with a thirty-day
expiry (STACK-97). The Stack reads it with the same conditional GET as
the model index, keeps the document as received, takes the newest
build for this platform as "available" against the `current` link's
tag, and treats an expired index as unknown. The pins this build ships
(`backend/src/lib/engineCatalog.ts`) are what installs at first run
without the index; their tags are the same upstream build tags, so
installed and available compare directly. Verifying the envelope's
signature against the Catalog's release key waits on that key existing
(the Catalog's release-signing item).

## MaiPai Go

Go never talks to the Stack. It talks to Home (or to Bot when Home is
unreachable), which owns identity and renders the UI schema.
