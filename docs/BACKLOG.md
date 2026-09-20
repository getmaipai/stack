# Backlog

What is built and what is missing in MaiPai Stack, per area. Scannable,
not narrative: the reasoning lives in [`dev.md`](dev.md), the contract
in [`integrations.md`](integrations.md). Update this file in the same
commit as the change that closes or opens a gap; the status dashboard
reads it directly.

Rewritten 2026-09-20 with the refocus
([plans/refocus-work-order-2026-09-20.md](plans/refocus-work-order-2026-09-20.md)):
the Stack is Home's engine foundation, not a product. Every console,
showroom, library, palette, tray, desktop, operator, client-key,
channel, docs-site, release and capability-matrix item from the
product era is dropped, not deferred; the pre-rewrite file is in git
history at `d4e088e`. Item ids that survive keep their numbers.

Size tags: **S** (a session or less), **M** (a real slice, days), **L**
(a platform-level capability, needs its own design pass first).

**Execution contract for every item:** read `dev.md` and
`integrations.md` and the named files before editing. Bun, Hono with
`@hono/zod-openapi`, Zod, SQLite through Drizzle; `@maipai/core` and
`@maipai/spec` from the sibling `getmaipai/shared` checkout at the
pinned tag; tests in `bun:test`, deterministic and offline, engines
driven by scripted stand-ins. Every item exits with
`bash scripts/check.sh` in addition to its named check. Hard-won logic
is copied from the kept modules and from Home's legacy engine files
(named per item) and re-read, never re-invented; feature scope and UI
are never copied. Nothing migrates Home until STACK-16.

## Milestones in execution order

| Milestone | Items, in order | Why here |
|---|---|---|
| **The refocus (2026-09-20)** | RF-01, RF-02, RF-03, RF-04, RF-05, RF-05b, RF-06 | The repo becomes the daemon and nothing else, on the shared libraries, with the seam to Home explicit. |
| Studio proof | STACK-13, STACK-74, STACK-14, STACK-93 | Complete generator jobs and the bench protocol, measure the Studio with the full resident set, prove the governor across two engines. |
| Home adoption | STACK-75, STACK-16 | Pin and test the Stack/Home wire, then move Home onto the Stack with rollback after the Studio proof. |
| Speech and the robot | STACK-94a to 94c, STACK-95, STACK-17 | The speech roles on the Mac, then the Linux service and the robot profile. |
| Operations | STACK-96, STACK-96b, STACK-97, STACK-87 | Pin and rollback proven live, the Catalog engine index, health honesty kept through the rewrite. |

## The refocus (2026-09-20)

- [x] **RF-01 (S): org record.** The two 2026-09-20 DECISIONS entries,
  the product table, the pitch line, `UI.md`'s home for `@maipai/ui`.
  Landed in `.github` at e48f5bd.
- [x] **RF-02 (M): the charter.** `AGENTS.md`, `README.md`, `dev.md`,
  `integrations.md` rewritten; `ux.md` and `docs/user/` deleted; the
  survey tables moved to `plans/`. Landed on `main` (the commit after
  d4e088e).
- [x] **RF-03 (S): this backlog.** Rewritten to the goals; the
  dashboard refreshed 2026-09-20. Landed on `main` with this file.
- [x] **RF-04 (L): the backend, fresh.** Landed on `main` at 58cae15
  (144 tests, gate green, review findings fixed). `git rm -r backend/src
  backend/tests`; the kept modules restored by path from d4e088e at
  their `@/lib` paths with their tests (governor, memory readers,
  download, store, engine catalog and install, model store and catalog,
  gguf, hf resolve, identity, health, roles, profiles, engine swap and
  rollback, the Catalog index check, launchd); the rest written new:
  the per-role supervisor (spawned, managed, read-only url), the
  router, the typed streaming event feed, the settings declaration, the
  readiness runner, the job queue shape, the routes in
  `integrations.md`'s table with no auth middleware and loopback at
  `Bun.serve`, `index.ts` and `app.ts`; three tables (`meta`, `models`,
  `health`) and one migration; `@maipai/core` imported for log,
  withTimeout, paths, archive, diagnostics, hardware and openapi with
  the local copies deleted. Removed: `frontend/`, `desktop/`,
  `installer/`, `docs/site/`, `docs/assets/screens/`, the showroom,
  library, palette, helper, MCP, operator, clients, channels, detect,
  groups, series, live, digest, hygiene, storage accounting, network,
  licences, setup plan, speed test, maintenance scheduler, the
  stack-release update manifests, and their tests and scripts;
  `package.json` and `scripts/check.sh` reference nothing deleted;
  `docs/api/openapi.json` regenerated. Waits on `core-v0.1.0` and
  `ui-v0.1.0` in `shared`. Acceptance: the full gate green; the commit
  message inventories what was removed and what was kept; a privacy
  test fails when a fetch target exists without a row; the readiness
  and identity tests from STACK-87 pass against the new supervisor.
  Files: everything under `backend/`, `package.json`,
  `scripts/check.sh`, `CHANGELOG.md`. Mirror: the kept modules; Home's
  legacy `llmSupervisor.ts`, `ttsSupervisor.ts`, `embedSupervisor.ts`
  for the per-role lifecycle. Out of scope: generator execution
  (STACK-13), the speech engines (STACK-94b, 94c), systemd (STACK-95). Exit:
  `bash scripts/check.sh` and a `code-review` at medium on this
  checkout.
- [x] **RF-05 (M): the seam, explicit.** The wire shapes (the role
  request and reply headers, the event envelope and its ten ids, the
  health item, the settings declaration as a `SettingsKey` plus the
  value half, the precious-state declaration) declared once under
  `backend/src/spec/` in exactly `home/spec`'s shape: JSON Schema
  2020-12 with the `shared/spec` `$id`, a hand-written Zod mirror the
  backend imports and defines nowhere else, valid and invalid fixtures,
  and `tests/spec.test.ts` round-tripping every fixture through Ajv 2020
  and the mirror. Landed on `main` with this line.
- [ ] **RF-05b (S, B at 0c): move `backend/src/spec` to `shared/spec`;
  then import `@maipai/spec` and delete the local Zod mirror.** The six
  schema files, their fixtures and `tests/spec.test.ts` copy across
  unchanged (same `$id`s); `shared/spec`'s `gen:ts` replaces
  `backend/src/spec/ts/`; the backend's imports change from
  `@/spec/ts/<name>` to `@maipai/spec`; `scripts/check.sh` pins the
  `spec-v` tag beside `core-v`. Exit: `bash scripts/check.sh`.
- [x] **RF-06 (S): the Home hand-off.**
  [plans/home-adoption-2026-09-20.md](plans/home-adoption-2026-09-20.md):
  nine Home items in order (install inside Home's installer, the Stack
  client and role wire, the event bridge, the Engines page with every
  person-facing verb mapped to its route, Updates and Repairs wiring,
  first-run sizing, the Studio bench as a Home bench, the `spec` move
  if 0c has not run, STACK-16's dual-run), each in the org template.
  Landed on `main` with this line.

## Roles and the router

- [x] **STACK-07: the role declaration and the wire.** Thirteen roles
  in `backend/src/roles.ts` with wire, residency, endpoints and quality;
  the router resolves `model` to a role or an installed model; identity
  headers on every reply; 503 with `offline_reason` for an unbound role,
  409 for incomplete provenance, 400 with the role list for an unknown
  id; streaming chat passes the engine's SSE bytes through. Kept
  through RF-04 at 58cae15 (the router rewritten without the client-key check).
- [ ] **STACK-93 (M): the second engine adapter under the governor.**
  `mlx-serve` or `oMLX` (the Studio bench's pick) as a second spawned
  engine kind: its pin in `engineCatalog.ts`, its launch args, its
  identity read, its post-load check, admitted by the same governor
  beside `llama-server`. Acceptance: a scripted two-engine load
  admits, queues and evicts per the rules in `dev.md`; a live load of
  both on the Studio records both footprints. Files:
  `backend/src/lib/engineCatalog.ts`, `backend/src/lib/engineArgs.ts`,
  `backend/src/lib/supervisor.ts`, `backend/src/lib/governor.ts`,
  `backend/tests/governor.test.ts`. Mirror: the llama-server adapter.
  Out of scope: a third engine; Windows. Exit: `bash scripts/check.sh`
  and the bench command in its report.

## Supervisor and engines

- [x] **STACK-08: the spawned llama-server supervisor.** Pinned build,
  free-port probe, size-scaled load timeout, post-load completion,
  measured footprint, restart on exit, drain on stop, idle unload.
  Rewritten per role in RF-04 at 58cae15 with the same lifecycle pieces.
- [ ] **STACK-13 (M): jobs and the managed ComfyUI.** The job API
  (submit, progress on the feed, cancel, result by id) and the
  synchronous `/v1/images/generations` wrapper; ComfyUI as a `managed`
  engine the Stack starts and stops. Acceptance: a scripted job reports
  progress and cancels cleanly; the wrapper returns an OpenAI-shaped
  image response; a second generator queues. Files:
  `backend/src/routes/jobs.ts`, `backend/src/lib/jobs.ts`,
  `backend/src/lib/supervisor.ts`. Mirror: the job shape from RF-05;
  ComfyUI's queue API. Out of scope: video and music engines; any UI.
  Exit: `bash scripts/check.sh`.

## Governor and sizing

- [x] **STACK-06: the governor.** Profiles, admission, one generator at
  a time, queue of four, idle and pressure eviction, RSS breach restart,
  the decision ledger. Kept unchanged in RF-04.
- [x] **STACK-06b: the kernel's ledger.** `bun:ffi` against libSystem
  on macOS, `/proc` on Linux, a scripted reader for tests. Kept.
- [x] **STACK-74 (M): Studio bench protocol and rollback rehearsal.**
  The protocol in `plans/studio-bench-protocol-2026-09-20.md` (models
  by digest, contexts, builds, the request mix, the pressure samples,
  the thresholds, the rehearsal); `scripts/bench/studio-bench.sh` as
  its one command (install through the routes, every row judged,
  `report.md` and `report.json`, `DRY_RUN=1` for the plan); rehearsed
  on the p16 laptop with the shipped pin (2,221 prompt tok/s, 114.8 gen
  tok/s, 414 MB footprint, first token 15 ms median, the rollback
  rehearsal passed, and a second run judged against that baseline). The
  Studio run is STACK-14.
  Landed on `main` with this line.
- [ ] **STACK-14 (L): the Studio bench.** `chat`, `embed`, `judge`,
  `stt`, `tts` resident together on the Studio, one generator on demand,
  measured with the residency profiles in Home's
  `docs/plans/hub-on-apple-silicon-2026-09-17.md` section 3; `mlx-serve`
  and `oMLX` measured beside `llama-server`. Needs its bench design
  (STACK-74) first. Acceptance: numbers with engine build, model file
  and a sanitized hardware line in `dev.md`; a chosen Studio profile and
  the second engine named for STACK-93. Files: `docs/dev.md`,
  `backend/src/profiles.ts`, `scripts/bench/`. Out of scope: Home
  migration. Exit: `bash scripts/check.sh` and the bench report.

## Store and provenance

- [x] **STACK-04: the model store.** Provenance-gated records, the HF
  cache layout, engine tag layout with the `current` link, manifests
  with blob references and orphan grace, ranged resumable downloads,
  read-only import by link. Kept.
- [x] **STACK-86: qualification.** The chat and engine pins held to
  their declarations offline. Kept.
- [x] **STACK-96 (M): pin and rollback proven live.** Committed at the
  commit that carries this line; live proof outstanding: run 1 proved
  the downloads, the checksum refusal and the first answer and exposed
  two real bugs (the supervisor never launched the `current` link's
  build; the header mapping), both fixed with regression tests; run 2
  with the fixes was blocked by 5.5 GB free on a 24 GB laptop (the
  governor's `p16` margin, not loosened). `scripts/prove-pin-rollback.sh`
  is the driver; the transcript and the analysis are in `dev.md`, "Pin
  and rollback, proven live". Rerun `bash scripts/prove-pin-rollback.sh`
  when 1.5 GB more is free or on the Studio: STACK-96b.
- [x] **STACK-96b (S): the live pass of the pin and rollback proof.**
  Run 3 on 2026-09-20, the same laptop with memory free at the
  daemon's start, as the Studio bench's rehearsal step: swap ok with
  chat HTTP 200 from the staged build, rollback ok, the broken swap
  refused with `current` relinked and `failed-swap` raised with its
  fix, the fix restoring the link, the wrong checksum refused, delete
  current refused. The table is in `dev.md`, "Pin and rollback, proven
  live". Landed on `main` with this line.

## Health, readiness and updates

- [x] **STACK-09b: the health list.** Keyed, durable, one fix per item,
  `health.changed` on every change, producers explicit. Kept.
- [x] **STACK-87 (M, re-scoped): ready and current claims time-bound
  through the rewrite.** `ready` only within `READY_TTL_MS` of a real
  request through the public route and only with the expected identity
  (the selected model's file for a spawned engine, the
  `expected_version` for a url binding), the reason on a role that is
  only loaded; the roles route says `not checked`, `passed`, `failed`
  or `skipped` per role from the last run; a run goes stale, with the
  change named, when a model, engine or setting changes after it (the
  `stack.generation` counter every producer bumps); a skipped role never
  makes a run green; the updates route says unknown on a missing or
  invalid index. `tests/honesty.test.ts` covers each with a scripted
  stand-in. Landed on `main` with this line.
- [x] **STACK-97 (M, cross-repo): the Catalog engine index.** Catalog:
  `engines/index.json` (pins per platform), `tools/src/engine-index.ts`
  (schema, duplicate-pin refusal, the signed envelope with a thirty-day
  expiry) and its test. Stack: `updates/catalog.ts` reads the envelope
  (or a bare body), keeps it as received, takes the newest build for
  this platform as available against the `current` tag, treats an
  expired index as unknown; pins carry `name` and `tag` (the upstream
  build tag) so installed and available compare directly; the
  components inventory names the index as the source beyond the shipped
  pins. Signature verification waits on the Catalog's release key.
  Landed on `main` with this line.

## Speech roles

- [x] **STACK-94a (S): the speech design note.** `dev.md`, "The
  speech roles: `stt` and `tts`, designed": sherpa-onnx 1.13.8 for
  `stt` behind our thin spawned worker; Pocket TTS for `tts` (the
  owner's live pick of 2026-09-04, Kokoro rejected by his ear) as a
  managed engine through a pinned `uv`; the pins; the wire from
  `spec/voice`; whisper.cpp's server recorded as the rejected path
  with its cost. Landed on `main` with this line.
- [x] **STACK-94b (M): `stt` as a spawned engine.** `sherpa-onnx-node`
  1.13.8 pinned exactly in `backend/package.json` (the 94b amendment in
  `dev.md`); the `speech-worker` subcommand over it; Moonshine tiny-en
  int8 and Silero VAD as store pins with sha256 (a package archive
  extracts to a directory); `POST /v1/audio/transcriptions` with
  `spec/voice`'s form and `WS /v1/audio/transcriptions/stream` with its
  `SttWireEvent` contract mirrored under `backend/src/spec/`; identity
  headers on every reply; the bundled clip transcribing in the suite
  through scripted engines and live on the dev machine
  (`scripts/prove-stt.sh`, the table in `dev.md` "stt proven live").
  Landed on `main` with this line.
- [ ] **STACK-94c (M): `tts` as a managed engine.** The `uv` 0.12.17
  pin per platform in `engineCatalog.ts` with its sha256; Pocket TTS
  3.1.0 in its own venv under `data/engines/pocket-tts/<version>/`,
  started as `<venv>/bin/pocket-tts serve`, with the managed Python,
  `UV_CACHE_DIR` and `HF_HUB_CACHE` under `data/`; the weight
  repositories and their revisions in `modelCatalog.ts`;
  the environment pinned by a committed per-platform requirements
  file with hashes (`uv venv` plus `uv pip sync --require-hashes`,
  flags verified on uv 0.12.17); the two weight repositories recorded
  at the package's own revisions and what loaded read back from the
  hub cache after the post-load check; `HOME` and every cache under
  `data/`; the per-wire health probe for a `url` binding with identity
  reported unverifiable; the `stack.engines.tts.hf_token` setting
  declared `secret: true` in `settings.ts` and passed to the child as
  `HF_TOKEN`, the settings route redacting a secret's value; `POST /v1/audio/speech`
  forwarding `spec/voice`'s `/tts` form and streaming the WAV body
  back with identity headers, cancel on client abort; one short sentence rendering in the suite through a scripted
  engine and live on the dev machine. Files: `backend/src/lib/engineCatalog.ts`,
  `backend/src/lib/modelCatalog.ts`, `backend/src/lib/supervisor.ts`,
  `backend/src/lib/identity.ts`, `backend/src/settings.ts`,
  `backend/src/routes/settings.ts`, `backend/src/routes/v1.ts`,
  `backend/src/speech/`. Mirror: Home's `ttsSupervisor.ts` and
  `spec/voice/ts/client.ts`. Out of scope: Home's sentence scheduler
  and `normalizeForSpeech` (Home's); an OpenAI-shaped request until the
  spec carries it. Exit: `bash scripts/check.sh` and the live render in
  `dev.md`.

## Service and platforms

- [x] **STACK-15: launchd.** `install-service`, `start`, `stop`,
  `status`, `uninstall-service --remove-data`, restart on failure, logs
  under the data directory. Kept.
- [x] **STACK-95 (S): the systemd user unit.**
  `backend/src/service/systemd.ts` (the `Type=notify` unit with
  `Restart=on-failure`, `WatchdogSec=30`, `StartLimitBurst=5`, logs
  under the data directory; install, start, stop, status, uninstall
  through `systemctl --user`), `service/notify.ts` (`READY=1`,
  `WATCHDOG=1`, `STOPPING=1` to `$NOTIFY_SOCKET` over an `AF_UNIX`
  datagram through `bun:ffi`, a no-op elsewhere), `index.ts` picking
  the manager by platform; `tests/systemd.test.ts` with a scripted
  `systemctl` and a scripted sender. Linux itself is exercised at
  STACK-17 on the robot. Landed on `main` with this line.
- [ ] **STACK-17 (L): the Linux ARM profile.** The robot's `chat`,
  `embed` and `judge` on pinned `llama-server`, the body's speech
  process as a `managed` engine holding `stt` and `tts`, the body's
  power and thermal budget as an admission input. Confirm against
  `bot/docs/dev.md` sections 2 and 4 before building. Files:
  `backend/src/profiles.ts`, `backend/src/lib/memory/linux.ts`,
  `backend/src/lib/engineCatalog.ts`, `docs/integrations.md`. Mirror:
  the Mac profile and the Bot design record. Acceptance: on the robot,
  the three language roles return identity headers; the speech host
  going away reports offline; a scripted thermal limit defers a load.
  Out of scope: people, pairing, Home migration. Exit:
  `bash scripts/check.sh` and a robot live check.

## Home adoption

- [ ] **STACK-75 (M): pin the Stack/Home contract.** A contract test
  suite (every route in `integrations.md`'s tables, its shapes, the
  identity headers, the 503 and 409 forms, the event ids, the settings
  declaration) that Home runs against the pinned Stack version in its
  own gate, the way the spec's round-trip fixtures work for records.
  Files: `backend/tests/contract/`, `docs/integrations.md`. Mirror:
  `home/spec` fixtures. Acceptance: the suite runs from a sibling
  checkout with one command and fails on any shape change. Out of
  scope: Home's consumers. Exit: `bash scripts/check.sh`.
- [ ] **STACK-16 (L): Home runs on the Stack.** Home's installer
  installs the Stack, Home calls every role by name, bridges the event
  feed into its notification system, renders the Engines page from the
  declarations, and deletes its own supervisors; dual-run proves each
  role before removal and a rollback restores the old path. Lands in
  `home` as its own items after STACK-14 proves the Studio profile;
  RF-06 writes the hand-off. Out of scope: removing Home's supervisors
  before the Studio proof. Exit: Home's gate and the dual-run check.

## Docs

- [x] **STACK-98 (S): the generated components inventory.**
  `docs/components.md` from `backend/scripts/gen-components-doc.ts`
  (`bun run gen:components-doc`): one section per role in `ROLE_IDS`
  order with the engine pins per platform, then a row per profile with
  the stance, the pinned model and its facts, and a status of pinned,
  candidate (named) or not yet; drift-checked in `scripts/check.sh`
  like the API document; `tests/componentsDoc.test.ts` renders a
  scripted catalog. Landed on `main` with this line.
- [x] **RF-02** covers `dev.md`, `integrations.md`, `AGENTS.md` and
  `README.md`. The user tier is gone; Home's docs describe what a person
  sees.
