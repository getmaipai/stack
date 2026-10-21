# MaiPai Stack: the contract with Home

This is the central document for anything that talks to the Stack. Home
is the only caller; Bot calls it by running Home's platform code on the
robot. The API itself is self-documenting (Hono routes as Zod schemas,
the generated `docs/api/openapi.json`, the explorer at `/api/docs`);
this file is the design of the seams and the shapes Home builds
against. Every change to a seam is additive (org compatibility rule): a
field or endpoint Home relies on is never removed or repurposed without
a versioned path and a changelog note. The wire shapes named below are
pinned in `@maipai/spec` (tag `spec-v0.1.2` in `getmaipai/commons`),
which the backend imports straight from the package; the only
Stack-local wire shape is the voice, declared in `backend/src/wire/voice.ts`
because `spec-v0.1.0` never carried it. The shapes: the role request
and reply headers, the event feed envelope, the health item, the
settings declaration, the precious-state declaration, the speech
session's `SttWireEvent` and `SttTranscribeResponse`, and the job.
The org rule "shared record changes go through the spec first" applies
to them.

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
| `POST /v1/tokenize` | `chat`, `coding`, `judge`, `router`, `vision` | the engine's own token count, `{ count }`: send `messages` (with `tools` and `chat_template_kwargs` when the turn carries them, rendered with the engine's chat template, no generation prompt, then tokenized) or a raw `content` string, exactly one; an image part counts as the template's media marker only, not the image's own tokens; an engine with no token-count route is a 501 that says so, never an estimate (oMLX has none; the Stack asks it for one token and reads its own prompt size, which is exact) |
| `POST /v1/messages` | `coding` | Anthropic Messages, served natively by the coding engine (llama-server b10797): `stream: true` is the engine's SSE bytes unchanged, with `tool_use` and `tool_result` blocks, thinking blocks, usage and stop reasons. The Stack drops client sampling, bounds `thinking.budget_tokens` by `stack.engines.coding.thinking_budget_ceiling`, and translates nothing. `model` is `coding` or the coding model's id. |
| `POST /v1/messages/count_tokens` | `coding` | Anthropic token count, the engine's own, unchanged. |
| `POST /v1/responses` | `coding` | OpenAI Responses, served natively by the coding engine (no `previous_response_id`: the engine refuses it). Same sampling and thinking rules as above. A wire the engine does not serve answers `501` with a sentence saying what to use, without starting the engine. |
| `POST /v1/embeddings` | `embed` | embeddings |
| `POST /v1/audio/transcriptions` | `stt` | transcription (multipart audio) |
| `POST /v1/audio/speech` | `tts` | speech; phrase-level streaming and cancel |
| `POST /v1/images/generations` | `image` | the job API with a wait; on a Mac with the picture models installed the mflux worker answers (see Picture generation below), otherwise the supervised ComfyUI |
| `POST /v1/videos/generations` | `video` | the job API with a wait; progress by phase, cancel, the clip fetched by URL (see Video generation below) |
| `POST /v1/audio/music` | `music` | the job API with a wait; progress by stage, cancel, the song fetched by URL (see Music generation below) |
| `GET /v1/models` | all | role ids plus installed model ids in OpenAI's list shape; `?role=coding` lists only the coding role's served model with `context_length` and `thinking_budget_ceiling` (an empty list when none is installed; never starts the engine) |

The request's common fields are spec `RoleRequest`: `model` carries a
role id (`"chat"`) or an installed model id. An installed model id on a
chat request selects that model's own process for the request; when the
field is a role id, the currently active process is used. Generator
roles accept `quality: fast | everyday | best`; `stream` and
`timeout_ms` are optional; everything else passes to the engine
unchanged.

**Every reply** carries the identity headers, spec `RoleReplyHeaders`:

| Header | Value |
|---|---|
| `x-maipai-engine` | the engine host and build that answered (`local b10797-832fd6f17`, or `local omlx-0.7.0` when chat runs on oMLX), or `none` |
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
| Roles | `GET /stack/v1/roles` | the Engines page: per role, its declaration; the derived state (`notInstalled`, `installed`, `loaded` with the reason it is not ready, `ready` with `checkedAt`, `offline` with `reason`) and `since`; the bound model with its measured or estimated footprint; `check` (what the last readiness run said: `not checked`, `passed`, `failed` with the reason, `skipped`; `stale` once a model, engine or setting changed after the run); `identity` (whether the process reports the expected model file or build); on the `chat` and `vision` rows, `reads_pictures` (true when the running process was launched with a projector, or, with nothing running, the selected model's projector is installed; a URL binding never claims it); on the `coding` row, `coding: { state, keep_warm_minutes, idle_seconds, slots, slots_busy, cannot_fit_reason }` (CODE-STACK-01 S2; `state` is `notInstalled`, `installed` = on disk and unloaded, `loading`, `ready`, `busy` or `offline`; reading it never starts the engine, and `cannot_fit_reason` is also the row's `reason` while `installed`) |
| Engines | `GET /stack/v1/engines`; `POST /stack/v1/engines/{name}/install` (no body: this machine's pin; `{ tag, url, sha256, size }`: stage a build beside the current one without activating it); `POST /stack/v1/engines/{name}/{start,stop,restart}`; `PUT /stack/v1/engines/{name}/current` (drain, relink, post-load check, relink back on failure); `DELETE /stack/v1/engines/{name}/builds/{tag}` (never the current one) | pinned builds and their install and version state (`current` / `notCurrent` with the reason, `needsRestart`); the actions behind Home's buttons |
| Models | `GET /stack/v1/models`; `GET /stack/v1/models/catalog` (the pins this build ships); `POST /stack/v1/models` (pull by pin); `GET /stack/v1/models/{id}/file` (installed wakeword assets only, bytes rechecked against the pin); `POST /stack/v1/models/import`; `DELETE /stack/v1/models/{id}`; `POST /stack/v1/models/{id}/actions` (`load`, `unload`, `pin`, `unpin`) | the model list with provenance, install state, runtime state and measured footprint; install from the Catalog index or import a verified local file; give Home a verified wakeword asset to serve to its paired robots |
| Jobs | `POST /stack/v1/jobs`; `GET /stack/v1/jobs/{id}`; `DELETE /stack/v1/jobs/{id}`; result by id | Home's picture, video and music packages |
| Health | `GET /stack/v1/health`; `POST /stack/v1/health/{code}/{fix,resolve,ignore}` | Home's Repairs list: the problem list as data, the fix button calls `fix` and shows the result |
| Readiness | `POST /stack/v1/check`; `GET /stack/v1/check/latest` | the check Home schedules and the "Check now" button; the latest run carries `stale` and `staleReason` once a model, engine or setting changed after it ran |
| Updates | `GET /stack/v1/updates`; `POST /stack/v1/updates/check`; `POST /stack/v1/updates/engines/{name}/{apply,rollback}` | the Updates page: installed, available, last checked, notes, go back |
| Events | `GET /stack/v1/events` (SSE) | Home's notification bridge, below |
| Hardware and budget | `GET /stack/v1/hardware`; `GET /stack/v1/hardware/budget`; `GET /stack/v1/hardware/budget/decisions` | the facts behind "what your computer can run", the memory picture (with the active `tier`, the in-force `margin_bytes` and `reading_degraded`), the governor's last 200 decisions |
| Engine self-heal | `GET /stack/v1/engines/self-heal` | an engine that exits on its own is restarted by the Stack (2 s, 10 s, 30 s, 2 min, stop after 5 failures in 30 minutes); the response has `enabled`, `crashesByDay` (UTC day, `crashes`, `healed`, `gaveUp`, 14 days), `events` (last 50: `crashed`, `healed` with `seconds`, `gave_up`; each `id` is stable per incident so a caller notifies once), `POST /stack/v1/engines/self-heal/restart` ({role, reason}; answers {accepted, why}) lets a health check ask for one restart that counts toward the breaker (event `requested_by_canary`, log `engine.restart_requested_by_canary`); `blocker` (why a restart, canary or prewarm must wait right now, or null), `stopped` (roles whose retries ended; the Repairs item `engine.crashed.<role>` carries the fix and the last 20 log lines) and `healing`; setting `stack.runtime.self_heal` |
| Memory watchdog | `GET /stack/v1/memory` | the whole computer's memory every 5 s (available, free, wired, compressed, swap and its 30 s growth, the kernel's pressure level), the watchdog's `level` (`normal`, `warn`, `critical`), `reserve_bytes`, `generation_paused`, the Stack's own processes, the biggest users by name (`stack: true` marks the Stack's), `recent_actions`. Settings: `stack.memory.watchdog` (on), `stack.memory.reserve_gb` (0 = the larger of 8 GB and 8 percent, at most a quarter of memory), `stack.memory.reap_orphans` (on). While the level is not `normal`, `POST /v1/images/generations` and `/v1/videos/generations` answer 503 `no_memory` with the numbers; a job the watchdog stopped ends `cancelled` with status `paused: low memory` (code `no_memory`), and a job that waited 3 minutes for memory ends `failed` with status `no_memory`. Health items `memory-low` and `memory-critical`; a `pressure` event with `source: memory-watchdog` on critical (at most one per 10 minutes). During shutdown every route except `/healthz` answers 503 `stack_restarting` with `Retry-After: 5`. |
| Install plan | `GET /stack/v1/install-plan[?vram_gb=N]` | the first-run wizard: `level`, `tier`, the `memory_gb` and `memory_source` (`unified`, `graphics`, `override`, `unknown`) they were judged on, and `models`, the pinned files for the tier's roles, starter first (`starter: true`, a small chat model so chats start while the large one downloads), each shaped as a `POST /stack/v1/models` body plus `starter` and `installed`; `total_bytes`, `remaining_bytes` (not yet installed), `free_disk_bytes`, `fits_disk`. Memory is system plus graphics memory on unified-memory computers, graphics memory only (CUDA VRAM summed) otherwise; if that cannot be read, `level` is null and `memory_source` `unknown` until Home passes the person's total VRAM as `vram_gb` (integer, 1 to 512) | the install step: post each model to the pull route |
| Settings | `GET /stack/v1/settings` (the declaration with values); `PUT /stack/v1/settings`; `POST /stack/v1/settings/apply` | Home's generic settings renderer, below |
| Storage | `POST /stack/v1/storage/sweep` | the prune Home schedules (orphaned blobs past their grace period) |
| Privacy | `GET /stack/v1/privacy` | the outbound endpoint rows for Home's privacy page, below |
| Backup | `GET /stack/v1/backup` | the precious-state declaration for Home's backup, below |
| Diagnostics | `GET /stack/v1/diagnostics` | a redacted zip (log tail, health, hardware without the computer name, settings, versions) Home hands to the person; nothing is sent anywhere |
| Voices | `GET /stack/v1/voices` | every voice the `tts` engine in effect can render with its declared metadata (id, name, description, language, country, gender, source, `onDisk`, licence, revision) plus `engine` and the capability flag `tts: { engine, tags }`, `tags` being the bracketed tags the engine renders as sounds (`[laugh]`, `[cough]`, ...; empty for Pocket TTS). `GET /stack/v1/roles` gives the `tts` role the same flag as `tts: { engine, requested, tags, fallback_reason }`. The engine is chosen by `stack.voice.engine` (`auto` is the tier's default); `voice_url` is ignored by the MLX engine, which has one built-in voice; Home's voice picker reads it |
| Liveness | `GET /healthz` | `{ ok, version, contract, uptimeSeconds }`; Home checks its pinned minimum Stack version and the `contract` number here at boot. `contract` is one integer, starting at 1, bumped only when a route or field is removed or repurposed; additive changes never bump it, so a Home on another computer refuses a Stack whose number it does not know |

Home calls every maintenance action; the Stack keeps no schedule of its
own. Every route is Zod-typed and the generated `docs/api/openapi.json`
is the reference; a row above whose path is not yet in that document is
not built, and BACKLOG.md carries its item.

## The search service (STACK-DDGS-01)

`GET /stack/v1/search` returns `{ ddgs: { state, url, phase, reason, restarts, library } }`. The Stack builds a managed Python 3.12
environment (pinned `ddgs==9.16.0`, hashed requirements, the same uv builder as the voice engines) when it starts, runs the loopback
sidecar (`backend/src/search/ddgs_sidecar.py`) and restarts it when it dies. `state` is `building`, `starting`, `ready`, `failed`,
`unsupported` (no requirements file for this platform) or `disabled`; `url` is set only while `ready`, and Home searches that
address itself (the Stack carries no searches and logs no words). A failed build or a service that keeps stopping is the health item
`search.ddgs` whose fix `retry_download` restarts the attempt; `POST /stack/v1/search/retry` does the same. Adults-only gates stay in Home.

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
| `job.progress` | `{ job, kind, state, percent, completed_bytes, total_bytes, status, bytesPerSecond?, items? }` | the package's progress; also model and engine downloads (optional per-file state uses `completedBytes` and `totalBytes`) |
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

The chat engine setting `context_length` defaults to `0`, which selects the largest context admitted by the fit plan up to the model's trained context. A positive owner setting is used as-is; the governor still makes the final memory admission decision.

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
`engines.chat.engine` (`auto`, the default, `omlx`, `llama-server` or `mlx-serve`: which engine answers the chat wire after a restart; `auto` is llama-server on every tier even when oMLX is installed (ENGINE-MLX-02), `omlx` is the opt-in, and chat falls back to llama-server if oMLX fails to start twice; ENGINE-MLX-01);
`engines.llama_server.context_length`, `.slots`, `.threads`,
`.cache_ram_mb`, `.flash_attention`; per llama-server role (`chat`, `embed`,
`vision`) `engines.<role>.gpu_layers` (`all` or `0`, where the model runs);
the coding engine's own keys (CODE-STACK-01 S2): `engines.coding.keep_warm_minutes` (15; minutes loaded after the last request, live), `.thinking_budget_ceiling` (2000 tokens, the server's `--reasoning-budget`), `.slots` (0 = 2 on p128, 1 on p64) and `.context_length` (131072, stepped down when memory is short);
and per role a `url` binding,
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
| Downloading a model or an engine build | Only when Home installs one or applies an update, or on a Mac with `stack.engines.chat.engine` set to `omlx` (an admin's choice; `auto` fetches nothing): once in the background at start, for the pinned MLX build of the chat model (ENGINE-MLX-01) | The name of the pinned file | Hugging Face or the mirror declared in `stack.updates.model_host`, and GitHub for engine archives, straight from this computer | `stack.engines.chat.engine` for the background fetch (leave it on `auto` or `llama-server` and nothing is fetched); otherwise none: an explicit action |
| Downloading pinned wakeword assets for a robot | Only when Home asks the Stack to install one through a model download job | The pinned asset filename; no household or person data | GitHub releases for openWakeWord and MaiPai Bot, straight from this computer | none: an explicit action |
| Reading a model's provenance before install | Only when Home asks to install a model by repository | The repository name, then its immutable revision and file list | Hugging Face or the declared mirror | none: an explicit action |
| The first part of a model file's header, or a model repository's file list and configuration file, read to size it before download | Only when a person asks whether a model will fit, before any download | The model file's address or repository name and revision; its file list and configuration file; nothing about the household or any person | Hugging Face (`huggingface.co`), with content redirected to `us.aws.cdn.hf.co` | none: an explicit action |
| Building a Python engine's environment (the packages the voice engines, Pocket TTS and the MLX voice, ComfyUI and the oMLX chat engine run on) | Only when Home installs the voice or image engine, in the background at start on a Mac whose chat engine setting is `omlx` and has no environment yet (ENGINE-MLX-01), and again when the Stack updates it | The names of the pinned packages and their hashes; uv, the tool that fetches them, comes from GitHub and sends nothing else | The Python Package Index, straight from this computer, and GitHub for the uv build and the oMLX release wheel | none: an explicit action |
| Fetching a video or audio file from a link a person pasted, or from a source a person follows (`media.fetch`, yt-dlp) | Only when Home submits a `media.fetch` job: when a person pastes a link, then each time a followed source is polled (its own interval, a few items per check, a pause between requests). A site that answers with too many requests or a sign-in wall four times is left alone for 30 minutes; only a person's own request goes through while it rests | A request to the site the person named, as a browser's tool would make it: the link, one ordinary client identity, and cookies only when the owner added a cookies file in Home. Nothing about the household or any person | The site named by the link, straight from this computer; the Stack has no list of sites and never contacts one by itself | none: per source in Home |
| Downloading the pinned ffmpeg and ffprobe builds | Only the first time a media job needs them, or when the Stack's release pins a new build (there is no version check) | The name of the pinned archive; nothing about the household | GitHub releases of jellyfin-ffmpeg, straight from this computer | none |
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

## Instant chat: the judge role (INSTANT-02, 2026-10-17)

A chat model that reasons on every turn (Muse Glimmer 30B, STACK-MUSE-01) has no Instant mode, so Home sends an Instant turn to
the `judge` role instead: `POST /v1/chat/completions` with `"model": "judge"` and `"chat_template_kwargs": {"enable_thinking":
false}`. No new role, route or memory: from p32 up the judge is the resident Qwen3 4B Q4_K_M and answers on the same route,
with its own identity headers (`x-maipai-model: Qwen3-4B-Q4_K_M.gguf`). Home decides whether a separate fast model exists by
reading `GET /stack/v1/roles`: the judge's `model.id` differs from chat's (on p16 the judge is the chat model, so there is no
Instant model and the 8B's own `enable_thinking` switch is the Instant mode). The engine runs several slots, so a turn does not
queue behind background judge work.

Measured 2026-10-17 on the Studio (live Stack, port 8770, Qwen3 4B judge, three trials each): time to first text for "hello" is
0.03 to 0.04 s alone and 0.04 to 0.13 s during a 600-token background generation. During a cold 8,000-token prefill on another
slot it was 1.5 s once and 0.05 to 0.15 s after that (prefix cached). Muse at the same moment took 2 to 6 s for short answers.
Context: the judge launches with a 40960 window, so Home falls back to chat when an Instant turn's history would not fit.

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

## Components: install and uninstall (COMPONENTS-01)

`GET /stack/v1/components` lists every installable part as one row: `{ id, label, summary, group (chat, voice, pictures, video, music, tools, loras),
kind (model, lora), state (installed, installing, notInstalled, failed), size_bytes (on disk now, models plus their engine environment, null when
nothing is installed), download_bytes (what an install would still fetch), full_bytes (a fresh install, for the setup estimate), requirement
(required, optional, unsupported) with requirement_reason, last_used_at, used_by, depends_on, job, percent, failure, can_install, install_block,
can_uninstall, uninstall_block }`, and beside the rows `{ tier, free_disk_bytes, disk_margin_bytes, installed_bytes }`. The tier, the `required` set and
`free_disk_bytes` come from the install plan's own sizing, so the setup wizard and this list never disagree. `install_block` and `uninstall_block` are
sentences for the person (not enough room, needs more memory, "Chat is using this model").

A component is what a household member would name, not a file: Z-Image-Turbo (id `z-image-turbo`, about 33 GB, `optional` on p128 only), FLUX.2 Klein 4B,
the Video model, Picture tools, each voice, the wake word, each chat model (its picture reader included) and each household LoRA (`lora.picture.<id>`,
`lora.video.<id>`, removable, never installable here).

`POST /stack/v1/components/{id}/install` is one job of kind `component.install` (`input: { component, model }`, role of the part): the pinned files,
then the engine environment. It answers 202 `{ job, component, joined }` (a second call joins the job), 200 `{ job: null, already_installed: true }`,
404 `unknown_component`, or 409 `not_available` / `not_enough_space` (a download plus `disk_margin_bytes` must fit the data volume). A failed job raises
the Repairs item `component-install-failed.<id>` whose fix `retry_download` starts the install again; the item clears when it lands.

`DELETE /stack/v1/components/{id}` removes the model records, their hub-cache files (a blob only when no other snapshot points at it) and the engine
environment when no other installed component runs in it, then answers `{ component, freed_bytes, removed }`. Removing what is not installed answers
`removed: false`. 409 `in_use` (a request or job is using it, or it is still installing), `required` (Home installs it on this tier), `chat_model_in_use`
(chat's selected model) or `only_chat_model`: the error is a sentence saying what to do first. The Stack never leaves chat without a model.

## Image tools (IMAGETOOLS-01)

`POST /v1/images/edits` (multipart: `image`, `operation` = `remove_background` | `erase` | `upscale` | `resize`; `mask` for erase, white is
removed; `scale` 2 or 4; `width`, `height` or `factor`; `engine` = `auto` | `vision` | `isnet`; `timeout_ms`) answers like
`/v1/images/generations`: 200 `{ created, job, data: [{ b64_json, width, height, content_type, operation, engine, model, ms }] }`, or 202 with the
job id when it runs past `timeout_ms`; `GET /v1/images/edits/{job}` returns the PNG (kept in memory about 10 minutes). Refusals carry `error` (what
happened, what to do) and `code`: 413 `too_large`, 422 `mask_required` `mask_empty` `mask_too_big` `no_subject` `bad_scale`, 503 `model_missing`
`no_memory` `setup_failed` `unsupported`, 500 `failed`. Limits in megapixels: remove background and erase 25 in, upscale 6 in and 36 out, resize 36 out.
`GET /stack/v1/image-tools` returns `{ image_tools: { state, phase, vision, models: { isnet, lama, esrgan }, limits, operations, reason } }`.
The worker is one Python process that starts on the first edit and exits after about two minutes idle; it holds a pinned 4 GB governor admission
while it lives. Pictures, masks and results are never logged or written beyond the request. Design: Home `docs/design/image-tools-2026-10-17.md`.

## Media service (MEDIA-STACK-01)

The Stack does the heavy media work for Home so Home never runs ffmpeg or yt-dlp itself: read a file's codecs, fetch a link a person chose,
convert to H.264 and AAC, make a thumbnail, a storyboard sheet and a short silent preview. Five job kinds on the ordinary job API; no media route
carries a file. Design: Home `docs/design/media-apps-blend-2026-10-17.md` sections 8, 12 and 14.

**How Home calls it.** `POST /stack/v1/jobs` with `{ kind, input }` answers 202 `{ job }`; poll `GET /stack/v1/jobs/{id}` (or follow `job.progress` and
`job.done` on the event feed) until `state` is `done`, `failed` or `cancelled`; `DELETE /stack/v1/jobs/{id}` cancels (queued or running). On `done`,
`result` holds the shape below. On `failed`, `reason` is a sentence for the person and `result` is `{ failure: { code, message, host?, quiet?,
quiet_until?, detail? } }`: branch on `code`, show `message`, put `detail` (the tool's last lines) under a Details disclosure.
A refused submit is 422 `{ error, code }` (the input is wrong: `bad_input`, `path_invalid`, `path_not_found`, `path_outside_roots`, `no_roots`) or 503
`{ error, code }` (`media_quiet_mode`, `queue_full`, or no code when the kind is unknown). Nothing is queued on a refusal.

**Folders.** Home reads library folders, so it declares them: `PUT /stack/v1/media/roots { read: string[], write?: string[] }` replaces the
declaration (saved under the Stack's data folder, so a restart keeps it; declare again whenever the library roots change). Each folder must exist and
may not be `/` or hold or sit inside the Stack's own data folder (422 `root_refused`, `path_not_found` or `path_invalid`). Every path in a job input
must be absolute, free of `..`, and, after symlinks are resolved, inside a `read` or `write` folder (the job folders below are always readable).
An output goes where `output_dir` says, which must be inside a `write` folder; without `output_dir` it goes into a folder the job owns, named by the
job id. Home reads or moves what it keeps, then calls `DELETE /stack/v1/media/outputs/{job}` (`{ released }`); folders nobody releases are swept after
7 days. Before any folder is declared, every media job is refused with `no_roots`.

**One lane.** All six kinds share one idle-priority first-in-first-out queue (`taskpolicy -b` on a Mac, `nice -n 19` elsewhere): one media job runs at
a time, the rest wait with `state: queued` and `position`. At most 64 wait (a submit past that is 503 `queue_full`). A cancelled queued job leaves the
queue; a cancelled running job stops its tool and frees the lane at once; a crashed job never blocks the next; a job past its deadline (probe 3 min,
preview and companion clip 20 min, fetch 3 h, transcode 12 min, setup 30 min) is stopped and fails with a sentence. The first job that needs a tool downloads and checks it
inside the job (`status` says so), which can take a couple of minutes on a slow link; `media.setup` does that ahead of time.

**Kinds.**

| Kind | Input | Result |
|---|---|---|
| `media.probe` | `{ path }` | `{ path, size_bytes, format, duration_s, bit_rate, has_video, has_audio, has_cover_art, width, height, video_codec, hevc_tag ("hvc1" or "hev1" for HEVC, else null), audio_codec, channels, sample_rate, projection, rotation, streams[{ index, type, codec, codec_tag, profile, width, height, pix_fmt, fps, channels, sample_rate, bit_rate, language, default, cover_art }], chapters[{ index, start_s, end_s, title }], tags{all, lower-case keys}, title, embedded_date (ISO date or year), created_at, source_url (the `purl` tag a fetch embeds), elapsed_ms }`. Failure `unreadable` when ffprobe cannot read the file. |
| `media.fetch` | `{ url (http or https), kind: "video" or "audio" (video), quality: "best" or a ceiling "2160", "1440", "1080", "720", "480", "360" (1080, the household default ceiling; owner ruling 2026-10-17), playlist (false; true for a channel or playlist), archive_key (letters, digits, `.`, `-`, `_`: names this source's download archive so an item is never fetched twice), max_items (1 to 100, newest first), date_after ("YYYYMMDD"), min_duration_s, max_duration_s, cookies_path (a file inside a declared folder; only when the owner configured cookies), person_initiated (false), subtitles (true), limit_rate_kbps, output_dir }` | `{ host, output_dir, count, items[{ id, title, uploader, channel, channel_id, duration_s, upload_date (ISO), webpage_url, extractor, ext, description, playlist_title, playlist_index, path, size_bytes, subtitle_paths[] (.vtt), thumbnail_path }], warnings[], elapsed_ms }`. `count: 0` is a success (everything was already in the archive). A fetch that stopped at `max_items` is a success. Failure codes: `rate_limited`, `login_wall`, `unavailable`, `unsupported`, `network`, `failed`, `media_quiet_mode`, `tool_setup_failed`. |
| `media.transcode` | `{ path, output_dir, output_name (no extension), max_height (never scales up), video: "auto", "encode" or "copy" (auto), audio: "auto" or "encode" (auto), crf (23), preset ("veryfast"), audio_bitrate_k (160) }` | `{ path, size_bytes, container ("mp4"; "m4a" for audio only), video_action ("copy", "encode" or "none"), audio_action, duration_s, width, height, video_codec, audio_codec, elapsed_ms }`. H.264 + AAC + `+faststart`, chapters and tags kept; `auto` copies a stream that is already 8-bit H.264 (within `max_height`) or AAC. `percent` moves with the output time. The output is written as `<name>.mp4.part` and renamed on success; nothing partial is left on failure or cancel. |
| `media.preview` | `{ path, output_dir, thumbnail (true), storyboard (true), clip (true), thumbnail_at_s (10 percent in), thumbnail_width (640), storyboard_columns (10), storyboard_frames (100 at most), storyboard_tile_width (160), clip_start_s (30 percent in), clip_length_s (6), clip_height (360) }` | `{ duration_s, thumbnail{ path, width, height, at_s, from_cover_art, size_bytes }, storyboard{ path, width, height, columns, rows, tile_width, tile_height, interval_s, frames, size_bytes }, clip{ path, start_s, duration_s, height, has_audio: false, size_bytes }, skipped[{ part, reason }], elapsed_ms }`. An audio file gets its cover art as the thumbnail and skips the other two. Frame `n` of the sheet is at `n * interval_s`. |
| `media.companion_clip` | `{ path, output_dir, output_name (optional output subfolder), key: "#00FF00" or "#FF00FF" or "none", kind: "loop" or "oneshot", min_seconds (1 to 10), max_seconds (1 to 10), colours (up to 8 uppercase #RRGGBB values), max_bytes (614400) }`. Source must be mp4, mov or webm, at most 12 seconds and 64 MB. `none` requires alpha in the source. | `{ seconds, frames, fps: 24, width: 480, height: 960, files[{ name, path, bytes }], av1, loop_gap, colour_distance?, area_ratio, opaque_share{ min, max }, ok, reasons[], report_path, elapsed_ms }`. Writes `clip.h264.mp4`, optional `clip.av1.mp4`, `still.png` (straight-alpha RGBA), and `report.json`. H.264 and AV1 are silent, yuv420p, fast-start MP4 files, each limited by `max_bytes`; AV1 is omitted when `libsvtav1` is unavailable. Both encode and tag BT.709 colour (matrix, primaries and transfer), with limited-range YUV. The video is a 480 x 960 frame: the top 480 rows are RGB premultiplied by alpha, and the bottom 480 rows are the alpha matte in greyscale. Home's player un-premultiplies the top half in a shader. Quality limits are first guesses for the key-colour bench. Failure codes: `no_alpha`, `too_short`, `too_large`, `unreadable`, `bad_input`. |
| `media.setup` | `{}` | `{ tools{ ffmpeg, ffprobe, "yt-dlp" } (paths), elapsed_ms }`. Downloads and checks all three tools now. |

**Quiet mode.** The limiter keys a site by its registrable host (`www.`, `m.` and other subdomains share a key; `media.example.co.uk` is `example.co.uk`).
Four failures in a row that mean the site is pushing back (a 429, a sign-in wall) put it in quiet mode for 30 minutes; a removed video, an unsupported
link or a network error never counts. While a site rests, a `media.fetch` without `person_initiated: true` is refused at submit with 503
`media_quiet_mode` (the sentence names the site and when it ends); one with `person_initiated: true` still runs, and a success ends quiet mode early.
Background requests to one site are also spaced at least 5 seconds apart, and yt-dlp pauses 3 to 8 seconds between files. The state survives a Stack
restart. `GET /stack/v1/media` lists the resting sites so Home can skip a poll without asking.

**State.** `GET /stack/v1/media` returns `{ media: { supported, platform, tools[{ name, installed, version, licence, source }], kinds[], lane{ name,
cap, queued, running_job, deadlines_minutes }, quiet_hosts[{ host, until, failures }], quiet_policy{ failures, minutes }, roots{ read, write } } }`.

**Tools and licences.** ffmpeg and ffprobe 8.1.3 come from one pinned archive per platform of jellyfin-ffmpeg 8.1.3-1 (GitHub release, sha256 and size
pinned; GPL-3.0-or-later build with libx264 and no nonfree parts; the Stack only runs them and ships no copy). Why this source: the other static macOS
builds are either `--enable-nonfree` (eugeneware/ffmpeg-static, which no licence lets anyone redistribute) or on a second download host that the privacy
page would have to name. yt-dlp 2026.8.19 is a hashed PyPI requirements file (Unlicense, with its default extras) synced into a uv environment, the
recipe of the image tools. The licence record is in `backend/src/media/pins.ts` and `docs/components.md`. `STACK_MEDIA_FFMPEG`, `STACK_MEDIA_FFPROBE`
and `STACK_MEDIA_YTDLP` point at programs an operator already has. No request is ever made to a video service by the Stack itself or by its tests
(RULES.md V1): the tests fetch a localhost fixture with yt-dlp's generic extractor.

## Chat and voice win over heavy jobs (ISOLATION-01)

The Stack sees every chat, transcription and speech request itself, so it keeps a heavy job from slowing them without any header or call from Home.

- **Interactive** means a request on `chat`, `coding`, `vision`, `router` (`/v1/chat/completions`), `stt` (`/v1/audio/transcriptions`, and each transcript event on the speech session websocket) or `tts` (`/v1/audio/speech`). The memory judge, embeddings, rerank and token counts are background and never pause anything.
- While one is in flight, plus a 4 s tail after the last one ends, the worker that is running a job (picture, video, music, image tools) is stopped with SIGSTOP and then continued with SIGCONT. It keeps its memory and loses no work; a streamed reply counts until its last byte is read or the client leaves.
- Only a worker the Stack itself started and attached for a running job can be stopped, never the Stack, never an engine behind a role. The one exception is the coding engine (CODE-STACK-01 S3b, `stack.engines.coding.yield_to_chat`, default on): while a coding request is in flight it is stopped for every interactive request but coding's own, for at most 120 s at a time (`STACK_ISOLATION_CODING_MAX_PAUSE_MS`), then runs 60 s before it can be stopped again. Every way out continues it first: the job ending, a cancel, the memory watchdog's cancel, the Stack stopping or exiting, a worker dying. One pause lasts at most 10 minutes, then it is continued by force (log `isolation.resume_forced`) and runs for 60 s before it can be stopped again. The pids of stopped workers are kept in `isolation-paused.json` in the data directory so a Stack that was killed while a worker was stopped continues it at its next start.
- The job deadline and the progress estimate do not count the paused time. The job stays `running`; its `status` is `paused: chat` on `GET /stack/v1/jobs/{id}`, and the status routes of the picture, video and music jobs say `stage_label` "Paused while chat is working" with `eta_seconds` null (music: `stage` "paused"). The estimate carries on at the resume.
- Log lines (JSON, `stack.log`): `isolation.paused` and `isolation.resumed` with job, role and paused seconds, `isolation.resume_forced`. `GET /stack/v1/memory` has an `isolation` object: `paused_now`, `interactive_in_flight`, `pauses`, `resumes`, `forced_resumes`, `paused_seconds`.
- `STACK_ISOLATION=off` in the Stack's environment turns the pause off (for measuring); `STACK_ISOLATION_TAIL_MS`, `STACK_ISOLATION_MAX_PAUSE_MS` and `STACK_ISOLATION_FORCED_RUN_MS` tune it.

## Video generation (VIDEO-GEN-01 to 03)

Wan2.2 TI2V-5B with FastWan's 3-step distillation, run by mlx-video on the Apple GPU (a Mac with 128 GB: tier `p128` only, because a clip peaks at 44.1 GB beside the roughly 28 GB resident on a 64 GB Mac and every clip there would be refused with `no_memory`;
`p16`, `p32` and `p64` answer 503 `not_available_on_this_computer`). Text to video and picture to video, 24 fps, no sound. A 5 s clip
(121 frames) at 832 x 480 takes about two and a half minutes and peaks at 44.1 GB, so a clip holds one pinned governor admission of that size
and chat is never evicted for it; a Mac that cannot hold the clip beside what is resident answers 503 `no_memory` at once. Design and the
measurements: Home `docs/design/video-generation-2026-10-17.md`.

**Two models (VIDEO-LTX-01).** `model` on `POST /v1/videos/generations` is `video` or `quick` (the default: the clip above, silent, up to 5 s, can start from a
picture), or `detailed` (LTX-2.3 on the same mlx-video, 768 x 448 or 448 x 768, 64-pixel steps, up to 10 s: a 5 s clip takes about 45 s, a 10 s clip about
80 s, a sound track with speech is made in the same pass, admission 46 GB). A model's own id names it too; anything else is 422 `unknown_model`. A length past
the model's ceiling is 422 `bad_seconds`, a picture can start a `detailed` clip too (`image_to_video` true on both qualities; the same generated-picture rule), a model
that is not installed is 503 `not_installed`. Results carry `quality` and `audio`; `GET /stack/v1/video` has `qualities.quick` and `qualities.detailed`
(`id`, `installed`, `available`, `audio`, `image_to_video`, `limits`, `memory`, `install`, `licence`, `lora_base_model`). Only one video model is in memory: asking
for the other stops the first one's worker. The Detailed component (`ltx-2-3-distilled-mlx`, p128 only, 73.6 GB; `plan_need: recommended`, so the setup wizard checks it by default, and an upgrade never installs it on its own: it shows as not installed with an Install button) needs the maker's licence accepted
once: `POST /stack/v1/components/{id}/install` answers 409 `licence_required` until the body carries `accepted_licence` (the `licence.id` the component lists);
the acceptance is one small file (`licence-acceptances.json`) and no name. Video LoRAs record the model they were made for (`base_model` `wan2.2-ti2v-5b` or
`ltx-2.3`, read from the tensors; `GET /stack/v1/video/loras` lists `base_models`), and a clip applies only LoRAs of its own model (422 `wrong_base_model`).

`POST /v1/videos/generations` (JSON) answers like `/v1/images/generations`: 200 `{ created, job, data: [{ url, poster_url, content_type, width, height,
frames, fps, seconds, seed, model, mode, lora_ids, ms, bytes, poster_bytes }] }`, or 202 `{ created, job, data: [] }` when the clip is still going at
`timeout_ms` (30 s unsaid, 30 min at most); then poll. Fields: `prompt` (required, 4000 characters), `negative_prompt` (accepted; the distilled model
runs without guidance, so it has no effect), `image` + `image_source` (see below), `size` (`832x480` default; multiples of 32, each side 256 or more,
area at most 399,360 pixels, so `480x832` also fits and 1280x704 does not), `seconds` (whole, 1 to 5, default 5), `seed`, `loras` (`[{ id, strength }]`, at
most 4, strength 0 to 2, the record's default when left out), `audience` (`all-ages` unsaid, or `adult`), `timeout_ms`. Errors carry `error` (what
happened and what to do) and `code`: 413 `too_large`; 422 `bad_size` `bad_image` `reference_source_required` `reference_image_refused`
`reference_not_generated` `unknown_lora` `lora_not_allowed` `lora_changed` `lora_missing` `too_many_loras` `duplicate_lora` `bad_strength`; 429 `queue_full` (four clips
already waiting); 499 `cancelled`; 500 `failed` `worker_stopped`; 503 `not_available_on_this_computer` `unsupported` `not_installed` `no_memory` `setup_failed`
`model_missing`; 504 `timeout` (15 minutes); 507 `out_of_memory`. A request body that breaks the schema (a sixth second, an empty prompt) is a plain 400.

`GET /v1/videos/generations/{job}` returns `{ job, state, phase, progress, phase_progress, position, error, code, data }`. `state` is `queued`,
`running`, `done`, `failed` or `cancelled`; `phase` is `queued`, `waiting for memory`, `starting`, `setting up` (the first clip only: the Python
environment and the pinned source build once), `loading`, `rendering`, `decoding`, `encoding`, `ready`. `progress` is 0 to 100 over the whole clip,
weighted by where the time goes (decoding is about 85 percent of it); `phase_progress` is 0 to 100 inside the phase. `data` holds the same entry as the
200 answer once `state` is `done`. A job the Stack no longer remembers (restart) but whose files are still held answers `done`; one whose files are gone
is 404 `unknown_job`. `GET .../{job}/video.mp4` serves the clip (H.264, yuv420p, 24 fps, a silent AAC track so a messaging app treats it as a clip, moov box first, titled `MaiPai video`, Range requests supported; a Stack without the video environment's ffmpeg keeps the plain video-only file) and
`GET .../{job}/poster.jpg` the JPEG of frame 0. `GET .../{job}/messages.mp4?title=` is the same clip prepared for messaging apps (made on first request and kept with the result; at most 20 MB, 503 `no_ffmpeg` when the video tools are missing). `POST /v1/videos/messages` (body: an mp4, at most 100 MB; the title goes in a percent-encoded `x-title` header, never the URL) is the stateless form: it returns the prepared file and keeps nothing, for a clip stored before the Stack made them this way. `DELETE /v1/videos/generations/{job}` cancels a queued or running clip (the worker is stopped and its
memory returns) or, for a finished one, deletes its files; Home calls it once it has stored the file. Results are otherwise kept for a day and the
newest 24 under `data/video/results/<job>/`. No prompt and no reference picture is written there, logged, or put in a job record or on the event feed.

GENPREVIEW-01 (stages, ETA, preview). While a clip runs the same status also carries `progress_fraction` (0 to 1, never goes back), `stage`
(`load_text`, `plan`, `load_model`, `motion`, `frames`, `save`), `stage_label` (the stage in words: "Making the motion, step 2 of 3", "Putting the frames
together, 24 of 60"), `step` and `steps` (motion steps finished and in all, only in the `motion` stage), `eta_seconds` (whole seconds left; the countdown only
runs down unless the stage's own measured pace says the run is slower) and `preview_url`. `progress` is `progress_fraction` as a whole percent whenever the
worker reports stages; a worker that reports only phases keeps the old weights. Stage weights are the measured shares of a clip (load 3 percent, plan 1, model
2, motion 9, frames 83, save 2). The ETA comes from the median seconds of each stage over the last seven clips of the same size and length, kept as numbers in
`data/gen-history.json` (a built-in total of about 130 s until there is history). `preview` in the request body (default true) asks for the first-frame
preview: the moment the motion is finished and the long frame-building stage starts, the worker decodes the first latent frame alone (about a second) and writes
`preview.jpg` (up to 480 px on the long side) into the job's work folder; `GET /v1/videos/generations/{job}/preview.jpg` serves it while the job runs, and
`preview_url` is null before then, when `preview` was false, and after the job ends (the clip's own `poster_url` takes over). The preview is deleted with the
job's work folder (done, failed, cancelled, or a Stack restart). Per-step previews of the noisy motion were not built: they need the frame decoder loaded for the
whole motion stage, which is only 9 percent of the clip.

**Reference pictures (VIDEO-GEN-12, owner ruling 2026-10-17).** `image` is a PNG, JPEG or WebP as base64 (a `data:` URL is fine), at most 20 MB,
and needs `image_source`. Only `generated` is accepted, and only for a picture this Stack's own image generator returned (or the poster of one of its own
clips): the Stack records the sha256 of every picture it generates (hash and time only, 30 days, the newest 2,000) and checks the bytes it is given, so the
picture must arrive unchanged. `uploaded` and any picture the Stack did not make are refused for everyone. The one other source is `household_photo`
(LIKENESS-01, owner ruling 2026-10-17): a photo of a household adult who agreed, accepted only with `consent_proof`, Home's signed proof (below) bound to the
sha256 of that exact picture. Home applies its own age, surface, consent and face-count gates first.

**Likeness proofs (LIKENESS-01).** Who agreed to what is Home's record; the Stack refuses to act on a likeness without a short-lived proof Home signed for
that one thing. A proof is `<payload>.<signature>`, both base64url: the payload is JSON `{ v: 1, purpose, subject, requester, bind, iat, exp, jti }` and the
signature is Ed25519 over the payload text. `purpose` is `photo` (a photo of the subject starts a clip, a picture or an edit; `bind` is the picture's sha256),
`style_import` (a style of the subject is added; `bind` is the file's sha256, so it is added as a file, never from a link) or `style_use` (that style is applied;
`bind` is the LoRA id). A proof lives at most 30 minutes (`exp - iat`), is accepted once (its `jti` is remembered until it expires: `likeness_proof_replayed`),
is checked when the request arrives and again when the job starts (a job can wait minutes in the line), and is refused when forged, expired, for another
picture or purpose, or when no key is registered. A photo or style of a person is made only with `audience: adult` (`likeness_adult_only`). Trust on first use is
the limit of the key registration: the Stack and Home share one computer's loopback, so Home registers at start and compares the fingerprint it gets back. Home registers its public key once with `PUT
/stack/v1/likeness/trust { public_key }` (base64 SPKI DER, Ed25519); the first key is trusted, a different one replaces it only with `rotation_signature`, the
old key's signature over the new key's base64 text (409 `likeness_key_mismatch` otherwise). `GET /stack/v1/likeness` reports `{ trusted, fingerprint,
max_proof_minutes }`. Errors are 403 with `likeness_proof_required`, `_invalid`, `_expired`, `_mismatch` or `likeness_not_trusted`.

**Pictures that look like a person.** A LoRA record has `likeness_subject` (the opaque id Home gave, or null). A file whose own description names a real
person's likeness is refused at import, unless the import carries `likeness_subject` and a valid `style_import` proof; a file that names a public figure
(celebrity, actor, influencer, politician and the like) is refused with or without one, and a minor in a sexual context is refused always. A likeness LoRA is
always adult-only (`classification_locked` on any change) and every picture or clip request that applies it needs `likeness_proof` (a `style_use` proof) on its
`loras` entry. `init_image` on `/v1/images/generations` and the picture of `/v1/images/edits` now need `image_source` too (`generated` checked against the
ledger, `household_photo` with a proof, or `uploaded`: a photo Home found to show no person). Output of a job that rested on a proof is not recorded as a
generated picture, so starting again from it needs a fresh proof. Home applies its own age, surface and consent gates first.

**LoRAs.** The household library is `data/video/loras/` (one `.safetensors` per record plus `manifest.json`). `GET /stack/v1/video/loras`;
`POST /stack/v1/video/loras` (multipart: `file`, or `path` for a file already on the Stack's computer; `name`, `licence`, `licence_acknowledged`,
`source_url`, `classification`, `strength_default`, `trigger_words` comma separated or a JSON array, `added_by`); `PATCH` and `DELETE /stack/v1/video/loras/{id}`.
The id is `lora-` and the first 16 hex of the sha256. The Stack reads the tensor shapes from the file's header: a LoRA for the 14B model (width 5120) or
the 1.3B model (1536) is refused 422 `wrong_base_model`; a file with no LoRA tensors is `not_a_lora`. An open licence (apache-2.0, mit, cc0-1.0, bsd-2/3-clause,
unlicense, isc, cc-by-4.0) imports as is; any other needs `licence_acknowledged=true` (422 `licence_acknowledgement_required`) and is recorded as
`acknowledged`. `classification` is `all-ages` or `adult-only` and defaults to `adult-only` (uncertain means adult-only); a file whose own metadata, name, tags or
trigger words name adult content is adult-only whatever is asked (409 `classification_locked` on a later try), and one that names a child or a minor in a sexual
context is refused outright (422 `lora_refused`; the word lists are a tripwire in `video/loras.ts`, not a judgement of the pictures). **Who may use which LoRA is
Home's rule**: the clip request names the ids it may apply, and `audience` is a second lock, so an `all-ages` request that names an `adult-only` LoRA
is refused (`lora_not_allowed`) even if Home's list is wrong. A file whose size or time changed since it was added is re-hashed before use (`lora_changed`).
The weights are merged into the model at load, so a LoRA adds about a second. The request body limit is 2 GB for the upload.

`GET /stack/v1/video` returns `{ video: { state, phase, available, code, reason, tier, memory, model, limits, loras_supported, lora_count, audio,
negative_prompt, reference_images, worker, environment, install } }` for Home to enable its control: `state` is `unsupported`, `off` (this tier), `not-installed`
(the model files are missing), `needs-setup` (installed; the first clip builds the environment and starts the worker), `building`, `idle` (the worker waits ten
minutes for the next clip, then exits and returns its memory) or `running`. `install.models` lists the two pins (the 24.2 GB FastWan MLX folder and the 21 MB umt5
tokenizer) shaped as install-plan models to post to `POST /stack/v1/models` (the Stack fills in each folder's pinned file list from its own pin), and
`POST /stack/v1/engines/video-gen/install` builds the pinned mlx-video source and the environment ahead of the first clip. The `video` role in
`GET /stack/v1/roles` follows the same facts: `notInstalled`, `installed`, `loaded` (the worker is up), `ready` (a clip finished in the last hour).
The tokenizer is the one file set the model would otherwise fetch from the Hub at run time; it is pinned, so the worker runs with `HF_HUB_OFFLINE=1` and
makes no network request.

## Music generation (MUSIC-GEN-01 and 02)

ACE-Step 1.5 (MIT; the 2B turbo DiT, a 5 Hz planning LM, the Qwen3-Embedding-0.6B text encoder and the music VAE) runs in process on the Apple GPU,
driven by one JSON-lines worker inside the managed Python 3.12 environment `music-gen`. No `acestep-api` server and no port. The worker starts on the first
song, keeps its models for five idle minutes (`MUSIC_IDLE_MS`; songs come in bursts of edits), then exits and returns its memory. It is never started at boot,
runs with `HF_HUB_OFFLINE=1`, and makes no network request. Tiers: `p128` (songs up to 240 s, quality `quick` or `detailed`, default `detailed`) and `p64` (up to
120 s, `quick` only); `p16` and `p32` answer 503 `not_available_on_this_computer`. Quality is the planning model: `quick` the 0.6B one, `detailed` the 1.7B one.
Design and the measurements: Home `docs/design/music-generation-2026-10-17.md`, sections 3, 4 and 12.

The on-demand MUSIC-GEN-17 bench measures sung-word recall, unmatched heard words with their times and LRC sections, and a squeezed ending. Run `python3 backend/scripts/bench/music-sung-words.py --stack http://127.0.0.1:<scratch-port> --lyrics <file> --caption "rock vocals" --seconds 60 --seed 42 --quality quick --whisper <model-dir> --out <dir>` with an existing local whisper model directory and a scratch Stack, never the live one. It saves `song.m4a`, `job.json` and `report.json`; a repeated LRC timestamp in the last 1.5 seconds fails (exit 1), with the preceding line included in the reported tail. Extra heard words are diagnostic only because whisper can mishear growled vocals. Pass exits 0; an error exits 2. This bench never runs in the gate.

`POST /v1/audio/music` (JSON) answers like the picture and video routes: 200 `{ created, job, data: [{ url, content_type, duration_s, seed, model, task, ms, bytes,
lrc }] }`, or 202 `{ created, job, data: [] }` when the song is still going at `timeout_ms` (60 s unsaid, 30 min at most); then poll. Fields: `task` (required:
`text2music`, `cover`, `repaint`, `extend`, `edit`), `caption` (style, mood, instruments, voice), `lyrics` (ACE-Step's tagged form), `instrumental`, `duration_s`
(`text2music` only: 10 to the tier's longest, default 60), `bpm` (30 to 300), `key`, `language`, `seed`, `quality`, `source` (base64 of an m4a this Stack made,
unchanged; at most 40 MB) with `source_sha256`, `from_s` and `to_s` (`repaint`: at least 2 s), `add_s` (`extend`: 5 to 120 s, default 20; `at` is `end` or `start`),
`strength` (`cover`: 0.1 to 1, default 0.6), `edit` (`{ op: trim | fade | loudness, from_s, to_s, seconds, where, lufs }`), `title` (written into the file), `timeout_ms`.
A `text2music` song needs a `caption` or `lyrics` (an instrumental needs a `caption`); the other tasks need `source`, and `repaint` needs `from_s` and `to_s`. The
chat model writes the lyrics; the Stack never asks ACE-Step to. Errors carry `error` (what happened and what to do) and `code`: 413 `too_large`; 422 `bad_request`
`bad_range` `too_long` (4000 characters of `caption` or `lyrics`) `source_not_made_here`; 429 `queue_full` (four songs already waiting); 499 `cancelled`; 500 `failed`
`worker_stopped`; 503 `not_available_on_this_computer` `unsupported` `not_installed` `no_memory` `setup_failed` `model_missing`; 504 `timeout` (10 minutes); 507
`out_of_memory`. A body that breaks the schema (an unknown `task`, a negative seed) is a plain 400.

`GET /v1/audio/music/{job}` returns `{ job, state, phase, progress, progress_fraction, stage, stage_label, eta_seconds, position, error, code, data }`. `state` is `queued`,
`running`, `done`, `failed` or `cancelled`. `stage` is `load`, `plan`, `music`, `mix` or `save` and `stage_label` says it in plain words: "Getting ready", "Planning the
song", "Making the music", "Mixing it down", "Saving". `progress_fraction` (0 to 1, never goes back) is weighted by measured stage times and `progress` is the same as a whole
percent; `eta_seconds` is whole seconds left, from the medians of the last seven jobs of the same task and length kept as numbers in `data/gen-history.json` (the built-in
times for a 60 s song are plan 16 s, music 1.4 s, mix 2.7 s, save 1 s, and no load when the worker is warm; the countdown only runs down unless the stage's own pace says
the run is slower). An edit skips plan and music, and a skipped stage counts as done. A job the Stack no longer remembers (restart) but whose file is still held answers
`done`; one whose file is gone is 404 `unknown_job`. `GET /v1/audio/music/{job}/file` serves the song (`audio/mp4`: AAC-LC, 48 kHz stereo, 256 kbps, the moov box first,
no tags except `title`; Range requests supported). `DELETE /v1/audio/music/{job}` cancels a queued or running job (the worker is stopped and its memory returns) or,
for a finished one, frees its file; Home calls it once it has stored the file. Results are held about ten minutes (`MUSIC_RESULT_TTL_MS`) and the six newest under
`data/music/results/<job>/`. No caption, lyrics, title or source song is written there, logged, or put in a job record or on the event feed; the lyric timings (`lrc`) are kept in
memory only, for as long as the song is held.

**The made-here ledger.** A change (`cover`, `repaint`, `extend`, `edit`) starts only from a song this Stack wrote. The Stack records the sha256 of every m4a it writes (hash
and time only, 30 days, the newest 2,000, in `data/music/made-here.json`) and checks the bytes it is given, so Home must send the stored file unchanged. Any other song is
422 `source_not_made_here` with "I can only change a song that was made here."; `source_sha256`, when sent, must equal the bytes' sha256 (422 `bad_request` otherwise). There is
no way to bring a recording in (Home's note, section 9: no uploaded audio and no real person's voice in v1).

**Edits.** `task: edit` runs no model: the worker trims, fades or normalises the decoded samples and encodes the file again, well under a second. It takes no governor
admission, but it goes through the same single chain as a song, so the worker is never shared: an edit sent while a song is being made starts when the song ends.

Memory: a song holds one governor admission through the generator queue (one generator job at a time across pictures, video and music; the loser shows `waiting for memory`)
of `MUSIC_PEAK_BYTES` (33 GB: the measured 32 GB peak of a 240 s detailed song plus a gigabyte). A song that can never fit beside what is resident is 503 `no_memory` at once, and so is any song while
the memory watchdog's level is not `normal`. Four songs may be waiting (429 `queue_full`).

`GET /stack/v1/music` returns `{ music: { state, available, code, reason, tier, memory, model, limits, quality, default_quality, tasks, worker, environment, install } }` for Home
to enable its control: `state` is `unsupported`, `off` (this tier), `not-installed` (the model files are missing), `needs-setup` (installed; the first song builds the environment
and starts the worker), `building`, `idle` (the worker waits five minutes for the next song, then exits) or `running`. `limits` holds `min_seconds` (10), `max_seconds` (the tier's, 0 when
off), `default_seconds`, `min_bpm`, `max_bpm`, `min_extend_seconds`, `max_extend_seconds`, `max_text_chars`, `max_source_mb` and `queue_max`; `quality` is the list this tier offers
and `default_quality` the one used when a request names none. `install.models` lists the two pins (the 10.1 GB ACE-Step folder, with the 1.7B planning LM, and the 1.37 GB 0.6B
planning LM) shaped as install-plan models to post to `POST /stack/v1/models`, and `POST /stack/v1/engines/music-gen/install` builds the pinned ACE-Step source and the
environment ahead of the first song. The `music` component (`GET /stack/v1/components`, group `music`, "Music: ACE-Step 1.5", optional, `p64` and `p128`) installs and removes
both. The `music` role in `GET /stack/v1/roles` follows the same facts: `notInstalled`, `installed`, `loaded` (the worker is up), `ready` (a song finished in the last hour).
The worker is handed a checkpoints folder the Stack assembles with links from the two pinned model folders; ACE-Step writes its own model code (two .py files) into the DiT
folder there, which is why the model repository's copies of those two files are not pinned (the code that runs is the pinned package's).

## Picture generation (IMGGEN-STACK-01 and 02, IMGGEN-EDIT-01, IMGGEN-LORA-01)

FLUX.2 Klein 4B (Apache-2.0) is the default on every tier (owner ruling 2026-10-17: plain pictures stay fast, about 4 s); Z-Image-Turbo (Apache-2.0, 13 to 30 s, the most community LoRAs) is the optional second model on a 128 GB Mac, chosen by name or by a LoRA made for it. Both run on mflux 0.23.0 (MLX, Apple GPU)
inside one managed Python 3.12 environment and one worker process that exists only while picture work does: it starts on the first request, waits ten
minutes (`IMAGE_IDLE_MS`) for the next one, then exits and returns its memory. It is never started at boot and never kept warm. The weights are pinned
model records (revision, sha256, bytes, licence per file; about 16 GB for Klein, 33 GB for Z-Image) placed in the hub cache, and the worker runs with
`HF_HUB_OFFLINE=1`. When at least one family is installed on an Apple silicon Mac with 32 GB or more, this path answers `image`; with none installed the
role stays on the supervised ComfyUI checkpoint exactly as before (`GET /stack/v1/roles` shows which). Design and the measurements: Home
`docs/design/image-engine-2026-10-17.md`.

Memory: a job holds one governor admission through the generator queue (one generator job at a time across pictures and video; the loser shows
`waiting for memory`): Klein 8-bit 15 GB (13 GB at 4-bit on a 32 GB Mac, which is the only change a tier makes), Klein reference edit at bf16 18 GB,
Z-Image-Turbo 34 GB (p128 only), plus 1 GB while LoRAs are applied (unbaked: about 0.6 s a picture slower, no rebuild to change a scale). A request that can
never fit beside what is resident is 503 `no_memory` at once. Four jobs may be waiting (429 `queue_full`).

`POST /v1/images/generations` (JSON) answers 200 `{ created, job, data: [Pic] }` within `timeout_ms` (two minutes unsaid, 30 minutes at most), or 202
`{ created, job, data: [] }` past it; then poll. Fields: `prompt` (required, 4000 characters), `model` (`image` or unsaid for the default; `flux2-klein-4b`;
`z-image-turbo`), `size` (`1024x1024` unsaid; 256 to 2048 a side, multiples of 16), `n` (1 to 4; seeds `seed`, `seed+1`, ...), `seed`, `steps` (4 for
Klein, 9 for Z-Image; at most 12 and 20), `negative_prompt` (accepted, no effect: the distilled models run without guidance), `loras`
(`[{ id | sha256, scale }]`, at most 4, scale 0 to 2, the record's default when left out), `audience` (`all-ages` unsaid, or `adult`), `init_image` (base64,
at most 40 MB, needs `image_source` and, for a household photo, `consent_proof`) with `strength` (0.05 to 1, default 0.6) for image to image, `preview` (default true: the status carries a small preview picture while the job runs, see below; false skips it), `timeout_ms`. A LoRA selects the base model it
was made for (a request that mixes bases is 422 `wrong_base_model`). `Pic` is `{ url, thumbnail_url, b64_json (the waiting reply only), content_type, seed,
width, height, model, steps, ms, lora_ids, mode }`. Errors carry `error` (what happened, what to do) and `code`: 413 `too_large`; 422 `bad_size` `bad_steps`
`bad_image` `unknown_lora` `wrong_base_model` `lora_not_allowed` `lora_changed` `lora_missing` `too_many_loras` `duplicate_lora` `bad_strength`; 429 `queue_full`;
499 `cancelled`; 500 `failed` `worker_stopped`; 503 `not_available_on_this_computer` `unsupported` `not_installed` `no_memory` `setup_failed` `model_missing`;
504 `timeout`; 507 `out_of_memory`. A body that breaks the schema is a plain 400.

`GET /v1/images/generations/{job}` returns `{ job, state, phase, progress, phase_progress, position, error, code, data }`; `state` is `queued`, `running`,
`done`, `failed` or `cancelled`; `phase` is `queued`, `waiting for memory`, `starting`, `setting up` (first picture only), `loading`, `rendering`, `decoding`,
`ready`. `progress` is 0 to 100 over the whole job (5 percent loading, then the step and decode share, per picture of `n`). The job is also on
`GET /stack/v1/jobs/{id}` (`percent`, `position`, `status`, and `result` `{ job, model, mode, ms, images: [{ index, seed, width, height }] }`). `GET
/v1/images/generations/{job}/{index}.png` is the picture (a fresh PNG with no metadata) and `.../{index}.thumb.jpg` its 384 px JPEG. `DELETE
/v1/images/generations/{job}` cancels a queued or running job (the worker stops between steps; one that does not answer in ten seconds is killed and its
memory returns) or deletes a finished job's files; Home calls it once it has stored them. Results are kept a day and the newest 48 under
`data/images/results/<job>/`. No prompt and no input picture is written there, logged, or put in a job record or on the event feed. Every picture the Stack
generates is recorded by hash for the video reference-picture gate (VIDEO-GEN-12).

GENPREVIEW-01 (steps and preview). While a picture runs the status also carries `progress_fraction` (0 to 1, never goes back), `stage` (`load`, `plan`,
`steps`, `decode`), `stage_label` ("Drawing, step 2 of 4"), `step` and `steps` (denoising steps finished and in all), `eta_seconds`, `preview_url` and
`preview_step`. After each denoising step the worker estimates the finished picture from the last two latents (the schedulers are Euler steps along a straight
line, so the point at sigma 0 is a linear extrapolation), average-pools the latents to a grid that decodes to about 256 px, runs the VAE on that, and writes
`preview.jpg` (JPEG, about 5 KB) into the job's work folder; `GET /v1/images/generations/{job}/preview.jpg?v=<n>` serves the newest one while the job runs
(`v` rises with each new file) and answers 404 `no_preview` before the first step finishes, when `preview` was false, for edits, and after the job ends (the
folder is removed with the job; a cancelled or failed job leaves nothing, and a Stack restart sweeps strays). `preview_step` is the step it shows. With `n` above
1 the preview is of the picture being made now. Measured on the Studio: the previews add about 3 percent to the worker's time for a 1024 x 1024 Klein picture
(4.25 s to 4.39 s median of 12 pairs), and about 1.5 percent for Z-Image-Turbo (13.29 s to 13.49 s median of 6 pairs, nine previews a picture). The ETA history is kept per size and picture model.

**Edits.** `POST /v1/images/edits` (multipart) gains two operations that run Klein's reference edit at bf16 (8-bit left a plant in the picture it was asked
to remove): `edit` (field `instruction`, one picture; the whole picture may change) and `edit_masked` (also `mask`, white is changeable, and/or `region` as
`x,y,w,h` fractions; `feather` 0 to 64 pixels, default 12). The Stack crops the changed area with context when it is under a quarter of the picture, edits at
up to 1024 px on the long side, and composites the result through the feathered mask, so the original pixels outside the mask and its feather ring are
unchanged bit for bit (0 feather: exactly the mask). `seed`, `steps`, `timeout_ms` as above. The reply is the generation reply (200 or 202, `Pic` with `mode`
`edit` or `edit-masked`, files under `/v1/images/generations/{job}/0.png`); extra codes: 422 `instruction_required` `mask_required` `bad_region` `mask_empty`.
IMGEDIT-01 additions (additive): `edit` and `edit_masked` take up to two extra pictures, `reference` and `reference2`, that the edit draws on ("add the woman from the
second picture to the bench"). Each is declared like the main picture (`reference_source`, `reference2_source`: `generated`, `uploaded` or `household_photo`) and a
`household_photo` reference needs its own signed likeness proof (`reference_proof`, `reference2_proof`, bound to that picture's hash, used once) and `audience: adult`.
With a reference the whole scene goes to the model (no crop). `GET /stack/v1/image` reports `edit.references` (0 on a Stack that cannot).
Two more tool operations, Apple's on-device person finder (macOS 14 and later, a small helper compiled once like the foreground finder): `find_people` answers `data[0].people`
(numbered boxes as fractions of the picture, each person's main blob only) and a copy of the picture with the boxes drawn and numbered; `erase_people` (field `people`: `1,3` or `all`)
erases those people and fills the place with LaMa; `people_mask` (same field) answers the grown mask of those people (white on black PNG) for `edit_masked` to fill with the picture model (2.6 s on the Studio, cleaner than LaMa). Codes: 422 `no_people`, `people_unavailable` (no helper: paint over the person with `erase`), `people_required`.
The other non-generative operations (`remove_background`, `erase`, `upscale`, `resize`) are unchanged.

**LoRA library.** `data/images/loras/` holds one `.safetensors` per record (named by its sha256) and `manifest.json`: `GET /stack/v1/image/loras`;
`POST /stack/v1/image/loras` (multipart: `file`, or `path` for a file already on the Stack's computer; `name`, `licence`, `licence_acknowledged`,
`source_url`, `classification`, `strength_default`, `trigger_words`, `added_by`); `POST /stack/v1/image/loras/install` (JSON `{ url, name, licence?,
... }`: a `huggingface.co` file link only, fetched by an install job, hashed on arrival, the repository's licence and tags read from the Hub; the job's
`result.lora` is the record, a failed job's `reason` starts with the code); `PATCH` and `DELETE /stack/v1/image/loras/{id}`. The id is `lora-` and the first
16 hex of the sha256. The base model (`flux2-klein-4b` or `z-image-turbo`) is read from the tensors; an SDXL-family file (SDXL, Pony, Illustrious, NoobAI), a FLUX.1 or Chroma file declared in its header, or a Wan file is refused 422 `wrong_base_model`
and says where it belongs. Open licences import as is; any other needs `licence_acknowledged=true`. `classification` defaults to `adult-only` (uncertain means
adult-only); a file whose own metadata, name, tags or trigger words name adult content is adult-only whatever is asked. Refused outright (422
`lora_refused`, no setting lifts it): a file that names a child or a minor in a sexual context, and a file that says it reproduces a real person's likeness
(a celebrity or likeness tag; a consenting household member's own face is refused until the owner rules). The word lists are a tripwire in
`lib/media/loraLibrary.ts`, not a judgement of the pictures. **Who may use which LoRA is Home's rule**: the request names the ids it may apply and
`audience` is a second lock (an `all-ages` request naming an `adult-only` LoRA is 422 `lora_not_allowed`). The video library (`video/loras.ts`) keeps its
own file; both read the same safetensors header.

`GET /stack/v1/image` returns `{ image: { state, phase, available, code, reason, tier, default_model, models: [{ id, family, label, licence, installed,
default, loras, edit, steps_default, peak_gb, warm_seconds, available, quantize, install }], loras_supported, lora_count, edit: { generative, masked, model },
limits, negative_prompt, idle_unload_s, memory, worker, environment, install } }`: `state` is `unsupported`, `off` (under 32 GB), `not-installed`,
`needs-setup`, `building`, `idle` (worker loaded) or `running`. `POST /stack/v1/image/install` (`{ family? }`) is one job: it downloads every pinned file of
the family, then builds the environment; a second call joins it. `POST /stack/v1/engines/image-gen/install` builds only the environment. The `image` role in
`GET /stack/v1/roles` follows the service when a family is installed: `notInstalled`, `installed`, `loaded` (the worker is up), `ready` (a picture finished
in the last hour).
