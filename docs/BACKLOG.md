# Backlog

What is built and what is missing in MaiPai Stack, per area. Scannable,
not narrative: the reasoning lives in [`dev.md`](dev.md), the experience
in [`ux.md`](ux.md), the seams in [`integrations.md`](integrations.md).
Update this file in the same commit as the change that closes or opens a
gap; the status dashboard reads it directly.

Size tags: **S** (a session or less), **M** (a real slice, days), **L**
(a platform-level capability, needs its own design pass first).

**Execution contract for every item:** read `dev.md` and the named files
before editing. Use an isolated worktree and the branch named by the brief; the coordinator lands on `main`. Bun, Hono with `@hono/zod-openapi`, Zod,
SQLite through Drizzle, React and Vite on `@maipai/ui`; tests in
`bun:test`, deterministic and offline, engines driven by scripted
stand-ins. Every item exits with `bash scripts/check.sh` in addition to
its named check. Hard-won logic is copied from the hub's engine files
(named per item) and re-read, never re-invented; feature scope and UI are
never copied. No item migrates the hub until STACK-16.

## Milestones in execution order (reviewed 2026-09-18)

The area lists below remain the dashboard's item records. Each open item
has one destination here. The release milestone ships a usable Mac app;
the Studio milestone proves the hub's profile before Home migrates.

| Milestone | Items, in order | Why here |
|---|---|---|
| v0.1.0: qualified capabilities | STACK-86, STACK-80, STACK-81, STACK-88, STACK-89, STACK-90, STACK-91, STACK-92 | Prove model operations, role wires, update recovery, engine observation and every visible control on a clean account; the [matrix](plans/v0.1.0-capability-matrix.md) sets each claim. |
| v0.1.0: app and release | STACK-66, STACK-76, STACK-79, STACK-82, STACK-87, STACK-67, STACK-68 | Install the Tauri app and daemon, authenticate its console, prove the first answer and show useful status. |
| v0.1.0: help and trust | STACK-55, STACK-37, STACK-69, STACK-70, STACK-28, STACK-29, STACK-71, STACK-72, STACK-77, STACK-78, STACK-85, STACK-73 | Make Help, settings, backups, privacy, licensing and diagnostics truthful. |
| v0.1.0: distribution | RELEASE-STACK-01, STACK-84, STACK-83, SITE-STACK-01 | Build signed artifacts, prove update compatibility and a clean install before the owner authorizes a tag. |
| Studio proof | STACK-13, STACK-74, STACK-14, STACK-61 | Complete generator jobs and the bench protocol, then measure the Studio and coding context against its real profile. |
| Home migration | STACK-75, STACK-16 | Pin and test the Stack/Home wire, then migrate Home with rollback after the Studio proof. |
| Later Mac operations | STACK-04d, STACK-21, STACK-22, STACK-23, STACK-24, STACK-25, STACK-27, STACK-30, STACK-31, STACK-50, STACK-60 | Improve general Hub discovery, the store, maintenance, data layout and coding-tool setup after the qualified release path works. |
| Optional interfaces | STACK-58, STACK-59, STACK-62, STACK-63 | Each needs the stated owner choice or usage evidence before it becomes a release dependency. |
| Other platforms and kit | KIT-01, STACK-17 | Extract the shared UI kit and prove the Linux robot profile after the Mac service is stable. |

The former Milestone 0, 0b, 0c and 0d headings were topic groupings,
not release gates. STACK-04c, STACK-34, STACK-07b, STACK-06b, STACK-09b,
STACK-10, STACK-11b, STACK-11c, STACK-12, STACK-15b, STACK-19,
STACK-35 and STACK-36 had repeated entries; each now has one item record.
STACK-33 is complete in 953eda0. STACK-18 is the existing app shell,
not the complete release. The host and release work is in STACK-66 and
RELEASE-STACK-01.

## Built foundation and Studio dependencies

- [x] **STACK-00 (M): the design.** `dev.md`, `ux.md`,
  `integrations.md`, the privacy page, this backlog, the org decision
  record. Done 2026-09-17.
  Verified on main at e6b48db.
- [x] **STACK-01 (S): repo scaffold.** `package.json` with Bun and Hono,
  `@hono/zod-openapi` wired with the explorer at `/api/docs`, Drizzle
  and SQLite under `data/`, one health route, `scripts/check.sh` running
  lint, format, tests and the standards core (mirror
  `home/scripts/check.sh`), `.env.example`. Verified. Acceptance: `bun start`
  serves `/api/docs` and `/healthz` on the default port; `check.sh`
  green. Out of scope: any engine.
  Verified on main at 79d1d2d.
- [x] **STACK-02 (M): hardware probe and profiles.** CPU, GPU class,
  unified or discrete memory, free disk, OS; the profile tiers and their
  role lists as one declaration. Mirror `home/backend/src/lib/hardware.ts`.
  Acceptance: `GET /stack/v1/hardware` on the dev Mac reports real values;
  a unit test for each tier's proposal from a scripted probe. Verified. Out of
  scope: the bench.
  Verified on main at ff1584d.
- [x] **STACK-03 (M): engine catalog and downloads.** Pinned builds per
  platform (version, URL, sha256 recorded here), resumable checksummed
  downloads with a clear offline failure. Copy the hard-won parts of
  `home/backend/src/lib/engineCatalog.ts`, `modelDownload.ts`,
  `modelDownloadJobs.ts`. Acceptance: `llama-server` for macOS arm64
  downloads, verifies and runs `--version`; a test proves a checksum
  mismatch refuses the build. Verified. Out of scope: spawning.
  Verified on main at 5c1c8bf.
- [x] **STACK-04 (M): the model store and provenance.** The model record
  (`dev.md`, "The model store and provenance"); install from a Catalog
  `model` package and from a Hugging Face repo; a model is selectable only
  with checksum and licence recorded. Acceptance: the record round-trips
  with id, provenance and clock stamp; an unverified model cannot be
  bound to a role (test). Committed, updates outstanding (STACK-10).
  Verified on main at a84e774.
- [x] **STACK-04b (M): the content-addressed store, imports and ranged
  downloads.** Hugging Face layout, engine tags and manifests, five-tool
  import scan, reference-counted remove, storage accounting, and migration.
  Verified; Windows and non-range servers use the documented
  fallback paths.
  Verified on main at 29135bc.
- [x] **STACK-04c (M): nicknames, nested model groups and utilization.**
  Nullable display nicknames, one-group model placement, persistent nested
  groups, per-model usage and load seconds, rollups, group actions, and the
  grouped Models and Monitoring surfaces. Verified on main at 8767f48.
- [x] **STACK-34 (M): detect and adopt.** Loopback-only probes for local
  engines and known model folders, persisted detection rows, explicit
  operator adoption or forget, managed-host registration, folder linking,
  version-floor health, and Engines/Models actions. Verified on main at fad2f39.
- [x] **STACK-05 (M): the supervisor.** `spawned`, `managed`, `url`
  engine kinds; spawn, watch, restart, the generation guard, the post-load
  check, the memory report; identity headers on every reply. Copy the
  restart semantics from `home/backend/src/lib/llmSupervisor.ts`,
  `backgroundSupervisor.ts`, `engineIdentity.ts`, `enginePostLoadCheck.ts`.
  Acceptance: a scripted engine's crash is restarted without cutting an
  in-flight request (test); a managed host that vanishes shows
  `offline_reason`. Committed at c1c4fbb with scripted engines; a live
  completion through a real llama-server and a verified model on this
  Mac is outstanding (STACK-14 records it), and the governor is STACK-06. Out of scope:
  the governor's rules.
  Verified on main at c1c4fbb.
- [x] **STACK-06 (M): the governor.** Profile, admission, one generator,
  eviction (TTL, LRU, pin), the cap, `keep_alive` as a hint; every rule
  readable as a sentence on the Hardware page. Seed from
  `home/backend/src/lib/resourceGovernor.ts`. Acceptance: a test per
  rule with scripted memory readings; a queued job reports its position.
  Verified with scripted readings; live pressure behavior on the
  Studio is STACK-14.
  Verified on main at 642421e.
- [x] **STACK-06b (M): the kernel's memory ledger.** Three OS readers behind
  one interface, kernel pressure watermarks, measured process footprints,
  and dry-run model sizing. Verified; the Windows reader is a
  named stub because it could not be tested on this Mac.
  Verified on main at a52c7bf.
- [x] **STACK-113i (M): visible, configurable governor.** Declare the live
  model-memory budget and advanced pressure watermarks; log the newest 200
  governor decisions; show the current budget, pressure, and decisions in
  Monitoring and the sidebar. Files: `backend/src/lib/governor.ts`,
  `backend/src/settings/stackKeys.ts`, `backend/src/routes/budget.ts`,
  `frontend/src/pages/MonitoringPage.tsx`,
  `frontend/src/kit/blocks/dashboard/components/nav-resources.tsx`.
  Mirror: ux.md, "The governor is visible and configurable." Acceptance:
  changing the setting changes scripted admission; a scripted refusal is
  logged; Monitoring renders decision sentences; the named captures are
  judged. Exit: `bash scripts/check.sh`.
- [x] **STACK-07 (M): roles and the router.** The role declaration, role
  by name in `model`, the OpenAI-shaped endpoints for text, embeddings,
  audio and images, the streaming speech sessions. Acceptance: an
  unmodified OpenAI client library completes a chat, an embedding, a
  transcription and a speech render against scripted engines; role
  scoping refuses a disallowed role with a clear error. Committed, engine binding completed by STACK-05.
  Verified on main at 147e0d4.
- [x] **STACK-07b (S): streaming completions and speech.** Chat streams
  pass through with identity headers, cancellation, and usage counters;
  phrase-level TTS streaming remains the contract for its future engine.
  Verified on main at 2fbd33f.
- [x] **STACK-08 (M): operator login and client keys.** Password login,
  keys hashed at rest and shown once, allowed roles, counters, revoke;
  loopback requires a key. Mirror the hub's `auth.ts` and `lib/secrets`
  pattern. Acceptance: a revoked key is refused within one request; the
  key never appears in a log or a response after creation (test). Verified on main at 8556157.
- [x] **STACK-09 (M): events and notifications.** The SSE feed with the
  typed events in `dev.md`; the Notifications page; the Repairs list.
  Acceptance: an engine crash produces `engine.state` and a Repairs row
  with one action (test); Home's bridge shape documented in the API. Verified (the tick and the changelog line were added at landing; the lane's commit omitted them).
  Verified on main at dd781aa.
- [x] **STACK-09b (M): one daemon-owned health list.** Idempotent health
  items with severity, cause, Fix or Learn more, resolve and ignore routes,
  producer codes, and the Repairs compatibility alias. Verified on main at c90af29.
- [x] **STACK-10 (M): updates.** Opt-in check, conditional manifests,
  engine swap and rollback, and a non-applying model revision watch.
  Verified; release manifest generation remains RELEASE-STACK-01.
  Verified on main at 21d703f.
- [x] **STACK-19 (M): engine management.** Operator controls, declared
  per-engine configuration with pending restart values, derived version
  state, install progress, protected removal, and the Engines page. Verified on main at e69fd4b.
- [x] **STACK-35 (M): property panel.** One reusable docked or mobile-sheet
  panel for engines, models, and detected stores with actions, tabs, keyboard
  selection, and inline destructive confirmation. Verified on main at 663c24a.
- [x] **STACK-36 (M): Overview console.** Range-aware usage, memory, and speed
  series backed by durable samples, with seven widgets, status rings, and
  showroom captures. Verified on main at 1b61833.
- [x] **STACK-11 (M): the admin UI, first run and the board.** committed:
  the initial first-run shell, login and board on the copied kit.
  STACK-11b replaced the wizard with board-first setup.
  Verified on main at 82fac4c.
- [x] **STACK-12 (M): Try it.** The stateless chat, voice, and generator
  role tabs, copied shadcn chat primitives, operator acknowledgement, and
  scripted visual captures are shipped. The pinned Qwen3 1.7B chat model
  installs through the setup plan; a live completion remains outstanding
  when the governor cannot admit the model.
  The first-run acceptance moved to STACK-11b; the Tester remains
  stateless and generator roles wait on STACK-13.
  Verified on main at 223d345.
- [x] **STACK-11b (M): the board is first open, with no wizard.** Committed
  with a scripted download; the real store lands in STACK-04b. The board
  measures the computer, lets the operator choose abilities, and keeps an
  honest download bar visible while the deferred password stays deferred.
  Verified on main at 63b3f66.
- [x] **STACK-11c (M): the dashboard shell.** The branded Stack sidebar,
  search and command palette, the initial sections, real monitoring and
  alert actions, and honest empty states. STACK-51 changed the nav.
  Verified on main at f3d1162.
- [ ] **STACK-13 (M): jobs and the managed ComfyUI.** The job API,
  progress on the feed, cancel, results by id, the synchronous wrapper;
  ComfyUI as a managed host for image edits. Acceptance: a scripted job
  reports progress and cancels cleanly; the wrapper returns an OpenAI-
  shaped image response.
  Files: `backend/src/routes/jobs.ts`, `backend/src/lib/supervisor.ts`,
  `frontend/src/pages/TryItPage.tsx`.
  Mirror: the current job lifecycle routes and inference wrapper.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-14 (L): the Studio bench and the MLX engines.** `mlx-serve`
  and `oMLX` as spawned candidates beside `llama-server` and `mlx-lm`,
  measured on the Studio with the residency profiles in the hub's
  `docs/plans/hub-on-apple-silicon-2026-09-17.md` section 3; multi-model
  memory behavior recorded. Needs its own bench design first.
  Acceptance: numbers with engine build, model file and a sanitized
  hardware line in `dev.md`; a chosen Studio profile.
  Files: `docs/dev.md`, `backend/src/lib/engineCatalog.ts`,
  `backend/src/lib/governor.ts`, `scripts/bench/`.
  Mirror: STACK-74 protocol and the existing speed test.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-15 (M): service install.** launchd on macOS with the
  data-directory permissions, an installer script, start, stop, pause
  and resume; the menu-bar item after the web UI. Verified with a
  temporary launchd label on this Mac; the release asset and hosted
  script land with the first release.
  Verified on main at e3b2098.
- [x] **STACK-15b (S): the one-line installer and compiled binary.** A
  checksum-verified macOS arm64 installer embeds the board, installs the
  launchd agent, restarts cleanly on re-run, and keeps data on uninstall.
  Verified with a temporary launchd label on this Mac; the release asset
  and hosted script land with the first release.
  Verified on main at e3b2098.
- [ ] **STACK-16 (L): Home runs on the Stack.** The hub's migration list
  in `dev.md`; Home registers as a client, calls by role, bridges events,
  and deletes its own supervisors. Lands in the `home` repo as its own
  items after STACK-14 proves the Studio profile. Needs its design pass
  in `home/docs/dev.md` first.
  Files: `home/backend/src/lib/engine*.ts, home/backend/src/routes/, docs/integrations.md`. Mirror: STACK-75 contract fixtures and the current Home supervisors.
  Out of scope: removing Home supervisors before the Studio proof.
  Exit: `bash scripts/check.sh`.
  Acceptance: a dual-run check proves each role before removal and a rollback restores the old path.

## Field survey decisions (2026-09-17)

Decided in [`plans/operations-design-2026-09-17.md`](plans/operations-design-2026-09-17.md);
each item's design section lands in `dev.md` before its code.

- [ ] **STACK-04d (S): the store writes through `@huggingface/hub`.**
  Replace `store/hfCache.ts`'s hand-written layout writer with the
  official client's `downloadFileToCacheDir` behind `lib/hf.ts` (the
  dependency rule: one adapter, the format's owner writes the format),
  keeping the read side and the tests; verify in the installed source
  that it produces `models--<org>--<repo>/{blobs,refs,snapshots}` and
  cite the line. Acceptance: the store tests still pass; a NOTICE line.
  Files: `backend/src/lib/store/hfCache.ts, backend/src/lib/hf.ts, NOTICE`.
  Mirror: the existing store tests.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-09c (M): alert channels.** `{type, name, config,
  verifiedAt}` in a registry, Telegram and ntfy providers, "Send a
  test" returning the provider's error, an unverified channel is a
  warning item, a privacy-page row per channel type. Acceptance: a
  scripted provider receives the test and the verified stamp lands;
  the privacy page lists both. Exit: `bash scripts/check.sh`.
  Verified on main at f940652.
## Cross-repo

- [ ] **KIT-01 (M): extract the shared UI kit.** Move the copied
  dashboard and primitive subset into a versioned `@maipai/ui` package
  pinned by Home and the Stack. Files: `frontend/src/kit/`,
  `home/frontend/src/kit/` and the new package manifest. Mirror: org
  `docs/UI.md` and the current copied kit. Acceptance: both apps build
  from the same package version, their existing visual captures do not
  regress, and the Stack has no copied kit source left. Out of scope:
  changing page behavior or adding a component library. Exit:
  `bash scripts/check.sh` in each touched repo.
- [x] **STACK-18 (M): the Tauri 2 desktop shell.** The `desktop/`
  package loads the daemon's console in a native window, provides a
  tray with initial status and actions, a daemon-down Start screen,
  native pickers, single-instance handling and notification hooks.
  Verified on main at a39948f. The app's service installation is
  STACK-66; authenticated tray reads and actions are STACK-76; the
  full menu and per-kind notifications are STACK-67 and STACK-68.

## Self-management area (2026-09-17)

The features a person would not think to do, or would find tedious,
that let the Stack set itself up, keep itself healthy, keep itself
current and keep the person informed. Each is built on the operating
layer above; none adds a person or leaves the machine.

- [x] **STACK-20 (M): Check my Stack.** One click (and nightly in the
  maintenance window, quietly) runs a real smoke test per ready role:
  a completion, a transcription of a bundled two-second clip, a speech
  render, a small image tile; then the fit-together check: with the
  resident set loaded, start one generator job and watch the kernel's
  pressure and the governor's decisions, pass only if pressure never
  reaches critical; each pass or fail with the health item
  and its fix; the last result on the Overview health card
  ("Checked 2 hours ago, all good"). Acceptance: a scripted failing
  role yields a health item with a fix; the nightly run is skipped
  while the person is active.
  Verified on main at 5c9b946.
- [ ] **STACK-21 (M): What's new for your computer.** When the
  Catalog's model index changes (a conditional GET, opt-in with the
  update check), tell the person which new models would run well on
  this machine and what they would gain, in one sentence each, with
  Install; never auto-install, never a telemetry call. Acceptance: a
  scripted index with three models yields one recommendation that
  fits the tier and two that are hidden for not fitting.
  Files: `backend/src/updates/models.ts, frontend/src/pages/OverviewPage.tsx`.
  Mirror: the current update watch and profile proposal.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-22 (M): the maintenance window.** Quiet hours the person
  sets once (default 2 to 5 in the morning): downloads, update checks,
  smoke tests, storage sweeps and benchmarks run then; heavy work
  pauses when the person is active (input in the last five minutes),
  on battery, or under memory pressure; a bandwidth cap for
  downloads; "Run maintenance now" on Settings. Acceptance: a scripted
  clock runs the window's jobs inside it and defers them outside;
  activity pauses a scripted download.
  Files: `backend/src/lib/governor.ts, backend/src/routes/settings.ts, frontend/src/pages/SettingsPage.tsx`.
  Mirror: the existing activity skip in Check my Stack.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-23 (M): ready when you sit down.** Models unload after an
  idle time the person sets; on battery they unload sooner; the chat
  model warms up before the hour the person usually uses it, learned
  from the Stack's own usage records on this machine (never sent
  anywhere, shown on the Monitoring page as "you usually chat around
  7 pm"). Acceptance: scripted usage records produce the warm-up
  hour; a battery event unloads a JIT model.
  Files: `backend/src/lib/governor.ts, backend/src/lib/series.ts`.
  Mirror: the current idle eviction rule.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-24 (M): storage hygiene.** Find models unused for thirty
  days, duplicate files across tools, orphan blobs, old engine builds
  and stale logs; show what each would free; one click to clean; a
  warning three days before the disk fills at the current download
  rate. Acceptance: a scripted store yields the exact list and sizes;
  the clean removes only what was listed; the disk warning fires on a
  scripted trend.
  Files: `backend/src/lib/store/, backend/src/routes/storage.ts, frontend/src/pages/SettingsPage.tsx`.
  Mirror: the current reference-counted remove.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-25 (M): move to a new computer.** Export "my setup"
  (plan, abilities, groups and nicknames, settings, alert channels
  minus their secrets, the client list minus keys) as one file; on a
  new machine, import it and the Stack re-downloads what fits the new
  hardware, re-sizes what does not, and says what changed. Part of
  Backups, per the org standard. Acceptance: export then import on a
  scripted smaller machine drops the abilities that do not fit and
  says so.
  Files: `backend/src/db/, backend/src/lib/setupPlan.ts, frontend/src/pages/SettingsPage.tsx`. Mirror: the setup plan and STACK-72 backup format.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-26 (M): the speed test, on `llama-bench`.** After a
  model installs and after any engine update, in the maintenance
  window, run llama.cpp's own `llama-bench` from the pinned archive
  for that model (prompt processing and generation tokens per second
  at the household's context, three repetitions), record first-token
  time and load time from the supervisor's own timers and the
  measured footprint, and keep the history per model, engine tag and
  context. Monitoring shows "your Mac: N tokens per second on this
  model, was M before the update" against the tier's expected range;
  a regression past ten percent raises a warning health item naming
  the update, with Go back one click away. Quality benchmarks are out
  of scope by decision (a trend line, Home's judge if anywhere).
  Acceptance: a scripted `llama-bench` output parses into the record
  (test); a second run with a lower number raises the item (test);
  the page's numbers are the recorded ones (screenshot judged).
  Verified on main at c375461.
- [ ] **STACK-27 (S): the weekly digest.** One passive notification a
  week: what was used and how much, what updated, what is tight, what
  could be cleaned, in five plain sentences; off by default on the
  Alerts page. Acceptance: a scripted week yields the five sentences.
  Files: `backend/src/lib/series.ts, backend/src/lib/channels/, frontend/src/pages/AlertsPage.tsx`.
  Mirror: the durable notification templates.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-28 (S): licences in plain words.** Every model's licence
  shown as one sentence a parent understands ("free for personal use;
  not for a business") from a small map of the common licences, with
  the full text a click away; a gated or non-commercial licence flagged
  before download. Acceptance: the map covers Apache-2.0, MIT, Llama
  community, Gemma terms, Qwen research, CC-BY-NC; an unknown licence
  says "read it before you rely on it".
  Files: `backend/src/lib/modelCatalog.ts, frontend/src/panels/model.tsx`.
  Mirror: the existing licence field and model panel.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-29 (S): guided fixes and a diagnostics bundle.** Every
  health item's "Learn more" opens a page with the exact steps in the
  user docs; "Save a diagnostics file" writes a redacted bundle
  (versions, hardware, health, the last hundred log lines with secrets
  removed) the person can keep or send to whoever helps them. Nothing
  is sent by the Stack. Acceptance: the redaction test from the
  logging standard covers the bundle.
  Files: `backend/src/lib/health.ts, backend/src/routes/logs.ts, frontend/src/pages/SettingsPage.tsx`.
  Mirror: the existing health code and local log route.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-30 (M): abilities by intent.** On the Abilities page,
  "What do you want to do?" (a chat assistant; help with homework;
  dictation; make images; code) picks the abilities and models for
  this machine and explains the choice in one sentence; the tier list
  stays behind "Change". Acceptance: each intent maps to a set that
  fits each tier (test per intent per tier).
  Files: `backend/src/lib/setupPlan.ts, frontend/src/pages/BoardPage.tsx`.
  Mirror: the current ability proposal.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-31 (S): engines kept current, safely.** An opt-in switch
  on Updates: apply engine updates in the maintenance window with the
  automatic rollback of STACK-10 if the post-swap check fails, and a
  notification either way; model updates are never automatic.
  Acceptance: a scripted failing update rolls back and notifies.
  Files: `backend/src/updates/engines.ts, backend/src/routes/updates.ts`.
  Mirror: the existing drain, swap and rollback.
  Out of scope: new person records or Home-side features.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-32 (M): the Library.** Local documentation for what is
  installed. When a model or engine is selected, its source page and
  docs links are registered on the record (STACK-04b); the Library
  fetches, on the person's say-so and in the maintenance window, the
  model card (the repo README at the pinned revision) and the engine's
  documentation into `data/library/<id>/`, indexes them locally
  (the docs site's Pagefind index, the same one the user docs use),
  shows them in a Library section with one page per installed thing
  (source, licence in plain words, the card, the file list, our own
  measured numbers for it), and puts them in the Stack's search and
  command palette. An MCP server (`stack-library`, the org's standard
  MCP over stdio) exposes `list_installed`, `get_doc` and `search`
  so Home's assistant and a coding tool can answer from the docs the
  person actually has. Fetches are listed on the privacy page; nothing
  is fetched without the switch on; a page that changes upstream is
  refetched only with the revision. Acceptance: two scripted installs
  produce two Library pages found by the palette; the MCP `search`
  returns the right page for a query (test); the privacy row exists.
  Verified on main at 953eda0.
- [x] **STACK-33 (S): the Library in the docs site's search.** The
  published docs site's search also covers the Library pages of this
  Stack when opened from the Stack (the site's Pagefind index merged
  with the local one at request time), so one search box answers both
  "how do I" and "what did I install". Acceptance: a query that matches
  only a Library page returns it from the site's search box. Verified on main at 953eda0.
- [ ] **STACK-37 (M): a local answer helper.** Ask answers live
  machine facts and shipped docs without a model. A separately enabled
  path may use the already loaded chat model with read-only tools and
  proposal cards. It downloads no helper model, declares no helper
  role, stores no conversation history, and works in model-free mode
  when chat is offline. Acceptance: scripted facts and docs answer
  with no engine running; every tool is read-only; with the switch off
  no model request occurs; a short question corpus reports correct
  answer links and rule hit counts. Out of scope: an agent loop,
  bundled model and automatic action.
  Files: `frontend/src/pages/DashboardShell.tsx, backend/src/routes/library.ts, docs/site/`.
  Mirror: the current palette and local Library search.
  Exit: `bash scripts/check.sh`.
## Console area (2026-09-17 and 2026-09-18)

The design record is ux.md "Look and feel references: UniFi's
structure, X's modernism". Each item below is one numbered pattern from
that section made real in the kit and in the pages, judged on the
showroom (`bun run showroom`, captures under `docs/assets/screens/`).
Order matters: the shell items (38 to 40) first, the kit blocks (41,
42) next, then the pages that use them.

- [x] **STACK-38 (S): the page header is the title** `1933cb6`. The top bar's
  title is sticky and is the page's title; the eyebrow ("MaiPai
  Stack"), the large heading and the subtitle at the top of every page
  body go. A page keeps at most one muted sentence under the header
  when it needs one. Files: `frontend/src/kit/blocks/dashboard/
  components/site-header.tsx` (sticky: `sticky top-0 z-30` on the
  header, a hairline under it), `frontend/src/pages/DashboardShell.tsx`
  and every page file with the triple (`grep -rn "MaiPai Stack" frontend/
  src/pages`). Mirror: X's "Home" header. Acceptance: no page renders an
  `h1` besides the header's; `dashboardShell.test.tsx` asserts the
  header stays in the document after a long page scrolls (a `sticky`
  class assertion is enough in happy-dom); showroom captures of
  Overview, Models and Engines opened and judged. Out of scope: the top
  bar's instance dot (STACK-46). Exit: `scripts/check.sh`.
  Verified on main at 1933cb6.
- [x] **STACK-39 (S): relative times.** `frontend/src/lib/relativeTime.ts`
  (`formatRelative(iso, now)`: "now" under a minute, "3m", "2h",
  "Yesterday", then the short date; unit tests for each boundary) and a
  `RelativeTime` component in `frontend/src/kit/ui/` that renders the
  relative form with the absolute time in a tooltip and `dateTime` on a
  `<time>` element. Used by Recent activity on Overview, the
  notification popover, the health rows and every panel's key-value
  list (the list shows both). Mirror: X's "3m" timestamps. Acceptance:
  `relativeTime.test.ts` covers the boundaries; `overview.test.tsx`
  finds a `<time>` element with a `dateTime`. Exit: `scripts/check.sh`.
  Verified on main at 209ee9b.
- [x] **STACK-40 (S): dark is black, light is flat.**  `frontend/src/kit/
  tokens.css` `.dark` block: `--background` and `--card` to a near-black
  neutral, `--border` a hairline grey, no shadow tokens in use; light
  mode drops the card drop shadows (`shadow-*` classes on `Card` and the
  property panel go, the hairline border stays). Mirror: X's dark
  mode. Acceptance: `grep -rn "shadow-" frontend/src --include=*.tsx`
  lists only the command palette and popovers (floating layers keep
  one); showroom `overview-console-dark.png` and `-light.png` opened
  and judged; every text and border token pair is checked for WCAG AA contrast
  and the ratios are listed in the commit message. Out of scope: a theme generator. Exit: `scripts/check.sh`.
  Verified on main at f482a6e.
- [x] **STACK-41 (M): the things table.** One block, `frontend/src/kit/
  blocks/things-table/ThingsTable.tsx`, on the kit's `table.tsx`:
  column definitions with alignment (numbers right, `tabular-nums`), a
  leading status dot from a four-state `status` field (ready, attention,
  offline, detected), hairline rows without per-row card chrome, a
  truncating name cell with a tooltip, accent link cells that open
  another thing's panel, group rows that collapse (the Models tree),
  selection checkboxes, and a quiet action row under the last row
  (text actions separated by hairlines). Used by Engines, Models (groups
  and detected rows included), Access clients and keys, Alert channels.
  Mirror: UniFi's Networks and Devices tables in our palette.
  Acceptance: `thingsTable.test.tsx` covers the dot states, the sort, the
  group collapse and the action row; Engines, Models and Access render
  through it (no page keeps its own row markup; grep for `border-b` in
  pages is empty); showroom captures opened and judged. Out of scope:
  the filter column (STACK-43). Exit: `scripts/check.sh`.
  Verified on main at df2155a.
- [x] **STACK-42 (M): the property panel, refined.** `frontend/src/kit/
  blocks/property-panel/PropertyPanel.tsx`: quick actions are icon
  buttons with tooltips (lucide icons per action, given by the panel's
  caller), never letters in circles; an icon-tab strip with tooltips
  for Overview, Insights, Settings; a quick-facts block (two or three
  facts with values) and two side-by-side outline buttons for the two
  most-used actions of the kind, both provided by the caller; a
  key-value list block (`KeyValueList`: label muted left, value right,
  a copy glyph after ids and paths, an optional inline action beside a
  value) used by every panel in `frontend/src/panels/`; a `Used by` row
  of client tiles when the item has usage. Mirror: UniFi's device panel
  in our palette. Acceptance: `panels.test.tsx` finds the icon buttons
  by their tooltip labels and the key-value rows by label; the copy
  glyph writes to the clipboard in the test (stubbed); showroom
  `engines-panel.png`, `models-panel.png`, `detected-panel.png` opened
  and judged. Exit: `scripts/check.sh`.
  Verified on main at 9cf2649.
- [x] **STACK-43 (M): the filter column.** A `FilterColumn` block
  (`frontend/src/kit/blocks/filter-column/`): a search field,
  collapsible checkbox groups with counts (status, kind, role, for the
  page's things), a Clear filters link, collapsible to nothing with a
  chevron; a Filter button that opens it as a sheet below tablet width.
  Engines, Models and Access use it in the three-column layout of ux.md
  item 5 (filters, table, panel). Mirror: UniFi's Devices page in our
  palette. Acceptance: `filterColumn.test.tsx` filters a fixture list by
  two groups at once and clears; the three pages render the column on a
  wide viewport and the button below it (the `--breakpoint-lg` width in
  `kit/tokens.css`);
  showroom captures opened and judged. Exit: `scripts/check.sh`.
  Verified on main at 90ab8cd.
- [x] **STACK-44 (S): one pill.** The `Button` `default` variant is a
  fully rounded pill; every screen keeps one filled button at most (the
  page's main action), everything else `outline`, `ghost` or a text
  link. An audit of `frontend/src/pages` and `panels` lists each filled
  button per screen in the commit message. Mirror: X's one "Post"
  button. Acceptance: a `bun test` walk of the showroom fixtures renders
  each page and asserts at most one `data-variant="default"` button
  outside dialogs; captures opened and judged. Exit: `scripts/check.sh`.
  Verified on main at 803cb02.
- [x] **STACK-45 (M): Overview's facts column and controls.** The left
  facts column of ux.md item 8 (the computer card with counts by kind,
  key facts as label and value rows, versions with "Up to date" and a
  history glyph, two full-width outline buttons: Speed test, Check my
  Stack); the time range as a segmented control (1h, 1D, 1W, 1M) with
  series checkboxes and colored legend swatches beside the usage chart;
  the right rail's Recent activity and Health as list cards with a
  muted meta line per item and a Show more link. Files: `frontend/src/
  pages/OverviewPage.tsx` and the components it splits into. Mirror:
  UniFi's Dashboard and X's side cards, in our palette. Acceptance:
  `overview.test.tsx` switches the range and asserts every chart
  re-queries with it; the buttons call the existing speed test and
  Check my Stack routes (or show the "coming with STACK-26/20" state
  until those land); showroom `overview-console-*.png` opened and
  judged at desktop and phone. Exit: `scripts/check.sh`.
  Verified on main at fa478a0.
- [x] **STACK-46 (S): the top bar.** The instance on the left with its
  status dot and name ("This computer", the dot in the worst health
  severity, green when the list is empty), the search field in the
  middle, the theme toggle and the bell on the right. Files:
  `site-header.tsx`, `nav-health.tsx` (the health read), the theme
  toggle from the kit. Acceptance: `dashboardShell.test.tsx` finds the
  dot's label and the toggle; captures opened and judged. Out of scope:
  moving This computer off the sidebar footer (it stays until the
  hand-off card design lands). Exit: `scripts/check.sh`.
  Verified on main at 803cb02.
- [x] **STACK-47 (S): settings as rows.** The generic renderer
  (`frontend/src/kit/settings/GenericForm.tsx`) renders the shape of
  ux.md item 4: label left with an info glyph that opens the
  explanation in a popover, control right (radio group inline for two
  or three options, select above that, checkbox, input), group
  headings from the declaration's `group`. The Settings page and every
  panel's Settings tab render through it. Acceptance:
  `genericForm.test.tsx` (new, beside the existing frontend tests)
  finds the info glyph and its popover text and
  the radio group for a three-option enum; `engines-configure.png`
  opened and judged. Verified. Exit: `scripts/check.sh`.
  Verified on main at 3c07a87.
- [x] **STACK-48 (M): the first phone and the first LAN request.** An
  off-laptop request renders only the sign-in gate, a fresh Stack tells
  the owner to set its password on the host, and LAN access refuses to
  become pending until that password exists. The shell keeps its title
  and three quiet icon actions on a phone; the board and Overview put
  the useful first state before the detail. Captures at 400px were
  opened and judged. Exit: `scripts/check.sh`.
  Verified on main at b4479b1.
- [x] **STACK-49 (M): Overview, second pass.** ux.md "Overview, second
  pass" made real: no prose in widgets; the one-line status strip in
  words with counts (the ring cards go); one hero chart with Usage,
  Memory and Speed as tabs, series toggles and the range in its
  toolbar, axes spanning the range, a check sentence beneath; tile
  strips for Models, Clients, Engines; segmented storage bar and the
  memory headroom scale; the facts column as one card ending with the
  last check result; the rail's Recent activity showing durable events
  only, by display name. Files: `frontend/src/pages/OverviewPage.tsx`
  split into `frontend/src/pages/overview/*` (StatusStrip, HeroChart,
  TileStrip, SegmentedBar, FactsColumn, Rail), `backend/src/lib/series.ts`
  (the range always returned as a full window), `backend/src/events.ts`
  (a `durable` flag per template), `backend/src/showroom/fixture.ts`
  (a full day of samples). Mirror: UniFi's Dashboard in our palette.
  Acceptance: the page renders no `<p>` inside a widget except the
  check sentence (test walks the DOM); the strip omits zero counts
  (test); each tab re-queries with the range and the axis domain equals
  the range (test); Recent activity excludes non-durable events (test);
  captures at 1440, 1024 and 400 opened and judged. Exit:
  `scripts/check.sh`.
  Verified on main at 57bdd16.
- [ ] **STACK-50 (M, owner agreed 2026-09-18): two databases, state and measurements.** dev.md
  "Two databases" (2026-09-18): `stack.db` keeps state (settings,
  models, groups, clients, channels, operator, detected, open health),
  `metrics.db` takes the measurements (usage_samples, memory_samples,
  speed_results, check_runs, model_usage, notifications) with its own
  Drizzle journal, batched writes, scheduled retention and VACUUM, and
  recreation when missing or corrupt (one health item, never a boot
  failure). Backups: `metrics.db` is `exclude` by default with the
  sentence on the page, "with history" includes it. Files:
  `backend/src/db/*` (split into `state/` and `metrics/`),
  `backend/src/lib/paths.ts` (`metricsDbPath`), every writer of a
  measurement table, `docs/user/backups.md` when it exists. Mirror: the
  current `db.ts` and journal. Acceptance: a fresh boot creates both
  files (test); deleting `metrics.db` while running yields the health
  item and a fresh file, state untouched (test); the retention job
  trims a scripted old ring and leaves state rows (test); the Overview
  reads unchanged. Out of scope: moving text logs into a database.
  Exit: `scripts/check.sh`.
- [x] **STACK-51 (M): the shell, second pass.** ux.md "The shell,
  second pass" (2026-09-18): Abilities leaves the sidebar (its actions
  on Models and the Overview strip); two sidebar groups, common on top
  (Overview, Engines, Models, Clients, Tester, Monitoring) and
  administrative pinned at the bottom (Settings, Logs, Alerts); "Try
  it" reads Tester, "Access" reads Clients, Updates and Backups become
  Settings sections, Logs becomes its own row; the header search is a
  magnifying-glass icon opening the palette, no text field at any
  width; the sidebar's bottom block shows memory used and disk free
  (the ring alone when collapsed); the instance name and health dot
  become a subtitle under the logo, "This computer" leaves the header;
  a Running/Paused pill in the header center that pauses everything
  (drain, unload, pause downloads and jobs) through the one
  implementation the tray and the palette use, with inline confirmation
  when requests are in flight. Files:
  `frontend/src/kit/blocks/dashboard/components/*`,
  `frontend/src/pages/DashboardShell.tsx`, `SettingsPage.tsx` (the
  Updates and Backups sections), a `LogsPage.tsx`, `backend/src/lib/
  governor.ts` (`pauseAll`, `resumeAll`, `runState`), a
  `/stack/v1/run-state` route. Acceptance: the two groups render in the
  named order with the bottom group pinned at 600 px and 1000 px tall
  (test); no text input in the header at 400 and 1440 (test); the
  resource block reads the stubbed budget and hardware (test); pause
  drains a scripted engine and the pill reads Paused, resume brings it
  back (test); Updates and Backups render inside Settings and the
  palette reaches them (test); captures at 1440 and 400 opened and
  judged. Exit: `scripts/check.sh`.
  Verified on main at 4283b32.
- [x] **STACK-52 (M): Settings, second pass.** ux.md "Settings" second
  pass (2026-09-18): the settings nav with "Find a setting" and the
  section rows plus the computer group; section cards (icon, title,
  chevron) with settings rows or a things table and its action row;
  the sections General, Updates, Backups, Network and access, Alert
  channels, Storage, Maintenance, Engines, and Hardware, Diagnostics,
  Reset under the computer's name; live apply with the sticky restart
  bar for `needsRestart` keys, no Save button; unbuilt sections show
  their declared rows disabled with the item's name. Files:
  `frontend/src/pages/SettingsPage.tsx` split into
  `frontend/src/pages/settings/*`, `frontend/src/kit/settings/
  GenericForm.tsx` (live apply, the saved tick), `backend/src/settings/
  stackKeys.ts` (the sections declared with `section` and `order`,
  Rule 5's index served on `/stack/v1/settings/index`), the former
  Updates and Backups pages' content moved in. Mirror: UniFi's Settings
  in our palette; org SETTINGS.md Rules 4 to 6. Acceptance: no filled
  button on the page until a restart-pending change exists (test); a
  change applies without Save and the tick shows (test); "Find a
  setting" finds a key by label and by `@modified` (test); every
  declared section renders a card (test walks the declaration);
  captures `settings.png`, `settings-updates.png`, `settings-phone.png`
  opened and judged. Exit: `scripts/check.sh`.
  Verified on main at 5137be6.
- [x] **STACK-53 (M): things pages, second pass.** ux.md "Things pages,
  second pass" (2026-09-18): one Add pill per page opening the sheet
  with Catalog, Hugging Face and Import tabs (import by link, and a
  streamed upload from another device); a three-dots menu on every row
  driven by the same declared action list as the panel header; Rename
  inline for nicknames, the display name everywhere and the id as
  subtitle only when different; "Not adopted" visible in the status
  cell and the filter; groups shown as a chip column and managed in
  Settings > Groups with "Move to group" in the row menu and the batch
  bar. Files: `frontend/src/kit/blocks/things-table/ThingsTable.tsx`
  (the row menu), `frontend/src/kit/blocks/add-sheet/AddSheet.tsx`,
  `frontend/src/pages/ModelsPage.tsx`, `EnginesPage.tsx`,
  `frontend/src/panels/*` (one `actions` declaration per kind, shared),
  `frontend/src/pages/settings/GroupsSection.tsx`, `backend/src/routes/
  models.ts` (a search over the catalog and Hugging Face behind the
  opt-in outbound switch; the upload route), `backend/src/lib/names.ts`
  (display names). Mirror: UniFi's Devices rows and its Add Device
  flow, in our palette. Acceptance: every row has a menu whose entries
  equal the panel's actions for that kind (test walks each kind); the
  Add sheet installs a scripted catalog model and imports a scripted
  folder (tests); Rename saves and the table and panel show the new
  name (test); a detected row reads "Not adopted" and the filter finds
  it (test); Move to group from the row menu and from the batch bar
  moves the rows (test); the Groups section creates, nests and deletes
  (test); no row shows a group name as its title (test on the fixture);
  captures `models-groups.png`, `models-add.png`, `models-row-menu.png`
  opened and judged. Exit: `scripts/check.sh`.
  Verified on main at 7e9229f.
- [x] **STACK-54 (M): the phone, second pass.** ux.md "The phone,
  second pass" (2026-09-18): at phone width a five-tab bottom bar
  replaces the sidebar sheet; a one-line header (glyph, computer pill
  with the health dot, the one Add or search glyph); things pages as
  list rows (glyph tile, name and subtitle, status word and sub-status,
  dot, chevron) with pill-chip filters; detail pages as grouped
  key-value cards with placeholder rows, chevron rows and an action
  list card; the phone Overview as a status strip, 2 by 2 ability
  tiles, activity rows and a facts card; 44 px touch targets. Files:
  `frontend/src/kit/blocks/phone/*` (TabBar, PhoneHeader, ListRow,
  DetailCard, ActionList), `frontend/src/pages/DashboardShell.tsx` (the
  phone layout switch on measured width), the things pages and panels
  (a `phone` render path from the same declarations), `OverviewPage.tsx`.
  Mirror: UniFi's phone app screens described in ux.md, in our palette.
  Acceptance: at 400 wide the tab bar renders with five tabs and no
  sidebar trigger (test); a things page renders rows with the status
  word and a chevron (test); a detail page renders the action list with
  the destructive action last (test); every tappable element measures
  44 px or more (test walks the DOM at 400 wide); captures
  `overview-console-phone.png`, `models-phone.png`,
  `model-detail-phone.png`, `settings-phone.png` opened and judged.
  Exit: `scripts/check.sh`.
  Verified on main at eeb390e.
- [ ] **STACK-55 (S): Ask and the doors to local docs.** The header
  opens Ask with pages, things, live facts and shipped docs results;
  Help links to the in-app pages, API explorer and Library. An outbound
  site search is a separate opt-in with a privacy row. Acceptance:
  Ask answers a count from a stubbed route, a health item opens its
  shipped help page while offline, and no search keystroke makes a
  network request by default. Out of scope: the optional model tier
  in STACK-37.
  Files: `frontend/src/kit/blocks/dashboard/components/site-header.tsx, frontend/src/pages/DashboardShell.tsx`.
  Mirror: the current palette and local Library result.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-56 (S): the seams, written down and guarded.** (landed 2026-09-18 at 26f8b6a.) dev.md "The
  seams" is the record; this item adds the two ux.md sentences (the
  Add sheet's fourth tab "A server you run" in "Things pages, second
  pass" item 1; the Sources row in "Settings" item 3) and the
  integrations.md contract row for the metrics route (planned), then
  makes the channel seam mechanical: a `bun:test` in `backend/tests/`
  reads every `ChannelType` from `lib/channels/index.ts` and fails
  unless `docs/user/privacy.md` has a row naming it (mirror the
  update-check privacy test from STACK-10). Acceptance: the docs
  sentences exist and prose-lint clean; the test fails on a temporary
  enum entry without a row (proved, then reverted); no new sidebar row
  or Settings section. Out of scope: STACK-57 to -59. Exit:
  `scripts/check.sh`.
  Verified on main at 26f8b6a.
- [x] **STACK-57 (S, done b482d59): a Hugging Face mirror setting.** `huggingFaceEndpoint`
  in `settings/stackKeys.ts` (default `huggingface.co`, section
  Storage, Sources row), honored by `lib/hf.ts` and the supervisor's
  `HF_HUB_CACHE` path; provenance recorded identically; the privacy
  row "Downloading a model" gains "or the mirror you chose".
  Acceptance: a scripted mirror URL receives the download request
  (test); the row exists. Exit: `scripts/check.sh`.
  Verified on main at bb8a3dd.
- [ ] **STACK-58 (S, filed, not built until asked; owner agreed 2026-09-18): a `webhook` alert channel.** One
  provider in `lib/channels/providers.ts` posting the alert sentence as
  JSON to a URL the person chose, with an optional bearer token
  (encrypted like the others); the privacy row has ntfy's shape ("the
  server URL you chose"). Acceptance: the scripted receiver gets the
  test message and the verified stamp lands; the seams guard passes.
  Exit: `scripts/check.sh`.
  Files: `backend/src/lib/channels/providers.ts, docs/user/privacy.md`.
  Mirror: the ntfy provider and privacy guard.
  Out of scope: new person records or Home-side features.
- [ ] **STACK-59 (S, filed, not built until asked; owner agreed 2026-09-18): `GET /stack/v1/metrics`.** Prometheus
  text format from the data `series`, memory and health already own;
  operator or client key; read-only; no outbound row. Acceptance: the
  route renders a scripted sample set and a scraper fixture parses it
  (test). Exit: `scripts/check.sh`.
  Files: `backend/src/routes/series.ts, backend/src/routes/hardware.ts`.
  Mirror: the existing read-only series route.
  Out of scope: new person records or Home-side features.
- [ ] **STACK-60 (M): connect a coding tool.** dev.md "Agents and
  harnesses": the tool-capable wire becomes a tested contract and a
  harness gets a door. Files: `backend/src/routes/inference.ts` (add
  `GET /v1/models` listing role ids and installed model ids in OpenAI
  shape, client key or operator), `backend/src/profiles.ts` and
  `roles.ts` (`coding` resolves to chat's binding wherever chat runs,
  its own model only on p128), `backend/tests/inference.test.ts` (new
  contract tests), `frontend/src/pages/ClientKeyDialog.tsx` (a "What is
  this key for?" preset row: "A coding tool" preselects `chat`,
  `coding`, `embed`; after creation a Connect step with the address, the
  key, copy buttons for a generic `OPENAI_BASE_URL` and `OPENAI_API_KEY`
  block and for OpenCode, Aider and Continue (owner agreed 2026-09-18;
  Claude Code and Codex CLI listed as coming), model field `coding`),
  `docs/user/keys-for-your-tools.md` ("Use it with a coding tool"),
  `docs/integrations.md` (contract row for `GET /v1/models`; the connect
  sentence), `docs/ux.md` "Clients and keys" (the Connect step). Mirror:
  the streaming pass-through test from STACK-07b; `PropertyPanel` for
  the Connect step. Acceptance: a scripted engine receives `tools`,
  `tool_choice` and `response_format` unchanged and the client gets
  `tool_calls` back, streamed and unstreamed, with identity headers
  (test); `GET /v1/models` lists every role id (test); on a p32 profile
  `model: "coding"` answers from the chat binding (test); a key scoped
  to `chat` only is refused for `coding` with the existing 403 (test);
  the Connect step capture opened and judged; the user page passes
  prose lint. Out of scope: STACK-61 to -63, anything named agent in the
  UI. Exit: `scripts/check.sh`.
- [ ] **STACK-61 (M, needs a measurement): the coding role's context and
  model.** The declared minimum context for `coding` (the household's
  lane needed 32K to 64K) and its p128 model, sized by the first-run
  bench (principle 10), never assumed; the engine default of 4096 is
  raised per tier from the measurement. Acceptance: the numbers and the
  engine build recorded in dev.md; a test asserts the declared context
  per tier. Exit: `scripts/check.sh`.
  Files: `backend/src/profiles.ts, backend/src/lib/engineArgs.ts, docs/dev.md`.
  Mirror: STACK-74 bench protocol and current role binding.
  Out of scope: new person records or Home-side features.
- [ ] **STACK-62 (S, owner's call): Anthropic Messages pass-through.**
  Only when a bound engine serves the shape natively (mlx-serve); never
  a translation layer written here. Acceptance: a scripted engine
  answering the Anthropic shape is reachable at `/v1/messages` with the
  identity headers (test). Exit: `scripts/check.sh`.
  Files: `backend/src/routes/inference.ts, backend/src/lib/router.ts`.
  Mirror: the chat pass-through.
  Out of scope: new person records or Home-side features.
- [ ] **STACK-63 (S, evidence-gated): per-client caps.** Only
  after per-client usage shows a need, add request rate and concurrency
  caps at the router with a counter and one health item per cap.
  Acceptance: scripted concurrent calls hit the cap, record its counter
  and recover after the window; other clients remain unaffected. Out
  Out of scope: a global cap or a person quota.
  Files: `backend/src/lib/clients.ts`, `backend/src/lib/router.ts`.
  Mirror: the existing client usage counters.
  Exit: `bash scripts/check.sh`.
- [x] **STACK-64 (S): Scan now.** ux.md "Scan, and real over mock" item 1:
  a "Scan this computer" text action beside Add on Engines and Models
  and as the first row of the Add sheet's Import tab; runs `POST
  /stack/v1/detected/scan`, shows the found rows with Adopt and the
  sentence with counts and the last scan time. Files: `EnginesPage.tsx`,
  `ModelsPage.tsx`, `AddSheet.tsx`, `routes/detected.ts` (return counts
  and `scannedAt`). Acceptance: a scripted sweep yields the sentence
  and the rows (test); the button on the live console finds the
  installed engine directory (coordinator-verified). Exit:
  `scripts/check.sh`.
  Verified on main at 75f983b.
- [x] **STACK-65 (M): the live acceptance walk.** ux.md "Scan, and real
  over mock" item 2: on a copy of the owner's real data directory on
  this Mac, with the real llama-server and the installed Qwen3 1.7B,
  walk every action the console offers and record the result in a
  table in `docs/dev.md` "Live walk 2026-09-18": Add from the catalog,
  Import a folder by link, Scan, Adopt a detected tool (Ollama if
  present), Rename, New group, Move to group, Load, Unload, Pin,
  Remove, Start, Stop, Restart an engine, Speed test, Check my Stack,
  Pause everything and Resume, create and revoke a client key, chat in
  Tester, set and change a setting, Send a test to a channel (scripted
  receiver), Fetch the docs in the Library, the palette's intents. Each
  row: the action, the HTTP calls it made, the result, pass or fail
  with the defect filed as a follow-up item. Anything that cannot work
  yet gets its one sentence and a disabled control in the same commit.
  Acceptance: the table exists with every action listed; every fail has
  an item; no button on the console does nothing. Exit: `scripts/check.sh`.
  Verified on main at 85fda5a.
- [x] **STACK-66 (M): the app owns the daemon's lifecycle.** dev.md "The
  desktop program" item 2: the compiled daemon as a Tauri sidecar; first
  launch installs the LaunchAgent that runs it (`backend/src/service/
  launchd.ts`), later launches attach; the fallback page's Start;
  Quit keeps the daemon; an Uninstall menu item. Acceptance: a fresh
  user account on this Mac (or a cleaned LaunchAgents dir) gets a
  running daemon after the first app launch (documented live check);
  Quit leaves `/healthz` answering; Uninstall removes the agent (test on
  the plist writer). Exit: `scripts/check.sh`.
  Files: `desktop/src-tauri/src/main.rs, desktop/src-tauri/tauri.conf.json, backend/src/service/launchd.ts`.
  Mirror: the existing compiled daemon and launchd installer.
  Out of scope: new person records or Home-side features.
- [x] **STACK-67 (M): tray status in depth.** dev.md item 3. Acceptance:
  the menu model (plain TS, tested) renders every role's line, memory,
  the last check sentence and the five actions; the icon severity
  follows a scripted health change within five seconds (test on the
  model with an injected clock); screenshots of the menu judged.
  Exit: `scripts/check.sh`.
  Files: `desktop/src-tauri/src/main.rs, backend/src/routes/roles.ts, backend/src/routes/budget.ts`.
  Mirror: the existing tray poll and role text.
  Out of scope: new person records or Home-side features.
- [x] **STACK-68 (S): notifications a person wants.** dev.md item 4.
  Acceptance: only durable events notify (test); each carries an Open
  action (test on the model); the per-kind switches exist in Settings >
  Alerts (test). Exit: `scripts/check.sh`.
  Files: `desktop/src-tauri/src/main.rs, backend/src/events.ts, frontend/src/pages/SettingsPage.tsx`.
  Mirror: the durable event templates and alert channels.
  Out of scope: new person records or Home-side features.
- [ ] **STACK-69 (S): Help in the app.** dev.md item 5. Acceptance: the
  Help page lists every user doc from the shipped index and renders
  one (test); "Learn more" on a health item lands on it offline (test).
  Exit: `scripts/check.sh`.
  Files: `frontend/src/pages/, docs/user/, docs/site/`.
  Mirror: the current Library page and local docs index.
  Out of scope: new person records or Home-side features.
- [x] **STACK-70 (M): the user docs, complete for a release.** dev.md
  item 6. Acceptance: the eight pages exist, pass the reading-level
  lint, each with a generated screenshot opened and judged; the docs
  site builds. Exit: `scripts/check.sh`.
  Files: `docs/user/, docs/assets/screens/, docs/site/`.
  Mirror: the existing user pages and showroom captures.
  Out of scope: new person records or Home-side features.
- [ ] **RELEASE-STACK-01 (M): the release build and manifests.** dev.md
  item 7: `scripts/build-release.sh` produces the daemon binary, the
  `.dmg`, `SHA256SUMS`, the three update manifests and the changelog
  section; a dry run on this Mac produces every artifact (documented);
  the release skill's checks (NOTICE current for pagefind and the MCP
  SDK, the README disclaimer block, clean-clone build) pass. Exit:
  `bash scripts/check.sh`.
  Files: `scripts/build-release.sh, scripts/release-entry.ts, desktop/src-tauri/tauri.conf.json, CHANGELOG.md, NOTICE`.
  Mirror: the current daemon-only release script.
  Out of scope: new person records or Home-side features.
  Acceptance: the named flow passes an offline scripted test and its documented live check.
- [x] **SITE-STACK-01 (S): the org site hosts install.sh.** The
  installer served at `getmaipai.github.io/stack/install.sh` from the
  docs site build, pinned to the latest release's assets by checksum;
  the privacy row already names it. Acceptance: the built site contains
  the script and its checksum matches the release asset (test in the
  site build). Exit: `scripts/check.sh`.
  Files: `docs/site/, installer/install.sh, docs/user/install.md`.
  Mirror: the current local installer and site build.
  Out of scope: new person records or Home-side features.

## Robot area

- [ ] **STACK-17 (L): the Linux ARM profile.** Run the robot's
  chat, embed and judge roles on pinned `llama-server`, register the
  body's speech process as managed, and take the body's power and
  thermal budget into the one governor. Confirm against `bot/docs/dev.md`
  sections 2 and 4 before building. Files: `backend/src/profiles.ts`,
  `backend/src/lib/memory/linux.ts`, `docs/integrations.md` and the
  robot's managed-engine adapter.
  Mirror: the Mac profile declaration
  and the Bot design record. Acceptance: on the robot, all three
  language roles return identity headers; the speech host going away
  reports offline; a scripted thermal limit defers a load without
  changing the body's sensor loop. Out of scope: people, pairing and
  Home migration. Exit: `bash scripts/check.sh` and a robot live check.

## Docs and site area

- [x] **DOCS-01 (S): user docs site.** Astro Starlight under `docs/site/`
  with the user tier (Get started, Fix a problem, Privacy), the first
  user pages in `docs/user/`, built locally;
  publishing to GitHub Pages is a later item).
  Verified on main at da29251.
- [x] **DOCS-02 (S): the Stack logo.** Done 2026-09-17: the mark and
  wordmark in `getmaipai/.github/brand/` as `maipai-stack-*`.
  Verified on main at bfe5538.

## Release and migration gaps (opened by the 2026-09-18 review)

- [ ] **STACK-71 (M): complete the settings contract.** Give each
  declared key its local disclosure level, default and reset action;
  generate the settings reference from the index; make `@modified`
  and the supported search filters work; align the port default and
  daemon address; expose a section master
  switch only where it controls a real section. Files:
  `backend/src/settings/stackKeys.ts`, `backend/src/routes/settings.ts`,
  `frontend/src/kit/settings/GenericForm.tsx`, `frontend/src/pages/SettingsPage.tsx`,
  `docs/user/settings.md`.
  Mirror: the current live-apply renderer and
  org `docs/SETTINGS.md` Rules 4 to 6. Acceptance: a test walks every
  declared key and proves its default, reset, help, level and reference
  entry; the configured port becomes the daemon and desktop address
  after restart; `@modified` finds a changed key and reset removes it.
  Out of scope: new settings or a global advanced mode. Exit:
  `bash scripts/check.sh`.
- [ ] **STACK-72 (M): declared, encrypted state backup and staged restore.**
  Declare `stack.db` as hot state and model and engine bytes as excluded;
  create a local AES-256-GCM archive with its key in the OS keystore,
  show an emergency recovery kit once, sign the archive, and stage a
  restore beside live data before swapping. Files: `backend/src/db/`,
  `backend/src/routes/`, `frontend/src/pages/SettingsPage.tsx`,
  `docs/user/backups.md`. Mirror: org `docs/BACKUPS.md` and the
  existing update rollback pattern. Acceptance: an offline test exports
  and restores into a fresh directory, refuses a tampered archive, and
  leaves live data unchanged after a failed restore; the UI lists
  included and excluded bytes. Out of scope: scheduled targets and
  the later `metrics.db` split. Exit: `bash scripts/check.sh`.
- [ ] **STACK-73 (S): audit the first release's privacy and licence
  surface.** Align the privacy table with every outbound call and
  install artifact, check the README disclaimer against the current
  org wording, and show model licence and gated terms before download.
  Files: `docs/user/privacy.md`, `docs/user/install.md`,
  `backend/src/lib/hf.ts`, `frontend/src/kit/blocks/add-sheet/AddSheet.tsx`,
  `NOTICE`, `README.md`. Mirror: the channel/privacy guard and the existing model
  provenance record. Acceptance: an endpoint inventory test names the
  release, model, Library and channel hosts and finds a row for each;
  a gated model cannot start a download without the operator's choice.
  Out of scope: adding an outbound host. Exit: `bash scripts/check.sh`.
- [ ] **STACK-74 (M): Studio bench protocol and rollback rehearsal.**
  Fix the model files, context, engine builds, request mix, pressure
  samples and pass thresholds before STACK-14 runs; record the
  baseline from `llama-server` and the recovery path after a failed
  engine update. Files: `docs/dev.md`, `scripts/bench/`,
  `backend/src/lib/speedTest.ts`.
  Mirror: the existing speed test and
  `docs/plans/operations-design-2026-09-17.md`. Acceptance: one
  reproducible command logs model digest, build, sanitized hardware,
  footprint, first token, throughput and pressure, plus a recorded
  rollback rehearsal. Out of scope: Home migration or a model winner
  before measurement. Exit: `bash scripts/check.sh` and the named
  live bench command in its report.
- [ ] **STACK-75 (M): pin the Stack/Home contract before migration.**
  Make the Stack's role, identity, offline, event and authorization
  fixtures consumable by Home's gate and record the minimum compatible
  Stack version. Files: `backend/tests/`, `docs/integrations.md`,
  `home/backend/tests/` in the Home worktree when its brief starts.
  Mirror: `backend/src/app.ts` routes and the existing OpenAPI drift
  check. Acceptance: both repos run the same fixture set for success,
  403, 409 and 503 responses and event names against the pinned
  version; removing a relied-on field fails it. Out of scope: moving
  any supervisor or person record. Exit: `bash scripts/check.sh` in
  each touched repo.

- [ ] **STACK-76 (M): authenticate native tray actions through the
  console.** Keep `/healthz` as the only anonymous native poll; pass
  protected status and commands through the webview's operator session
  and show a sign-in action when it expires. Files:
  `desktop/src-tauri/src/main.rs`, `frontend/src/kit/host.ts`,
  `frontend/src/pages/DashboardShell.tsx`, `backend/src/routes/runState.ts`.
  Mirror: the existing session-backed console fetches and the current
  tray menu. Acceptance: with an operator password set, the tray
  displays real roles and health and Pause and Resume succeed; after
  logout, protected data disappear and actions open sign-in; no
  unauthenticated run-state call succeeds. Out of scope: a new auth
  bypass, bundled administrator key or changed child safety path.
  Exit: `bash scripts/check.sh` and a live bundled-app check.

- [ ] **STACK-77 (M): backup targets and schedule.** Add local and SMB
  targets through one backup-agent port, encryption before a byte leaves
  the computer, nightly backup before updates, and seven daily, four
  weekly and three monthly retained copies with a size cap. Files:
  `backend/src/lib/backup/`, `backend/src/routes/`,
  `frontend/src/pages/SettingsPage.tsx`, `docs/user/backups.md`,
  `docs/user/privacy.md`. Mirror: org `docs/BACKUPS.md` and the
  maintenance scheduler from STACK-22; until STACK-22 lands use a
  bounded built-in schedule. Acceptance: a scripted SMB target sees
  only ciphertext, two failures raise a health item, and a scripted
  clock enforces retention. Out of scope: S3 and Home as a target.
  Exit: `bash scripts/check.sh`.
- [ ] **STACK-78 (S): prove restore in the release gate.** Before an
  update or restore, make a backup; in the release workflow, restore
  the latest archive into a temporary directory and boot it headlessly
  through operator sign-in. Files: `scripts/build-release.sh`,
  `backend/tests/`, `docs/user/backups.md`. Mirror: org
  `docs/BACKUPS.md` "Restore drill" and the existing launchd smoke test.
  Acceptance: a dry-run release logs the restored schema and sign-in;
  a corrupt archive aborts before a tag can be cut. Out of scope:
  copying model or engine binaries. Exit: `bash scripts/check.sh` and
  the release dry-run command.

## Product review follow-ups (2026-09-18)

The reasoning and field evidence are in
[`plans/stack-product-review-2026-09-18.md`](plans/stack-product-review-2026-09-18.md).
These items add release proof and correct first-run gaps. They do not
move the Stack across its client boundary.

- [ ] **STACK-79 (M): a first useful answer from a fresh Mac install.**
  Put a small proven starter setup ahead of the management Overview:
  measured machine fit, model and disk size, the role it enables,
  download progress, a first Tester response, then the return
  dashboard. Files: `frontend/src/pages/BoardPage.tsx`,
  `frontend/src/pages/OverviewPage.tsx`,
  `backend/src/routes/setupPlan.ts`, `backend/src/lib/modelCatalog.ts`,
  `docs/ux.md`, `docs/user/install.md`. Mirror: the existing setup
  plan and STACK-74 measurement protocol. Acceptance: from a clean
  data directory on the smallest supported Mac, the operator can
  choose the curated chat setup, see its licence and disk cost,
  install, get one local answer, and recover from an offline or
  insufficient-space result without entering an engine setting.
  Out of scope: a conversation history, person record or an
  unmeasured all-modality plan. Exit: `bash scripts/check.sh` and a
  recorded clean-install walk.
- [ ] **STACK-80 (M): truthful model discovery and install metadata.**
  Separate opt-in Hugging Face search from update checks; resolve a
  selected repository to an immutable revision, actual files,
  licence and size before offering Install; prove the proposed role
  from model metadata or a supported format, and refuse unknown
  ability or gated terms until the operator chooses. Files:
  `backend/src/routes/catalog.ts`, `backend/src/lib/hf.ts`,
  `frontend/src/kit/blocks/add-sheet/AddSheet.tsx`,
  `docs/user/privacy.md`. Mirror: STACK-04 provenance, STACK-73
  licence gate and the official `@huggingface/hub` metadata API.
  Acceptance: a scripted HF response for a chat GGUF, an image
  repository, a gated model and an unsupported repository yields
  distinct honest results; no row says it fits without a supported
  size calculation; search sends no request when its own switch is
  off. Out of scope: adding an outbound host or fetching all search
  results. Exit: `bash scripts/check.sh`.
- [ ] **STACK-81 (M): choose a maintained Hugging Face cache path.**
  Compare the current downloader and cache writer with official
  `@huggingface/hub` cache downloads under Bun, including pinned
  revisions, resume, progress, independent SHA-256 verification,
  symlink behavior and a read-only import of another tool's file.
  Adopt the library where those checks pass and keep Stack's
  provenance record separate from a Hub blob name. Files:
  `backend/src/lib/download.ts`, `backend/src/lib/modelStore.ts`,
  `backend/src/lib/store/hfCache.ts`, `backend/package.json`,
  `docs/dev.md`. Mirror: STACK-04b store rules and the official Hub
  cache layout. Acceptance: one offline fixture and one pinned live
  pull yield the same files and revision; interrupted and tampered
  pulls never become selectable; document any feature the library
  cannot supply before retaining custom code. Out of scope:
  weakening checksums or changing engine downloads. Exit:
  `bash scripts/check.sh` and the pinned pull command.
- [ ] **STACK-82 (M): make the console's visible actions and status
  usable.** Put repair actions and ready abilities ahead of charts
  on return Overview; show detected hosts away from installed models;
  label panel actions; wire phone Add, Search and Group; ensure the
  tab bar never covers content. Files:
  `frontend/src/pages/OverviewPage.tsx`,
  `frontend/src/pages/ModelsPage.tsx`,
  `frontend/src/pages/DashboardShell.tsx`, `frontend/src/panels/`,
  `frontend/src/kit/blocks/phone/`, `docs/ux.md`,
  `docs/assets/screens/`. Mirror: the one action list in
  `frontend/src/lib/actions.ts`, UniFi's drill-down pattern in
  `docs/ux.md`, and the review's capture findings. Acceptance:
  keyboard and phone users can reach every named action in two
  steps from its row; no visible control has a no-op handler; a
  fresh capture set shows one consistent nav and no content behind
  the tab bar. Out of scope: a new chart or a second phone API.
  Exit: `bash scripts/check.sh` and
  `bun scripts/screenshot.ts --showroom`.
- [ ] **STACK-83 (M): test the product promise on clean installs.**
  Run the built app and daemon on a clean Mac profile, the smallest
  supported Mac profile and a developer's existing Ollama install;
  record time and actions to first answer, disk and memory cost,
  whether an adopted host is left untouched, a failed download,
  one repair, restart and restore. Have three people who did not
  build Stack try the starter path without coaching. Files:
  `docs/plans/stack-product-review-2026-09-18.md`,
  `docs/user/install.md`, `scripts/build-release.sh`.
  Mirror: STACK-79, STACK-74 and STACK-78 checks. Acceptance: each
  run records sanitized steps, observed outcomes, failures and fixes;
  the release promise names only capabilities that passed. Out of
  scope: analytics, telemetry or personal test data. Exit:
  `bash scripts/check.sh --docs` and the recorded build and walk
  commands.
- [ ] **STACK-84 (M): prove app and daemon update compatibility.**
  Evaluate Tauri's signed updater against the Stack app manifest;
  publish one compatibility range for the app, daemon and role API;
  rehearse a failed app update and an engine rollback on a clean Mac.
  Files: `desktop/src-tauri/`, `backend/src/updates/`,
  `scripts/build-release.sh`, `docs/dev.md`,
  `docs/user/update.md`. Mirror: RELEASE-STACK-01 and STACK-75
  contract fixtures. Acceptance: a bad or mismatched update leaves
  the previous app and daemon usable and gives an exact repair
  action; the signature and checksum checks both fail closed.
  Out of scope: automatic model revision changes. Exit:
  `bash scripts/check.sh` and a release dry run.
- [ ] **STACK-85 (S): one local search path for Help and Library.**
  Compare the shipped Pagefind index, the fetched Library index and
  the substring search route under the compiled daemon; use the
  maintained Pagefind API where it can serve both sets offline,
  with citations and exact links. Keep Ask's deterministic commands
  finite and count their use, without adding a phrase list. Files:
  `backend/src/lib/library.ts`, `frontend/src/pages/DashboardShell.tsx`,
  `frontend/src/pages/LibraryPage.tsx`, `docs/ux.md`.
  Mirror: STACK-33, STACK-55 and STACK-37. Acceptance: a shipped
  help page and a fetched model page are both found offline with
  source links; a missing page says why; an unsupported Ask query
  gives search results instead of an invented repair. Out of
  scope: a dedicated helper model or outbound search. Exit:
  `bash scripts/check.sh`.
- [ ] **STACK-86 (M): qualify the first Mac chat pin.** Resolve the
  curated Qwen GGUF to an immutable Hub commit and exact file SHA-256;
  record licence, file and disk bytes, supported llama-server build,
  conservative memory estimate and a measured first-load result on the
  smallest Mac class claimed by v0.1.0. Files:
  `backend/src/lib/modelCatalog.ts`, `backend/src/lib/engineCatalog.ts`,
  `backend/src/lib/setupPlan.ts`, `backend/src/routes/catalog.ts`,
  `docs/dev.md`. Mirror: STACK-04 provenance and STACK-74 bench
  protocol. Acceptance: a changed Hub `main`, wrong digest, insufficient
  disk and unsupported Mac each produce a precise refusal; a clean
  supported Mac completes one authenticated chat request and records
  peak memory and speed. Out of scope: general Hub search, another model
  format or a new outbound host. Exit: `bash scripts/check.sh` and the
  pinned live pull and load. Reason: the first install needs an immutable,
  measured promise before the wider discovery work in STACK-80 and
  STACK-81.
- [ ] **STACK-87 (M): make ready and current claims time-bound.** Tie
  the overview and tray's ready state to a recent authenticated request
  through the public chat role and expected engine/model identity; mark
  the result stale after a pin, model, engine or settings change. Distinguish
  installed, loaded, ready, not checked and check failed. The release
  update badge names the last successful check and says unknown when its
  signed manifest is missing or invalid; skipped non-chat roles cannot
  make the overall check green. Files: `backend/src/lib/checkMyStack.ts`,
  `backend/src/updates/check.ts`, `backend/src/updates/manifests.ts`,
  `backend/src/routes/check.ts`, `frontend/src/pages/OverviewPage.tsx`,
  `docs/user/update.md`. Mirror: the current post-load check, health list
  and STACK-84 compatibility plan. Acceptance: scripted stale identity,
  skipped role, invalid manifest and real chat success produce different
  status and repair text; a live check after restart records its time and
  identity. Out of scope: probing uninstalled modalities or changing the
  safety, consent or privacy paths. Exit: `bash scripts/check.sh` and the
  live chat check. Reason: an HTTP 200 or old cached result must not be
  shown as a current working Stack.

## Capability-matrix release gates (2026-09-18)

These items implement the bounded cells in the
[v0.1.0 matrix](plans/v0.1.0-capability-matrix.md). A scripted route
test is necessary but does not replace the named clean-account walk.

- [ ] **STACK-88 (M): prove the full verified-model lifecycle.** Make
  rename, nested group and move, load, unload, pin and unpin, and remove
  work from the real Models page for a qualified GGUF, preserving store
  references and state after restart. Files: `backend/src/routes/models.ts`,
  `backend/src/routes/groups.ts`, `backend/src/lib/modelStore.ts`,
  `frontend/src/pages/ModelsPage.tsx`, `backend/tests/`.
  Mirror: the temporary-data live walk in `dev.md` and STACK-04c.
  Acceptance: on a fresh account install one qualified model, perform
  every named action from its row, restart, confirm group, residency and
  pin state, then remove it without deleting shared or imported bytes.
  Out of scope: changing another tool's store or controlling its process.
  Exit: `bash scripts/check.sh` and the recorded clean-account C3 walk.
- [ ] **STACK-89 (M): qualify coding and embedding model roles and
  client keys.** Pin one supported GGUF per role only where the selected
  llama build and minimum Mac profile can pass a real request; show an
  honest unavailable state if either fails. Check role-scoped key use,
  revocation and the Tester on the same wire. Files:
  `backend/src/lib/modelCatalog.ts`, `backend/src/routes/inference.ts`,
  `backend/src/routes/clients.ts`, `frontend/src/pages/TryItPage.tsx`,
  `backend/tests/`, `docs/dev.md`.
  Mirror: STACK-86 qualification, STACK-07 router and STACK-74 bench.
  Acceptance: from a fresh supported account each published coding or
  embedding pin completes a role-appropriate client and Tester request
  with expected identity and measured memory/disk; wrong-role and revoked
  keys fail, and an unqualified pin cannot be offered.
  Out of scope: voice, media, arbitrary Hub repos or a new engine.
  Exit: `bash scripts/check.sh` and the recorded C6 and C13 walks.
- [ ] **STACK-90 (M): update one installed model revision safely.** Watch
  a pinned repository revision, resolve changed files and licence before
  offering an update, stage verified bytes, run the role, retain the old
  revision until success, and restore it on failure. Files:
  `backend/src/updates/models.ts`, `backend/src/routes/updates.ts`,
  `backend/src/lib/modelStore.ts`, `frontend/src/pages/ModelsPage.tsx`,
  `backend/tests/`, `docs/user/update.md`.
  Mirror: STACK-04 provenance, STACK-81 cache checks and the existing
  engine rollback pattern. Acceptance: on a fresh account a new pinned
  chat revision reports exact changed files, size and terms; an update
  passes a role request and removes the old revision only after success;
  a tampered or incompatible revision rolls back to the working model.
  Out of scope: automatic revision changes or a claim for every Hub repo.
  Exit: `bash scripts/check.sh` and the recorded C4 walk.
- [ ] **STACK-91 (M): monitor owned engines and detected hosts honestly.**
  Show identity, provenance, state and observed-at time for llama-server,
  mlx-serve, ComfyUI and detected local hosts where actually present.
  Enable start, stop and restart only for a Stack-owned llama process;
  a missing or stale external host becomes offline, not ready. Files:
  `backend/src/routes/engines.ts`, `backend/src/routes/detected.ts`,
  `backend/src/lib/detect.ts`, `frontend/src/pages/EnginesPage.tsx`,
  `backend/tests/`.
  Mirror: STACK-34 detection and the temporary-data engine live walk.
  Acceptance: a fresh account scans a real owned engine and a scripted
  local external host, sees their separate identities and timestamps,
  exercises owned start, stop and restart, then loses the external host
  without an attempted control call or false ready badge.
  Out of scope: installing, updating or controlling external processes.
  Exit: `bash scripts/check.sh` and the recorded C5 walk.
- [ ] **STACK-92 (S): make every unavailable control honest.** Apply the
  matrix's disabled-control inventory to the real console and phone;
  remove the media Tester placeholder action, cache-clearing no-op and
  actions that appear available without a qualified host. Files:
  `frontend/src/pages/TryItPage.tsx`, `frontend/src/pages/SettingsPage.tsx`,
  `frontend/src/pages/DashboardShell.tsx`, `frontend/src/pages/EnginesPage.tsx`,
  `frontend/src/pages/ModelsPage.tsx`, `frontend/src/kit/blocks/add-sheet/`,
  `frontend/tests/`.
  Mirror: `docs/ux.md` "Scan, and real over mock" item 2 and STACK-82.
  Acceptance: on a fresh account every visible control is exercised on
  desktop and phone; unavailable operations are disabled with the
  matrix sentence, and no enabled control has a no-op or placeholder
  handler. Out of scope: qualifying a new engine or modality.
  Exit: `bash scripts/check.sh` and the recorded C8 walk.

The [capability matrix](plans/v0.1.0-capability-matrix.md) restores
bounded Hub discovery and a verified download path (STACK-80 and
STACK-81) to the v0.1.0 gate. It does not promise that every search result
is runnable. STACK-84 is also a release gate: an app and daemon
update must fail safely before v0.1.0 promises updates. No item for
universal control of third-party memory or automatic installs of every
modality is opened: those promises have no bounded acceptance test for
this team.
