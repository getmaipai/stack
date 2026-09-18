# Backlog

What is built and what is missing in MaiPai Stack, per area. Scannable,
not narrative: the reasoning lives in [`dev.md`](dev.md), the experience
in [`ux.md`](ux.md), the seams in [`integrations.md`](integrations.md).
Update this file in the same commit as the change that closes or opens a
gap; the status dashboard reads it directly.

Size tags: **S** (a session or less), **M** (a real slice, days), **L**
(a platform-level capability, needs its own design pass first).

**Execution contract for every item:** read `dev.md` and the named files
before editing. Work on `main`. Bun, Hono with `@hono/zod-openapi`, Zod,
SQLite through Drizzle, React and Vite on `@maipai/ui`; tests in
`bun:test`, deterministic and offline, engines driven by scripted
stand-ins. Every item exits with `bash scripts/check.sh` in addition to
its named check. Hard-won logic is copied from the hub's engine files
(named per item) and re-read, never re-invented; feature scope and UI are
never copied. No item migrates the hub until STACK-16.

## Milestone 0: the Stack runs the Studio beside the hub

- [x] **STACK-00 (M): the design.** `dev.md`, `ux.md`,
  `integrations.md`, the privacy page, this backlog, the org decision
  record. Done 2026-09-17.
- [x] **STACK-01 (S): repo scaffold.** `package.json` with Bun and Hono,
  `@hono/zod-openapi` wired with the explorer at `/api/docs`, Drizzle
  and SQLite under `data/`, one health route, `scripts/check.sh` running
  lint, format, tests and the standards core (mirror
  `home/scripts/check.sh`), `.env.example`. Verified at bf9bd7f. Acceptance: `bun start`
  serves `/api/docs` and `/healthz` on the default port; `check.sh`
  green. Out of scope: any engine.
- [x] **STACK-02 (M): hardware probe and profiles.** CPU, GPU class,
  unified or discrete memory, free disk, OS; the profile tiers and their
  role lists as one declaration. Mirror `home/backend/src/lib/hardware.ts`.
  Acceptance: `GET /stack/v1/hardware` on the dev Mac reports real values;
  a unit test for each tier's proposal from a scripted probe. Verified at fffabe5. Out of
  scope: the bench.
- [x] **STACK-03 (M): engine catalog and downloads.** Pinned builds per
  platform (version, URL, sha256 recorded here), resumable checksummed
  downloads with a clear offline failure. Copy the hard-won parts of
  `home/backend/src/lib/engineCatalog.ts`, `modelDownload.ts`,
  `modelDownloadJobs.ts`. Acceptance: `llama-server` for macOS arm64
  downloads, verifies and runs `--version`; a test proves a checksum
  mismatch refuses the build. Verified at 1c6d0aa. Out of scope: spawning.
- [x] **STACK-04 (M): the model store and provenance.** The model record
  (`dev.md`, "The model store and provenance"); install from a Catalog
  `model` package and from a Hugging Face repo; a model is selectable only
  with checksum and licence recorded. Acceptance: the record round-trips
  with id, provenance and clock stamp; an unverified model cannot be
  bound to a role (test). Committed, updates outstanding (STACK-10).
- [x] **STACK-04b (M): the content-addressed store, imports and ranged
  downloads.** Hugging Face layout, engine tags and manifests, five-tool
  import scan, reference-counted remove, storage accounting, and migration.
  Verified at 2665498; Windows and non-range servers use the documented
  fallback paths.
- [x] **STACK-04c (M): nicknames, nested model groups and utilization.**
  Nullable display nicknames, one-group model placement, persistent nested
  groups, per-model usage and load seconds, rollups, group actions, and the
  grouped Models and Monitoring surfaces. Verified at <hash>.
- [x] **STACK-34 (M): detect and adopt.** Loopback-only probes for local
  engines and known model folders, persisted detection rows, explicit
  operator adoption or forget, managed-host registration, folder linking,
  version-floor health, and Engines/Models actions. Verified at <hash>.
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
- [x] **STACK-06 (M): the governor.** Profile, admission, one generator,
  eviction (TTL, LRU, pin), the cap, `keep_alive` as a hint; every rule
  readable as a sentence on the Hardware page. Seed from
  `home/backend/src/lib/resourceGovernor.ts`. Acceptance: a test per
  rule with scripted memory readings; a queued job reports its position.
  Verified at <hash> with scripted readings; live pressure behavior on the
  Studio is STACK-14.
- [x] **STACK-06b (M): the kernel's memory ledger.** Three OS readers behind
  one interface, kernel pressure watermarks, measured process footprints,
  and dry-run model sizing. Verified at f682ed0; the Windows reader is a
  named stub because it could not be tested on this Mac.
- [x] **STACK-07 (M): roles and the router.** The role declaration, role
  by name in `model`, the OpenAI-shaped endpoints for text, embeddings,
  audio and images, the streaming speech sessions. Acceptance: an
  unmodified OpenAI client library completes a chat, an embedding, a
  transcription and a speech render against scripted engines; role
  scoping refuses a disallowed role with a clear error. Committed, engine binding completed by STACK-05.
- [x] **STACK-07b (S): streaming completions and speech.** Chat streams
  pass through with identity headers, cancellation, and usage counters;
  phrase-level TTS streaming remains the contract for its future engine.
  Verified at <hash>.
- [x] **STACK-08 (M): operator login and client keys.** Password login,
  keys hashed at rest and shown once, allowed roles, counters, revoke;
  loopback requires a key. Mirror the hub's `auth.ts` and `lib/secrets`
  pattern. Acceptance: a revoked key is refused within one request; the
  key never appears in a log or a response after creation (test). Verified
  at <hash>.
- [x] **STACK-09 (M): events and notifications.** The SSE feed with the
  typed events in `dev.md`; the Notifications page; the Repairs list.
  Acceptance: an engine crash produces `engine.state` and a Repairs row
  with one action (test); Home's bridge shape documented in the API. Verified at dd781aa (the tick and the changelog line were added at landing; the lane's commit omitted them).
- [x] **STACK-09b (M): one daemon-owned health list.** Idempotent health
  items with severity, cause, Fix or Learn more, resolve and ignore routes,
  producer codes, and the Repairs compatibility alias. Verified at f866376.
- [x] **STACK-10 (M): updates.** Opt-in check, conditional manifests,
  engine swap and rollback, and a non-applying model revision watch.
  Verified at 8ee0683; release manifest generation remains RELEASE-STACK-01.
- [x] **STACK-19 (M): engine management.** Operator controls, declared
  per-engine configuration with pending restart values, derived version
  state, install progress, protected removal, and the Engines page. Verified
  at cd7303b.
- [x] **STACK-35 (M): property panel.** One reusable docked or mobile-sheet
  panel for engines, models, and detected stores with actions, tabs, keyboard
  selection, and inline destructive confirmation. Verified at da31809.
- [x] **STACK-41 (M): the things table.** One reusable real-table block for
  Engines, Models, Access and Alerts with status dots, groups, selection,
  sorting, links and quiet action rows. Verified at 036b70e.
- [x] **STACK-42 (M): the property panel, refined.** Icon quick actions,
  overview/insights/settings tabs, quick facts, paired primary actions, and
  copyable key-value metadata across engines, models, groups, detected stores,
  clients and channels. Verified at 530e0b0.
- [x] **STACK-43 (M): the filter column.** A reusable search and collapsible
  checkbox filter column with live counts, clear behavior, and a responsive
  sheet on Engines, Models, and Access. Verified at eb41d14.
- [x] **STACK-45 (M): Overview's facts column and controls.** A facts column
  for this computer, persisted usage ranges with ability filters, measured
  memory and storage status, and activity and health list cards. Verified at
  74b1752.
- [x] **STACK-36 (M): Overview console.** Range-aware usage, memory, and speed
  series backed by durable samples, with seven widgets, status rings, and
  showroom captures. Verified at ed67582.
- [x] **STACK-11 (M): the admin UI, first run and the board.** committed:
  first run steps 1 to 3 and 5, login, the board; the downloading step
  and Try it are STACK-12. The five
  first-run steps and the board from `ux.md`, on `@maipai/ui`, generated
  screenshots against a scripted engine set, each opened and judged.
- [x] **STACK-12 (M): Try it.** The stateless chat, voice, and generator
  role tabs, copied shadcn chat primitives, operator acknowledgement, and
  scripted visual captures are shipped. The pinned Qwen3 1.7B chat model
  installs through the setup plan; a live completion remains outstanding
  when the governor cannot admit the model. Verified at cd56396.
  Acceptance: a fresh data directory completes first run headlessly in
  Playwright and lands on a green board; the "Share with your family"
  card renders. Out of scope: the menu bar.
- [x] **STACK-11b (M): the board is first open, with no wizard.** Committed
  with a scripted download; the real store lands in STACK-04b. The board
  measures the computer, lets the operator choose abilities, and keeps an
  honest download bar visible while the deferred password stays deferred.
- [x] **STACK-11c (M): the dashboard shell.** The branded Stack sidebar,
  search and command palette, all twelve sections, real monitoring and
  alert actions, and honest empty states for the work still to come.
- [x] **STACK-12 (M): Try it.** The stateless tabs per role with the
  adult acknowledgment once and the AI-outputs disclaimer at first run.
  Acceptance: each tab exercised in Playwright against scripted engines;
  the acknowledgment shows exactly once per operator (test).
  Landed: the tick with its verified commit is the STACK-12 line in
  milestone 0; this entry is the design.
- [ ] **STACK-13 (M): jobs and the managed ComfyUI.** The job API,
  progress on the feed, cancel, results by id, the synchronous wrapper;
  ComfyUI as a managed host for image edits. Acceptance: a scripted job
  reports progress and cancels cleanly; the wrapper returns an OpenAI-
  shaped image response.
- [ ] **STACK-14 (L): the Studio bench and the MLX engines.** `mlx-serve`
  and `oMLX` as spawned candidates beside `llama-server` and `mlx-lm`,
  measured on the Studio with the residency profiles in the hub's
  `docs/plans/hub-on-apple-silicon-2026-09-17.md` section 3; multi-model
  memory behavior recorded. Needs its own bench design first.
  Acceptance: numbers with engine build, model file and a sanitized
  hardware line in `dev.md`; a chosen Studio profile.
- [x] **STACK-15 (M): service install.** launchd on macOS with the
  data-directory permissions, an installer script, start, stop, pause
  and resume; the menu-bar item after the web UI. Verified with a
  temporary launchd label on this Mac; the release asset and hosted
  script land with the first release.
- [x] **STACK-15b (S): the one-line installer and compiled binary.** A
  checksum-verified macOS arm64 installer embeds the board, installs the
  launchd agent, restarts cleanly on re-run, and keeps data on uninstall.
  Verified with a temporary launchd label on this Mac; the release asset
  and hosted script land with the first release.
- [ ] **STACK-16 (L): Home runs on the Stack.** The hub's migration list
  in `dev.md`; Home registers as a client, calls by role, bridges events,
  and deletes its own supervisors. Lands in the `home` repo as its own
  items after STACK-14 proves the Studio profile. Needs its design pass
  in `home/docs/dev.md` first.

## Milestone 0b: what the field survey changed (2026-09-17)

Decided in [`plans/operations-design-2026-09-17.md`](plans/operations-design-2026-09-17.md);
each item's design section lands in `dev.md` before its code.

- [x] **STACK-07b (M): streaming.** `stream: true` on `/v1/chat/completions`
  proxies the engine's SSE token stream with the identity headers on
  the response, cancellation on client disconnect, and the
  phrase-level TTS stream for `/v1/audio/speech`. Files: `backend/src/lib/supervisor.ts`,
  `routes/inference.ts`. Acceptance: an unmodified OpenAI client
  receives streamed deltas from a scripted engine; disconnect aborts
  the engine request without retiring the backend (test). Exit:
  `bash scripts/check.sh`.
  Landed: the tick with its verified commit is the STACK-07b line in
  milestone 0; this entry is the design.
- [x] **STACK-06b (M): the governor reads the kernel's ledger.** A
  `bun:ffi` memory reader (`kern.memorystatus_level`,
  `kern.memorystatus_vm_pressure_level`, `host_statistics64`,
  `proc_pid_rusage` phys_footprint) with Linux and Windows twins
  behind one interface; soft and hard watermarks; the dry-run
  measurement path (`llama-fit-params` for GGUF) and the measured
  footprint stored per model and context; `os.freemem()` removed.
  Acceptance: on this Mac the reader's free percent matches
  `memory_pressure` within one point (pasted); watermark tests with
  scripted readings; a model's badge shows a dry-run number. Exit:
  `bash scripts/check.sh`.
  Landed: the tick with its verified commit is the STACK-06b line in
  milestone 0; this entry is the design.
- [x] **STACK-04b (L): the store layout, import, remove.** Models in
  the Hugging Face cache layout under `data/models/hub`; engines as
  `data/engines/<name>/<tag>/` with a manifest and a `current` link;
  the import scan of other tools' directories with links, never
  copies; ranged parallel downloads with per-part resume and a
  full-file hash; reference-counted remove with a one-hour prune
  grace. Design section first. Acceptance: a model in a temp
  `HF_HUB_CACHE` is imported by link and served; a blob shared by two
  manifests survives one remove; the tests from STACK-03 and -04
  still pass. Exit: `bash scripts/check.sh`.
  Landed: the tick with its verified commit is the STACK-04b line in
  milestone 0; this entry is the design.
- [ ] **STACK-04d (S): the store writes through `@huggingface/hub`.**
  Replace `store/hfCache.ts`'s hand-written layout writer with the
  official client's `downloadFileToCacheDir` behind `lib/hf.ts` (the
  dependency rule: one adapter, the format's owner writes the format),
  keeping the read side and the tests; verify in the installed source
  that it produces `models--<org>--<repo>/{blobs,refs,snapshots}` and
  cite the line. Acceptance: the store tests still pass; a NOTICE line.
- [x] **STACK-09b (M): one health list.** Health items (code, severity,
  title, text, since, cause, one fix, learn-more), keyed and
  idempotent, `GET /stack/v1/health`, `health.changed` on the feed;
  Repairs become health items with a fix; the board renders the HA
  shape. Acceptance: raising a code twice yields one item; resolving
  removes it; the enumeration of every producer (supervisor,
  governor, model store, updates) with its test. Exit:
  `bash scripts/check.sh`.
  Landed: the tick with its verified commit is the STACK-09b line in
  milestone 0; this entry is the design.
- [x] **STACK-09c (M): alert channels.** `{type, name, config,
  verifiedAt}` in a registry, Telegram and ntfy providers, "Send a
  test" returning the provider's error, an unverified channel is a
  warning item, a privacy-page row per channel type. Acceptance: a
  scripted provider receives the test and the verified stamp lands;
  the privacy page lists both. Exit: `bash scripts/check.sh`.
- [x] **STACK-10 (M): updates** (moved here from milestone 0 with the
  survey's shape; verified at 8ee0683, landed as c90af29's successor): three hosted manifests, opt-in check offered once
  on the second launch with only `If-None-Match` and a user agent
  sent, engines pinned by `bNNNN` resolved through `nightly-tag.txt`
  and cross-checked against GitHub's asset digest, drain and swap
  with automatic rollback on a failed post-swap check, keep-previous
  directories, the weekly model-revision watch, the page's API.
  Acceptance: an update and a rollback of a scripted engine with no
  request cut (test); the check's request has exactly the two headers
  (test); the privacy page lists the URLs. Exit: `bash scripts/check.sh`.
- [x] **STACK-11b (M): the first open is the board.** No wizard: the
  board is the first screen with This computer in plain words, the
  Add abilities cards with sizes and "can run", the "Start small"
  suggestion, downloads as a background job with the honest bar and
  the network sentence, the one-time dismissible note; the operator
  password is deferred until a client key is created or LAN access is
  switched on. Design in `ux.md` "Install and first open". Acceptance:
  a fresh data directory opens straight to the board with no network;
  a scripted "Start small" shows size, speed and time left and
  survives a pause; creating a key prompts for the password once;
  screenshots re-taken and judged.
  Landed: the tick with its verified commit is the STACK-11b line in
  milestone 0; this entry is the design.
- [x] **STACK-11c (M): the dashboard shell.** The sidebar with the
  twelve sections in `ux.md` "The shell", the top bar with the
  machine in plain words, the search-and-command palette (slash or
  Command-K over pages, models, engines, settings and actions), the
  health badge, the hand-off card; every section route exists with
  its designed empty state; Overview is the board; Models, Engines,
  Access, Alerts and Settings render the real routes that exist;
  Monitoring, Updates, Backups render their empty states until their
  items land. Acceptance: Playwright walks every section on a fresh
  data directory and each shows its designed empty state; the palette
  opens with both keys and jumps to a page and runs an action;
  screenshots at desktop light, desktop dark and phone, opened and
  judged.
  Landed: the tick with its verified commit is the STACK-11c line in
  milestone 0; this entry is the design.
- [x] **STACK-15b (M): the one-line installer.** `install.sh` hosted
  on our GitHub Pages: downloads the compiled Stack binary
  (`bun build --compile`) for the platform from our own GitHub
  release with its sha256 checked, installs under the home folder,
  registers the launchd agent (later systemd), starts it, opens the
  board; re-running updates; an uninstall flag removes everything but
  the data directory. Acceptance: on a clean macOS user account the
  command ends with the board open in under a minute, with the log
  pasted; the script is shellcheck-clean; nothing but our own release
  is downloaded (the script's URLs enumerated in the privacy page).
  Landed: the tick with its verified commit is the STACK-15b line in
  milestone 0; this entry is the design.
- [x] **STACK-12 (M): Try it** is built on shadcn/ui's chat components
  (`message-scroller`, `message`, `bubble`, `attachment`, `marker`)
  added to the kit by the registry, a small SSE hook against the
  Stack's own `/v1/chat/completions`, `MediaRecorder` to
  `/v1/audio/transcriptions` for Listen, and `/v1/audio/speech`
  through an `<audio>` element for Speak; stateless; the decision and
  the candidates graded are in `dev.md` "Try it's chat surface".
  Landed: the tick with its verified commit is the STACK-12 line in
  milestone 0; this entry is the design.

## Cross-repo

- [ ] **KIT-01 (M): extract the shared UI kit.** Extract `@maipai/ui`
  from `home/frontend/src/kit` into a package that both repos pin. Until
  then, the Stack carries a copied subset for its admin shell.

- [ ] **STACK-04c (M): nicknames, groups, utilization by group.** A
  `nickname` on the model record (display only); a `groups` table
  (`id`, `name`, `parentId`) with each model in exactly one group and
  an ungrouped default; per-model usage recorded by the router and
  supervisor (requests, tokens in and out, seconds loaded, peak memory
  while loaded, last used) and rolled up by group through the tree;
  routes to create, rename, move and remove groups and to move
  models; per-group status (loaded, ready, on demand, failed counts
  and the worst health item) and group actions that apply beneath
  (load, unload, pin, unpin, check for updates, move, remove) with
  the count confirmed inline; the Models page as a tree with rollups
  and drag to move;
  Monitoring's utilization by group. Acceptance: a nested rollup
  counts a model once (test); a nickname changes no API behavior
  (test: a request by nickname is 400, by id works); the tree renders
  scripted groups with their rollups (screenshot judged).
- [x] **STACK-19 (M): engine management.** Controls (start, stop,
  restart, probe, install a build, make current with drain and swap,
  remove), per-engine configuration declared once and rendered
  generically (context, slots, threads, prompt cache, flash
  attention; host URL and expected version for managed), and a
  version state that is a fact (current, not current with the reason,
  needs restart) from the store's tags and the updates' newest pinned
  build. Design in `ux.md` "Engines". Acceptance: each control calls
  its route against a scripted engine (test per control); a config
  change marks needs-restart and the restart applies it; "not
  current" appears when a newer pinned build exists (test); the page
  screenshot opened and judged.
  Landed: the tick with its verified commit is the STACK-19 line in
  milestone 0; this entry is the design.
- [x] **STACK-35 (M): the property panel.** One `PropertyPanel`
  component (header with name, status badge and quick-action buttons;
  Overview, Settings, Insights tabs) used by Engines, Models and
  groups, Access clients, Alert channels and detected items, with the
  table on the left and the panel staying open across rows and arrow
  keys; the per-kind action sets in `ux.md` "The list and the panel".
  Acceptance: each page opens the panel on a row and moves with arrow
  keys (test); every action calls its route (test per kind);
  screenshots of the panel on Engines and Models, opened and judged.
  Landed: the tick with its verified commit is the STACK-35 line in
  milestone 0; this entry is the design.
- [x] **STACK-36 (M): Overview as the console dashboard.** The seven
  widgets in `ux.md` "Overview: the console dashboard" on the block's
  section cards and charts, with the time range; the recorded series
  behind them (`usage_samples` per five minutes by ability, client and
  model for a week; memory samples per five seconds for an hour and per
  five minutes for a week; speed results from STACK-26) written by the
  router, governor and supervisor and served by `GET /stack/v1/series`
  with a range parameter. Acceptance: scripted series render every
  widget with real numbers (screenshots at desktop light, dark and
  phone, judged); the time range changes every chart (test); the ring
  segments filter the list (test); the squint test written up in the
  report against a UniFi screenshot the lane fetches for comparison
  only, never copied.
  Landed: the tick with its verified commit is the STACK-36 line in
  milestone 0; this entry is the design.
- [ ] **STACK-34 (M): detect and adopt.** Discovery of engines and
  model folders the Stack did not install: well-known loopback ports
  (Ollama 11434, LM Studio 1234, ComfyUI 8188, oMLX, mlx-serve 11234,
  any `llama-server` answering `/health`), installed apps and binaries
  in the usual places, the model folders from the import scan;
  detection on boot and in the maintenance window, loopback only,
  never the network. A `detected` table (kind, name, version, where,
  what it could hold, `forgotten`); rows on Engines and Models in the
  "Detected, not adopted" state; Adopt (probe, identity, version
  against the tested floor, choose roles, register as `managed` or
  import by link), Forget; a health item when an adopted host is
  below the tested version. Design in `ux.md` "Detect and adopt".
  Acceptance: a scripted Ollama on a loopback port is detected, shown
  as not adopted, adopted with the chat role and served through it
  (test); a forgotten row stays hidden until its version changes
  (test); nothing is probed outside 127.0.0.1 (test asserts the
  address list); screenshot judged.
- [ ] **STACK-18 (M): the tray app on Tauri 2.** A `tray/` package:
  the Stack icon as the tray or menu-bar item colored by the worst
  health severity, a menu with each role's one line, Open (the web UI
  in a Tauri window), Pause everything, Resume, Quit; native
  notifications for `critical` and `error` health items and for
  `update.available` and `model.installed`, posted under the app's
  bundle id; an independent poll of `/healthz` that shows "The Stack
  is not running" with Start when the daemon is down; the daemon as a
  Tauri sidecar in the app bundle so the bundle is the second install
  path; the Tauri updater plugin against `app.json`. Acceptance: on
  this Mac the bundled app shows the icon, a scripted critical health
  item posts a native notification (screenshot), Pause drains and
  Resume restores; the bundle installs the service the same way
  `install.sh` does. Exit: `bash scripts/check.sh` plus the tray
  package's own `cargo test`.

## Milestone 0c: self-managing (2026-09-17, from the owner's review)

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
- [ ] **STACK-21 (M): What's new for your computer.** When the
  Catalog's model index changes (a conditional GET, opt-in with the
  update check), tell the person which new models would run well on
  this machine and what they would gain, in one sentence each, with
  Install; never auto-install, never a telemetry call. Acceptance: a
  scripted index with three models yields one recommendation that
  fits the tier and two that are hidden for not fitting.
- [ ] **STACK-22 (M): the maintenance window.** Quiet hours the person
  sets once (default 2 to 5 in the morning): downloads, update checks,
  smoke tests, storage sweeps and benchmarks run then; heavy work
  pauses when the person is active (input in the last five minutes),
  on battery, or under memory pressure; a bandwidth cap for
  downloads; "Run maintenance now" on Settings. Acceptance: a scripted
  clock runs the window's jobs inside it and defers them outside;
  activity pauses a scripted download.
- [ ] **STACK-23 (M): ready when you sit down.** Models unload after an
  idle time the person sets; on battery they unload sooner; the chat
  model warms up before the hour the person usually uses it, learned
  from the Stack's own usage records on this machine (never sent
  anywhere, shown on the Monitoring page as "you usually chat around
  7 pm"). Acceptance: scripted usage records produce the warm-up
  hour; a battery event unloads a JIT model.
- [ ] **STACK-24 (M): storage hygiene.** Find models unused for thirty
  days, duplicate files across tools, orphan blobs, old engine builds
  and stale logs; show what each would free; one click to clean; a
  warning three days before the disk fills at the current download
  rate. Acceptance: a scripted store yields the exact list and sizes;
  the clean removes only what was listed; the disk warning fires on a
  scripted trend.
- [ ] **STACK-25 (M): move to a new computer.** Export "my setup"
  (plan, abilities, groups and nicknames, settings, alert channels
  minus their secrets, the client list minus keys) as one file; on a
  new machine, import it and the Stack re-downloads what fits the new
  hardware, re-sizes what does not, and says what changed. Part of
  Backups, per the org standard. Acceptance: export then import on a
  scripted smaller machine drops the abilities that do not fit and
  says so.
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
- [ ] **STACK-27 (S): the weekly digest.** One passive notification a
  week: what was used and how much, what updated, what is tight, what
  could be cleaned, in five plain sentences; off by default on the
  Alerts page. Acceptance: a scripted week yields the five sentences.
- [ ] **STACK-28 (S): licences in plain words.** Every model's licence
  shown as one sentence a parent understands ("free for personal use;
  not for a business") from a small map of the common licences, with
  the full text a click away; a gated or non-commercial licence flagged
  before download. Acceptance: the map covers Apache-2.0, MIT, Llama
  community, Gemma terms, Qwen research, CC-BY-NC; an unknown licence
  says "read it before you rely on it".
- [ ] **STACK-29 (S): guided fixes and a diagnostics bundle.** Every
  health item's "Learn more" opens a page with the exact steps in the
  user docs; "Save a diagnostics file" writes a redacted bundle
  (versions, hardware, health, the last hundred log lines with secrets
  removed) the person can keep or send to whoever helps them. Nothing
  is sent by the Stack. Acceptance: the redaction test from the
  logging standard covers the bundle.
- [ ] **STACK-30 (M): abilities by intent.** On the Abilities page,
  "What do you want to do?" (a chat assistant; help with homework;
  dictation; make images; code) picks the abilities and models for
  this machine and explains the choice in one sentence; the tier list
  stays behind "Change". Acceptance: each intent maps to a set that
  fits each tier (test per intent per tier).
- [ ] **STACK-31 (S): engines kept current, safely.** An opt-in switch
  on Updates: apply engine updates in the maintenance window with the
  automatic rollback of STACK-10 if the post-swap check fails, and a
  notification either way; model updates are never automatic.
  Acceptance: a scripted failing update rolls back and notifies.

- [ ] **STACK-32 (M): the Library.** Local documentation for what is
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
- [ ] **STACK-33 (S): the Library in the docs site's search.** The
  published docs site's search also covers the Library pages of this
  Stack when opened from the Stack (the site's Pagefind index merged
  with the local one at request time), so one search box answers both
  "how do I" and "what did I install". Acceptance: a query that matches
  only a Library page returns it from the site's search box.

- [ ] **STACK-37 (M, low priority): the helper.** The in-console
  assistant of dev.md "The helper" (2026-09-17), built in three tiers
  so most questions never reach a model. Tier 1: an intent table in
  the command palette that answers the enumerable questions from the
  API ("how many engines", "are my models up to date", "how much disk
  do models use") with the number in the row and a jump to the page,
  each intent with a hit counter. Tier 2: the Library search
  (STACK-32/33). Tier 3: the `helper` role, a read-only tool set over
  `/stack/v1` (`health`, `engines`, `models`, `updates`, `storage`,
  `series`, Library `search`) declared once and also served by the
  `stack-library` MCP server, run on the loaded `chat` engine when it
  supports tool calls, else on the Stack's pinned `qwen3-1.7b-q8-0`
  in its own low-priority llama-server that unloads after idle; the
  reply renders in the property panel, with "Ask about this" on every
  health row and alert; any action is a proposal card, never a tool.
  Mirror `lib/router.ts` for the role and `routes/library` for the
  tools. Acceptance: the two named questions are answered with no
  engine running (test on the intent table); a scripted engine
  (`STACK_SCRIPTED_ENGINES=1`) proves the tool loop answers "why is
  chat offline" from the health list; the tool set contains no
  mutating tool (test enumerates the registry); with every person
  engine stopped the helper still loads on its own process (scripted
  test); with memory below the watermark the palette shows the
  "needs 2 GB free" state instead of loading. Out of scope: quality
  benchmarks, a chat bubble, any write tool. Exit: `scripts/check.sh`.

## Milestone 0d: look and feel (2026-09-17 night, from the owner's references)

The design record is ux.md "Look and feel references: UniFi's
structure, X's modernism". Each item below is one numbered pattern from
that section made real in the kit and in the pages, judged on the
showroom (`bun run showroom`, captures under `docs/assets/screens/`).
Order matters: the shell items (38 to 40) first, the kit blocks (41,
42) next, then the pages that use them.

- [x] **STACK-38 (S): the page header is the title** `7894513`. The top bar's
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
- [ ] **STACK-39 (S): relative times.** `frontend/src/lib/relativeTime.ts`
  (`formatRelative(iso, now)`: "now" under a minute, "3m", "2h",
  "Yesterday", then the short date; unit tests for each boundary) and a
  `RelativeTime` component in `frontend/src/kit/ui/` that renders the
  relative form with the absolute time in a tooltip and `dateTime` on a
  `<time>` element. Used by Recent activity on Overview, the
  notification popover, the health rows and every panel's key-value
  list (the list shows both). Mirror: X's "3m" timestamps. Acceptance:
  `relativeTime.test.ts` covers the boundaries; `overview.test.tsx`
  finds a `<time>` element with a `dateTime`. Exit: `scripts/check.sh`.
- [x] **STACK-40 (S): dark is black, light is flat.** (6723dee) `frontend/src/kit/
  tokens.css` `.dark` block: `--background` and `--card` to a near-black
  neutral, `--border` a hairline grey, no shadow tokens in use; light
  mode drops the card drop shadows (`shadow-*` classes on `Card` and the
  property panel go, the hairline border stays). Mirror: X's dark
  mode. Acceptance: `grep -rn "shadow-" frontend/src --include=*.tsx`
  lists only the command palette and popovers (floating layers keep
  one); showroom `overview-console-dark.png` and `-light.png` opened
  and judged; every text and border token pair is checked for WCAG AA contrast
  and the ratios are listed in the commit message. Out of scope: a theme generator. Exit: `scripts/check.sh`.
- [ ] **STACK-41 (M): the things table.** One block, `frontend/src/kit/
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
- [ ] **STACK-42 (M): the property panel, refined.** `frontend/src/kit/
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
- [ ] **STACK-43 (M): the filter column.** A `FilterColumn` block
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
- [x] **STACK-44 (S): one pill.** The `Button` `default` variant is a
  fully rounded pill; every screen keeps one filled button at most (the
  page's main action), everything else `outline`, `ghost` or a text
  link. An audit of `frontend/src/pages` and `panels` lists each filled
  button per screen in the commit message. Mirror: X's one "Post"
  button. Acceptance: a `bun test` walk of the showroom fixtures renders
  each page and asserts at most one `data-variant="default"` button
  outside dialogs; captures opened and judged. Exit: `scripts/check.sh`.
- [ ] **STACK-45 (M): Overview's facts column and controls.** The left
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
- [x] **STACK-46 (S): the top bar.** The instance on the left with its
  status dot and name ("This computer", the dot in the worst health
  severity, green when the list is empty), the search field in the
  middle, the theme toggle and the bell on the right. Files:
  `site-header.tsx`, `nav-health.tsx` (the health read), the theme
  toggle from the kit. Acceptance: `dashboardShell.test.tsx` finds the
  dot's label and the toggle; captures opened and judged. Out of scope:
  moving This computer off the sidebar footer (it stays until the
  hand-off card design lands). Exit: `scripts/check.sh`.
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
  opened and judged. Verified at dd70cfa. Exit: `scripts/check.sh`.

- [ ] **STACK-49 (M): Overview, second pass.** ux.md "Overview, second
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
- [ ] **STACK-50 (M): two databases, state and measurements.** dev.md
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
- [ ] **STACK-51 (M): the shell, second pass.** ux.md "The shell,
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

- [ ] **STACK-52 (M): Settings, second pass.** ux.md "Settings" second
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
- [ ] **STACK-53 (M): things pages, second pass.** ux.md "Things pages,
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
## Milestone 1: the robot

- [ ] **STACK-17 (L): the Linux ARM profile.** `llama-server` on the Pi
  for chat, embed and judge with the robot's pins and flags; the body's
  speech process as a managed engine; the governor reading the body's
  power and thermal budget (GOV-01). Confirmed against `bot/docs/dev.md`
  sections 2 and 4 before it starts.

## Docs and site

- [x] **DOCS-01 (S): user docs site.** Astro Starlight under `docs/site/`
  with the user tier (Get started, Fix a problem, Privacy), the first
  user pages in `docs/user/`, verified at <hash> (built locally;
  publishing to GitHub Pages is a later item).
- [x] **DOCS-02 (S): the Stack logo.** Done 2026-09-17: the mark and
  wordmark in `getmaipai/.github/brand/` as `maipai-stack-*`.
