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
| `POST /v1/audio/transcriptions/jobs` | `stt` | long-file transcription job (JSON/base64 audio or video, up to 3 hours) |
| `POST /v1/audio/speech` | `tts` | speech; phrase-level streaming and cancel |
| `POST /v1/images/generations` | `image` | the job API with a wait; on a Mac with the picture models installed the mflux worker answers (see Picture generation below), otherwise the supervised ComfyUI |
| `POST /v1/videos/generations` | `video` | the job API with a wait; progress by phase, cancel, the clip fetched by URL (see Video generation below) |
| `POST /v1/audio/music` | `music` | the job API with a wait; progress by stage, cancel, the song fetched by URL (see Music generation below) |
| `POST /v1/audio/stems` | `music` | the job API with a wait; splits a song made here into vocals, drums, bass and other; each result can seed later music edits |
| `POST /v1/audio/voice-convert` | `music` | the job API with a wait; converts a vocal toward a reference voice |
| `POST /v1/audio/align` | `music` | the job API with a wait; known lyrics plus a song in, one `{ t, end, text }` per word out (MMS forced aligner); see "Lyric timing" below |
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
| Graphics compiler health | `GET /stack/v1/engines/gpu-health` | compiles one tiny shader through the compiler service the engines use (GPU-HEALTH-01); `{ ok, reason }`, `reason` the household sentence when the Mac's compiler does not answer, null otherwise; a Mac that cannot be asked reads ok |
| Memory watchdog | `GET /stack/v1/memory` | the whole computer's memory every 5 s (available, free, wired, compressed, swap and its 30 s growth, the kernel's pressure level), the watchdog's `level` (`normal`, `warn`, `critical`), `reserve_bytes`, `generation_paused`, the Stack's own processes, the biggest users by name (`stack: true` marks the Stack's), `recent_actions`. Settings: `stack.memory.watchdog` (on), `stack.memory.reserve_gb` (0 = the larger of 8 GB and 8 percent, at most a quarter of memory), `stack.memory.reap_orphans` (on). While the level is not `normal`, `POST /v1/images/generations` and `/v1/videos/generations` answer 503 `no_memory` with the numbers; a video job the watchdog stopped (queued or running) ends `cancelled` with status `paused: low memory` and code `memory_cancelled` (a Max job ends `failed` with the same code), distinct from a person's Stop (`cancelled`), a worker crash (`worker_stopped`) and a refusal at submit (`no_memory`); picture and music jobs still report `no_memory` for the same stop. A job that waited 3 minutes for memory ends `failed` with status `no_memory`. The running job is the last thing the watchdog gives up. At CRITICAL, one step per round (5 s ticks): unload idle workers and the idle voice engine, evict the idle judge, then, when nobody has used chat, speech or voice for 2 minutes and the newest raw reading is still critical, put chat on the smaller Reduced model through the same swap as `POST /stack/v1/tiers/reduced`; wait 10 s after anything that freed memory, re-read the pressure, and only if the raw reading (without the ladder's hysteresis) is still critical cancel the running job (video first). A person who is chatting keeps the full model: the Reduced step is skipped and the job is the one that yields (the worker is also stopped while a turn runs, see below). If a chat turn starts while the swap is attempted, the swap answers `waiting` and the step is tried once more, then skipped. Reduced that the watchdog entered is left again when the level has been `normal` for a minute and no turn is running (Reduced is one state with three holders, Home through `POST /stack/v1/tiers/reduced`, the Max window and the watchdog; a leave or the 30 minute lease cap drops only its own holder, and chat returns to the full model when none is left). Log lines `memory.action` with actions `unload-idle`, `evict-judge`, `reduce-chat`, `cancel-running`, `restore-chat`. Memory held by other programs is named and never touched; the Stack still gives back its own idle memory first. Health items `memory-low` and `memory-critical`; a `pressure` event with `source: memory-watchdog` on critical (at most one per 10 minutes). During shutdown every route except `/healthz` answers 503 `stack_restarting` with `Retry-After: 5`. |
| Install plan | `GET /stack/v1/install-plan[?vram_gb=N]` | the first-run wizard: `level`, `tier`, the `memory_gb` and `memory_source` (`unified`, `graphics`, `override`, `unknown`) they were judged on, and `models`, the pinned files for the tier's roles, starter first (`starter: true`, a small chat model so chats start while the large one downloads), each shaped as a `POST /stack/v1/models` body plus `starter` and `installed`; `total_bytes`, `remaining_bytes` (not yet installed), `free_disk_bytes`, `fits_disk`. Memory is system plus graphics memory on unified-memory computers, graphics memory only (CUDA VRAM summed) otherwise; if that cannot be read, `level` is null and `memory_source` `unknown` until Home passes the person's total VRAM as `vram_gb` (integer, 1 to 512) | the install step: post each model to the pull route |
| Settings | `GET /stack/v1/settings` (the declaration with values); `PUT /stack/v1/settings`; `POST /stack/v1/settings/apply` | Home's generic settings renderer, below |
| Storage | `POST /stack/v1/storage/sweep` | the prune Home schedules (orphaned blobs past their grace period), then tidy; the response includes removed bytes and counts per sweep |
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

## Adult jobs: the redacted view and the full view (ADULT-LOCK-04)

A job made with `audience: "adult"` (picture generate and edit, video, or a generic job whose `input.audience` is `adult`) is reported
to every caller as state and progress only. This is the Stack's half of Home's Adult lock; the job's `classification` second lock
(`lora_not_allowed` and the audience checks) is unchanged.

**What the standard view of an adult job holds.** `GET /stack/v1/jobs`, `GET` and `DELETE /stack/v1/jobs/{id}`: `id`, `kind`, `role`, `state`,
`percent`, `position`, the dates, `status` equal to the state, `input` reduced to `{ audience: "adult" }` (plus `tier` when set), `result: null`,
`reason` a fixed line on failure or cancel, no `items` and no byte counts. `GET /stack/v1/events`: a `job.progress` of an adult job carries
`job`, `kind`, `state`, `percent`, `status` (the state) and `position`; its `job.done` carries `job`, `kind`, `ok` and no `reason`.
`GET /v1/videos/generations/{job}` and `GET /v1/images/generations/{job}`: `state`, `phase`, `progress`, `phase_progress`,
`progress_fraction`, `stage`, `eta_seconds`, `position` and `code` stay; `stage_label`, `step`, `steps`, `preview_url`, `preview_step` are null,
`data` is `[]` and a failure's `error` is a fixed line. The files of an adult job (`preview.jpg`, the clip, `poster.jpg`, `messages.mp4`, a
picture and its thumbnail) answer the same 404 as a file that is gone. The request that makes the job (`POST`) is the maker's own call and
answers as before. An adult job is known by its job record, and after a restart by `audience: "adult"` in the result's `meta.json`.

**The full view.** Home asks for it per request, after it has checked the person's unlock proof, with two headers:

| Header | Value |
|---|---|
| `x-maipai-view` | `full` |
| `x-maipai-home-token` | the Stack's Home credential |

The credential is a random value the Stack keeps in `data/keys/home-view-token` (made at first use, mode 600), or `STACK_HOME_VIEW_TOKEN` (at
least 16 characters) when the unit that starts the Stack sets it; Home reads the file, or sets the variable and keeps the same value. The
Stack never returns it from any route. A request with `x-maipai-view: full` and a missing or wrong token is refused on every route, adult job
or not, with 403 `{ code: "full_view_forbidden" }` (so a caller cannot find out which jobs are adult by trying); a request without
`x-maipai-view`, or with the token alone, gets the standard view. The full view of a job that is not adult is the same as its standard view.
Logs never carry a prompt, a LoRA name or a file name of a job (typed events, counts and codes only).

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
| Splash chat's local prefix cache | Only while Splash chat is running; its bounded local SSD cache is emptied at every launch | Nothing leaves this computer; files stay under the Stack data directory and Splash runs offline | No network receiver | `stack.engines.chat.engine` = `splash` |
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
kind (model, lora), superseded_by (catalog component ids that replace it), state (installed, installing, notInstalled, failed), size_bytes (on disk now, models plus their engine environment, null when
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

`GET /stack/v1/tidy` plans removal from live component and model-store state and returns `{ reclaimable_bytes, items: [{ id, kind, bytes, reason, blocked }] }`.
Kinds are `superseded`, `orphan_folder` and `partial_download`. A top-level folder is known by name when its id appears in any catalog/component pin, model record or model manifest; the `hub`, `manifests` and `store` layout folders are always preserved. Replaced models wait until a successor is installed, the role is ready, and the configured
`stack.storage.tidy_grace_hours` has elapsed (default 24). A model stays blocked while required by the tier, selected by a role setting, loaded, used by
a running or queued job, or depended on by an installed LoRA. An unknown folder is an orphan only when no record or manifest references a file inside it and it has passed the same grace period. Active installs and downloads protect their model folders and partial files; stale `.part` files are eligible after seven days only when no job is active for that model. The response says when a grace period ends and names each blocker.

`POST /stack/v1/tidy` accepts `{ dry_run?: boolean }`, defaulting to true, and returns `{ dry_run, removed, skipped }`. A real run removes superseded
components through the same removal operation as `DELETE /stack/v1/components/{id}`. Folder and partial-file cleanup resolves and confines paths to the
models tree, refuses symbolic links and record or catalog references, and reports a retryable skip if removal fails. The Stack logs each successful
removal with its id, byte count and reason. A real tidy run is blocked from deleting orphan folders if it would remove more than three folders or 25 GB in one run. The existing `POST /stack/v1/storage/sweep` prunes orphaned blobs, then runs tidy for real; Home's current
sweep schedule therefore handles both.

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

## Look (LOOK-01)

`POST /v1/images/looks` takes multipart `image` (one JPEG, at most 2 MB), `source` (the caller's source id) and `detail` (`fast` or `detailed`, default `fast`). Fast returns one `LookResult`: household object labels with counts, scores and fractional boxes; light, a majority upper-wall colour when available, object and scene tags; `cost: { ms, tier: "fast" }` and `expires_in_s: 90`. Cached live tracks may appear with `stale: true` for up to 90 seconds. `detailed` returns 422 `detail_unavailable` until that tier is built. Refusals are `{ error, code }`: 413 `too_large`, 415 `not_jpeg`, 422 `detail_unavailable`, 429 `too_fast` (12 per source per minute), 503 `model_missing` or `no_memory`, 500 `failed`.

`GET /stack/v1/image-tools` includes `look: { state, models, reason }`. Install the separate Look component in Home's Engines page. It uses the existing `image-tools` Python environment and a 600 MB governor admission, and pauses while chat works. The JPEG travels as bytes over worker stdin and is decoded in memory. Nothing is stored or logged but counts and elapsed milliseconds. There is no route to retrieve a previous result. Design: Home `docs/design/look-component-2026-10-22.md`.

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

**One lane.** All seven kinds share one idle-priority first-in-first-out queue (`taskpolicy -b` on a Mac, `nice -n 19` elsewhere): one media job runs at
a time, the rest wait with `state: queued` and `position`. At most 64 wait (a submit past that is 503 `queue_full`). A cancelled queued job leaves the
queue; a cancelled running job stops its tool and frees the lane at once; a crashed job never blocks the next; a job past its deadline (probe 3 min,
preview and companion clip 20 min, edit 30 min, fetch 3 h, transcode 12 min, setup 30 min) is stopped and fails with a sentence. The first job that needs a tool downloads and checks it
inside the job (`status` says so), which can take a couple of minutes on a slow link; `media.setup` does that ahead of time.

**Kinds.**

| Kind | Input | Result |
|---|---|---|
| `media.probe` | `{ path }` | `{ path, size_bytes, format, duration_s, bit_rate, has_video, has_audio, has_cover_art, width, height, video_codec, hevc_tag ("hvc1" or "hev1" for HEVC, else null), audio_codec, channels, sample_rate, projection, rotation, streams[{ index, type, codec, codec_tag, profile, width, height, pix_fmt, fps, channels, sample_rate, bit_rate, language, default, cover_art }], chapters[{ index, start_s, end_s, title }], tags{all, lower-case keys}, title, embedded_date (ISO date or year), created_at, source_url (the `purl` tag a fetch embeds), elapsed_ms }`. Failure `unreadable` when ffprobe cannot read the file. |
| `media.fetch` | `{ url (http or https), kind: "video" or "audio" (video), quality: "best" or a ceiling "2160", "1440", "1080", "720", "480", "360" (1080, the household default ceiling; owner ruling 2026-10-17), playlist (false; true for a channel or playlist), archive_key (letters, digits, `.`, `-`, `_`: names this source's download archive so an item is never fetched twice), max_items (1 to 100, newest first), date_after ("YYYYMMDD"), min_duration_s, max_duration_s, cookies_path (a file inside a declared folder; only when the owner configured cookies), person_initiated (false), subtitles (true), limit_rate_kbps, output_dir }` | `{ host, output_dir, count, items[{ id, title, uploader, channel, channel_id, duration_s, upload_date (ISO), webpage_url, extractor, ext, description, playlist_title, playlist_index, path, size_bytes, subtitle_paths[] (.vtt), thumbnail_path }], warnings[], elapsed_ms }`. `count: 0` is a success (everything was already in the archive). A fetch that stopped at `max_items` is a success. Failure codes: `rate_limited`, `login_wall`, `unavailable`, `unsupported`, `network`, `failed`, `media_quiet_mode`, `tool_setup_failed`. |
| `media.transcode` | `{ path, output_dir, output_name (no extension), max_height (never scales up), video: "auto", "encode" or "copy" (auto), audio: "auto" or "encode" (auto), crf (23), preset ("veryfast"), audio_bitrate_k (160) }` | `{ path, size_bytes, container ("mp4"; "m4a" for audio only), video_action ("copy", "encode" or "none"), audio_action, duration_s, width, height, video_codec, audio_codec, elapsed_ms }`. H.264 + AAC + `+faststart`, chapters and tags kept; `auto` copies a stream that is already 8-bit H.264 (within `max_height`) or AAC. `percent` moves with the output time. The output is written as `<name>.mp4.part` and renamed on success; nothing partial is left on failure or cancel. |
| `media.preview` | `{ path, output_dir, thumbnail (true), storyboard (true), clip (true), thumbnail_at_s (10 percent in), thumbnail_width (640), storyboard_columns (10), storyboard_frames (100 at most), storyboard_tile_width (160), clip_start_s (30 percent in), clip_length_s (6), clip_height (360) }` | `{ duration_s, thumbnail{ path, width, height, at_s, from_cover_art, size_bytes }, storyboard{ path, width, height, columns, rows, tile_width, tile_height, interval_s, frames, size_bytes }, clip{ path, start_s, duration_s, height, has_audio: false, size_bytes }, skipped[{ part, reason }], elapsed_ms }`. An audio file gets its cover art as the thumbnail and skips the other two. Frame `n` of the sheet is at `n * interval_s`. |
| `media.edit` | `{ inputs[] (1 to 24 files), ops[] (1 to 12 steps), output: { dir (optional), name (with .mp4, .mov, .webm or .png) } }`. The working clip starts as `inputs[0]`; the ops run in order. `{ op: "upscale", factor?: 2 }` sharpens video 2x with the existing `image-tools` Real-ESRGAN model, then downsamples its 4x image result with Lanczos. Width and height double, rounded to even pixels; frame rate, duration and original audio are preserved, with audio copied. `{ op: "cutout", background: "black"|"white"|"green"|"blur"|"transparent"|"#RRGGBB", subject?: { frame?, box?: [x0,y0,x1,y1], point?: {x,y} }, feather_px?: 0..12 }` tracks a subject through the clip with the optional SAM 2.1 component; `background` is required and `feather_px` defaults to 2. Transparent results must use `.webm`; all other cutouts use `.mp4`. Cutouts are limited to 60 seconds and 1920 pixels wide. Tracking runs about 5.5 fps on MPS, plus compositing, or roughly a minute per 10-second clip when warm. Source audio is retained; audio codecs unsupported by WebM are converted to Opus for transparent results. Clips are limited to 60 seconds, 6 megapixels per input frame and 20 minutes of estimated work for upscale. An input over 10 minutes, unknown step, more than 12 steps or 24 files, or an output that would replace an input is refused with a sentence. | `{ path, size_bytes, container, duration_s, width, height, video_codec, audio_codec, streams[], steps[{ op, action }], elapsed_ms }`. `percent` moves across the steps; cutout reports tracked frames as progress. Output is staged and renamed on success; intermediate files are removed. A `spatial_sound` step adds `files[]` (`{ role: "stereo"|"surround_5_1", name, path, size_bytes, audio_codec, channels }`; `files[0]` is the stereo clip and is also `path`; the 5.1 sibling is written beside it as `<name>-5.1.<ext>`) and `spatial: { applied, reason: null|"no_person"|"no_speech"|"several_people"|"centered"|"already_spatial", note, notes[], segments, sources[], surround, rear_quiet, side_level_db, frames, people_frames, speech_spans }`; `sources` lists what moved (`"speech"`, and for the other sound `"walker"`, `"vehicle"`, `"impact"` or `"side"`); `note` and `notes` are the plain lines to show (`rear_quiet` means the back speakers of the 5.1 file stay near silent because the clip's sound has little width). Failure codes include `bad_input`, `too_long`, `model_missing`, `no_memory`, `cutout_failed`, `no_audio`, `speech_unavailable`, `spatial_failed`, `unreadable`, `failed`, plus path codes. No network is used during editing. |
| `media.companion_clip` | `{ path, output_dir, output_name (optional output subfolder), key: "#00FF00" or "#FF00FF" or "none", kind: "loop" or "oneshot", min_seconds (1 to 10), max_seconds (1 to 10), colours (up to 8 uppercase #RRGGBB values), palette_reference (optional base64-encoded rest-picture image), max_bytes (614400) }`. `#00FF00` removes green hues; `#FF00FF` removes magenta hues. For each decoded frame, the actual background is estimated from its outer two-pixel border, so muted or drifting green and magenta backgrounds work. Two keying regimes: (1) a key-like border, pure or muted, uses hue keying (a pixel's green over its other channels, or magenta over green) and unmixes against the estimated background, so skin, hair and clothing stay fully opaque and untinted; (2) a non-key-like border falls back to the pure-colour formula. A palette reference matches opaque clip colour statistics toward the rest picture and supplies the colour-distance palette. One-shots skip up to the first 15 settling frames. A loop keeps up to ten spare frames after its best cycle and crossfades them into the seam, so the last frame is one blend step before the first and playback wraps without a jump; a clip with fewer than two spare frames over the state's minimum length (idle at 3 seconds from a 3 second clip) gets the short fade instead. Source must be mp4, mov or webm, at most 12 seconds and 64 MB. `none` requires alpha in the source. | `{ seconds, frames, fps: 24, width: 480, height: 960, files[{ name, path, bytes }], av1, loop_gap, settle_skipped_frames, colour_match{ applied, strength }, colour_distance?, area_ratio, opaque_share{ min, max }, ok, reasons[], report_path, elapsed_ms }`. Writes `clip.h264.mp4`, optional `clip.av1.mp4`, `still.png` (straight-alpha RGBA), and `report.json`. H.264 and AV1 are silent, yuv420p, fast-start MP4 files, each limited by `max_bytes`; AV1 is omitted when `libsvtav1` is unavailable. Both encode and tag BT.709 colour (matrix, primaries and transfer), with limited-range YUV. The video is a 480 x 960 frame: the top 480 rows are RGB premultiplied by alpha, and the bottom 480 rows are the alpha matte in greyscale. Home's player un-premultiplies the top half in a shader. Quality limits are first guesses for the key-colour bench. Failure codes: `no_alpha`, `too_short`, `too_large`, `unreadable`, `bad_input`. The colour half gets a light unsharp pass (5x5, luma amount 0.9) after the premultiply, because the video model smooths fine skin and fabric detail. |
| `media.setup` | `{}` | `{ tools{ ffmpeg, ffprobe, "yt-dlp" } (paths), elapsed_ms }`. Downloads and checks all three tools now. |

**`media.edit` batch 3 operations.** These are additive entries in `ops[]`; each step works on the current clip.

| Operation | Fields and behavior |
|---|---|
| `speed_ramp` | `{ from_factor, to_factor, at_s, over_s }`; factors are 0.25 to 4, `over_s` is 0.3 to 10 seconds. Picture and sound change speed together. |
| `reverse` | `{}`; reverses picture and sound for clips up to 60 seconds. |
| `freeze` | `{ at_s, hold_s }`; holds the selected frame for 0.5 to 5 seconds and inserts silence during the hold. |
| `loop` | `{ times }`; repeats picture and sound 2 to 6 times. The result must fit within 10 minutes. |
| `kenburns` | `{ zoom_from, zoom_to, pan, duration_s? }`; zoom is 1 to 2 and pan is `none`, `left`, `right`, `up` or `down`. A PNG or JPEG may be the first input; it makes a silent stereo clip at 24 fps, 1280x720, 5 seconds by default. |
| `fps_boost` | `{ fps }`; interpolates picture to 30, 48 or 60 fps, copies sound, and accepts clips up to 30 seconds. |
| `flip` | `{ direction }`; direction is `horizontal` or `vertical`. Sound is copied. |
| `rotate` | `{ degrees }`; degrees is 90, 180 or 270. Sound is copied. |
| `sharpen` | `{ amount }`; amount is 0 to 1.5. 1 is strong; above 1 up to 1.5 is Sharpen+ (it sharpens edges and cannot recover missing detail). Sound is copied. |
| `denoise` | `{ amount, deblock? }`; amount is 0 to 1. `deblock: true` (default false) smooths compression blocks before the denoise. Sound is copied. |
| `ripple` | `{ amount }`; amount is 0 to 1. A gentle whole-frame water-like wobble (about 1% of the height at 1); a look, not simulated water. Sound is copied. |
| `spatial_sound` | `{ surround?: boolean, side?: "left"|"right" }` (SPATIAL-02/03/07). Moves the clip's own dialog toward the side of the screen where the speaker stands while he talks (stereo, always), and with `surround: true` also writes a 5.1 E-AC-3 file. Needs a picture and a sound track. The positions are found inside the job and are never part of the request: frames are sampled 4 a second and go to the Look person detector (one batch entry on the existing worker, no second model), speech spans come from the Stack's Silero detector, position is the box centre as -1 (left) to +1 (right), smoothed (median of 5, at most 0.6 a second, held 1.5 s without a person then glided to the middle). One visible person is placed; two or more people in view centre the dialog (no motion tie-break). Frames and audio are read from a private folder that is deleted before the step ends; nothing is logged but counts. The picture is copied byte for byte (`-c:v copy`), container metadata is kept, `-shortest` is never used. Stereo is AAC 192k; 5.1 is E-AC-3 384k (FL, FR, FC, LFE, BL, BR; the rear is the clip's own side signal, delayed 10 ms and low-passed at 7 kHz, never invented). SPATIAL-07 adds the other sound of the clip (footsteps, a train, a knock), put where its visible source is, and only when the clip's own audio did not already do it. Gate first, on the audio (16 kHz stereo read into a private folder): left-right correlation 0.98 or more with a balance that is not already off to one side is dual mono and may be panned; correlation under 0.98 with a per-0.5 s balance range of 0.5 or more (or a dual-mono clip that already sits to one side) is already spatial and is left alone; anything in between is left alone. A clip left alone for that reason returns `applied: false, reason: "already_spatial"` and the line "This clip's sound already moves with the picture, so it is unchanged."; a requested 5.1 file is still made from the unchanged audio. The speech lines above keep their behaviour, including music-heavy clips at correlation 0.7, and are skipped only when the native balance ranges by 0.5 or more and correlates (Pearson 0.6 or more) with the person track. Position sources, all from the picture: a person who travels across the frame (the box centre, found by the pass above); a train, car, bus, truck or boat (Look with the `all` vocabulary through the same `lookFrames` entry, the LEADING box edge in the direction of travel, since a box wider than the frame has a flat centre; several of one class in a frame is doubt); a fixed impact such as a knock (the column centroid of frame differences around the strongest motion, read at each energy onset, +10 dB in 30 ms; skipped when the camera moves, when nothing moves near the onset, or when two separate regions are alike). Music, a source nobody can see, and doubt stay centred; speech spans are excluded from the effects pan. `side` is an override only: the sound of the clip goes 0.6 to that side (at each onset when there are onsets, else the whole clip outside speech), still behind the gate. At most 64 knots; no new model, no network, CPU only; frames and the grey pictures are deleted before the step ends. The step may appear once. `surround: true` must be the last step and the output must be `.mp4` or `.mov`, else the job is refused at submit with 422 and "Make the 5.1 file as the last step of the edit." (or the container line). A clip with no sound fails with code `no_audio` and "This clip has no sound, so there is nothing to place. Make or add sound first." A cartoon, a scene with nobody in it, a clip nobody speaks in, several people or a speaker in the middle is not a failure: the job is done, the stereo sound is copied unchanged, and the result says why (see `spatial` below). The 5.1 file is still made when asked. Failure codes: `no_audio`, `bad_input` (no picture), `model_missing` (Look not installed: "Spatial sound needs the Look part. An admin can install it in Settings, Models and storage, then try again."), `no_memory`, `speech_unavailable` (the speech part is not running), `spatial_failed`. |
| `pip` | `{ input, corner, size, margin }`; `input` names a later file, corner is `top_left`, `top_right`, `bottom_left` or `bottom_right`, size is 0.15 to 0.5 of frame width, and margin is 0 to 0.1. The second clip's sound is ignored. |

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

## Reduced chat while a Max job runs (TIER-REDUCED-ROUTE)

Home puts chat on the smaller model (qwen3-4b class) so a Max job fits, and brings it back after.

- `POST /stack/v1/tiers/reduced` with `{ "on": boolean }`. 200 `{ ok: true, swap_ms, reduced }` (asking for the state chat is already in is 200 with `swap_ms` 0). 202 `{ ok: false, waiting: true, reduced }` when a chat turn is in flight: nothing changed, ask again after the turn. 409 or 503 `{ ok: false, reason, reduced }` with a plain sentence (409: coding mode, a change already running, the smaller model missing; 503: the swap failed and chat is back on its previous model).
- `GET /stack/v1/memory` has `reduced_chat: boolean`, the Stack's own state, for Home's notice.
- Home renews by repeating `{ "on": true }`. With no renewal for 30 minutes (`STACK_REDUCED_CHAT_CAP_MS`) the Stack leaves Reduced by itself, and retries every 15 s while a chat turn blocks it, so a crashed Home never leaves chat stuck on the small model.

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

**Video models.** `model` on `POST /v1/videos/generations` is `video` or `quick` (the default, Wan, silent up to 5 s), `ltx25-q8` (LTX-2.5 Standard and Boost), or `ltx25-max` (LTX-2.5 Max). A model id names it too. The retired `detailed` value and LTX-2.3 model id answer 422 `retired_model`: use `ltx25-q8` or `ltx25-max`. Other unknown names answer 422 `unknown_model`; an uninstalled supported model answers 503 `not_installed`. Results carry `quality` and `audio`. `GET /stack/v1/video` retains `qualities.detailed` as a deprecated compatibility object with `installed: false`, `available: false`, and a retirement reason. The Stack no longer catalogs or plans the old component. If it remains on a machine, it is absent from Components and TIDY-01 offers its model folder as an orphan after the grace period; an admin can also remove it from the component list. Video LoRA records retain `ltx-2.3` as a recognized legacy base, but uploads or edits declaring it answer 422 `wrong_base_model` with “That style was made for a retired video model.” New LTX styles must declare `ltx-2.5`; Wan Quick styles remain unchanged.

**Picture start and end on LTX-2.5 (VIDEO-INPUTS-01).** `POST /v1/videos/generations` with `model` `ltx25-q8` (Standard and Boost sizes) or `ltx25-max` takes the same `image` field
as Quick (base64 or a data: URL; PNG, JPEG or WebP; at most 20 MB) and an additive `end_image` (same encoding and limits). `image` is the first frame: the Stack's ffmpeg
fits it to the clip's true size (scale to fill, centre crop, never stretched, orientation applied, metadata dropped) and the worker gives it to the runtime as image conditioning at
frame 0, replacing the first latent. `end_image` guides the last frame (frame index `frames - 1`) and needs `image`: `end_image` alone is 422 `bad_image`; Quick answers 422 `reference_unsupported` to `end_image`. A picture that is not valid base64 or not a PNG, JPEG or WebP is 422 `bad_image` (the message names the last picture when that is the bad one),
over 20 MB is 413 `too_large`, a size or length outside the measured table is still 422 `bad_size` or `bad_seconds`. Both runtimes take images:
the 0.18.0 runtime (Max) through `ImageConditioningInput.at` and `.guide`, the pinned fork (Standard and Boost) through the `(path, frame_idx, strength)` tuple of `ltx_pipelines_mlx.utils.args`;
the worker refuses a runtime whose `generate_and_save` has no `images` argument instead of making the clip from words. `GET /stack/v1/video` reports `image_to_video: true` and the new
`end_image: true` on `qualities.ltx25` and `qualities.ltx25max` (false on Quick). The result's `mode` is `image-to-video`. The Stack keeps no copy: the files are deleted when the job ends.
The caller (Home) owns the age and surface gate; the Stack does not judge where a picture came from.

**Memory of a clip that starts from a picture (VIDEO-PICTURE-ADMIT-01).** The picture encoder (the VAE encoder) and the picture's latent add to the footprint, so admission asks for the
figure of a clip with a start picture when the request carries `image` (an end picture changed no figure by more than 0.8 GB, so one figure covers both). Measured 2026-11-02 on the M5 Max (128 GB),
the Stack's own worker under `/usr/bin/time -l`, seed 7, one clip per measurement, OS footprint in GB (words only, start picture, start and end picture):
Standard 512x256 10 s 39.4, 39.7, 39.7 (admitted 39.7); Standard 512x256 5 s 25.3, 26.3, 27.1 (admitted 27.1); Boost 640x320 5 s 32.4, 32.1, 32.3 (admitted 32.4, the words-only figure, never lower); Boost 768x448 5 s 45.8, 45.6, 45.6 (admitted 45.8, the
words-only figure, never lower); Max 1024x576 10 s 47.4 in the worker (48.6 in the table), 56.5, 57.0, and 58.6 in the bench CLI (admitted 58.6 plus 5 percent, 61.5). Max stays under the 64 GB per-clip cap.
`GET /stack/v1/video` reports them beside the words-only figures: `peak_gb_picture` and `short_peak_gb_picture` on every `qualities.ltx25.profiles` row (the 5 s Standard figure is the short one), and
`peak_gb_picture`, `admit_gb_picture` (61.5) and `short_peak_gb_picture` (null) on the `qualities.ltx25max.profiles` row. The progress estimate of a clip from a picture is kept apart from the words-only
history of the same size, so a picture clip's ETA learns from picture clips (they ran 20 to 30 percent longer at Max: 206 s words only, 248 s with a start picture, 267 s with both).

**LoRAs on LTX-2.5 (VIDEO-LORA-05).** `loras: [{ id, strength? }]` on `POST /v1/videos/generations` now works with `model` `ltx25-max` (the ids come from `GET /stack/v1/video/loras`;
`strength` 0 to 2, the record's default when left out; at most 2 per clip, 422 `too_many_loras`) and is still 422 `lora_unsupported` on `ltx25-q8` (Standard and Boost) until a LoRA clip is measured there:
the pinned fork (0.14.15, commit 5795228) has the runtime's `_pending_loras` hook and its fusing code but no unfused mode, and its fusing writes float32 scales and biases (checked on a toy q8 layer;
0.18.0 keeps bfloat16), so what a Standard or Boost LoRA costs in seconds and memory is unmeasured. Read `qualities.ltx25.loras` and `qualities.ltx25max.loras` on `GET /stack/v1/video`:
`{ supported, max, max_strength, mode: "fused" | "unfused", admit_factor (0 fused, 1.1 unfused), runtime, base_models: ["ltx-2.5"], reason }`, plus `negative_prompt: "none"` on both (the distilled path has no
guidance, so a negative prompt is accepted and ignored; Home sends negative text only to a profile that says `nag`, none does yet). Offer a LoRA only where `supported` is true.
*Base.* An LTX-2.5 file must declare `base_model: ltx-2.5` on `POST /stack/v1/video/loras`. An LTX file without a declared base is refused because its version cannot be read from the tensors. The legacy enum `ltx-2.3` remains readable for old manifests, but new uploads, installs and edits using it answer 422 `wrong_base_model` with “That style was made for a retired video model.” The raised file cap is 4 GB (413 `too_large`).
*LTX-2.3 styles on a 2.5 clip (LTXD-18B, supersedes the old refusal).* A record whose `base_model` is `ltx-2.3` (LTXD-23: new uploads, installs and base edits to `ltx-2.3` are accepted for LoRAs; the 2.3 video model itself stays retired, `retired_model`. A new 2.3 record enters with `tested_on_25: null`, and any base change clears the mark) is no longer refused on an LTX-2.5 clip. A bench clip showed one 2.3 file (Claymation) changing a 2.5 Max clip cleanly and another (googlyeyes) doing nothing, so the Stack keeps the result on the record. Fields on every LoRA record (`GET /stack/v1/video/loras`): `tested_on_25` is `"tested"`, `"no_effect"` or `null` (only a 2.3 record has a value; set or cleared with `PATCH /stack/v1/video/loras/{id}` `{ "tested_on_25": ... }`, 422 `bad_mark` on a 2.5 or Wan record or another value) and `untested_on_25` is true for a 2.3 record with no result (derived, never stored). A clip naming a 2.3 style: untested runs with a warning; `tested` runs with a lighter warning; `no_effect` is refused 422 `lora_no_effect` ("... changed nothing in a test clip on LTX 2.5, so it was not used. Pick a style made for LTX 2.5."). The 200 and 202 reply of `POST /v1/videos/generations` then carries `lora_warnings: [{ id, code: "untested_on_25" | "tested_on_25", message }]`. Home offers a 2.3 style by default only when `tested_on_25 === "tested"`. Wan styles, a 2.5 style on a 2.3 or Wan clip, unknown bases and an `ss_ltx_version` that contradicts the declared base keep today's 422 `wrong_base_model`; an LTX file with no declared base and no `ss_ltx_version` answers 422 `wrong_base_model` "Say whether this LTX style was made for LTX 2.5 or LTX 2.3."

*Marking a 2.3 style after a bench clip (admin, one call per file).* Make one test clip on LTX 2.5 with the style, then record the result. Replace `<id>` with the record id from `GET /stack/v1/video/loras` and `<stack>` with the Stack address:

```
curl -X PATCH <stack>/stack/v1/video/loras/<id> -H "content-type: application/json" -d '{"tested_on_25":"tested"}'
curl -X PATCH <stack>/stack/v1/video/loras/<id> -H "content-type: application/json" -d '{"tested_on_25":"no_effect"}'
curl -X PATCH <stack>/stack/v1/video/loras/<id> -H "content-type: application/json" -d '{"tested_on_25":null}'
```

`tested` lets Home offer the style by default; `no_effect` makes a 2.5 clip naming it answer 422 `lora_no_effect`; `null` clears the mark. A 2.5 or Wan record answers 422 `bad_mark`.
*Refused before a job exists.* The runtime ignores every tensor it cannot map without an error (a kohya file, `lora_down` and `lora_up`, loads and changes nothing; measured 2026-11-02), so the Stack reads the header
itself: a file with no ComfyUI-style `diffusion_model...lora_A.weight` and `lora_B.weight` pair is 422 `lora_keys_unsupported` (at import for an `ltx-2.5` file, again at request time, and in the worker), the message says to use a
copy saved for ComfyUI or diffusers; with the pack installed the file is also matched against the pack's own transformer (names after the runtime's rename table, and the in and out sizes, q8 and bf16 packs): no matching layer is
`lora_keys_unsupported`, some layers of the wrong size is `wrong_base_model`. A file made for another base, an unknown id, a duplicate, and an adult-only file on a request whose `audience` is not `adult` (`lora_not_allowed`) are refused as before.
*How it runs.* The worker hands `[(path, strength)]` to the runtime as `pipe._pending_loras` (what `generate --lora PATH STRENGTH` does) and sets `LTX2_LORA_MODE` before it builds the pipeline (0.18.0 reads it at construction).
Max is fused (bf16: no extra memory, no requantization; measured +0 GB and a few seconds). The q8 profiles prefer unfused (bench: +0.6 s and +0.76 GB for a 0.34 GB file, against +18 s fused) but only 0.18.0 has it, so they would run fused.
Admission adds file bytes x 1.1 when unfused and nothing when fused (`admit_factor`). A changed LoRA set rebuilds the pipeline; the same set reuses it. The request also refuses a footprint over the 64 GB per-clip cap (422 `lora_too_large`).
Extend and retake take no LoRA (422 `lora_unsupported`). Proven for real: see the CHANGELOG entry for the clip, its time and its footprint.

**LTX-2.5 Max (LTX25-MAX-01).** `model` `ltx25-max` (or `ltx25-max-bf16`, or the pack id `ltx-2-5-bf16-distilled-mlx-max`) makes a 1024x576 clip of up to 10 s (241 frames at 24 a second)
with a sound track and speech, from words or from a start picture and an optional end picture (`image`, `end_image`, see below; LoRAs: see "LoRAs on LTX-2.5"). It is the Max slot of the LTX-2.5 engine and a
separate quality: `GET /stack/v1/video` has `qualities.ltx25max` in the same shape as `qualities.ltx25` (`ready`, `installed`, `environment`, `install`, `licence`), with
its own runtime (`ltx25-max-gen`, dgrauet/ltx-2-mlx 0.18.0) and its own pack (`ltx-2-5-bf16-distilled-mlx-max`, the ungated mlx-community conversion, distilled set only, 71 GB, the
same licence acceptance as the other LTX models). One `profiles` row: `{ name: "max", size: "1024x576", max_seconds: 10, max_frames: 241, peak_gb: 48.6, admit_gb: 51 }`:
`peak_gb` is the measured OS footprint (`footprint`; the MLX peak reads 37 GB and is not the admission figure), `admit_gb` is what admission reserves (the footprint plus 5 percent), under the owner's
64 GB per-clip cap. A clip that starts from a picture needs `peak_gb_picture` 58.6 and `admit_gb_picture` 61.5 (see the picture memory paragraph above), still under the cap. Any other size is 422 `bad_size`. Standard and Boost stay on the fork runtime and the q8 pack and are not affected. Only one video model is in memory at a time, as with the others.
The runtime must be run with the pack's Gemma 4 folder (`<pack>/gemma4-12b-ltx-v1`): without it the prompt is silently ignored (an unrelated clip, garbled speech). The Stack always
passes it, and the worker refuses a Max request that does not name that folder.

**Extend and retake a Max clip (LTX25-EDIT-01).** Two additive request shapes on `POST /v1/videos/generations` with `model` `ltx25-max` (runtime `ltx25-max-gen`, dgrauet/ltx-2-mlx 0.18.0, classes
`ExtendDistilledPipeline` and `RetakePipeline(distilled=True)`). Same `prompt`, `seed`, `timeout_ms`, `tier` and job API (202, poll, the same `video.mp4` and `poster.jpg` URLs); the result's `mode` is `extend` or `retake`.
- `source_video`: an absolute path to the clip, inside a media folder Home declared (or the Stack's media job folder), resolved by the same rule as `media.edit` inputs, so a clip of 100s of MB is never sent as base64. The Stack reads it, never changes it and keeps no copy after the job.
- `extend_seconds` (1 to 6): appends that long after the source. Mapped to `ceil(seconds x 24 / 8)` latent frames (8 pixel frames each): 4 s is 12 latent frames, 96 pixel frames; a whole number of seconds adds exactly that many. The source stays as it is (re-decoded with the new part, about 39.5 dB PSNR against the source), no visible seam, new speech follows `prompt`.
- `retake_from_seconds` (1 to 9): regenerates from that second to the clip end. Latent start is `floor(seconds x 24 / 8)` (5 s is latent frame 15), the end is always the clip end (31 for a 241 frame clip). The part before is kept (about 39.7 dB). The cost follows the whole source length, not the retaken part.
- Send exactly one of `extend_seconds` and `retake_from_seconds`, with `source_video`. `image`, `end_image`, `size`, `seconds` and `loras` are not taken with an edit (422 `bad_edit`; styles keep `lora_unsupported`).
- Source rules: a picture and a sound track, 25 to 241 frames (a little over 1 s up to 10 s; the longest source measured; an extended clip of 14 s cannot be edited again), at least 768x448. A source that is not on the measured size table or not at 24 a second is re-made first by the Stack's ffmpeg (24 fps, scaled to fill and centre-cropped to the largest table size inside it, never stretched); the reply carries the true `width` and `height`. A source already on the table at 24 fps is copied as it is.
- Refusals are plain 422 before anything queues: `bad_source` (unreadable, no picture, too short, too long, too small), `bad_source_audio` (no sound track), `bad_retake` (the start is at or past the clip end), `bad_edit` (both or neither edit, a missing `source_video`, a picture or size with an edit), `edit_unsupported` (a model other than `ltx25-max`, or a Max runtime without the classes), `source_not_found`, and the media path codes (`path_outside_roots`, `no_roots`, `path_invalid`). When the media service's ffprobe is not on this computer yet, the job probes the source instead and the refusal is the job's `code`.
- Memory: measured OS footprints with a 10 s source, runtime 0.18.0, seed 7 (M5 Max): 1024x576: extend 48.8 GB, retake 56.5 GB (through the Stack worker, which caps the MLX cache at 4.4 GB); 768x448: extend 59.3 GB, retake 59.1 GB (the runtime's own command line, no cache cap). Times with a 10 s source: extend by 4 s about 156 s, retake from 5 s 202 to 422 s depending on how busy the computer is; the cost follows the whole source length. Admission reserves the footprint plus 5 percent (`admit_gb`), under the 64 GB per-clip cap. Both runs need the pack's Gemma folder like every Max run; the worker checks it.
- Status: `GET /stack/v1/video` `qualities.ltx25max` has `extend` and `retake` (true when the installed runtime has `extend_distilled.py` and `retake.py`; before it is installed, when the pinned build is one that ships them), an `edit` object (`extend_seconds`, `retake_from_seconds`, `source`, and `profiles[]` with `extend` and `retake` `{ peak_gb, admit_gb }` per source size) and `extend` and `retake` on each `profiles` row (null where not measured at that size).
- Progress adds stage `source` ("Reading your clip") before `load_text`; the rest are the generate stages (`motion` has 11 steps for an extend, 8 for a retake).

`POST /v1/videos/generations` (JSON) answers like `/v1/images/generations`: 200 `{ created, job, data: [{ url, poster_url, content_type, width, height,
frames, fps, seconds, seed, model, mode, lora_ids, ms, bytes, poster_bytes }] }`, or 202 `{ created, job, data: [] }` when the clip is still going at
`timeout_ms` (30 s unsaid, 30 min at most); then poll. Fields: `prompt` (required, 20000 characters), `negative_prompt` (accepted; the distilled model
runs without guidance, so it has no effect), `image` + `image_source` (see below), `size` (`832x480` default; multiples of 32, each side 256 or more,
area at most 399,360 pixels, so `480x832` also fits and 1280x704 does not), `seconds` (whole, 1 to 5, default 5), `seed`, `loras` (`[{ id, strength }]`, at
most 4, strength 0 to 2, the record's default when left out), `audience` (`all-ages` unsaid, or `adult`), `timeout_ms`. Errors carry `error` (what
happened and what to do) and `code`: 413 `too_large`; 422 `bad_size` `bad_image` `unknown_lora` `lora_not_allowed` `lora_changed` `lora_missing` `too_many_loras` `duplicate_lora` `bad_strength`; 429 `queue_full` (four clips
already waiting); 499 `cancelled`; 500 `failed` `worker_stopped`; 503 `not_available_on_this_computer` `unsupported` `not_installed` `no_memory` `setup_failed`
`model_missing`; 504 `timeout` (15 minutes); 507 `out_of_memory`. A request body that breaks the schema (a sixth second, an empty prompt) is a plain 400.

`GET /v1/videos/generations/{job}` returns `{ job, state, phase, progress, phase_progress, position, error, code, data }`. `state` is `queued`,
`running`, `done`, `failed` or `cancelled`; `phase` is `queued`, `waiting for memory`, `waiting for running jobs` (a Max clip in its window while other jobs still run), `waiting for the computer` (a Max clip in its window with nothing running, held until the computer is free enough; the job stays `running`, MAX-WAIT-REASON-01), `starting`, `setting up` (the first clip only: the Python
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

**Reference pictures and styles of real people (MODELS-CENSOR-05, owner ruling 2026-11-02).** `image` is a PNG, JPEG or WebP as base64 (a `data:` URL is
fine), at most 20 MB. The Stack never judges where a picture came from or whom it shows: the models decide for an adult, the app only filters, and Home keeps
the age and audience gates. The Stack keeps a ledger of the sha256 of every picture it generates (hash and time only, 30 days, the newest 2,000). On
`/v1/images/generations` and `/v1/images/edits`, `image_source` (`generated`, `uploaded`, `household_photo`) and `reference_source` are optional and refuse
nothing; they only decide whether the result counts as a picture this Stack made and so may start a later job (a result derived from a photo someone brought
does not). The likeness proofs of LIKENESS-01 are removed: there is no `/stack/v1/likeness` route, no signing key to register, and `consent_proof`,
`reference_proof`, `likeness_proof`, `likeness_subject` and the `likeness_*` error codes no longer exist (an older caller that still sends the fields is
ignored, not refused). A style file whose description names a real person or a public figure is added like any other and is classed adult-only, so it never
reaches a child's or a teen's request.

**LoRAs.** The household library is `data/video/loras/` (one `.safetensors` per record plus `manifest.json`). `GET /stack/v1/video/loras`;
`POST /stack/v1/video/loras` (multipart: `file`, or `path` for a file already on the Stack's computer; `name`, `licence`, `licence_acknowledged`,
`source_url`, `classification`, `strength_default`, `trigger_words` comma separated or a JSON array, `added_by`, `base_model`); `PATCH` and `DELETE /stack/v1/video/loras/{id}`.
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
song, keeps its models for five idle minutes (`stack.engines.music.keep_warm_minutes`, default 5, `MUSIC_IDLE_MS` overrides; songs come in bursts of edits), then exits and returns its memory. It is never started at boot,
runs with `HF_HUB_OFFLINE=1`, and makes no network request. Tiers: `p128` (songs up to 240 s, quality `quick` or `detailed`, default `detailed`) and `p64` (up to
120 s, `quick` only); `p16` and `p32` answer 503 `not_available_on_this_computer`. Quality is the planning model: `quick` the 0.6B one, `detailed` the 1.7B one.
Design and the measurements: Home `docs/design/music-generation-2026-10-17.md`, sections 3, 4 and 12.

`POST /v1/audio/stems` accepts `{ source, source_sha256, model: "htdemucs", timeout_ms? }`. `source` is base64 of an unchanged m4a this Stack made; both the hash and made-here ledger entry must match. A successful response's `data` lists the present stems as AAC `audio/mp4` files at 44.1 kHz stereo; stems below RMS `1e-4` are omitted. The queued job reports `loading`, `splitting` and `encoding`, supports `DELETE /v1/audio/stems/{job}`, and returns 202 with an empty `data` array when it outlasts the wait. Results share music's ten-minute, newest-six retention. `GET /stack/v1/stems` reports model installation and the 2 GB governor admission. Demucs 4.1.0 loads the pinned safetensors model through its own `demucs.hf.load_safetensors_model` loader; the YAML manifest, checkpoint revision and checksums are pinned in the Stack catalog.

`POST /v1/audio/beats` accepts `{ source, source_sha256, timeout_ms? }`, where `source` is base64 audio up to 40 MB and 12 minutes. It returns `{ tempo_bpm, meter, beats[], downbeats[], sections[{start_s,end_s,label}], confidence, downbeat_confidence, duration_s, engine: "librosa" }` in `data`; poll or cancel at `/v1/audio/beats/{job}` and `GET /stack/v1/beats` reports readiness. Results contain numbers only and are held in memory. The worker runs offline with librosa and has no model file.

`POST /v1/audio/voice-convert` accepts `{ source, reference, source_sha256?, reference_sha256?, pitch_shift?, auto_shift?, timeout_ms? }`; both audio values are base64. The source vocal may be up to 40 MB; the reference must be 6–30 seconds, and the optional pitch shift is an integer from -12 to 12 semitones. Defaults are `pitch_shift: 0` and `auto_shift: false`, preserving the source key. The same job poll, cancel and fetch flow returns one AAC `audio/mp4` vocal at `/v1/audio/voice-convert/{job}`; a conversion that outlasts its wait returns 202 with `data: null`. Results use music's ten-minute, newest-six retention. `GET /stack/v1/voice-convert` reports installation and limits. SoulX-Singer SVC and its RMVPE pitch model are pinned by Hugging Face revision and SHA-256; Apache-2.0. Audio and names are never logged. The worker is offline after installation and runs under the music-role 6.5 GB admission reservation.

`POST /v1/audio/speech/recorded` submits a non-realtime Fish Audio Drama 3 job. It accepts `{ text, reference?, reference_text?, reference_sha256?, speakers?, format?, timeout_ms? }`; text is up to 4,000 characters and is passed through unchanged, including inline cues such as `[angry]`, `[shouting]`, `[whispers]` and `[laughs]`. A reference or each of up to four `speakers` entries contains base64 audio and its transcript; clips must be 6–30 seconds and no larger than 40 MB. If a transcript is missing and no usable local transcriber is available, the request is rejected with “This reference needs the sample's words.” `speakers` and `<|speaker:N|>` text are passed to one model call for dialogue. `format` is `m4a` (AAC 192 kbps) or `wav`; output is mono at the model's native sample rate. Poll and cancel at `/v1/audio/speech/recorded/{job}`, fetch at `/v1/audio/speech/recorded/{job}/file`; a long render returns 202 with `data: null`. `GET /stack/v1/speech-recorded` reports tier support and limits. Fish Audio Drama 3 4-bit weights, tokenizer, `LICENSE` and `NOTICE` are pinned file-by-file at one Hugging Face revision under `fish-audio-community`; the model runs offline after install. Recorded speech has a separate `mlx-audio` 0.6.4 environment and a 30 GB admission reservation, and does not replace live Chatterbox Turbo.

### Long-file transcription (CAPTION-01b)

`POST /v1/audio/transcriptions/jobs` accepts `{ source, source_sha256, from_s?, to_s?, language?, vocabulary?, timeout_ms? }`. `source` is base64 of audio or video, at most 250 MB and three hours; the Stack verifies the checksum, probes for an audio track, and extracts mono 16 kHz PCM with its pinned ffmpeg. Ranges must be sent as a pair and lie within the file. The optional language is English (`en`, `en-US`, `en-GB`); another value returns 422 with the next step. Vocabulary is accepted as a hint, but this Parakeet model does not apply hotwords, so `data.vocabulary_applied` is false.

The installed Parakeet TDT 0.6B v2 int8 recognizer and Silero VAD already loaded by `stt` find speech spans; each span returns `{ start, end, text, words, confidence? }`, with absolute file seconds and per-word timestamps where available. The top-level result is `{ language: "en", segments, vocabulary_applied }`. POST waits 30 seconds by default (up to 30 minutes) and returns 202 with `data: null` if still running; poll `GET /v1/audio/transcriptions/jobs/{job}` and cancel or delete with `DELETE` at that path. Transcript contents are held in memory only and disappear on restart. Rule 6a logs counts and milliseconds only. The job reserves up to 8.5 GB for the 1.94 GB Parakeet model and audio buffers; range requests scale the audio portion with the range duration. Files over 250 MB or three hours return 413, invalid media and ranges return 422, and unavailable engines or memory return 503.

Selected range: `from_s` and `to_s` are cut by ffmpeg, so only that range is extracted and transcribed, and all times stay on the original file's clock. Speaker detection (CAPTION-01g): send `diarize: true` and optionally `num_speakers` (1 to 20; 422 without `diarize`). The result then adds `speakers: [{ id: "spk-1", label: "Speaker 1" }]`, `segments[].speaker` (the id of the speaker with the most overlap), `diarization` (`done` or `unavailable`) and, when unavailable, a plain `diarization_note`; a missing model or failed diarizer still returns the full transcript. Detection runs locally with pyannote segmentation 3.0 and NVIDIA TitaNet small, and adds 0.4 GB to the job's admission.

### Lyric timing (MUSIC-GEN-20b)

`POST /v1/audio/align` accepts `{ source, source_sha256, lyrics, origin?, from_s?, to_s?, timeout_ms? }`. `source` is base64 of an audio file, at most 40 MB and 4 minutes; `lyrics` is plain text, one lyric line per line (blank lines allowed), at most 8000 characters. The provenance rules are stems': without `origin` (or with `made_here`) the source must be an unchanged m4a this Stack made and its ledger entry must match; `origin: "owned_file"` accepts any m4a, mp3, wav, flac or ogg file and writes nothing to the ledger. The reply is `{ created, job, data: { words, aligned_words, total_words, line_starts } }`: `words` is one `{ t, end, text }` per placed word in seconds (`text` is the lyric's own spelling), `total_words` counts the words the aligner can read (Latin letters and apostrophes; notes and other scripts are skipped), and `line_starts` has one entry per source line, the index in `words` of that line's first placed word, or `-1` for a blank line or one with no readable word. Only the alignment is done here: no score threshold, no anchor filtering, no interpolation (Home does those). A file that aligns no word fails with a plain message. `from_s` and `to_s` (seconds, sent together, `from_s` at least 0, `to_s` after `from_s`, the window at most 4 minutes; anything else is a plain 400) align only that window of the song against the lyrics given: the worker decodes just the window with the bundled ffmpeg (mono, 16 kHz), and every returned `t` and `end` is on the original file's clock (`from_s` added), so Home can show a first alignment from the opening ~40 s and run the full pass later. The reply keeps its shape and adds `data.window: { from_s, to_s }`; without the two fields nothing changes. The lyrics sent should be the ones sung in the window; words the window does not contain are simply not placed.

The job reports `loading` and `aligning`, supports `DELETE /v1/audio/align/{job}` and `GET /v1/audio/align/{job}`, and returns 202 with `data: null` when it outlasts the wait. The word timings are the person's lyrics, so they are held in memory only (the newest twelve), never written to disk, and gone on a restart. Rule 6a: the Stack's log carries counts and milliseconds only (`align.done`: words, total, lines, ms), never a lyric word or a file name, and every error message is a fixed sentence with any lyric word blanked. The model is torchaudio's `MMS_FA` bundle (Meta's MMS wav2vec2 CTC aligner, CC-BY-NC-4.0), pinned by sha256 as the optional component `mms-fa-align` (1,262,047,414 bytes) and installed through the normal download path; the worker runs with no network (`HF_HUB_OFFLINE=1`, `TORCH_HOME` on this computer, no token or proxy). Admission is a tool-class job of 11.1 GB for a full file, the measured footprint of a 4 minute song; a windowed request is admitted at 2.1 GB plus 0.046 GB per window second, never below 3.8 GB (3.94 GB for 40 s, 4.86 GB for 60 s, 7.62 GB for 120 s), computed from `to_s - from_s` before admission (memory grows with length: 3.8 GB at 40 s, 4.7 GB at 60 s, 7.4 GB at 120 s, 11.0 GB at 240 s on the Studio; a 60 s song takes about 7 s warm, a 4 minute song about 38 s).


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
`{ created, job, data: [] }` past it; then poll. Fields: `prompt` (required, 20000 characters), `model` (`image` or unsaid for the default; `flux2-klein-4b`;
`z-image-turbo`), `size` (`1024x1024` unsaid; 256 to 2048 a side, multiples of 16), `n` (1 to 4; seeds `seed`, `seed+1`, ...), `seed`, `steps` (4 for
Klein, 9 for Z-Image; at most 12 and 20), `negative_prompt` (accepted, no effect: the distilled models run without guidance), `loras`
(`[{ id | sha256, scale }]`, at most 4, scale 0 to 2, the record's default when left out), `audience` (`all-ages` unsaid, or `adult`), `init_image` (base64,
at most 40 MB, `image_source` optional) with `strength` (0.05 to 1, default 0.6) for image to image, `preview` (default true: the status carries a small preview picture while the job runs, see below; false skips it), `timeout_ms`. A LoRA selects the base model it
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
`household_photo` reference is accepted like any other.
With a reference the whole scene goes to the model (no crop). `GET /stack/v1/image` reports `edit.references` (0 on a Stack that cannot).
Two more tool operations, Apple's on-device person finder (macOS 14 and later, a small helper compiled once like the foreground finder): `find_people` answers `data[0].people`
(numbered boxes as fractions of the picture, each person's main blob only) and a copy of the picture with the boxes drawn and numbered; `erase_people` (field `people`: `1,3` or `all`)
erases those people and fills the place with LaMa; `people_mask` (same field) answers the grown mask of those people (white on black PNG) for `edit_masked` to fill with the picture model (2.6 s on the Studio, cleaner than LaMa). Codes: 422 `no_people`, `people_unavailable` (no helper: paint over the person with `erase`), `people_required`.
The other non-generative operations (`remove_background`, `erase`, `upscale`, `resize`) are unchanged.
`segment` uses the optional SAM 2.1 small component to return one still-picture mask (single-channel PNG, 255 inside the selected thing, 0 outside) and its `area` fraction. Send `prompt` as JSON in the multipart form: `{ "box": [x0,y0,x1,y1], "points": [{"x": 12, "y": 24, "label": 1}] }`; either a box or at least one positive point is required, with at most 16 positive or negative points. Coordinates are pixels in the picture. Inputs are limited to 12 megapixels and 4096 pixels on the long side. One call loads SAM on demand (about 10 seconds cold); warm worker reuse is not included yet. Masks use the same video-class memory admission, and refusals reuse the cutout model-missing, memory and unexpected-failure sentences. The component adds no download when already installed.

**LoRA library.** `data/images/loras/` holds one `.safetensors` per record (named by its sha256) and `manifest.json`: `GET /stack/v1/image/loras`;
`POST /stack/v1/image/loras` (multipart: `file`, or `path` for a file already on the Stack's computer; `name`, `licence`, `licence_acknowledged`,
`source_url`, `classification`, `strength_default`, `trigger_words`, `added_by`); `POST /stack/v1/image/loras/install` (JSON `{ url, name, licence?,
... }`: a `huggingface.co` file link only, fetched by an install job, hashed on arrival, the repository's licence and tags read from the Hub; the job's
`result.lora` is the record, a failed job's `reason` starts with the code); `PATCH` and `DELETE /stack/v1/image/loras/{id}`. The id is `lora-` and the first
16 hex of the sha256. The base model (`flux2-klein-4b` or `z-image-turbo`) is read from the tensors; an SDXL-family file (SDXL, Pony, Illustrious, NoobAI), a FLUX.1 or Chroma file declared in its header, or a Wan file is refused 422 `wrong_base_model`
and says where it belongs. Open licences import as is; any other needs `licence_acknowledged=true`. `classification` defaults to `adult-only` (uncertain means
adult-only); a file whose own metadata, name, tags or trigger words name adult content is adult-only whatever is asked. Refused outright (422
`lora_refused`, no setting lifts it): a file that names a child or a minor in a sexual context. A file that names a real person or a public figure is added
(classed adult-only). The word lists are a tripwire in
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
