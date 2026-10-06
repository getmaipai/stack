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

- [x] the standards pin resolves through a per-tag worktree, std-v0.3.0 (verified at this commit)

**Execution contract for every item:** read `dev.md` and
`integrations.md` and the named files before editing. Bun, Hono with
`@hono/zod-openapi`, Zod, SQLite through Drizzle; `@maipai/core` and
`@maipai/spec` from the sibling `getmaipai/commons` checkout at the
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
| Studio proof | STACK-13a, STACK-13b, STACK-74, STACK-14, STACK-93 | Complete generator jobs and the bench protocol, measure the Studio with the full resident set, prove the governor across two engines. |
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
  (STACK-13a, 13b), the speech engines (STACK-94b, 94c), systemd (STACK-95). Exit:
  `bash scripts/check.sh` and a `code-review` at medium on this
  checkout. Landed 2026-09-20 at 1c5cad6.
- [x] **RF-05 (M): the seam, explicit.** The wire shapes (the role
  request and reply headers, the event envelope and its ten ids, the
  health item, the settings declaration as a `SettingsKey` plus the
  value half, the precious-state declaration) declared once under
  `backend/src/spec/` in exactly `home/spec`'s shape: JSON Schema
  2020-12 with the `shared/spec` `$id`, a hand-written Zod mirror the
  backend imports and defines nowhere else, valid and invalid fixtures,
  and `tests/spec.test.ts` round-tripping every fixture through Ajv 2020
  and the mirror. Landed on `main` with this line. Landed 2026-09-20 at 1c5cad6.
- [x] **RF-05b (S): pin the wire shapes in `@maipai/spec` and delete
  the local Zod mirror.** The nine shapes (the role request and reply
  headers, the event envelope, the health item, the settings declaration,
  the precious-state declaration, `SttWireEvent`,
  `SttTranscribeResponse`, and the job) are imported from
  `@maipai/spec` (tag `spec-v0.1.2` in `getmaipai/commons`, resolved to
  its own per-tag worktree by `scripts/ensure-tag.sh`); `backend/src/spec/`
  and `backend/tests/spec.test.ts` are deleted; the backend's imports
  change from `@/spec/ts/<name>` to
  `@maipai/spec/stack/ts/<name>.js`; `scripts/check.sh` pins the
  `spec-v` tag beside `core-v` through the same `ensure-tag.sh` call.
  The voice stays Stack-local at `backend/src/wire/voice.ts` (added by
  `5c5612d` after `spec-v0.1.0` folded the other shapes in, carried by
   no spec tag). Exit: `bash scripts/check.sh`.
- [x] **RF-06 (S): the Home hand-off.**
  [plans/home-adoption-2026-09-20.md](plans/home-adoption-2026-09-20.md):
  nine Home items in order (install inside Home's installer, the Stack
  client and role wire, the event bridge, the Engines page with every
  person-facing verb mapped to its route, Updates and Repairs wiring,
  first-run sizing, the Studio bench as a Home bench, the `spec` move
  if 0c has not run, STACK-16's dual-run), each in the org template.
  Landed on `main` with this line.

## Roles and the router

- [ ] **STACK-WAKE-01 (S): the wakeword role hosts the pinned front end and our phrase as served assets, and is the Stack side of ROBOT-ASSETS-01's single store.** The `wakeword` role's "installed only" stance becomes real: the openWakeWord front end (v0.5.1, Apache-2.0) and `trained_hey_maipai_v2` (our model, from the Bot release) are pinned, checksummed downloads fetched by the Stack's `model_download_jobs`, the one downloader; Home's ROBOT-ASSETS-01 serves them to robots and fetches nothing itself for these files, so there is no second store. Their privacy page rows (GitHub releases) land in the same commit. No inference on the hub in this item. Exit: `bash scripts/check.sh`.

- [x] **VISION-01b (M): the vision role is its own model and process, pinned and admitted as jit.** Home's VISION-01 Stack slice (verdict `home/data-scratch/architect/VISION-01b.verdict`). Qwen3-VL-4B-Instruct Q4_K_M and its Q8_0 projector pinned by revision and sha256 (Apache-2.0), the projector a component; the role selects only a record declaring picture input (spec-v0.1.83 `image_input`); llama-server launched with `--mmproj`, one slot, an 8,192 context of its own; a picture probe; card sampling; governor `jit` admission that never evicts or shrinks chat; `scripts/install-pin.ts`; `scripts/bench/vision-measure.ts`. Measured 2026-10-06 on the 24 GB laptop: it does not fit beside the 8B chat under the p16 margin, so p16 keeps vision not available (`dev.md`, "The vision role"). Tests: `backend/tests/vision.test.ts`.
- [x] **VISION-02b (M): Qwen3-VL-8B-Instruct as a selectable chat model that reads pictures.** Home's VISION-02 Stack slice (verdict `home/data-scratch/architect/VISION-02b.verdict`). Pins (Apache-2.0, revision `f982a07`, the projector a chat component), the chat launch loads its projector and keeps its slots, a picture check after load, `launch.imageMaxTokens` 2,560 reported as `picture_tokens_max`, `qwen3vl` a verified architecture, the projector in the fit plan, a measured footprint held only up to its context, the admission dry run at the launch's KV cache type. p16's binding is not moved (VISION-02e, the owner's go). Measured in `dev.md`, "The chat model reads pictures". Tests: `backend/tests/chatVision.test.ts`.
- [ ] **VISION-01b-FIT (S, owner's call): a way for pictures to fit on a 24 GB machine.** Answered by the owner's choice of arm 1 (VISION-02, a vision-capable chat model); closes when VISION-02e's go flips p16. Open before the flip: the fit plan chooses 108,544 for the VL-8B, a context admission cannot admit on this machine (`dev.md`, "The chat model reads pictures"). A smaller chat context is not an option (rule 4). Exit: p16's stance changed only on a measured fit.
- [x] **STACK-07: the role declaration and the wire.** Thirteen roles
  in `backend/src/roles.ts` with wire, residency, endpoints and quality;
  the router resolves `model` to a role or an installed model; identity
  headers on every reply; 503 with `offline_reason` for an unbound role,
  409 for incomplete provenance, 400 with the role list for an unknown
  id; streaming chat passes the engine's SSE bytes through. Kept
  through RF-04 at 58cae15 (the router rewritten without the client-key check).
- [x] **STACK-93 (M): the second engine adapter under the governor.**
  `mlx-serve` v26.9.4 (the pick by the prebuilt rule, `dev.md`, "The
  second chat engine"; oMLX the named alternative) as a second spawned
  engine kind: its pin in `engineCatalog.ts`, its launch on loopback,
  the identity the Stack stamps, admitted by the governor at the file
  times its own multiplier beside `llama-server`; the chat role bound
  to either by `stack.engines.chat.engine`; an MLX model as a
  directory pin of nine verified files
  (`mlx-community/Qwen3-1.7B-4bit`). Proven live on the laptop
  (`scripts/prove-mlx.sh`: admitted at 1.38 GB, measured 1.24 GB,
  first completion 1.88 s with the load, 50 ms warm). Tests:
  `backend/tests/mlxServe.test.ts`. The Studio bench (STACK-14) puts
  both engines on one model. Landed 2026-09-20 at c73786f.

## Supervisor and engines

- [x] **STACK-08: the spawned llama-server supervisor.** Pinned build,
  free-port probe, size-scaled load timeout, post-load completion,
  measured footprint, restart on exit, drain on stop, idle unload.
  Rewritten per role in RF-04 at 58cae15 with the same lifecycle pieces.
- [x] **STACK-13a (M): the job API and the generator queue.** The
  spec's `StackJob` shape with fixtures; submit, progress on the feed,
  cancel, result by id; a generator role's queue with positions, one in
  flight per role, admitted through the governor (the governor's own
  queue waited on, an impossible peak or a governor refusal failing the
  job with the reason, the admission released however the run ends);
  `/v1/images/generations` as the job API with a wait answering in
  OpenAI's image shape, 202 with the id past its deadline. Driven by a
  scripted sidecar in `tests/generatorQueue.test.ts`. Landed on `main`
  with this line. Landed 2026-09-20 at 6965a1c.
- [x] **STACK-13b (M): ComfyUI as a managed engine.** ComfyUI v0.36.0
  as an engine archive plus a venv the Stack builds through the pinned
  uv from a hashed requirements file (one builder with Pocket TTS);
  Stable Diffusion 1.5 EMA-only as the pinned checkpoint with sha256,
  linked into ComfyUI's folder; the `image` role's runner rendering one
  text-to-image graph through ComfyUI's queue with cancel; the
  generator's checkpoint-list probe; the engines routes building the
  environment as one job. The graph proven on the dev machine outside
  the governor (a lighthouse in 18.3 s); through the Stack the governor
  refused the engine with its numbers, recorded in `dev.md` "The image
  role". Landed on `main` with this line.
- [ ] **13b-live (S): the render through the Stack.** Rerun
  `bash scripts/prove-image.sh` with about 2 GB more free than the
  laptop had (needs 5.2 GB with the p16 margin of 4 GB) or on the
  Studio and record the transcript in `dev.md` beside the refusal:
  the engine's start, the checkpoint's load, the render's time, the
  measured footprint, the readiness check ok. Files: `docs/dev.md`.
  Mirror: the tts live table. Out of scope: any code change; if the
  run finds one, it is its own item. Exit: `bash scripts/check.sh
  --docs` and the table in `dev.md`.
- [ ] **STACK-99 (M): the music role on ACE-Step 1.5.** ACE-Step 1.5
  as a managed engine through the uv pattern (MIT code and weights,
  the official MLX backend, its REST server acestep-api, an ungated
  download pinned by revision and sha256), the music role behind the
  job API like image, a 30 s instrumental and a 30 s sung clip
  rendered live with time and footprint measured on the Studio
  (STACK-14's protocol) before the pin is final. The owner's pick
  (`docs/plans/jev-and-yue-2026-09-20.md`: YuE2 rejected as CUDA-only
  with non-commercial weights, Jev rejected as hosted-only). Files:
  `backend/src/generators/`, `engineCatalog.ts`, `modelCatalog.ts`,
  `routes/v1.ts`. Mirror: STACK-13b. Out of scope:
  vocals-versus-instrumental scope for the household (the owner's
  question in the note), unofficial MLX forks (never). Exit: `bash
  scripts/check.sh` and the measured table in `dev.md`.

## Governor and sizing

- [x] **STACK-06e (S): the governor's tier follows the machine.**
  `startGovernor` took a `tier` and nothing passed one, so every
  machine ran the `p16` margin. The daemon now sets the tier from
  `proposeProfile` at start and every process watch carries it
  (`watchProcessMemory`); a test holds a p128 machine to p128's 20 GB
  margin. `governor.ts` untouched (the governor lane holds it; the
  budget route reporting the tier joins STACK-06c's callback work).
   Landed on `main` with this line. Landed 2026-09-20 at fa46457.
- [x] **The budget route reports the tier** (S); verified at this commit. Landed date unrecorded (no commit names this ID; ticked before 2026-09-21).
- [x] **STACK-06c (S): the governor drains its queue on memory
  changes.** Governor half verified at this commit; jobs.ts drops its
  kick in a follow-up (STACK-06d, S). Today a queued request is re-admitted only inside
  `release()`, so a request queued for pressure or the working margin
  with nothing loaded waits until an unrelated release; the job queue
  (STACK-13a) works around it by releasing a handle the governor does
  not hold, no more often than the governor's poll, which also rotates
  the queue's order when the head still cannot be admitted. Objective: the
  governor's own poll (`lib/governor.ts`, the memory reading and
  pressure update) re-admits its queue head when pressure returns to
  normal or free memory clears the margin, with a callback or a promise
  the caller of `admit` can wait on instead of watching the loaded set;
  then `lib/jobs.ts` drops the kick and the poll. Files:
  `backend/src/lib/governor.ts`, `backend/src/lib/jobs.ts`. Mirror: the
  queue's admission loop in `jobs.ts`. Out of scope: the admission
  rules. Exit: `bash scripts/check.sh` with a test that a request
  queued under pressure runs when the reading clears without any
  release. Landed 2026-09-20 at 228e06b.
- [x] **STACK-06d (S): jobs.ts waits on admit's promise and drops the
  kick and the poll.** Files: backend/src/lib/jobs.ts,
  backend/tests/generatorQueue.test.ts. Exit: bash scripts/check.sh. Landed 2026-09-20 at 0a9cc01.
- [x] **STACK-06: the governor.** Profiles, admission, one generator at
  a time, queue of four, idle and pressure eviction, RSS breach restart,
  the decision ledger. Kept unchanged in RF-04. Landed 2026-09-20 at 0a9cc01.
- [x] **STACK-06b: the kernel's ledger.** `bun:ffi` against libSystem
  on macOS, `/proc` on Linux, a scripted reader for tests. Kept.
  Landed 2026-09-17 at a52c7bf.
- [x] **Degraded memory reading (issue #3)** (S): a failed probe never
  reads as full memory; verified at this commit. Landed date unrecorded (no commit names this ID; ticked before 2026-09-21).
- [x] **Release under a degraded reading keeps the head** (S);
  verified at this commit. Landed date unrecorded (no commit names this ID; ticked before 2026-09-21).
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

- [x] **STACK-PROCMEM-01 (M): process memory counts the weights an engine maps; the runaway watch uses this run's own reading.**
  Measured 2026-10-06 on the live chat (Qwen3-8B Q4_K_M, context
  40,960): the governor recorded 3,379,206,840 bytes, the macOS
  `phys_footprint` alone, while about 7.9 GB was resident (the GGUF is
  memory-mapped, so its pages are outside the footprint). Effects: two
  "resident RSS exceeded measured peak" restarts of a healthy chat in
  five minutes, a chat counted at 3.4 GB in every other role's
  admission, and wrong "measured" figures. Fix: one figure,
  `MemoryReader.processMemoryBytes` (macOS: the larger of
  `ri_resident_size` and `ri_phys_footprint`, fallback `ps -o rss=`);
  the runaway watch's baseline is only this run's post-load reading and
  a restart waits for requests in flight unless pressure is critical;
  the run's peak rises with healthy readings and is stored; a GGUF
  model's figure from the old definition gains its file size once. Also fixed the timing flake in
  `governor.test.ts` ("a degraded reading changes no state..."). Files:
  `backend/src/lib/memory/`, `backend/src/lib/governor.ts`,
  `backend/src/lib/supervisor.ts`, `backend/src/lib/modelStore.ts`,
  tests. Exit: `bash scripts/check.sh`. Landed on `main` with this line.
- [x] **STACK-AVAIL-MEM-01 (S): available memory counts what the kernel reclaims, not free plus inactive.**
  On 2026-10-06, after STACK-PROCMEM-01 made the 8B chat's figure honest
  (8,436,858,360 bytes), the p16 laptop could not start chat: the macOS
  reader reported 8.2 GiB free (free plus inactive plus word 13 of
  `vm_statistics64_data_t`, the high half of the faults counter, meant
  as purgeable) while `memory_pressure` said 69 percent free, pressure
  was normal and about 16 GB of file cache was reclaimable. Fix: one
  definition, free pages plus the larger of the file-backed cache with
  purgeable pages and the inactive and speculative queues
  (`availableBytesFromVmStatistics`); active anonymous memory and the
  compressor are never counted, and kernel warn or critical still queues
  every admission. On macOS a GGUF figure stored below its own file size
  (an older build's write after the definition mark, as in the rollback
  that day) gains its file size at start. Files:
  `backend/src/lib/memory/darwin.ts`, `backend/src/lib/modelStore.ts`,
  `backend/src/lib/admission.ts`, tests. Exit: `bash scripts/check.sh`.
  Landed on `main` with this line.
- [ ] **STACK-AVAIL-MEM-02 (S): unwired mapped weights on macOS.**
  STACK-AVAIL-MEM-01's available figure counts every file-backed page,
  and its start-up repair raises a GGUF figure below the file size. Both
  are right only while Metal wires the weights (`-ngl all` on Apple
  silicon). Before any Mac launch leaves mapped weights unwired (CPU-only
  or partial offload): subtract the loaded engines' resident mapped-file
  bytes from the file-cache count, and repair a figure only when it was
  written by an older build (a per-row definition stamp). Found in the
  STACK-AVAIL-MEM-01 review. Files: `backend/src/lib/memory/darwin.ts`,
  `backend/src/lib/governor.ts`, `backend/src/lib/modelStore.ts`.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-FIT-CTX-01 (S): a measured peak counts only at the context it was measured at.**
  `buildFitPlan` uses `measuredPeakBytes` for every context it tries,
  though the record keeps `measuredContextLength`; a figure measured at
  a smaller context understates a larger one (the KV cache grows with
  it). Use the measured figure only at or below its context and fall
  back to the estimate above it. Files: `backend/src/lib/fitPlan.ts`,
  `backend/src/lib/supervisor.ts`, `backend/tests/fitPlan.test.ts`.
  Exit: `bash scripts/check.sh`.

## Store and provenance

- [x] **STACK-04: the model store.** Provenance-gated records, the HF
  cache layout, engine tag layout with the `current` link, manifests
  with blob references and orphan grace, ranged resumable downloads,
  read-only import by link. Kept. Landed 2026-09-17 at a84e774.
- [x] **STACK-86: qualification.** The chat and engine pins held to
  their declarations offline. Kept. Landed 2026-09-18 at 063ef7c.
- [x] **STACK-96 (M): pin and rollback proven live.** Committed at the
  commit that carries this line; live proof outstanding: run 1 proved
  the downloads, the checksum refusal and the first answer and exposed
  two real bugs (the supervisor never launched the `current` link's
  build; the header mapping), both fixed with regression tests; run 2
  with the fixes was blocked by 5.5 GB free on a 24 GB laptop (the
  governor's `p16` margin, not loosened). `scripts/prove-pin-rollback.sh`
  is the driver; the transcript and the analysis are in `dev.md`, "Pin
  and rollback, proven live". Rerun `bash scripts/prove-pin-rollback.sh`
  when 1.5 GB more is free or on the Studio: STACK-96b. Landed 2026-09-20 at b8a25b1.
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
  stand-in. Landed on `main` with this line. Landed 2026-09-20 at 6a701d0.
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
  Landed on `main` with this line. Landed 2026-09-20 at 6a701d0.

## Speech roles

- [x] **STACK-101a (M): the voice list with metadata.** `GET
  /stack/v1/voices` lists every voice the `tts` role can render
  (presets, community voices the Stack has fetched, cloned voices)
  with, per voice: id, friendly name, description, language (BCP 47),
  country, gender (as the source declares it; "unknown" when it does
  not), source, whether the files are on disk, and licence. Metadata
  comes from the preset table the engine ships; nothing is guessed
  from a file name. Files: `backend/src/speech/voiceList.ts`,
  `backend/src/routes/voices.ts`, `backend/src/wire/voice.ts` (a Voice
  wire shape declared once; it was added after `spec-v0.1.0` folded the
  other shapes in and no spec tag carries it),
  `docs/integrations.md`, `docs/api/openapi.json` regenerated. Mirror:
  the models route and the `tts` render path (STACK-94c). Acceptance:
  a scripted-engine test listing presets with their metadata; a voice
  with missing metadata listed with "unknown", never dropped. Out of
  scope: the preview endpoint (STACK-101b). Exit: `bash
  scripts/check.sh`. Landed 2026-09-20 at 6799c8a.
- [x] **STACK-101b (M): the voice preview.** `POST
  /stack/v1/voices/{id}/preview` renders one fixed sample sentence
  through the normal `tts` path, cached under `data/` per voice and
  engine build so the second play is instant. Files:
  `backend/src/routes/voices.ts`, `docs/integrations.md`,
  `docs/api/openapi.json` regenerated. Mirror: the `tts` render path
  (STACK-94c). Acceptance: a live preview on this laptop with the
  cache hit measured. Out of scope: the picker itself (home
  VOICE-BROWSER-01). Exit: `bash scripts/check.sh` and the live
  preview line in dev.md. Landed 2026-09-21 at 79eb703 (c-97): the cached preview per voice and engine build; the `engine` field on the voice wire came with it; the live preview line in dev.md is still pending the coordinator's measurement.

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
  `SttWireEvent` contract imported from `@maipai/spec`; identity
  headers on every reply; the bundled clip transcribing in the suite
  through scripted engines and live on the dev machine
  (`scripts/prove-stt.sh`, the table in `dev.md` "stt proven live").
  Landed on `main` with this line.
- [x] **STACK-94c (M): `tts` as a managed engine.** Pocket TTS 3.1.0
  in a venv the Stack builds through pinned uv 0.12.17 from a hashed
  requirements file; the weights, tokenizer and default voice as
  hub-file pins with sha256; `stack.engines.tts.hf_token` encrypted at
  rest and redacted; `POST /v1/audio/speech` forwarding `spec/voice`'s
  form and streaming the WAV with identity headers and cancel on
  client abort; the readiness probe rendering one sentence; proven
  live on the dev machine (`scripts/prove-tts.sh`, the table in
  `dev.md` "tts proven live"). Landed on `main` with this line. Landed 2026-09-20 at 456f420.
- [x] **STACK-EMBED-01: the embedding model is pinned** (S, Sonnet). Landed 2026-10-01. nomic-embed-text-v1.5 Q4_K_M (84 MB, the file the household already runs) is a pinned model for the embed role, so Home can move search onto the Stack (home STACK16 E3).
- [x] **STACK-CHAT-01: the household's chat and background models are pinned, and the judge has its own** (M, Sonnet). Landed 2026-10-01. qwen3-8b-instruct-q4-k-m and qwen3-4b-q4-k-m (the files the household already runs) are pinned; on p16 chat binds the 8B and the judge binds the 4B as its own process; smaller profiles keep the shared 1.7B. Corrected by STACK-CHAT-02 (2026-10-01): found live, the free-memory margin refuses chat when a separate judge is resident on a 24 GB machine; p16 shares chat for the judge, a separate judge binds from p32.
- [x] **STACK-94d (M): the voice engine online only when needed.**
  Pocket TTS runs with `HF_HUB_OFFLINE=1` always and no token in its
  environment; `backend/src/speech/voices.ts` fetches, through the
  store's checksummed path into the hub cache, what a request needs
  and does not have (a preset voice pinned by sha256, a community
  voice pinned to its commit and the hub's digest, the gated cloning
  weights once with `stack.engines.tts.voice_cloning` on and a token),
  before the engine uses it; a voice that cannot be pinned or needs
  cloning that is unavailable is refused with the reason; the privacy
  row says so. Tests: `backend/tests/voices.test.ts` (no request on
  start, a missing voice fetched once then served offline, no token
  refused with the reason). Proven live (`scripts/prove-tts.sh`,
  `dev.md` "The voice engine online only when needed"). Landed 2026-09-20 at 6ab81a2.

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
  STACK-17 on the robot. Landed on `main` with this line. Landed 2026-09-20 at 1ab24e9.
- [ ] **STACK-SIZE-01 (M): the sizer honours a per-role step-down.** The
  hub's design (`home/docs/plans/hardware-tiers-2026-09-23.md`, "The
  configuration is proposed, never fixed") makes the probe's proposal a
  default a person may step down per role. Today the Stack only
  proposes: `setMachineTierFromHardware` (`lib/supervisor.ts`) sets the
  governor tier from `proposeProfile(hardware)` with no input, and the
  governor's `pinned` flag is per-process eviction, not a choice. This
  item: the sizer reads the per-role choice from the household's
  declared setting (`engines.<role>.choice`: proposed, a pinned
  candidate, on demand, off) through the Home contract, and accepts any
  per-role allocation that fits the machine's measured budget with the
  governor's margin kept, in both directions: a role turned off or
  stepped down frees memory another role may take (the owner's example:
  pictures and video off so chat can run a larger model than the tier's
  default; vision resident instead of on demand). A set that does not
  fit is refused with the reason and the roles to turn down. The
  per-role Setting record is the one store of the allocation. Files:
  `backend/src/profiles.ts`, `lib/supervisor.ts`, `lib/governor.ts`,
  the hardware and models routes. Tests: a p64 machine with `chat`
  stepped to the 8B and `image` off runs the 8B and never admits an
  image job; a p32-class machine with `image` off admits the next
  larger chat candidate the catalog pins, and the same machine with
  `image` on refuses it with the reason. Exit: `bash scripts/check.sh`.

- [x] **STACK-SIZE-02 (S): wire the dry run, fix or delete the header
  Landed 2026-09-30.
  estimator.** Objective: admission's second source (`llama-fit-params`)
  actually runs. Pointers: `backend/src/lib/supervisor.ts`
  (`dryRunFootprint`, `estimateFootprint`, both with no callers),
  `lib/admission.ts`, `lib/governor.ts` (the first-load estimate). Mirror
  the order in `docs/dev.md`, "Fit planning versus admission". Acceptance:
  a first load of a downloaded GGUF stores the dry run's result with the
  model and context and admits on it; `estimateFootprint` is deleted
  (the planner of STACK-SIZE-03 replaces it) or, if kept, takes the KV
  element size from the KV cache type, resolves a pinned revision and
  declares its request on `/stack/v1/privacy`. Out of scope: the
  planner, MLX. Test: a fake `llama-fit-params` output drives admission;
  a refused fit names the reason. Exit: `bash scripts/check.sh`.
- [ ] **STACK-SIZE-03 (M): the pre-download planner and its verdict.**
  Objective: for any model, pinned or not, a fit verdict before a byte of
  weights is downloaded (owner decision 2026-09-30). Pointers: a new
  `lib/fitPlan.ts`; the pinned `gguf-parser-go` in `lib/engineCatalog.ts`
  (exact tag and URL, our own sha256, `verified` per platform, MIT line
  in `NOTICE`); `lib/governor.ts` for the arithmetic it imports;
  `routes/`. Mirror `EngineBinaryPin` for the pin and `governorPeak` for
  the shared arithmetic. Acceptance: JSON output only; verdict yes, slow,
  no or unknown with the named bottleneck, the shortfall in bytes, one
  plan per path, every figure with source, range and date; only verified
  architectures (Qwen3 dense today) get a number, the rest are unknown;
  the range request is declared on `/stack/v1/privacy` with its guarding
  test; a plan the planner accepts is never refused by admission. The
  spec rows landed in commons as spec-v0.1.59 (SIZER-SPEC-01: KV cache
  type, footprint entry, engine names, `stack-fit-plan.schema.json`);
  pin that tag. Out of scope: MLX
  (STACK-SIZE-04), Home's wording. Test: the twelve `llama-server`
  comparison rows from `docs/dev.md` as fixtures. Exit:
  `bash scripts/check.sh`. Part B (the module `lib/fitPlan.ts`: parse, run, build) landed 2026-09-30; the route, the privacy declaration and the multi-role sum remain. Part C (the route `POST /stack/v1/fit-plan` and the privacy row) landed 2026-09-30; the multi-role sum remains.
- [x] **STACK-SIZE-07 (S): missing estimator health item and fix. Landed 2026-09-30.** Objective: a fit-plan request without `gguf-parser` raises a health item with one fix that installs the pinned tool, and the privacy row names the observed redirect host. Pointers: `backend/src/lib/fitPlan.ts`, `backend/src/routes/fitPlan.ts`, `backend/src/routes/health.ts`, `backend/src/lib/privacy.ts`. Acceptance: health item, repair, and observed redirect host are covered by tests; out of scope: install at setup, MLX. Exit: `bash scripts/check.sh`.
- [x] **STACK-SIZE-08 (M): the fit plan counts what is loaded, with the governor's own rules. Landed 2026-09-30.** Objective: the plan judges a candidate alongside the roles loaded now, applies the governor's cap and free-memory conditions, sums loaded peaks into the total, and checks host memory on GPU machines. Pointers: `backend/src/lib/fitPlan.ts`, `backend/src/lib/governor.ts`, `backend/tests/fitPlanAdmissionParity.test.ts`. Acceptance: a parity test drives planning and admission with the same numbers; the GPU path checks both device and host memory. Out of scope: estimates for non-chat roles beyond their measured footprints. Exit: `bash scripts/check.sh`.
- [ ] **STACK-SIZE-09 (M): the full-profile sum.** Objective: once STACK-SIZE-01's per-role choice and pins exist for every role, the plan lists every role of the person's chosen set, not only what is loaded now. Pointers: `backend/src/lib/fitPlan.ts`, `backend/src/profiles.ts`, the per-role setting. Acceptance: the plan lists the chosen profile's roles and sums their known peaks using the governor's admission conditions. Out of scope: new estimators for non-chat roles beyond their measured footprints. Exit: `bash scripts/check.sh`.
- [x] **STACK-SIZE-04 (M): MLX sizing with bounded prefix cache and context headroom. Landed 2026-09-30 (launch cap and admission headroom; constants from one model).** Objective: the MLX launch caps its prefix cache, admits with config-derived KV headroom for verified architectures and a fixed reserve otherwise, and watches measured idle footprint plus the same headroom. Pointers: `backend/src/lib/mlxMemory.ts`, `backend/src/lib/supervisor.ts`, `backend/src/lib/governor.ts`. Acceptance: tests cover the `1024MB` cache flag, verified Qwen3 KV arithmetic, unknown architecture reserve, all governor peak sources, and watcher baseline. Out of scope: GGUF, pre-download MLX planning. Exit: `bash scripts/check.sh`.
- [x] **STACK-SIZE-10 (M): plan an MLX model before it is downloaded. Landed 2026-09-30.** Objective: the fit-plan route accepts a Hugging Face MLX repository and the module reads bounded repository facts to build its plan with the verified architecture's KV headroom. Pointers: `backend/src/lib/fitPlan.ts`, `backend/src/lib/mlxMemory.ts`, the route in `backend/src/routes/fitPlan.ts`, the privacy row `model-size-check`. Acceptance: a plan for the pinned Qwen3-1.7B-4bit repository uses a fake fetch with no network and returns estimated peaks on Apple silicon; out of scope: GGUF, the Studio bench. Exit: `bash scripts/check.sh`.
- [x] **STACK-SIZE-11 (S): MLX --kv-quant follows the KV rule. Landed 2026-09-30 (the rule and the flag plumbing; the setting is not read by the Stack until STACK-16; the KV factor for a quantized cache stays the unquantized value until the Studio measures it).** Objective: `mlxKvQuantFor` maps quantized to 8 and auto, full and undefined to no flag; `mlxServeArgs` builds the MLX arguments and appends `--kv-quant 8` when selected. Pointers: `backend/src/lib/engineArgs.ts`, `backend/src/lib/supervisor.ts`, `backend/src/lib/mlxMemory.ts`. Acceptance: unit tests cover the mapping and argument lists, and the existing launch-plan assertion passes unchanged; the unquantized factor is documented pending Studio measurement. Out of scope: wiring the person-level setting into the Stack (STACK-16) and changing the admission factor. Exit: `bash scripts/check.sh`.
- [x] **STACK-CLEAN-01 (S): two sizer cleanups.** Landed 2026-09-30. The planner's all-unknown paths are one function; the reinstall fix's success text names the engine it installed. A third item, a test seam for the request the supervisor hands the governor (to assert the MLX headroom and the dry-run peak), was tried and dropped: no engine build is installed in the test environment, so a role start fails before admission and no test can capture the request; the two values are covered by the mlxMemory tests, the governor's peakFor tests and the plan parity test, and the seam is worth revisiting on the Studio bench (STACK-14) where an engine is installed.
- [x] **STACK-SIZE-12 (S): the plan judges capacity, not free memory.** Landed 2026-09-30. Found by the first real run of the fit plan (SIZER-E2E-01): a 2.4 GB model read "no" on a 24 GB laptop because free memory at that second was below the working margin. The plan now uses only the governor's capacity condition; free memory stays admission's.
- [x] **STACK-SIZE-13 (S): dense llama models get numbers.** Landed 2026-09-30. SIZER-LLAMA-01 measured Llama 3.2 3B Q4_K_M in six real loads and every row passed both hard rules; llama joins the verified list for dense files only (a mixture of experts stays unknown until measured). Larger llama models remain in the Studio bench (SIZER-BENCH-01, row D3).
- [x] **STACK-SIZE-14: install gguf-parser on demand for a GGUF fit plan, and answer 404 for an MLX repo that does not exist.** Landed 2026-09-30. A missing parser is installed through the pinned engine path with shared in-flight work and a 120 second timeout; failed installs keep the unknown plan and health item, and a definite Hugging Face 404 for an MLX repository now returns 404 while other lookup failures remain unknown.
- [x] **STACK-SIZE-15: a Hugging Face repository page of GGUF files is sized from one file** (S, Sonnet; found live by the owner pasting a repository page). Landed 2026-09-30. A repository with no safetensors but with .gguf files is sized from the preferred quant (Q4_K_M, then Q4_K_S, Q4_0, Q5_K_M, Q5_K_S, Q8_0, else the smallest; vision projectors and later shards skipped) through the same size checker as a file link. Corrected by STACK-SIZE-16 (2026-09-30): imatrix, draft-head and projector files are never picked; the preference list gains IQ4_XS, Q3_K_M, IQ3_S, IQ3_XXS and IQ2_S.
- [x] **STACK-SIZE-17: the fit plan carries the model file's size** (S, Sonnet; found live by the owner). Landed 2026-09-30. Pinned spec-v0.1.68; model_file_bytes is set when the Stack knows the file size (parser output, repository listing, MLX weights sum, store file) and omitted otherwise, including for unmeasured model families, so Home can say what is known.
- [ ] **SIZER-BENCH-01 (M, bench on the Studio, Sonnet or Codex at raised reasoning; owner: the Studio lane)**: run the sizer's Studio bench (`docs/plans/sizer-studio-bench-2026-09-30.md`). Objective: measure the eight rows of that plan (three MLX dense and mixture-of-experts and sliding-window models, three GGUF models, one quantized-KV MLX row) at four contexts each, compare every result with the fit plan's low and high and with admission's estimate, and record the table in `docs/dev.md` "Fit planning versus admission". Acceptance: the record names engine builds, model files and a sanitized hardware line; each architecture that passes the three verification rules gets its own reviewed commit adding it to `VERIFIED_ARCHITECTURES` or `VERIFIED_MLX_MODEL_TYPES`; a quantized-KV factor from row E1 replaces the placeholder note in `lib/mlxMemory.ts` or the note is confirmed. Out of scope: any product change beyond those constants and lists; the laptop (this bench never runs beside the household's hub). Blocked on: the Studio running the Stack (STACK-13a, STACK-14). Exit: the table in `docs/dev.md` plus the reviewed commits.
- [x] **STACK-SIZE-05 (S): read Metal's working-set cap.** Landed 2026-09-30. Objective:
  on Apple silicon the usable memory is capped by the GPU's recommended
  working set, which the governor never reads, so unified-memory totals
  can overstate what the GPU may hold. Pointers: `lib/governor.ts`
  (`defaultModelBudgetBytes`), the hardware probe in `@maipai/core`.
  Acceptance: the budget is the smaller of the current rule and the
  recommended working set, reported in the hardware facts. Test: a
  probe reporting a cap below total memory lowers the budget. Exit:
  `bash scripts/check.sh`.
- [ ] **STACK-SIZE-06 (S): multi-GPU budgets per device.** Objective: a
  machine with two 8 GB cards is not sized as one 8 GB card.
  `primaryBudgetBytes` in `@maipai/core` returns the largest single
  card; the planner's multi-GPU path needs one budget per device from
  `cudaDevices`. Acceptance: the plan lists each device and marks the
  multi-GPU throughput as unknown until measured. Exit:
  `bash scripts/check.sh`.

- [ ] **STACK-FLOOR-01 (S): the `p8` profile, the robot's pins as the
  lowest step-down.** The same design's floor tier: an 8 GB laptop or a
  CPU-only desktop runs the robot's configuration, and every bigger
  machine may step down to it. Today the lowest profile is `p16`
  (`backend/src/profiles.ts`). This item adds `p8` below it: the floor
  chat model (the 1.7B at Q8 today, MEASURE-02's 2B candidate when
  measured), stt and tts on the CPU, the embedder, no judge model, no
  generators, its own working margin in the governor's table, and the
  label in the wizard's words ("The robot's brain on your computer:
  chat and voice only, no photos or pictures, slower and plainer
  answers. Uses the least memory."). Test: an 8 GB probe proposes
  `p8`; a p64 machine stepped to `p8` runs only the floor set. Exit:
  `bash scripts/check.sh`.

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

## Thin chat path (2026-10-02)

Rules: `home/docs/design/RULES.md` chat rules 4 and 11; record:
`home/docs/plans/chat-thin-path-2026-10-02.md`. Home's items are
`THIN-3A` and `THIN-4G` in `home/docs/BACKLOG.md`.

- [ ] **STACK-CTX-01 (M): the chat engine launches with the machine's
  real context.** Today the launch falls back to 4,096 tokens
  (`backend/src/settings.ts:64` default for
  `stack.engines.llama_server.context_length`,
  `backend/src/lib/supervisor.ts:570` and `:603`,
  `backend/src/lib/fitPlan.ts:54`, `backend/src/routes/fitPlan.ts:49`),
  while the bench that found the thin-path problem ran at 32,768. Change:
  the default context is the largest the fit plan admits for this machine
  and model (capped at the model's trained context), never a constant; an
  owner's explicit setting still wins; the chat role status reports the
  launched `context_length` and the slot count, and says whether the
  figure is total or per slot (`--parallel` in `engineArgs.ts:61` splits
  the context across slots); an engine that cannot be admitted at the
  minimum refuses with the plain reason (this is the reason Home's issue
  #203 wants shown). The launch also carries the `--lora` flags for style
  adapters when a companion pins one (rule 14). Regenerate
  `docs/components.md` from `backend/src/lib/componentsDoc.ts:107` and
  `backend/src/lib/modelCatalog.ts:24`; fix the 4,096 sentences in
  `docs/dev.md:575-580`, `docs/integrations.md:183` and
  `docs/plans/studio-bench-protocol-2026-09-20.md:37`. Mirror: STACK-SIZE-04
  (admission headroom) and the existing fit-plan tests. Acceptance: on a
  24 GB Apple-silicon laptop with the 8B chat model the chat role starts
  with the context the fit plan admits (not 4,096) and reports it; a
  second engine started to compete for memory makes the chat role refuse
  with the memory reason, not a bare failure. Out of scope: Home's window
  (`THIN-3A`, `THIN-3C`), moving the supervisor onto a router mode (the
  record's open owner decision). Exit: `bash scripts/check.sh`.
- [ ] **STACK-SEARCH-01 (L): the Stack installs and owns the search
  service by default.** Rule 11: by default the Stack installs,
  configures, runs and health-reports everything chat needs, search
  included (a SearXNG instance), so a new household sets up nothing and
  search works with no key and no account. An owner who already runs a
  SearXNG, on this machine or another, chooses it with one setting; the
  Stack (and Home, `THIN-4G`) checks it at save time and shows its health
  like any other service. No model runner is ever adopted this way
  (`STACK-ADOPT-01` is dropped). Design note first (a doc in
  `docs/plans/`, written before any code): how it is fetched (pinned
  version, pinned URL, checksum, a clear offline message, per the org's
  download-don't-vendor rule), the runtime it needs (see
  `backend/src/lib/uvEnvironment.ts`), its memory share under the
  governor, the safesearch-capable engines it names, how the three
  safesearch levels (child strict, teen moderate, adult off) are passed
  per request, its health and restart behaviour, update and rollback, and
  the licence (AGPL-3.0) obligations. Then chunk into `S` and `M` items
  here. Files: new `backend/src/lib/` service module, `backend/src/roles.ts`
  or the supporting-service list, `backend/src/settings.ts`. Mirror: how
  the Stack installs and supervises an engine (`engineInstall.ts`,
  `supervisor.ts`) and Home's Kiwix sidecar. Acceptance for the design
  note: it answers each question above and lists the chunked items.
  Out of scope: page reading (Home's `THIN-4A`), the hosted-key option
  (`THIN-4H`). Exit: the note, then `bash scripts/check.sh --docs`.
- [x] **STACK-TOKENIZE-01 (S): the chat engine's own token count by
  role.** Home's `THIN-3B` needs the engine's count on rendered messages
  (Home rules 2 and 4). `POST /v1/tokenize` passes llama-server's own
  `/apply-template` (no generation prompt) and `/tokenize` through on a
  chat-wire role, with the same role resolution, identity headers and
  engine checks as a completion, and answers `{ count }`; an engine
  without those routes is a 501 that says so, never an estimate. Files:
  `backend/src/routes/v1.ts`, the scripted process in
  `backend/src/lib/supervisor.ts`, `docs/integrations.md`. Tests in
  `backend/tests/routes.test.ts`. Done 2026-10-06.

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
- [x] **HOME-STACK-01, the Stack's own half (M, done 2026-09-21): the compiled binary.**
  `scripts/build-binary.sh` compiles `maipai-stack` (`bun build --compile`
  from `backend/src/index.ts`) for Home's installer to place, verifying
  live against a real scratch data directory every time it runs rather
  than trusting a one-time claim: `/healthz`, the role list, and (since
  a compiled binary can never load `sherpa-onnx-node`'s native binding
  once it also contains the daemon's own graph - a genuine Bun bundler
  bug, `getmaipai/stack#8`, filed with a minimal repro) a real `stt`
  transcription end to end, through a real `bun` (`STACK_BUN_BIN`)
  running the worker against `backend-src/`, a real dereferenced copy of
  `backend/` shipped as a sibling of the binary - not a documented gap,
  a real fix. Also fixed along the way: `db/index.ts`'s migrations
  folder and `lib/paths.ts`'s default data directory, both invisible to
  a compiled binary's virtual filesystem (drizzle's migrator and the
  data-dir fallback both use plain `node:fs`/`import.meta.dir`), now
  resolve relative to `process.execPath`'s real directory via
  `lib/paths.ts`'s new `isCompiledBinary`. Every other role (external
  subprocesses, never a native Node addon) was already unaffected.
  Files: `scripts/build-binary.sh` (new), `backend/src/db/index.ts`,
  `backend/src/lib/paths.ts`, `backend/src/lib/supervisor.ts`
  (`speechWorkerCommand()`'s compiled-vs-bun-run branch),
  `backend/src/service/launchd.ts` + `systemd.ts` (`STACK_BUN_BIN`
  passthrough), `backend/package.json`. `bash scripts/check.sh` green,
  full backend suite 327/327. Out of scope: an actual Linux build;
  Home's own `install.sh`/`uninstall.sh` wiring (lands in `home`'s own
  BACKLOG as its own HOME-STACK-01 item - now also has to keep
  `backend-src/` beside the binary and set `STACK_BUN_BIN`, not just
  place a single file).
- [ ] **STACK-16 (L): Home runs on the Stack.** Home's installer
  installs the Stack, Home calls every role by name, bridges the event
  feed into its notification system, renders the Engines page from the
  declarations, and deletes its own supervisors; dual-run proves each
  role before removal and a rollback restores the old path. Lands in
  `home` as its own items after STACK-14 proves the Studio profile;
  RF-06 writes the hand-off. Out of scope: removing Home's supervisors
  before the Studio proof. Exit: Home's gate and the dual-run check.

- [ ] **DATA-LOCATION-STACK: the Stack's class list, record, never-create and moves on Home's request** (M, lands in `getmaipai/stack`; the coordinator files it in the Stack's own backlog; revised 2026-09-30). Objective: the Stack declares `stack-state`, `stack-models` (models and store together), `stack-engines` and `stack-logs`, keeps its own record beside its lock, adopts core's never-create, marker and verified-copy helpers, and serves its classes and moves to Home, per the design record's "The Stack". Pointers: `stack/backend/src/lib/paths.ts` (`ensureDataDir`), `stack/backend/src/lib/store/layout.ts` (`currentEngineRoot`), `stack/backend/src/lib/uvEnvironment.ts` (its `home/` folder assigned to a class), new `GET /stack/v1/storage/classes`, `GET /stack/v1/storage/locations`, `POST /stack/v1/storage/move`, `maipai-stack install-service --location`, `PreciousState` derived from the class list. Mirror: the Stack's own health list and event feed. Acceptance: with its models drive unplugged the Stack raises a health item and creates nothing; a missing `stack-state` refuses to start; a `stack-models` move keeps every hard link and symlink and engines start from the new folder; every folder under `STACK_DATA_DIR` belongs to a class. Out of scope: Home's Storage page (02a). Exit: the Stack's `scripts/check.sh`.
  Filed here 2026-10-01 from home's DATA-LOCATION design record (`getmaipai/home` `docs/dev.md`, "DATA-LOCATION"); depends on commons spec-v0.1.58 and core-v0.1.1 (landed) and home's items 00c and 01a.

- [x] **STACK-ADMIT-01 (S): a request the working margin queued is retried on every poll.**
  Measured 2026-10-04: a chat request needing about 0.5 GB got 503
  "cannot admit" with 7.8 GB free and normal pressure after the 15 s
  wait. The arithmetic: `canAdmit` needs `loaded + peak <= cap` and
  `free - peak >= margin` (p16 margin 4 GB; free is free + inactive +
  speculative pages, so it counts reclaimable memory). While an engine
  loads, free dips under peak + margin, the request queues, and the
  poll retried the queue only on a pressure edge back to normal or a
  crossing of the low-water floor; free recovering inside the normal
  band fired neither, so the request waited out its deadline although
  it fit. Defect, not design (the 2026-09-20 run 2 refusal was a real
  misfit: 2.4 GB estimate under a 5.5 GB free). Fix: the poll tries the
  queue head every poll. Files: `backend/src/lib/governor.ts`,
  `backend/tests/governor.test.ts` (new test first). Out of scope: the
  admission rules and margins. Exit: `bash scripts/check.sh`.
  Landed 2026-10-03 at 4156075.

## Docs

- [x] **STACK-98 (S): the generated components inventory.**
  `docs/components.md` from `backend/scripts/gen-components-doc.ts`
  (`bun run gen:components-doc`): one section per role in `ROLE_IDS`
  order with the engine pins per platform, then a row per profile with
  the stance, the pinned model and its facts, and a status of pinned,
  candidate (named) or not yet; drift-checked in `scripts/check.sh`
  like the API document; `tests/componentsDoc.test.ts` renders a
  scripted catalog. Landed on `main` with this line. Landed 2026-09-20 at 8e90d8f.
- [x] **RF-02** covers `dev.md`, `integrations.md`, `AGENTS.md` and
  `README.md`. The user tier is gone; Home's docs describe what a person
  sees. Landed date unrecorded (no commit names this ID; ticked before 2026-09-21).

## SearXNG settings

- [ ] **SEARXNG-SET-02 (M): the Stack configures its own SearXNG from the catalog** (2026-10-06; after STACK-SEARCH-01's service module and SEARXNG-SET-01). Objective: an admin chooses engine groups in Home and the Stack writes, restarts and verifies its own SearXNG. Files: `backend/src/settings.ts` (`stack.search.groups.{news,images,video,science}`, `stack.search.engines.{yandex,baidu}`, boolean, `needs_restart`), the search service module, `backend/src/lib/privacy.ts`, `backend/src/routes/v1.ts` (`GET /stack/v1/search/preview`, `POST /stack/v1/search/revert`), `docs/integrations.md`. Writes with the `yaml` package: `use_default_settings`, `keep_only` union, formats html and json, `safe_search: 2`, limiter off on loopback, secret kept. Acceptance: golden files per combination; a failing restart restores the last good file; revert works; privacy rows follow the groups; the pinned version's `/config` holds every catalog name and a `disabled` engine can be named per request (proves the UNVERIFIED fact). Out of scope: installing SearXNG (STACK-SEARCH-01). Exit: `bash scripts/check.sh`.
