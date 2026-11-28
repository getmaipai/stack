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

- [x] **INSTANT-02 (S): the judge role is Home's Instant chat target.** Home's INSTANT-02 (`home/docs/design/instant-mode-2026-10-17.md`). The judge was already a chat-wire role on the resident Qwen3 4B from p32 up; no code route was needed. Landed 2026-10-17: the contract in `docs/integrations.md` "Instant chat", a test that pins it (`profiles.test.ts`), and a measured contention row (first text 0.03 to 0.13 s beside a background generation). Out of scope: Home's toggle (INSTANT-04) and the 4B's tool bench (INSTANT-03).
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
- [x] **ENGINE-MLX-01 (M): oMLX as a chat engine on Apple silicon; since ENGINE-MLX-02 opt-in, llama-server the default everywhere.** Design and numbers:
  Home's `docs/design/chat-engine-comparison-2026-10-17.md`; Stack design: `dev.md`, "The chat engine on Apple silicon: oMLX".
  Built: `chat/omlx.ts` (managed uv environment, hashed requirements with the release wheel by checksum, launch, offline and keyed),
  `chat/omlxClient.ts` (the wire adapter: model name, pinned template variables, `timings` from usage, token counts by one-token
  requests), `lib/chatEngines.ts` (auto by tier, fallback after two failed starts, one-setting rollback),
  `lib/chatEngineAssets.ts` (background environment build and model pull at start, then the switch), the MLX model record, the install-plan entry on p64
  and p128, the engines routes, privacy rows, tests (`omlx.test.ts`; the real engine in `omlxSmoke.test.ts` with `OMLX_SMOKE=1`).
  **ENGINE-MLX-02 verdict (owner ruling 2026-10-17): llama-server is the default on every tier, oMLX is opt-in** (`stack.engines.chat.engine` = `omlx`).
  Benches: tool-name defect 15 of 70 right on oMLX against 65 of 70 on llama-server before the namespace fix, 58 of 70 after; fewer tool calls
  on math and convert; 1 of 60 replies leaked raw tool markup; search 26 of 30 against 28 of 30. `auto` never fetches the 19 GB model or the
  engine; the install plan and default disk totals dropped them (p64 and p128 `required_free_bytes` 88.9 GB to 63.2 GB), and `chat-mlx` is an
  optional disk-plan row. Home mirrors `docs/disk-plan.json`.
- [x] **STACK-93 (M): the second engine adapter under the governor.**
  `mlx-serve` v26.9.4 (the pick by the prebuilt rule, `dev.md`, "The
  second chat engine"; oMLX the named alternative) as a second spawned
  engine kind: its pin in `engineCatalog.ts`, its launch on loopback,
  the identity the Stack stamps, admitted by the governor at the file
  times its own multiplier beside `llama-server`; the chat role bound
  to either by `stack.engines.chat.engine`; an MLX model as a
  directory pin of nine verified files
  (`mlx-community/Qwen3-1.7B-4bit`, removed 2026-11-17). Proven live on the laptop
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
  optional smoothed speed and per-file progress for model and engine
  downloads, including a stalled state whose existing `.part` file
  resumes on retry;
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
- [x] **STACK-99 (M): the music role on ACE-Step 1.5.** ACE-Step 1.5
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
  scripts/check.sh` and the measured table in `dev.md`. Built 2026-10-17
  as MUSIC-GEN-01 and MUSIC-GEN-02 (Home
  `docs/design/music-generation-2026-10-17.md`): the `music-gen` engine
  with an in-process JSON-lines worker instead of `acestep-api`, the
  pins, `/v1/audio/music`, the made-here ledger and the `music`
  component; the measured peak (`MUSIC_PEAK_BYTES`) and the real-worker
  run are the owning session's. MUSIC-GEN-15 adds optional local Whisper
  transcription to the finished-song result for Home's content checks;
  the transcript is one-shot, memory-only and fails closed when sung
  words cannot be read. Its optional pin and 2 GB admission increment
  are documented in `integrations.md`.

- [x] **MP-07 (M): sound effects on Stable Audio 3 Small-SFX (Stack half).** Built 2026-11-13 (Home
  `docs/design/music-port-2026-11-13.md`, MP-07): the `sfx-gen` engine (stable-audio-3 source at `790793b`, MIT, uv
  environment from a hashed torch 2.7.1 file) with a JSON-lines worker that runs offline on torch MPS, cuts the silent tail
  and sets the loudness with the managed ffmpeg; the pin `stable-audio-3-small-sfx` (ungated mirror at one revision, every
  file by sha256); the component with the Stability Community and Gemma licence accepted once; the optional `sound-effects`
  disk-plan rows; `POST /v1/audio/sound` with job polling and the file; `GET /stack/v1/sound`. Measured on the Studio: 5.27 GB
  peak, 2 to 12 s warm for 2 to 47 s sounds; admission 6.5 GB. Exit: `bash scripts/check.sh`, `tests/sound.test.ts`, and the
  real-worker test run once against the weights in a scratch folder. Not done: gapless loops (`loop: true` is refused),
  lengths past 47 s, a listening check of the cut and the loudness.

## Governor and sizing

- [x] **SPLASH-MEM-01: the chat engine's Metal budget is what the ledger counts** (S). Incident 2026-11-12: Splash chat held 61.2 GB (its `--max-memory`, the model's need plus 12 GB headroom plus the governor's 20 GB margin) while the ledger reserved 35 GB, so a 33 GB song waited on memory that was never free. Built: `splashChatMemoryPlan` is the one definition (need plus the headroom setting, whole GiB, no margin) for the launch, chat's admission headroom and the watchdog ceiling; the governor reads every owned process's live bytes, counts growth past the admitted peak as overage on the budget side of admission, restarts chat between turns when a held generator job would fit after that overage (owner's ruling 2026-11-12), and the memory report names per-item peak, live and overage bytes; the waiting lines carry no memory words. `docs/dev.md` "SPLASH-MEM-01".

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

- [x] **STACK-EMBED-02 (M): the embed role runs on the processor when graphics memory is too small.**
  The embed role was offline with "estimated peak unknown against a
  1.9 GB model budget": the budget was free graphics memory, `nomic-bert`
  is not a verified graphics-side architecture so its estimate was dropped,
  and the installed record's size was 0. Adds `stack.engines.<role>.gpu_layers`
  (chat, embed, vision; default `all`, embed settable to `0`) passed to
  `llamaServerArgs`; a processor-placed role is planned against system
  memory with its estimate kept; the size is filled on install and
  `reconcileModelSizes()` repairs null and 0 at start; fit refusals say
  what went wrong and what to do. Apple/Metal keeps `-ngl all` by default
  (see STACK-AVAIL-MEM-02). Files: `backend/src/settings.ts`,
  `backend/src/lib/{engineArgs,fitPlan,modelStore,supervisor}.ts`, tests.
  Landed on branch `stack-embed-02`; the box still needs the setting set
  to `0` after the deploy.

## Store and provenance

- [x] **STACK-MUSE-01 (M): Muse Glimmer 30B is the chat pin above 24 GB.** *(Removed 2026-11-17 by the owner's decision, see CHANGELOG; every profile now binds Qwen3 8B. The entry below is history.)*
  Owner's rule 2026-10-16: Qwen3 8B stays the p16 chat (16 and 24 GB);
  p32 binds `muse-glimmer-30b-q4-k-m` (17 GB) and p64/p128 bind
  `muse-glimmer-30b-q4-k-xl` (19.7 GB), both pinned to one revision of
  `meta-models/Muse-Glimmer-30B-GGUF` with sha256. Catalog records gain
  `launch.chatTemplateKwargs`, passed as `--chat-template-kwargs`, so
  Muse runs at `reasoning_strength: low`. Tests: `profiles`,
  `engineArgs`, `modelStore`, `installPlan`. Measurement is Home's
  STUDIO-EVAL-01. Reasoning: dev.md "The chat pin above 24 GB".
- [x] **VISION-03a (S): Muse Glimmer 30B reads pictures through its own projector.** *(Removed 2026-11-17 with the Muse pins; the projector mechanism stays for any model that declares one.)*
  Home's design note `docs/design/vision-images-2026-10-17.md`. The
  repository's `mmproj-Muse-Glimmer-30B-Q4_K_M.gguf` (1.4 GB, same
  revision, sha256 `f48b4523...`) is pinned as `muse-glimmer-30b-mmproj-q4-k-m`
  (component `projector`); both Muse pins declare `imageInput` and launch
  with `--image-max-tokens 2560`. The projector loads in the one resident
  chat process (no second role, nothing extra to keep warm), so p32, p64
  and p128 read pictures once it is installed; the install plan now brings
  the projector of any bound model that declares one. Nothing changes until
  the file is pulled: without it the launch is text only, as before.
  Tests: `museVision`, `installPlan`, `chatVision`, `modelStore`.
- [x] **VISION-03f (S): an installed model takes on what its pin declares, and chat restarts when its projector arrives.**
  Found 2026-10-17 on a scratch Stack built from the Studio's own database:
  the Muse record installed before VISION-03a had no `imageInput`, and the
  install plan skips an installed model, so pulling the projector alone left
  chat text only (`imageInput: false`, no `--mmproj`). Now
  `reconcilePinDeclarations` copies a pin's `component`, `imageInput`,
  `launch` and `sampling` onto the installed record of the same id,
  revision and sha256 at daemon start and when a projector finishes
  installing, and `restartForNewProjector` restarts a chat process that
  started text-only so the next message reads pictures (a process that did
  load its projector is left alone). Measured on the scratch Stack with the
  Studio's record and the real projector: keep-warm launches with
  `--mmproj ... --image-max-tokens 2560`, the role row reads
  `imageInput: true`, `picture_tokens_max` 2560. Tests:
  `museProjectorReconcile`.
- [x] **VISION-03g (S): an upgrade pulls the picture projector an installed model declares.** Found live 2026-10-17: Home v0.2.6 installed on the Studio but the Muse folder had no projector, because the install plan only runs in the setup wizard. At daemon start `pullMissingDeclaredParts` (`installJobs.ts`) finds each installed model whose pin declares `imageInput`, pulls the projector it names when it is not on disk (a job in the install strip, sha256 verified), and chat restarts with it (VISION-03f). A failed pull raises the Repairs item `model-part-missing.<id>` with Try again, cleared when it installs. The pull route and this repair share `startModelInstall`. Tests: `declaredParts`. Live: the 1.4 GB file was placed by hand and registered through the pull route; chat then read a chart (804 prompt tokens, 11.9 s).
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

- [x] STACK-STATUS-01: `GET /stack/v1/status` composes health, busy, using, memory, jobs and problems (record: home `docs/design/stack-home-catalog-separation-2026-11-16.md` section 7).
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
- [x] **VOICE-STUDIO-01 slice 1 (M): Chatterbox Turbo (MLX) as the Studio's expressive second `tts` engine.** Landed 2026-10-17; design in `dev.md`
  "The second voice engine". `stack.voice.engine` (`auto`, `chatterbox-turbo`, `pocket`), tier default Chatterbox on p64 and p128, Pocket
  elsewhere and as the fallback when the engine will not start; `mlx-audio` 0.5.9 managed runtime, pinned `mlx-community/chatterbox-turbo-fp16`
  (Apache-2.0 weights card, MIT code); `tts.tags` capability on the role and each voice; tests in `ttsEngines.test.ts`. Open: Orpheus 3B MLX
  as the alternate (interface and registry slot exist), reference-clip cloning (pin S3TokenizerV2), the blind listening test, a tag
  passthrough test from `reply.speech` (REG-02, Home).
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

## Linux and the engine computer

- [x] **STACK-LINUX-CUDA-01: a pinned Linux x64 CUDA llama-server build** (S, Sonnet; P0). Objective: the Stack can fetch and run its own pinned `llama-server` on Ubuntu 24.04 x64 with NVIDIA cards. Files: `backend/src/lib/engineCatalog.ts` (entries at lines 90-127, selection at 266-271), `docs/components.md` (generated). Mirror: the Windows CUDA x64 entry. Reuse check: the upstream llama.cpp release's prebuilt Linux CUDA asset, pinned by URL, revision and sha256; no build of our own unless upstream ships none, and then the item says so and stops. Acceptance: `selectEngineBinary` picks the entry on a scripted linux/x64/cuda probe; a test refuses a mismatched checksum; the generated components doc lists it. Out of scope: qualification on the box (REMOTE-STACK-P0), ComfyUI. Exit: `bash scripts/check.sh`. (landed 2026-10-07; 9219e68, 1643cd8, 7e94ea4)
- [x] **STACK-CONTRACT-01: `/healthz` reports a contract number** (S, Sonnet; P1). Objective: one integer `contract` (start at 1) beside `ok`, `version`, `uptimeSeconds`, additive, so a Home on another computer can refuse a Stack it cannot talk to. Files: `backend/src/app.ts:38-42`, `docs/integrations.md`, `docs/api/openapi.json` (generated). Mirror: the liveness route's own schema. Reuse check: a field on the existing route; no new route. Acceptance: test reads `contract: 1`; integrations.md says when it is bumped (a removed or repurposed route or field). Out of scope: Home's check (REMOTE-STACK-LINK-01). Exit: `bash scripts/check.sh`. (landed 2026-10-07; dee4b21)
- [x] **STACK-PICTURES-CAP-01: role rows say whether they read pictures** (S, Sonnet; P3). Objective: `reads_pictures: boolean` on the chat and vision rows of `GET /stack/v1/roles`, from `roleReadsPictures()` (`backend/src/lib/supervisor.ts` near 562). Files: `backend/src/routes/roles.ts`, the roles schema in `@maipai/spec` `stack/` first. Mirror: `context_length` on the chat row (STACK-CTX-01). Reuse check: the supervisor's existing function. Acceptance: test with a vision-capable profile reads true, p16 reads false. Out of scope: binding vision by URL. Exit: `bash scripts/check.sh`. (landed 2026-10-07; 9aa3efb)
- [ ] **STACK-LINUX-COMFY-01: hashed ComfyUI requirements for Linux CUDA** (S, Sonnet; P3; after STACK-SIZE-06). Objective: the Stack's managed ComfyUI environment installs on Linux x64 CUDA, as it does on macOS. Files: `backend/src/lib/engineCatalog.ts:235-241`, `backend/src/lib/uvEnvironment.ts`. Mirror: the macOS requirements file. Reuse check: `uv pip compile --generate-hashes` against ComfyUI's own requirements. Acceptance: the catalog entry declares linux/x64; a test resolves it on a scripted Linux probe. Out of scope: LoRAs, video, SDXL pins (the Stack's model vetting owns those). Exit: `bash scripts/check.sh`.


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
  Additional acceptance criteria for Home's own SearXNG: enable JSON
  output; enable the limiter and pass only the loopback caller; prefer
  IPv4 when the machine has no global IPv6 route (UNVERIFIED: how
  SearXNG exposes this); pin the curated engine set with `keep_only`;
  send one warm-up query after each start and do not count its failure;
  disable query logging and prove no query appears in logs by grepping
  the logs after a query; update only to a pinned version, health-check
  after update, and roll back automatically on failure; forward search
  through the Stack's own API so the engine link uses one SSH port
  forward (UNVERIFIED: design point); hash-lock SearXNG's Python
  packages using `uv --require-hashes` or a `uv.lock` with hashes; and
  add `/stack/v1/privacy` rows for every fetch host (the PyPI index and
  file host, and the release host) in the same commit as code that
  fetches from those hosts. Prove the no-query-logging behavior with a
  test that greps the logs after a query (UNVERIFIED until that test
  confirms SearXNG writes no queries at its configured log level).
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

- [x] PARTS-API-01 (first landing): `GET /stack/v1/parts?audience=`, `POST /stack/v1/parts/{id}/install`, `DELETE /stack/v1/parts/{id}`, additive; the old list routes go in the second landing with Home (record: home `docs/design/stack-home-catalog-separation-2026-11-16.md`).
- [x] PARTS-UPDATE-01: update.available on every part row from the Catalog index; POST /stack/v1/parts/{id}/update and /rollback for models (staged, verified, switched, previous kept) and for llama-server (record: home docs/design/stack-home-catalog-separation-2026-11-16.md section 3).
- [x] PARTS-ENABLE-01: enabled and the effective order from the pushed choices (PUT /stack/v1/parts/choices), engines listed as parts with no switch, required_by, and refusals that say why (record: home docs/design/stack-home-catalog-separation-2026-11-16.md section 4).
- [x] BUDGET-01: one `stack.memory.budget_percent` setting replaces `model_budget_bytes` and `reserve_gb`; the machine class, the governor cap, the warm set and the watchdog reserve all follow it (record: home `docs/design/stack-home-catalog-separation-2026-11-16.md` section 5).
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

## Image tools (owner approved 2026-10-17)

- [x] **LOOK-01 step 3a: fast Look** (M). `POST /v1/images/looks`, pinned YOLOX-nano in the `image-tools` environment, household boxes and counts, coarse light and wall tags, per-source 90 second track cache, in-memory only. Detailed tier and accuracy measured on live frames remain open (step 3b).

- [x] **COMPONENTS-01: install and uninstall every component** (M). `lib/components.ts` (one definition of each part: its pinned records, the engine environment it runs in, the tier it fits, what uses it), `GET /stack/v1/components`, `POST /stack/v1/components/{id}/install` (job kind `component.install`, a Repairs item with Try again on failure), `DELETE /stack/v1/components/{id}` (hub-cache blobs and environments removed only when nothing else uses them, bytes freed reported, refused while a request or job uses it, never leaves chat without a model), last use in `meta` (`lib/componentUse.ts`). Z-Image-Turbo (33 GB) is `optional` on p128. Tests with a scripted download and environment build: `tests/components.test.ts`. Home: Settings, Engines and AI, Models and storage.
- [x] **MEDIA-STACK-01: the media service** (M). Built 2026-10-17 on a scratch Stack with the real tools: jobs `media.probe`, `media.fetch`, `media.transcode`, `media.preview` and `media.setup` on one idle-priority FIFO that never wedges, the per-site limiter and 30-minute quiet mode, Home's folder declaration (`PUT /stack/v1/media/roots`), `GET /stack/v1/media`, `DELETE /stack/v1/media/outputs/{job}`, two privacy rows; ffmpeg and ffprobe from jellyfin-ffmpeg 8.1.3-1 and yt-dlp 2026.8.19, pinned. Tests: `backend/tests/mediaLane`, `mediaCore`, `mediaJobs` (no binaries, no network) and `mediaReal` (real tools, localhost fixtures only; no request to any video service, Home RULES.md V1). Budget: probe 52 ms, transcode of a 60 s 720p HEVC clip 25.4 s, preview 3.2 s, localhost fetch 1.7 s. Open: nothing here; Home's ingest slices call it.
- [x] **CMEDIA-STACK-01: `media.companion_clip`** (M). The media lane accepts a keyed green or magenta clip, or a source with alpha, fits loop and one-shot clips, reports colour/size/opacity/loop checks, and writes a premultiplied-colour plus matte H.264 MP4, optional AV1 MP4, transparent still and JSON report. Contract and failure codes are in `docs/integrations.md`; quality thresholds await the key-colour bench.
- [x] **CMEDIA-KEY-01: key the background that was drawn.** Estimate each decoded frame's background from its border; use hue keying and unmixing for muted or drifting green and magenta, retaining the pure-key formula for near-pure and non-key-like borders. Synthetic and real muted-green picture coverage in `companionKey.test.ts`.
- [x] **IMAGETOOLS-01: the Stack's image tools service** (M). Built 2026-10-17 on a scratch Stack with real images: `POST /v1/images/edits` (remove_background, erase, upscale, resize, depth), `GET /v1/images/edits/{job}`, `GET /stack/v1/image-tools`, pinned ONNX components of the `image` role in the install plan, the `image-tools` managed environment and one on-demand worker (`backend/src/imagetools/`). Measured end to end: Apple Vision cut-out 0.6 to 0.9 s, IS-Net 2.5 s at 2048 px, erase 1.5 s warm (6.8 s with the model load), upscale 2x of 1024 px 4.4 s. Depth uses Depth Anything V2 Small (Apache-2.0), returning a normalized grayscale PNG with near white and far black. Design: Home `docs/design/image-tools-2026-10-17.md`. Open: the compiled Apple helper as a release asset and a Linux requirements file (Home IMGTOOLS-08), erase of large holes at native resolution (IMGTOOLS-07).
- [x] **IMGEDIT-01 (Stack half): reference pictures for edits, and find_people / erase_people** (M). Built 2026-10-17: `edit` and `edit_masked` take `reference` and `reference2` with their own source declaration and likeness proof; the image tools gain Apple's person finder (numbered boxes, main blob per person, LaMa fill). Tests: `imageGen.test.ts`, `imageTools.test.ts` (including the real worker with `IMAGE_TOOLS_PYTHON`). Measured on the Studio in the Home design note `image-editing-2026-10-17.md`.

- [ ] **IMG-OPS-07: find and erase chosen subjects** (M). Add `find_subjects` and `erase_subjects` using Apple's foreground instance masks and Vision person/animal labels; `erase_subjects` fills selected instances with LaMa. Measure household animals and people on the Studio; wildlife labels remain unclaimed until measured.
- [x] **IMG-OPS-09: label `find_subjects` with Look detections** (S). Built 2026-11-04: reuses Look's untracked COCO-80 mode for instance-box IoU labels; default Look and its household robot vocabulary stay unchanged. If Look is unavailable, return object labels with a one-line status.
- [x] **IMG-OPS-10: use YOLOX-s for the all vocabulary** (S). Built 2026-11-04: household stays on YOLOX-nano; `vocabulary: "all"` uses YOLOX-s when installed and falls back to nano with a `find_subjects` status. Animal labels: YOLOX-s 11/12, nano 8/12, RT-DETR 12/12 (`docs/design/detector-2026-11-04.md`). YOLOX-s resident footprint remains unmeasured.

## Video generation (owner approved 2026-10-17)

- [x] **SWAP-01: the `swap` generic job, a composite of the original footage** (L). Built 2026-11-19 on branch, not landed: `backend/src/lib/makeDispatchSwap.ts` (door, shape pick, runner), `lib/swapChecks.ts` (segments, guide layout, checks, plain lines), `video/swap.ts` (the donor adapter a pack names), `video/compositeSwap.ts` and `composite_swap_worker.py` (caption erase and detect, reference crops, people and framing analysis, composite, post-encode check), the `composite-swap` environment registered like the other generator environments (built once from the hashed requirements file on a scratch data directory: uv, Python 3.12, numpy 2.2.6, OpenCV 4.11), the video pack's `swap` job and `recipes/swap.md`. Proved with fakes for the model and the tools plus a synthetic clip for the pixel checks. NOT proved: a full-length swap on real footage (needs the Mac Studio, the model files and the private regression clips); the portrait peaks (unmeasured, same pixel count as the measured landscape shapes); the face finder and the caption finder on real photos and clips (OpenCV cascades and a brightness heuristic); the thresholds for residual head frames (10 percent of a segment) and the encode tolerance (24 levels, 1 percent) on real footage.

- [x] **LTX25-MAX-01: the Max profile of the LTX-2.5 engine** (M). Built 2026-11-02; a real 1024x576, 10 s clip through the job API on a scratch Stack: 205 s, worker footprint 47.1 GB sampled (bench 48.6 GB), AAC audio, all four speech lines heard. Not built: a startup STT self-check (the worker refuses a request without the Gemma folder and checks the pipeline took it instead). Objective: a 1024x576, 10 s clip with sound on the dgrauet runtime 0.18.0 and the ungated bf16 pack, as `qualities.ltx25max` and `model` `ltx25-max`, for Home's Max video slot. Files: `backend/src/video/ltx25.ts`, `ltx25_worker.py`, `ltx25-max-gen.darwin-arm64.requirements.txt`, `videoGen.ts`, `lib/engineCatalog.ts`, `lib/modelCatalog.ts`, `routes/video.ts`, `routes/videoGenerations.ts`, `tests/videoLtx25Max.test.ts`. Acceptance: pins hashed, the Gemma folder always passed (regression test), a real 1024x576 10 s speech clip through the job API with AAC audio and the transcript matching, footprint under 64 GB.

- [x] **VIDEO-GEN-01: Stack `video-gen` engine, worker, pins, install** (M). Built 2026-10-17: `backend/src/video/` (service, worker `video_worker.py`, LoRA library, result store, reference-picture ledger), pinned FastWan MLX folder, umt5 tokenizer and mlx-video `87db56a` source, hashed requirements, `POST /stack/v1/engines/video-gen/install`, the `video` role state. Real runs on a scratch Stack: text to video 132 s wall for 121 frames at 832 x 480 (4.6 MB mp4, 54 KB poster), picture to video 132 s, one LoRA 168 s, worker idle RSS 2.3 GB, zero outbound requests at run time (offline worker).
- [x] **VIDEO-GEN-02: Stack `/v1/videos/generations` job API** (M). Built: phases, cancel, 202, governor admission of 44.1 GB through the generator queue, caps, `GET /stack/v1/video`. API in Home `docs/design/video-generation-2026-10-17.md`, "Stack API as built".
- [x] **VIDEO-GEN-03 (Stack half): LoRA library** (M). Built: import with hash, licence, base-model check from tensor shapes, classification, audience lock. Home half (who may use which, the settings page) open.
- [x] **VIDEO-LTX-01 (Stack half): Detailed video, LTX-2.3 with sound and speech** (L). Built 2026-10-17: `video/ltx_worker.py` (distilled two-stage LTX-2.3 on the pinned mlx-video, the text-encoder mask fix, LoRA merge at load, stages and first-frame preview, H.264 plus the model's AAC sound), `VIDEO_SPECS` (Quick 5 s and Detailed 10 s, per-model size, area, LoRA base and admission: 44.1 GB and 46 GB), `model` on `POST /v1/videos/generations`, `qualities` on `GET /stack/v1/video`, LoRA base detection from tensors (`wrong_base_model`), pins `ltx-2-3-distilled-mlx` (36 files, 47.1 GB) and `video-gemma-3-12b-text-encoder` (13 files, 26.4 GB), component `ltx-2-3-distilled-mlx` (optional, p128 only) with the licence accepted once (`licence_required`, `accepted_licence`, `data/licence-acceptances.json`), disk row `video-detailed`, `VIDEO_DETAILED_STAGES`, AAC copied untouched in the messaging copy. Tests: `videoDetailed.test.ts` (a REAL test through the job API runs where `LTX_REAL_MODEL_DIR` is named), `components.test.ts`, `videoMessages.test.ts`. Measurements and the licence reading: Home `docs/design/video-generation-2026-10-17.md` section 14. Picture to video on Detailed was closed the same day (VIDEO-LTX-02: the shipped encoder config disagrees with the shipped weights, the worker builds the encoder from the weights' shapes; measured end to end 2026-10-17, `ltx_worker.py` item 4). Open: speech reliability past 5 seconds (VIDEO-LTX-03).
- [x] **VIDEO-LTX-03 (Stack half): Detailed video is in the Recommended plan on p128** (S). Owner ruling 2026-10-17: the disk-plan row `video-detailed` is `recommended` (checked by default, can be unchecked); the p128 recommended `required_free_bytes` goes from 63.2 GB to 153.5 GB (73.6 GB of weights plus the video engine, with the 20 percent margin). The first-run install plan (`plannedPinsFor`) and so every upgrade still exclude it, and the licence gate on `POST /stack/v1/components/{id}/install` is unchanged. Teens and children stay Quick-only. Tests in `diskPlan.test.ts` and `components.test.ts`. Home mirrors `docs/disk-plan.json`. Reversed 2026-10-25 by AIMODELS-DATA-01: `video-detailed` is now `optional` (unchecked by default), the `video` row is `recommended` and in the p128 default selection, and `pictures` is `required` on p64 and p128 (installed on the first run); the p128 recommended `required_free_bytes` is now 148.3 GB.
- [x] **VF-CHECK-01 (Stack half, first slice): `media.verify`, the finished-file checker** (M). Built 2026-11-20: `backend/src/media/verify.ts`, job kind `media.verify` on the media lane, documented in `docs/integrations.md`. Checks the finished file against a shot list: black and frozen pictures (Home's `CLIP_RULES` numbers, held-still exemption), silence, per-shot loudness and a far-quieter flag, copied sound between shots, each spoken line heard once in its own shot through the `stt` role, and the file's shape. Tested on fixtures broken on purpose (`verify.test.ts`); the speech check is tested with a stubbed listener, a live run needs the `stt` models installed. Open: the shot-list and dialogue request fields wait for the VF-ROLES-01 commons tag; Home's film exporter does not call it yet.
- [ ] **VF-ROUGHCUT-01 (Stack half): `media.rough_cut`** (M). Built 2026-11-20: `backend/src/media/roughCut.ts`, job kind `media.rough_cut`, documented in `docs/integrations.md`. Request and result per commons spec `stack-rough-cut-request` and `stack-rough-cut-result` (mirrored locally until the spec pin passes the tag). Open: the spec pin, the real six-shot three-line run, Home's silent-animatic move (FILM-ANIMATIC-01), Home's voiced use (VF-STORYBOARD-01).
- [ ] **VF-ENHANCE-01 (Stack half, door only)**: `POST /v1/videos/enhance` (`backend/src/routes/videoEnhance.ts`, `video/enhance.ts`). Checks the clip (422 plain line), then refuses `not_installed` (409, the `StackMakeRefusal` shape of spec-v0.1.431, declared locally until the spec pin moves past 0.1.426) because no Refine Details adapter is a pinned, installed part (rule 11). Runs nothing. Open: pin and test the adapter (the film session's Refine Details test), set `ENHANCE_ADAPTER_PART`, wire the run, recipe `operations` and `memory_floor_bytes` from spec-v0.1.430.
- [ ] **VIDEO-GEN-12 (Stack gate half built)**: uploaded pictures and photos of people are refused as references for everyone; only pictures this Stack generated pass. The post-render check and the "no identifiable real person" check are still open.
- [x] **LIKENESS-01 (Stack half): signed likeness proofs** (M). Built 2026-10-17, then retired 2026-11-02 by MODELS-CENSOR-05 (a62b58a): `lib/likeness.ts`, the trust-key route, the `consent_proof` checks on video and picture sources and the `style_import` and `style_use` proofs are removed, and `tests/likeness.test.ts` with them. What stays: `likeness_subject` on both LoRA libraries, now set from the file's own description and used only to class a style adult-only, so children and teens never get it; an adult is never refused, and no proof is asked for. Tests: `tests/adultMediaNotRefused.test.ts`. Open: a post-render check of the output (VIDEO-GEN-12 stays a named gap).
- [x] **IMGGEN-STACK-01: Stack picture engine (mflux worker, pinned weights, install, role state)** (M). Built 2026-10-17: `backend/src/images/` (service, worker `mflux_worker.py`, models table, install job, result store), FLUX.2 Klein 4B (Apache-2.0, 16 files, revision e7b7dc27) and Z-Image-Turbo (Apache-2.0, 17 files, revision f332072a) pinned per file with sha256 and bytes, mflux 0.23.0 in a hashed `image-gen` environment, `POST /stack/v1/image/install`, `GET /stack/v1/image`, the `image` role state. Real run on a scratch Stack (M5 Max, p128): 1024 x 1024 Klein 8-bit 4.2 s warm wall (4.07 to 4.19 s in the worker, 7.2 s with the model load, 10.5 s from a stopped worker), 13.5 GB peak, zero outbound requests at run time (offline worker). Z-Image-Turbo is pinned and wired but not downloaded on this run (33 GB, over the approved budget): its first real run is open (IMGGEN-BENCH-01). SDXL-Lightning on sd.cpp (the p16 and p32 floor) is not built: p16 answers `off`, p32 runs Klein at 4-bit (not yet measured on a 32 GB Mac).
- [x] **IMGGEN-STACK-02: `/v1/images/generations` job API** (M). Built: size, `n` 1 to 4, seed, steps, `loras`, `audience`, image to image, phases and progress, cancel between steps (kill after 10 s), 202 past the deadline, PNG and thumbnail result store (a day, newest 48), generator queue and governor admission (15 GB Klein, 34 GB Z-Image) serialised with video. The stepwise `preview` frame was built later (GENPREVIEW-01). API in Home `docs/design/image-engine-2026-10-17.md`, "Stack API as built".
- [x] **GENPREVIEW-01: stages, ETA and live previews for picture and video jobs** (M). Built 2026-10-17. Job status adds `progress_fraction`, `stage`, `stage_label`, `step`, `steps`, `eta_seconds`, `preview_url` (and `preview_step` for pictures); `preview` request flag (default on); `GET .../{job}/preview.jpg`; per-step 256 px picture previews from the straight-line x0 estimate with pooled latents (+3 percent worker time); the clip's first-frame preview at the start of the frame-building stage; stage weights and an ETA from the median of the last seven runs per size (`data/gen-history.json`, numbers only). Contract: `docs/integrations.md`; measurements in Home `docs/design/image-engine-2026-10-17.md` and `video-generation-2026-10-17.md`. Tests: `tests/imageGen.test.ts`, `tests/videoGen.test.ts`.
- [x] **IMGGEN-EDIT-01: generative edits** (M). Built: `edit` and `edit_masked` on `POST /v1/images/edits` (Klein reference edit at bf16, mask and region crop with context, feathered compositing). Real run: mask removal of a plant 5.1 s, a whole-picture recolour 8.0 s, a region edit 1.8 s; 0 differing pixels outside the mask and its feather ring.
- [x] **IMGGEN-DEFAULT-01: Klein is the default picture model on every tier; Z-Image-Turbo is the advanced choice** (S). Owner ruling 2026-10-17 (reverses the same day's p128 default): plain picture requests stay fast (Klein, about 4 s); Z-Image-Turbo (13 to 30 s, the most community LoRAs) is optional in the disk plan (unchecked, Recommended plan about 89 GB), selected by name or automatically by a LoRA made for it. LoRA base detection reads Civitai-style files (kohya `lora_unet_layers_N` Z-Image names, a header that declares its base) and names Pony, Illustrious, NoobAI, FLUX.1 and Chroma files in the refusal. Design note: Home `docs/design/image-engine-2026-10-17.md` section 16.
- [ ] **IMGGEN-ZIT-P64: measure Z-Image-Turbo at 4-bit and 8-bit for a 64 GB computer** (S, bench; on the GPU lock). Objective: peak MLX memory, load time and warm 1024 px seconds for `quantize=4` and `8` on the real weights through the worker, with the chat model resident; the 8-bit peak is 30.1 GB (34 GB admitted) and most of it may be the bf16 load, so the number to find is the steady and the load peak separately. Done when `ZImage` tiers gain `p64` or the note records why not.
- [ ] **IMGGEN-SDXL-01: the anime and illustration picture model (Illustrious XL, with Pony and NoobAI LoRAs)** (L). Objective: the SDXL family has the largest Civitai LoRA library by a wide margin and no Stack engine yet (sd.cpp `sd-server`, `--lora-apply-mode at_runtime`, 8 to 10 s with a 4-step Lightning or DMD2 LoRA, measured in the design note section 3.3). Needs the owner to accept the Illustrious licence (Fair AI Public License 1.0-SD, share-alike on derivative models) and the SDXL OpenRAIL++ terms; installable in Models and storage as an optional row, never the default. Until then `detectImageBase` refuses these files with a sentence that names the family.
- [x] **IMGGEN-LORA-01: LoRA library and application** (M). Built: `lib/media/loraLibrary.ts` (generic) and `images/loras.ts`; add by file, path or Hugging Face link (install job, hash on arrival, licence and tags from the Hub), base read from tensors, audience lock, likeness and minor refusals, unbaked application per request. Real run: the Apache-2.0 pixel-art LoRA changes the picture (mean pixel difference 27 of 255 at scale 1, 16 at 0.5), a repeat without it is bit-identical, +0.3 s a picture warm and about +1 s when the LoRA set changes. Open: the video library (`video/loras.ts`) can move onto the generic one; CivitAI links (anonymous listing refused).
- [x] **ROBUST-01: engines that stop on their own restart themselves** (M). Incident 2026-10-17: chat and embed died at 14:48Z and stayed down about 1.5 hours, because the supervisor only raised `engine.crashed.<role>` and an engine starts on a request while Home pauses chat when the role is offline, so no request ever came. Built: `lib/selfHeal.ts` restarts a resident engine (chat, embed, judge, router, stt, tts; the picture and vision engines only when they were mid-request) after 2 s, 10 s, 30 s, 2 min (5 min step kept in the ladder), stops after 5 failures in 30 minutes and leaves the Repairs item (`The <role> engine keeps stopping`) with its Restart engine fix and the last 20 log lines, forgets failures after 10 healthy minutes and on a hand restart; waits (15 s rechecks, not counted as failures) while an install or stage job, an engine update (`holdSelfHeal`), a picture or video job on the graphics processor, a pause, or low memory (the memory watchdog's level) is in force; one restart at a time; a restart counts only after the identity check and a one-token request pass (otherwise the process is stopped and the failure counted). `lib/crashClassifier.ts` names the cause (out of memory, killed by the system, missing file, port in use, bad config, unknown) with the fix in plain words; `engine.exit` is logged with exit code, signal and the last stderr lines. A sweep every 20 s (first look 5 s after start) kicks any role that is offline with no process and nobody retrying it. `GET /stack/v1/engines/self-heal`: crashes per day, events with stable ids (Home notifies once), stopped and healing roles. Setting `stack.runtime.self_heal` (default on). The LaunchAgent (`KeepAlive` on a non-zero exit, 30 s throttle) already covers the Stack process dying. Tests: `backend/tests/selfHeal.test.ts` (manual clock, scripted engines, no launchctl, no ports). Home half: ROBUST-01 in the Home backlog. Unverified: a real oMLX or llama-server crash end to end on the Studio. <!-- prose-lint: allow -->
- [x] **MAKE-CLEARER-2026-11-13: `restore` (SeedVR2 3B) for pictures** (M). Built 2026-11-13: operation `restore` on `POST /v1/images/edits` through the existing mflux worker in low-RAM mode (`images/restore.ts`, worker op `restore`), two pinned weight files (`numz/SeedVR2_comfyUI` @ 09ced71, sha256 recomputed), optional component `seedvr2-3b` and disk-plan row `pictures-clearer` (p64 and up), `restore` listed in the image-tools `operations` when installed. Real run on the Studio: 5.7 s then 3.0 s at 512 px (9.84 GB peak footprint) and 24 s at 2 megapixels (10.05 GB). Not built: clips (per-frame flicker, temporal path unbenched). Tests in `tests/imageGen.test.ts`.

- [x] **IMGGEN-KLEIN3-01: optional FLUX 3 Image Klein picture family.** Added its revision-pinned mflux family, licence acceptance notice, optional disk and tier candidates, fixed 16-step text-to-picture generation, explicit no-edit/no-reference/no-LoRA capability, component and API declarations. The local word bench scored 18 to 19 of 20. The 34 GB peak and 16 to 25 second timing are diffusers measurements; mflux peak remains unmeasured. H3 remains the picture recommendation.

- [ ] **PLACE-SHEET-01 (Stack half): multi-angle reference sheets for a place and a prop** (L). Designed 2026-11-20 in `docs/dev/place-sheet-01.md`, not built. Rows: 01a spec (kind `place`, `compose`, `composed`, pack `sheet_angles`), 01b angles as pack data, 01c one shared `composeSheet` (also the Ingredients compositor the reference clip lacks), 01d reference clip object and place route, 01e Home half. No model runs needed to land.
- [ ] ADMIN-02 (M) resource history ring and `/stack/v1/resources/*` for the admin page: built (GPU and tokens per second still null; Stack CPU counts the Stack process only), admin screen not built (docs/plans/admin-and-standalone-2026-11-21.md)
- [ ] ADMIN-01 (M) admin account, sessions, CSRF rule, local reset and the opt-in Tailscale listener: built and tested, admin page not built (docs/plans/admin-and-standalone-2026-11-21.md)
- [ ] ADMIN-03 (S) service restart, engine restart (audited), host reboot (off by default, setting `stack.admin.allow_reboot`) and redacted logs routes: built and tested, admin page not built (docs/plans/admin-and-standalone-2026-11-21.md, step 3)
- [ ] ADMIN-04 (S) role enable/disable and role priority as declared settings (`stack.roles.<role>.enabled`, `.priority`): a turned-off role is not launched or admitted and says why on `GET /stack/v1/roles`; priority orders the governor queue; changes audited; built and tested, admin page not built (docs/plans/admin-and-standalone-2026-11-21.md, step 4)
- [ ] ADMIN-05 (M) profile planner (`lib/profilePlanner.ts`) with `POST /stack/v1/profiles/recommend` and `/apply`: Matched (within 25 percent above a tier floor), Custom recommended (deterministic, golden plans at 16, 24, 32, 48, 64, 96 and 128 GB) and the Custom fit check; apply writes the ADMIN-04 role settings, audited, and starts missing pinned installs. Built and tested; not built: measured peaks from this machine feed the planner (it uses the pinned estimates), judge and router bindings are the tier's own, the admin page and the Home change (docs/plans/admin-and-standalone-2026-11-21.md, step 4b)
- [x] CHOICES-API-01 (M) the Stack holds all model choices (2026-11-21, owner decision): `GET /stack/v1/choices` (one read for the shared AI and models page, with plain label, summary, version, quantization, licence, repo, min profile and `search_text` per candidate), `PUT /choices/{category}/{tier}` (per level and per hardware profile), `PUT /choices/{category}/order`, `POST /choices/recommended`, `GET /choices/unused` and `POST /choices/unused/remove`, `POST /choices/add-model`, `POST /choices/migrate`; stores in `meta` (`choices.picks`, `choices.added`, `choices.migration`) beside `parts.choices`; tests in `tests/choices.test.ts`; see [dev/choices.md](dev/choices.md). Not built: the admin page and Home views over it, the shared UI, spec shapes. The resolver reads the stored pick: see CHOICES-RESOLVE-01
- [x] CHOICES-RESOLVE-01 (M) a stored model choice is the model that runs (2026-11-21): `lib/choiceResolver.ts` is the one precedence (session load, stored pick, the legacy chat and voice settings mirrored into the pick, the category order, the recommended model; switched-off models never run), read by `selectedModel`, the Reduced swap, `codingModeHeavy`, the voice engine choice and the picture and video routes; a pick that is not installed or does not fit leaves the previous model serving and says why; picks swap a running engine without a Stack restart; `GET /roles` carries `choice` and the choices read carries `running` per level, from `lib/choiceRuntime.ts`, so the two agree; tests in `tests/choiceResolver.test.ts` and `tests/flashNextMode.test.ts`; see [dev/choices.md](dev/choices.md). Not built: pick `options` are recorded and not applied, Reduced voice is not run by the Stack, the Boost chat model runs through the coding role only
- [ ] ADMIN-06 (M) admin page shell (`admin-ui/`, Vite, React 19, `@maipai/ui` kit, built to `admin-ui/dist`, served at `/admin` by the Stack, also beside the compiled binary as `admin-ui/`): sign-in and first-run setup, top bar with live status, `⌘K`, Overview, Health, Engines, light and dark, phone width, live through the SSE feed. Built and tested; Features, Models and priority, Settings, Updates, Tools and Helper screens not built. Gaps in the API the page works around: no read that says whether an admin account exists (the page tries sign-in and switches to setup on `no_admin`), version and uptime come from `/healthz` (not in `/stack/v1/status`)
- [ ] ADMIN-07 (S) admin page Resources screen (`admin-ui/src/Resources.tsx`, helpers in `resourceData.ts`): memory budget bar split by engine with a plain-words pressure badge, CPU, swap, waiting-request and disk tiles, live charts at 1 hour, 24 hours and 7 days (memory by engine, CPU, tokens per second, swap, queue), per-engine memory now, peak and average; refreshes every 5 s; light, dark, 375 px. Reads only `GET /stack/v1/resources/{summary,history}`. Built and tested (`tests/adminResources.test.ts`); not built, because the routes lack the fields: GPU and tokens per second are null on this machine, no per-engine request counts, last answer time or load and unload times, no admission decisions in sentences, no disk by item or prune route. The kit has five chart colors, so beyond five series the bands share neutral tokens (legend names each)
- [ ] ADMIN-08 (M) admin page Features, Models and priority, Settings, Updates and Tools screens (`admin-ui/src/{Features,Models,SettingsScreen,Updates,Tools}.tsx`, pure helpers in `manage.ts`, confirm dialogs in `shared.tsx`): feature switches (ADMIN-04 settings), setup picker (matched, custom recommended, own choices) with the plain-words fit table from `profiles/recommend` and `profiles/apply`, priority order with up and down, pinned catalog models per feature with download and remove, generic settings renderer with save and apply, updates with check, apply and go back, tools with the readiness check, diagnostics zip, restart the Stack and restart the computer (only when `stack.admin.allow_reboot` is on). Every write asks first and shows the API's own sentence on failure. Built and tested (`tests/adminManage.test.ts`; exercised against a scratch Stack on desktop and 375 px, light and dark). Gaps in the API the page works around or lacks: no read of retained previous engine builds (Go back only offers the `previous` tag an update on this page answered with, kept in the browser), no download progress (the page polls the model list every 3 s), `profiles/recommend` returns `matched: null` when no tier is within 25 percent of the memory (the page handles it; the schema should say so), no route to read the reboot switch except `GET /stack/v1/settings`, the Helper screen is ADMIN-09 Update 2026-11-21 (STACK-MODELS-PAGE-02): the Features, Models and priority screens were replaced by one "AI and models" screen, the shared `StackModelsPage` (`admin-ui/src/{ModelsScreen,ProfilePlanner,stackClient}.tsx`); `Features.tsx` and `Models.tsx` no longer exist.
- [ ] ADMIN-10 (M) standalone install and update with no Home: `scripts/release-stack.sh vX.Y.Z` builds the binary folder and writes `release/maipai-stack-<tag>-<platform>-<arch>.tar.gz`, `SHA256SUMS` and a copy of `install.sh` (it tags and publishes nothing); `scripts/install.sh install|update|rollback|status|uninstall` downloads those two files from one pinned release URL, verifies the checksum before unpacking (optional `--sha256`), keeps each build in `<prefix>/releases/<tag>`, points `current` and `previous` at them, runs the binary's own `install-service` (launchd on macOS, systemd --user on Linux), prints the `/admin/` URL and the setup-code file, swaps and restarts on update, goes back to the old build by itself when the new one does not answer `/healthz`, and keeps data in `<prefix>/data` through every swap. Built and tested (`tests/standaloneInstall.test.ts`, fake build, file:// release folder); run for real on macOS in a scratch prefix and port (install, `/admin/` 200, update, rollback, bad tag, tampered checksum, uninstall). Not done: the Linux systemd path is untried on a Linux machine, nothing is published (the owner decides the first release tag), `PINNED_TAG` in `install.sh` is empty until then, no Stack-side `stack update` command (the engine pin-and-rollback code swaps engines, not the Stack's own binary, so it is not reused), and the checksum list comes from the same host as the tarball (use `--sha256` for an independent check)
- [x] STACK-START-01 (S) the Stack listens before it restores Home mode (2026-11-21): the daemon used to await the restore of a persisted "coding" mode (a ~73 GB load, about 4.4 minutes) before `Bun.serve`, so `/healthz` was silent for minutes, Home's installer (20 s wait) failed and rolled the update back twice. `setupHomeModeRuntime` now configures the mode runtime and returns; the restore runs in the background (`homeModeRestore()`), reports through `GET /stack/v1/coding/mode` (`state: "switching"`, `target: "coding"`), answers chat, judge, router and coding requests with the usual "Home is changing modes" 503, and falls back to Normal on failure as before. Test: `tests/flashNextMode.test.ts`. Proved on a scratch data dir with a 45 s fake load: `/healthz` 200 in under 3 ms while the mode view said switching.
- [x] ADMIN-11 (M) public README, user docs (`docs/user/`, grade 6: install, sign in, admin page tour, features and models, Helper, update and go back, privacy, fix a problem), developer docs (`docs/dev/{admin-api,helper,installer}.md`) and the screenshots: `scripts/make-admin-screenshots.sh` starts a scratch Stack (own data folder, free port), makes the admin account through the real setup route, and drives headless Chrome over the DevTools protocol for all 11 screens at 1280 and 375 px, light and dark (44 WebP files, 2.3 MB, `docs/images/admin/`), with made-up demo data swapped in at the browser only (`scripts/admin-screenshots/fixtures.ts`). All 44 were opened and judged on desktop and phone. Two UI defects fixed with them: `ago` now reads "3 hours ago" (`tests/adminFormat.test.ts`), and a Health card's fix button no longer squeezes the text on a phone. Not done: no release is published (the docs say how one is made), the Linux path and Windows are untried, and a docs site for the Stack is not built.
- [x] ADMIN-09 (M) the Helper, the admin page's chat assistant with its own model (`backend/src/lib/{helper,helperTools}.ts`, `routes/helper.ts`, `admin-ui/src/Helper.tsx`, bench in `docs/helper-bench.md`): a `helper` role (jit, llama-server, its own process, not on `/v1`, not reachable by Home) on the pinned Qwen3-4B Q4_K_M (the judge's file, one copy on disk), chosen by a 16-question tool-calling bench (15 of 16, about 100 tokens/s, 3.9 GB resident; Qwen3-VL-4B tied and lost on size). Loads on the first message (about 4 s), unloads after `stack.engines.helper.keep_warm_minutes` idle (default 5, never below 1) through the governor's `jit` idle limit. Routes (admin session only, Home's token gets 403 `admin_only`): `GET /stack/v1/helper/status`, `GET` and `DELETE /history`, `POST /chat`, `POST /approvals/{id}/approve` and `/deny`. Read tools (health, roles, memory, hardware, updates, settings, logs) run at once; every write (role on or off, a setting, restart an engine or the Stack, check, apply or roll back an update) is parked and runs only on Approve, through the same in-process routes, logged as `admin.action.helper.approved` (source helper, approved by admin). It cannot reboot, edit files, run commands, change `stack.admin.*` or secret settings, or reach the network; the wording of an ask is fixed by the Stack, not the model. History is one `meta` row with a clear button. Built and tested (`tests/helper.test.ts`, `tests/adminHelper.test.ts`; real model load, a real chat, a real approval and an idle unload exercised against a scratch Stack; desktop and 375 px, light and dark). Not done: `@role` pointing, a context meter, a streamed reply, the standalone installer's optional Helper step, and a bench of answer quality beyond tool choice.
- [x] STACK-LORAS-01 slices 0 to 2 (L, 2026-11-26): the Stack owns LoRAs (Home's design note `docs/plans/stack-owns-loras-2026-11-25.md`). Built: spec `Lora` `disk_id` and `status` (spec-v0.1.486); one store `data/loras/manifest.json` (`lib/media/loraStore.ts`, merges the two old manifests by id, idempotent); `lib/media/loraCatalog.ts` (trash 30 days, restore, import of Home's records and previews, the adult-only fence) and `loraSources.ts` (encrypted site keys, Hugging Face and Civitai search, install onto a drive behind the one global licence accept, `lora.move` job); `routes/loras.ts` (`/stack/v1/loras`); `drive_missing` status; a drive holding a style cannot be removed; privacy row `lora-browse`. Open: slice 3 (kit page `StackLorasPage`, admin-ui), an `installing` row while a download runs (the job shows it today), a `StackConnection` kind for the site keys (they sit in `lora-source-keys.json` for now), and slices 4 to 6 in Home.
- [x] STACK-LORAS-01 nsfw tag (S, 2026-11-26, owner decision): the Stack does not know users. `classification` (adult-only means nsfw) comes from the download site's own check at install (Civitai flag and level, Hugging Face `not-for-all-audiences`; a missing flag or failed check leaves it untagged with no origin, per rule C11) with `classification_origin` `site`, or from an admin PATCH (origin `admin`), no ticket. The Home ticket verifier, `STACK_HOME_CALLBACK_URL` and the loopback callback were removed; the request fence stays. Home applies its own rules and lowers through this PATCH with its token.

## LocalAI review port (owner, 2026-11-27)

Plan: Home's [localai-port-plan-2026-11-27.md](https://github.com/getmaipai/home/blob/main/docs/plans/localai-port-plan-2026-11-27.md). A code review of LocalAI (MIT, commit 08f74d1, read only, nothing run) found these Stack-side steps. LocalAI code is a reference only and nothing is copied. Every new model or engine needs its licence checked as AGPL-compatible and not non-commercial before it is pinned, and every install stays pinned and checksummed.

- [ ] **STACK-RERANK-FILL-01 (S): the rerank role has a model and an endpoint.** Found 2026-11-27: `roles.ts` declares `rerank` (resident, reserved, 1.2 GB in the sizer) with `endpoints: []` and no pinned model, so nothing answers it. Objective: pin a bge-reranker GGUF (licence checked), run it through llama-server `--reranking`, add the `/v1/rerank` endpoint, and let Home's search call it. Acceptance: a request with a query and ten passages returns scores in order; the role shows in Resources with its measured memory. Out of scope: choosing a different retrieval design. Reuse check: llama-server's native rerank first (the engine feature is the implementation). Exit: a named test plus `scripts/check.sh --pre`. Status: role, pin and `/v1/rerank` endpoint are wired 2026-11-27; route test uses a scripted engine. Pin: `bge-reranker-v2-m3-q4-k-m` (gpustack/bge-reranker-v2-m3-GGUF @ 3093af03, Q4_K_M, 438 MB, Apache-2.0 on the weights and the conversion; llama-server b12589 has native `--reranking`). Test: `backend/tests/rerank.test.ts`. Home calling it for search is Home's row. Landed 6f799a7b; left open because native `--reranking` on b12589 and measured memory on an installed re-ranker have not been verified.

- [x] **STACK-UPDATE-SAFE-01 (M): a model update loads the new file, and rolls back if it does not.** Objective: after a model update downloads, unload the old one, load the new one, and keep the old files until the load check passes; any failure restores the old model; a journal finishes or undoes a step that was interrupted by a crash. Files: `backend/src/updates/models.ts`, `backend/src/lib/download.ts`. Acceptance: kill the Stack mid-update in a test and it boots on the old model; a corrupt new file is refused with the old one still running. Out of scope: engine updates (`prove-pin-rollback.sh` covers them). Reuse check: the existing manual `rollbackModel` and engine rollback first; LocalAI's journaled upgrade (`core/services/modelupdates/upgrade.go`) is the reference. Exit: a named test. Status: built (journal in meta, load check, boot recovery; test modelUpdateSafe.test.ts). Landed on GitHub main: af39a888.

- [x] **STACK-FIT-UI-01 (S to M): the admin page shows fit in plain words on measured peaks.** Objective: each model row in `ProfilePlanner.tsx` shows the memory it needs at the chosen context and the headroom in words ("3.7 GB free", "0.9 GB over"), with a bar that draws over-budget past the limit, using the governor's measured peaks and never total RAM. Complements `ADMIN-07` and the `STACK-SIZE-*` rows. Acceptance: the same numbers as `POST /stack/v1/fit-plan`; a screenshot opened. Out of scope: Home, where users never see resource words. Reuse check: the shipped kit `StackModelsPage` and `fit-plan` route; LocalAI's `FitCell.jsx` is the reference. Exit: a named test and a preview. Status: built 2026-11-27. Each plan row with a known peak, including unavailable rows with a refusal reason, shows need and headroom; rows without a peak remain blank. A row shows "Needs 5.3 GB, 73.9 GB free" (or "0.9 GB over", in red) with a bar of the AI memory limit that runs past the limit marker when the row does not fit, labelled measured or estimated. Numbers are the plan's own peaks (`lib/profilePlanner.ts`, the governor's recorded footprints first), never total RAM; `fit-plan` is for a model not yet downloaded and has no plan row to draw. Screenshot: `SHOTS_ONLY=models-fit` (opened on desktop and phone width, light and dark; this 128 GB computer has no over-budget row, the over case is pinned in the test). Test: `backend/tests/fitCell.test.ts`. Landed on GitHub main: f665c5f7.

- [ ] **STACK-VARIANT-FIT-01 (M): fit-aware choice among a model's variants, and a Hugging Face importer that understands shards.** Objective: a pure selector that filters variants by "this engine runs here" and "known size fits the governor's room", ranks proven fit, then engine preference, then size; the importer groups shards, pairs a projector file and reads the quant from the file name. Extends `STACK-SIZE-01` and `STACK-SIZE-09`. Acceptance: tests with a small, medium and large machine pick the expected variant; an unknown size is shown as unknown, never as fits. Out of scope: Home choosing models (the Stack owns them). Reuse check: `lib/fitPlan.ts` and the pinned `gguf-parser`; LocalAI's `resolve_variant.go` and `variant_quantization.go` are the reference, and its total-RAM budget is not copied. Exit: named tests. Status: partially wired 2026-11-27: HF resolution groups shards and returns variant metadata; model inspection uses `variantSelect.ts` to recommend or refuse a multi-file model. Automatic fit-aware selection for import, planner, download and engine launch is still absent. Projector pairing is metadata only and does not install a paired component. The row remains open.

- [x] **STACK-SWAP-SWEEP-01 (S): a boot sweep for an interrupted engine swap.** Objective: at start, find a half-finished swap (staged build, `failed-swap` marker, partial files) and finish or undo it. First confirm what boot repair exists today. Acceptance: crash a swap in a test and the next boot is clean. Reuse check: the existing swap and `current` relink logic. Exit: a named test. Status: built (swap journal, sweepEngineSwaps at boot; tests in engineSwap.test.ts). Boot repair before this: only migrateLegacyEngineTags. Landed on GitHub main: 88845012.

- [x] **STACK-CTX-400-01 (S): a context overflow answers 400, not 5xx.** Objective: when a request is longer than the context, the `/v1` routes return a 400 with a plain message that names the limit. First confirm the current status code. Acceptance: a test with an oversize prompt. Reuse check: LocalAI's `backend_errors.go` is the reference. Exit: a named test. Status: built 2026-11-27. llama-server already answers 400 (`exceed_context_size_error`, with `n_prompt_tokens` and `n_ctx`) and the route passed it through unchanged and without a plain message; MLX and Splash word it their own ways, some under a 5xx. `lib/contextOverflow.ts` now turns any of them, streamed or not, into a 400 of type `context_length_exceeded` that names the tokens sent and the limit. Test: `backend/tests/contextOverflow.test.ts`. Chat wire only; the coding role's Anthropic and Responses wires keep their own error shapes. Landed on GitHub main: 429b492c.

- [x] **STACK-STALL-WATCHDOG-01 (S): restart an engine that has stopped making progress.** Objective: an engine that is busy but has produced no tokens or steps for N seconds (set per role) is restarted and the request fails with a plain message; wall-clock age alone never kills a long image or video job. Files: `lib/memoryWatchdog.ts`, the engine supervisor. Acceptance: a stuck fake engine is restarted in a test; a slow but progressing job is left alone. Reuse check: the existing runaway watch first; LocalAI's wall-clock busy watchdog is the thing not to copy. Exit: a named test. Status: built 2026-11-27. `lib/stallWatch.ts` (pure rule, per-role limits in seconds: chat 300, coding 600, judge/router/vision 300, embed/rerank 120, stt 300) and the supervisor's check every 5 s: a streamed chat-wire request is watched by its tokens, an embedding or re-rank by its answer; a process whose every watched request is silent past the limit is restarted (`engine-stalled`) and the waiting request fails with "The X engine stopped answering for N seconds and was restarted". Not watched, on purpose: unstreamed chat completions, speech, sessions and generator jobs (no progress signal the Stack can see), so no long job is killed by age. A job-step stall is a later row. Test: `backend/tests/stallWatch.test.ts`. Reuse: the governor runaway watch is memory-only and restarts only when idle, so it could not be extended to silence; it and this watch share `restartRole`. Landed on GitHub main: d070c602, 50c86dfc.

- [x] **STACK-ENGINE-LOG-01 (S): a live, redacted per-engine log buffer.** Objective: a ring buffer of each engine's recent output with subscribe, shown on the admin page, admin only, with secrets and prompt text redacted. Reuse check: today's `stack.log` tail and crash stderr tails first; LocalAI's `backend_log_store.go` is the reference. Acceptance: a test that a prompt string never appears in the buffer. Exit: a named test. Status: built (lib/engineLogs.ts ring + redaction, /stack/v1/engine-logs admin-session routes, Engines screen panel; test engineLogs.test.ts). Landed on GitHub main: 894053b4.

- [ ] **STACK-SPEC-NGRAM-01 (S): n-gram speculative decoding where the pinned llama.cpp supports it.** Objective: pass `--spec-type ngram-*` and the lookup cache for chat when it speeds up repetitive output, measured on the Studio. First check the pinned build has the flag. Acceptance: measured tokens per second before and after, written down; off if it does not help. Reuse check: the existing draft-model and DFlash settings. Exit: the measurement. Status: setting and llama-server argument wiring are present; off by default (`stack.engines.llama_server.speculative_ngram`: off, simple, mod). Pinned build b12589 supports `--spec-type ngram-simple|ngram-map-k|ngram-mod|ngram-cache` and `--lookup-cache-static|dynamic` (checked with `llama-server --help`). Measured 2026-11-27 on the Studio through `job.sh run`, Qwen3-4B Q4_K_M, temperature 0, 300 tokens, 3 rounds of 4 prompts, machine busy (load 10 to 17), so numbers are noisy: two quiet baselines gave JSON copy 133, code edit 136-138, story 137-141, explanation 139-140 tokens/s. ngram-simple: JSON copy 201 (about 1.5x), code edit 166 (1.2x), open prompts 97 and 124 with zero drafts made (so no extra work, the dip is load noise: a baseline run beside it gave 79 and 81). ngram-mod: JSON copy 180 (1.35x), code edit 155 (1.14x), story 129 (0.93x, 64 tokens drafted), explanation 195 (1.4x). ngram-map-k was slower on code (98) and is not offered. Not measured: the default 35B-A3B hybrid chat model (a recurrent model may not support draft rollback) and the lookup cache files; left off, so a person must choose it. Re-measure on a quiet machine and on the default chat model before turning it on by default. Left open: repeat on a quiet machine and measure on the default chat model before considering a default change.

- [ ] **STACK-SOUND-TAG-01 (S): sound-event tagging for the robot and hub microphone.** Objective: tag alarms, glass, crying and similar sounds using sherpa-onnx's CED support (confirm it is in our bundle; licence Apache-2.0 for the model). Acceptance: a fixture clip is tagged correctly; nothing is stored. Out of scope: any alert policy (Home owns it). Reuse check: the bundled sherpa-onnx first, not LocalAI's wrapper. Exit: a named test. Status: implementation built 2026-11-28, off by default (the model installs only on request; no profile pins it); acceptance incomplete. The committed test uses a fake tagger for the HTTP route; no alarm or glass fixture has been measured. Model: zipformer-small, Apache-2.0 per its model card, archive 111,034,072 bytes, SHA-256 `07e2fafcdcbc461f2816188d9b0bbafced12584030cf67d5652e549ef256a2c6` (matches the release's `checksum.txt`; the download was hashed here). Run on the model's own test clips with the real addon: a cat clip tagged Meow 0.82, a pig clip Oink 0.85, a dog clip Bark 0.56, 50 to 75 ms per clip of 6 to 12 s, whole test process 253 MB resident (not a pinned footprint; none is recorded). Route `POST /v1/audio/tags` (raw PCM16 mono), nothing stored. Tests: `backend/tests/soundTagging.test.ts`. Left: an alert policy (Home), a recorded-clip bench for alarms and glass (the stock test clips are animals), a measured footprint.
- [ ] **SCENE-02b (S): Stack half of sound events.** `POST /v1/audio/events` now classifies at most four seconds of mono PCM16 through the existing optional `sound-tagging` component and returns only the closed list of 12 events; the privacy row says audio and results are kept only in request memory. Status: route built 2026-11-28; thresholds remain provisional at 0.5 until `SCENE-SOUND-BENCH-01`; 12 fixture clips are not done and the bench has not run. Do not tick complete until Home's bench and fixtures are complete.
  - 1. Runtime: `sherpa-onnx-node` 1.13.8 and `sherpa-onnx-darwin-arm64` 1.13.8 are pinned in `backend/package.json:32-33`; `backend/src/speech/sherpa.ts:1-5,12` loads that native binding in the spawned speech worker, `backend/src/speech/worker.ts:1-12,29-40` serves STT, and `backend/src/lib/supervisor.ts:1508-1512` launches it. `scripts/install.sh:19-23,26` keeps models under `~/.maipai-stack/data`; the worker build and model are separate. Local package exists at `node_modules/.bun/sherpa-onnx-node@1.13.8`; no installed CED model was found under `data/` or `backend/data/`.
  - 2. Verified: installed Node package `audio-tagg.js:13-39` exports `AudioTagging`, accepts CED config and computes events; its package version and Apache-2.0 package license are in its `package.json`. `backend/src/speech/sherpa.ts` types currently omit the tagger. Sherpa release docs show CED AudioTagging at [Node API example](https://csukuangfj.github.io/sherpa/onnx/javascript-api/examples/audio_tagging.html) and Python [CED example](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/audio-tagging-from-a-file-ced.py); release page [audio-tagging-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) reachable, but its asset metadata did not load.
  - 3. Candidate: `sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2`, sherpa's `audio-tagging-models` asset; asset archive size and checksum could not be verified from the GitHub release page. The 6.13 MB `model.int8.onnx` is listed at [CED Tiny files](https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/tree/main) with SHA-256 `73aa22e783115f6a4ae169b36089907e07d0fd44795595eddea9c1bfc74cc945`; labels file is 14.7 kB. Label CSV includes baby cry, dog bark, glass/shatter, alarm, doorbell and ding-dong ([labels](https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/blob/main/class_labels_indices.csv)). Model license could not be verified as Apache-2.0: sherpa repo is Apache-2.0, but upstream [CED source repo](https://github.com/RicherMans/CED) is GPL-3.0 and sherpa's model card has no explicit license. Do not pin until rights are resolved.
  - 4. Smallest design: add pure `tagSounds(pcm, sampleRate) -> Array<{label, score}>` to the existing STT speech worker via its installed `AudioTagging` API; propose a `sound_tagging` component of `stt` and a new `/v1/audio/tags` route, not an alert policy. Install the model through `backend/src/lib/modelStore.ts` and the pinned catalog pattern in `backend/src/rows/modelCatalog.json`, with exact URL, revision, SHA-256, size and license. Memory and latency unknown for Stack hardware; sherpa's JS example reports 0.045 s for a 3.2 s clip on its unspecified machine ([example](https://csukuangfj.github.io/sherpa/onnx/javascript-api/examples/audio_tagging.html)).
  - 5. Privacy: Keep PCM and results in memory only; write no audio or tags to disk and send no audio or tags outside the home.
  - Privacy: Require explicit opt-in on each device before microphone tagging starts; provide a device-level off switch.
  - 5. Licence: the sherpa-onnx CED Tiny [model card](https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19) has no licence metadata or licence text; it says the files are converted from [RicherMans/CED](https://github.com/RicherMans/CED). The source repository declares GPL-3.0 and its exact text is [`LICENSE`](https://github.com/RicherMans/CED/blob/main/LICENSE), while its [README](https://github.com/RicherMans/CED/blob/main/README.md) points to pretrained Tiny checkpoints without stating their licence. sherpa-onnx [release notes](https://github.com/k2-fsa/sherpa-onnx/commit/c1608b3524ed876fb7acaa7747a2e41171e9015e) say the exported CED Tiny files are copied into the archive, but add no licence. GPL-3.0 permits commercial use and GPL-3.0-only code is compatible with an AGPL-3.0 product; downloading a separate model does not by itself make the Stack a derivative work. However, the checkpoints and conversion lack an explicit model licence, so commercial permission, AGPL compatibility, and attribution terms for these weights could not be verified. The upstream source licence requires preserving copyright and licence notices when redistributing covered source, but no model-specific attribution requirement is stated.
  - 6. Archive: the exact release asset URL is `https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19.tar.bz2`. The [release page](https://github.com/k2-fsa/sherpa-onnx/releases/tag/audio-tagging-models) does not render its asset metadata and lists no checksum; archive byte size and SHA-256 could not be verified. The Hugging Face [model file listing](https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/tree/main) reports `model.int8.onnx` as 6.13 MB and its [file page](https://huggingface.co/k2-fsa/sherpa-onnx-ced-tiny-audio-tagging-2024-04-19/blob/main/model.int8.onnx) gives SHA-256 `73aa22e783115f6a4ae169b36089907e07d0fd44795595eddea9c1bfc74cc945`; it was not fetched because public-page access to the file bytes was unavailable in this session. The listed file digest is not the archive digest.
  - Verdict: NO-GO. The shipped CED Tiny checkpoint licence and archive checksum are not verified.

- [x] **STACK-PARAKEET-V3-01 (M): try Parakeet v3, then cache-aware streaming speech recognition.** Objective: measure parakeet-tdt v3 (25 languages) in sherpa-onnx against the current v2 on word error and speed; if streaming gives a real latency gain for voice, add it behind the existing STT role. Acceptance: a written comparison on our fixtures before any change. Reuse check: `profiles.ts` STT pins and `prove-stt.sh`; LocalAI's `parakeet-cpp` and `nemo-speech-cpp` are references. Exit: the comparison. Status: comparison done 2026-11-28, no change to any profile. v3 is pinned beside v2 (checksum confirmed from the GitHub release digest; `parakeet-tdt-0.6b-v3-int8`, not bound to any profile, so nothing installs it yet). Measured with `bash scripts/compare-stt.sh` on 12 synthesized clips (macOS `say`, 8 English, 2 German, 2 Spanish; `backend/src/speech/fixtures/compare-sentences.json`), the speech worker on the Studio (M5 Max), CPU, 2 threads: mean word error v2 0.219, v3 0.042; English 0.0 for both; German v2 0.83, v3 0.25; Spanish v2 0.48, v3 0.0. Real-time factor v2 0.055, v3 0.054 (p95 0.065 and 0.057, over HTTP with a 2 s warm-up call). Worker resident memory peak v2 1.91 GB, v3 1.93 GB (about the 1.94 GB already recorded for v2). Installed size 671 MB against 661 MB. Caveats: synthesized speech, only 12 short clips, and German and Spanish are six sentences between them, so the gain for those languages is a strong signal and not a measured rate; English is unchanged on this set; no streaming test. Left: a human-recorded set before switching any default, a decision on a multilingual profile (v3 makes Spanish and German usable at no cost in speed or memory), the cache-aware streaming comparison (time to first partial), and the `measured` block in the catalog row from a real install. Report: `data-scratch/reports/stt-compare-2026-11-28.json`. Landed on GitHub main: c855b88b (not on the live hub).
  - 1. Current pin: `parakeet-tdt-0.6b-v2-int8`, p64 and p128, sherpa-onnx release archive `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2`, 482,440,461 bytes, CC-BY-4.0, SHA-256 `6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714` (`backend/src/rows/modelCatalog.json:28-53`; bindings `backend/src/profiles.ts:37-41`; inventory `docs/components.md:198-199`). `backend/src/speech/sherpa.ts:130-141` loads encoder, decoder and joiner with `OfflineRecognizer`, `modelType: "nemo_transducer"`, CPU provider.
  - 2. The declarations support v3: the sherpa-onnx v3 model card specifies the same offline transducer file layout and `nemo_transducer` loader for 25 languages, CC-BY-4.0 with NVIDIA attribution ([model card](https://github.com/k2-fsa/sherpa-onnx/blob/master/scripts/nemo/parakeet-tdt-0.6b-v3/README.md)). Archive `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, 487,211,443 bytes, SHA-256 `1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9` ([public mirror metadata](https://huggingface.co/onemira/parakeet-tdt-0.6b-v3-onnx)); release page asset metadata did not render, so the upstream asset checksum was not independently confirmed. The pinned `sherpa-onnx-node` and `sherpa-onnx-darwin-arm64` are 1.13.8 (`backend/package.json:32-33`); the expected local installed package directory was absent, so runtime export/API support in the installed Node binding could not be checked. Sherpa's current model list documents multilingual cache-aware Nemotron 3.5 streaming with sherpa-onnx support ([model list](https://k2-fsa.github.io/sherpa/onnx/nemo/index.html)); archive `sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2` is public, but exact archive size and SHA-256 were not verified from an upstream asset listing. NVIDIA Open Model Data Warehouse License Agreement 1.1 is not CC-BY-4.0 and requires legal review before pinning ([license summary and bundle metadata](https://github.com/KoljaB/RealtimeSTT/blob/master/docs/engines/sherpa-onnx.md)).
  - 3. Today's voice session sends partials on its configured interval by re-transcribing buffered audio, then finalizes after silence or client flush (`backend/src/speech/session.ts:1-7,25-31,87-98`; `backend/src/speech/server.ts:1-8`). Home's `backend/src/lib/turnEnd.ts:3-13,19-28` uses edge partial text to avoid starting speculative work on unfinished fragments; Stack `/v1/audio/endpoint` scores the utterance-so-far with Smart Turn (`backend/src/speech/endpoint.ts:14-20`). True cache-aware streaming could feed incremental partials to that decision and reduce repeated decoding, but latency gain is unknown and depends on measured time to first partial and final response.
  - 4. Proposed smallest safe change: add v3 as a separate catalog row with pinned URL, revision, archive size, checksum and attribution, preserving v2 as the current selection; only change selection after comparison. Extend `scripts/prove-stt.sh:1-9,47-71` to install and request v2 and v3 in isolated scratch data, record transcript, WER against references, cold-load time, warm RTF and measured peak. Existing speech fixture is only `backend/src/speech/fixtures/clover-two-seconds.wav`; its transcript is documented in `backend/src/speech/fixtures/README.md`. There are no multilingual fixtures.
  - 5. Bench v2 and v3 on the same reference transcripts for WER, real-time factor, and measured peak; benchmark a cache-aware model separately for time to first partial from first PCM frame and end-to-final latency. Use clover for the existing English regression plus add licensed, human-checked fixtures for v3's covered languages before claiming multilingual quality. Current measured Parakeet peak is 1.94 GB on an M5 Max 128 GB machine for both p64 and p128 (`modelCatalog.json:46-49`; `docs/components.md:198-199`); per-tier cost is therefore about 1.94 GB each as current evidence, and v3/streaming model peaks are unknown until measured. Do not infer memory from archive size.
  - Verdict: BENCH-FIRST. V3 has a compatible offline model layout and an attribution-friendly licence, but the pinned Node binding was not inspected locally and no v3 fixture or measured accuracy, latency or memory result exists.

  Status: feasibility checked 2026-11-27, see findings; not built.
  - 1. Current path: `/v1/audio/transcriptions/stream` receives 16 kHz mono float PCM in `backend/src/speech/server.ts:173-188`, then `SttSession.pushPcm` buffers/VADs it in `backend/src/speech/session.ts:87-91,113-153`; no live echo/noise stage. The offline enhancement route stores a temporary WAV, runs MossFormer2 at 48 kHz, and removes the temp directory in `backend/src/routes/audioEnhance.ts:33-42`; `backend/src/speech/dereverb_worker.py:1-23` runs `MossFormer2SEModel.enhance` on a whole clip. Home requests ideal browser `echoCancellation`, `noiseSuppression`, `autoGainControl`, and `voiceIsolation`, with plain-audio fallback, in `mic-capture.ts:106-125`; robot array hardware does its own AEC per `docs/dev.md:1323-1326`.
  - 2. LocalAI authors' [LocalVQE repository](https://github.com/localai-org/LocalVQE) says Apache-2.0 code and weights are Apache-2.0; no non-commercial restriction is stated. It supports 16 kHz, causal 256-sample streaming (16 ms hop), GGML C++ inference and a PyTorch research reference, not ONNX. v1.2 is 1.3M parameters/~5 MB F32; current v1.3 is 4.8M/~19 MB. The README reports 1.7 ms per hop on Ryzen 9 7900/4 threads for v1.2, not Stack hardware. macOS arm64 build: could not verify; README says tested Linux, macOS expected but unverified. Source reports 800-clip AEC Challenge metrics and separate per-hop timings, not Stack WER or latency.
  - 3. [DPDFNet](https://github.com/ceva-ip/DPDFNet) is Apache-2.0 code and pretrained model, with a 2.31M-parameter 16 kHz baseline ONNX model and online/offline denoising in [sherpa docs](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/speech-enhancement/dpdfnet.rst); denoising only, no AEC. sherpa-onnx is already the STT runtime (`backend/src/speech/sherpa.ts:4-10`) and Apache-2.0; the model can fit this engine, but would not solve echo. No compatible small AEC model found in the shipped runtime. MossFormer2 is already pinned Apache-2.0 at 0.10 GB in `docs/components.md:226`, but its current route is offline and Mac MLX-specific.
  - 4. Proposed smallest design: an optional stateful preprocessor in the existing speech worker, before VAD and STT, with synchronized mic and playback-reference frames. LocalVQE requires the exact speaker output loopback as a second input ([LocalVQE README](https://github.com/localai-org/LocalVQE)); AEC is impossible without that reference stream. A robot or hub must expose synchronized speaker PCM to the Stack; a hub with only microphone input can run NS/dereverb, but cannot cancel its own speaker echo in the Stack.
  - 5. Privacy: Keep mic, reference, and enhanced PCM in memory only; write no audio to disk and send nothing outside the home. Keep the preprocessing path local and add no outbound endpoint. Fair bench: a recorded fixture with clean near-end speech, known far-end playback/reference and room echo; compare baseline and enhanced WER, plus end-to-end added latency in ms (p50/p95) on target hardware.
  Verdict: BENCH-FIRST. LocalVQE is small and licensed for use, but AEC needs a speaker reference that the hub/robot capture contract does not currently provide, and Stack latency and WER remain unmeasured.

- [ ] **STACK-FAILOVER-01 (M): an ordered fallback when an engine fails.** Objective: a role can name a fallback model that answers while the first is unhealthy, with the switch shown in health. Acceptance: kill the primary in a test and the request is served by the fallback with a notice. Reuse check: the Reduced chat model swap in `memoryWatchdog.ts` first; LocalAI's failover (`models/model-failover.md`) is the reference. Exit: a named test. Status: first slice landed 2026-11-27 (2074d173): the pure `lib/failoverChoice.ts` `chooseServing` (first healthy, fitting model in order, plain-word notice) with seven tests. Not called by the supervisor, no role setting names a fallback, nothing shown in health; the row stays open.

- [ ] **STACK-METRICS-01 (S, optional): a `/metrics` endpoint.** Objective: expose sampled memory, CPU, queue depth and role-held bytes in Prometheus format on the admin listener only. Complements `ADMIN-02` (GPU and tokens per second are still null). Reuse check: the existing history ring. Exit: a named test. Status: endpoint is wired and exposes sampled memory, CPU, queue depth and role-held bytes; it is not wired to any scraper. Landed 09dacafd; left open because no scraper reads it yet.

- [x] **STACK-VERIFY-01 (S): confirm four unknowns from the LocalAI review.** Objective: check and write down (a) whether a Home ship kills an in-flight turn, (b) what boot repair exists after a crashed swap (feeds `STACK-SWAP-SWEEP-01`), (c) the status code for a context overflow (feeds `STACK-CTX-400-01`), and (d) whether outbound fetches check every resolved address at connect time (the DNS rebinding case). Acceptance: one line each in this row, with the file and line. Exit: the notes. Findings 2026-11-27 (partial; the row stays open for a re-read of each cite): (a) a turn in flight is probably lost on a Home ship: the reply buffer is in memory (home `backend/src/routes/turn.ts` RESUME_TTL_MS). (b) no boot-time swap recovery exists: `daemon.ts:80` only renames legacy tag dirs and `updates/engines.ts:84-88` raises an alert (feeds `STACK-SWAP-SWEEP-01`). (c) context overflow: llama-server answered 400 already, other engines may not; fixed by `STACK-CTX-400-01`. (d) closed: commons `ssrfGuard.ts:230-234` pins the connection to the validated address, so DNS rebinding is covered. Status: answered 2026-11-27 from the code and the earlier scout. (1) A ship loses an in-flight chat turn: true before `CHAT-RESUME-02` (Home 0e8048017), which now leaves a cut-off note. (2) No boot repair for an interrupted engine swap: true before 88845012, fixed. (3) Context overflow status: now 400 by STACK-CTX-400-01 (429b492c). (4) The SSRF guard connects to the validated address, not a second lookup: confirmed at `commons/core/src/ssrfGuard.ts` lines 230 to 234 (the request's `lookup` returns the pinned `target.address`). Nothing left to confirm; ticked.
# STACK-SEGMENTS-01: media segment detection (slice 4: wiring)

Built: `media.segments` job admission on the media lane, bounded URL fetch and local
path input, SHA-256 media storage and pipeline-version cache, ffprobe duration probe,
existing STT long-file job, detector adapter, SQLite record, record/skip/correction/
delete/render routes, privacy declaration, and API integration notes.

Not built/known gaps: test and gate validation still pending; clean-reference decoding
and ffmpeg render need integration fixtures; fingerprint matching, correction learning,
and transcription/model provenance beyond current-role identifiers are not implemented.
Segment record schemas, `normalizeSegments` and `skipPlan` come from `@maipai/spec`
(`spec-v0.1.489`); Stack retains status decisions, boundary snapping, and render/time helpers.
