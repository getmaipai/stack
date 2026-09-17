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
- [ ] **STACK-10 (M): updates.** Superseded by the survey's shape in milestone 0b below. Opt-in check, download beside the
  current build, drain under the guard, swap, keep the old build, one-click
  rollback; for the Stack, engines and models. Per
  `getmaipai/.github/docs/UPDATES.md`. Acceptance: an update and a
  rollback of a scripted engine build with no request cut (test); the
  privacy page lists the check.
- [x] **STACK-11 (M): the admin UI, first run and the board.** committed:
  first run steps 1 to 3 and 5, login, the board; the downloading step
  and Try it are STACK-12. The five
  first-run steps and the board from `ux.md`, on `@maipai/ui`, generated
  screenshots against a scripted engine set, each opened and judged.
  Acceptance: a fresh data directory completes first run headlessly in
  Playwright and lands on a green board; the "Share with your family"
  card renders. Out of scope: the menu bar.
- [ ] **STACK-12 (M): Try it.** The stateless tabs per role with the
  adult acknowledgment once and the AI-outputs disclaimer at first run.
  Acceptance: each tab exercised in Playwright against scripted engines;
  the acknowledgment shows exactly once per operator (test).
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
- [ ] **STACK-15 (M): service install.** launchd on macOS with the
  data-directory permissions, an installer script, start, stop, pause
  and resume; the menu-bar item after the web UI. Acceptance: a clean
  Mac boots the service on login and the board is reachable.
- [ ] **STACK-16 (L): Home runs on the Stack.** The hub's migration list
  in `dev.md`; Home registers as a client, calls by role, bridges events,
  and deletes its own supervisors. Lands in the `home` repo as its own
  items after STACK-14 proves the Studio profile. Needs its design pass
  in `home/docs/dev.md` first.

## Milestone 0b: what the field survey changed (2026-09-17)

Decided in [`plans/operations-design-2026-09-17.md`](plans/operations-design-2026-09-17.md);
each item's design section lands in `dev.md` before its code.

- [ ] **STACK-07b (M): streaming.** `stream: true` on `/v1/chat/completions`
  proxies the engine's SSE token stream with the identity headers on
  the response, cancellation on client disconnect, and the
  phrase-level TTS stream for `/v1/audio/speech`. Files: `backend/src/lib/supervisor.ts`,
  `routes/inference.ts`. Acceptance: an unmodified OpenAI client
  receives streamed deltas from a scripted engine; disconnect aborts
  the engine request without retiring the backend (test). Exit:
  `bash scripts/check.sh`.
- [ ] **STACK-06b (M): the governor reads the kernel's ledger.** A
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
- [ ] **STACK-04b (L): the store layout, import, remove.** Models in
  the Hugging Face cache layout under `data/models/hub`; engines as
  `data/engines/<name>/<tag>/` with a manifest and a `current` link;
  the import scan of other tools' directories with links, never
  copies; ranged parallel downloads with per-part resume and a
  full-file hash; reference-counted remove with a one-hour prune
  grace. Design section first. Acceptance: a model in a temp
  `HF_HUB_CACHE` is imported by link and served; a blob shared by two
  manifests survives one remove; the tests from STACK-03 and -04
  still pass. Exit: `bash scripts/check.sh`.
- [ ] **STACK-09b (M): one health list.** Health items (code, severity,
  title, text, since, cause, one fix, learn-more), keyed and
  idempotent, `GET /stack/v1/health`, `health.changed` on the feed;
  Repairs become health items with a fix; the board renders the HA
  shape. Acceptance: raising a code twice yields one item; resolving
  removes it; the enumeration of every producer (supervisor,
  governor, model store, updates) with its test. Exit:
  `bash scripts/check.sh`.
- [ ] **STACK-09c (M): alert channels.** `{type, name, config,
  verifiedAt}` in a registry, Telegram and ntfy providers, "Send a
  test" returning the provider's error, an unverified channel is a
  warning item, a privacy-page row per channel type. Acceptance: a
  scripted provider receives the test and the verified stamp lands;
  the privacy page lists both. Exit: `bash scripts/check.sh`.
- [ ] **STACK-10 (M): updates** (moved here from milestone 0 with the
  survey's shape): three hosted manifests, opt-in check offered once
  on the second launch with only `If-None-Match` and a user agent
  sent, engines pinned by `bNNNN` resolved through `nightly-tag.txt`
  and cross-checked against GitHub's asset digest, drain and swap
  with automatic rollback on a failed post-swap check, keep-previous
  directories, the weekly model-revision watch, the page's API.
  Acceptance: an update and a rollback of a scripted engine with no
  request cut (test); the check's request has exactly the two headers
  (test); the privacy page lists the URLs. Exit: `bash scripts/check.sh`.
- [ ] **STACK-11b (M): the first open is the board.** No wizard: the
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
- [ ] **STACK-11c (M): the dashboard shell.** The sidebar with the
  eleven sections in `ux.md` "The shell", the top bar with the
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
- [ ] **STACK-15b (M): the one-line installer.** `install.sh` hosted
  on our GitHub Pages: downloads the compiled Stack binary
  (`bun build --compile`) for the platform from our own GitHub
  release with its sha256 checked, installs under the home folder,
  registers the launchd agent (later systemd), starts it, opens the
  board; re-running updates; an uninstall flag removes everything but
  the data directory. Acceptance: on a clean macOS user account the
  command ends with the board open in under a minute, with the log
  pasted; the script is shellcheck-clean; nothing but our own release
  is downloaded (the script's URLs enumerated in the privacy page).
- [ ] **STACK-12 (M): Try it** is built on shadcn/ui's chat components
  (`message-scroller`, `message`, `bubble`, `attachment`, `marker`)
  added to the kit by the registry, a small SSE hook against the
  Stack's own `/v1/chat/completions`, `MediaRecorder` to
  `/v1/audio/transcriptions` for Listen, and `/v1/audio/speech`
  through an `<audio>` element for Speak; stateless; the decision and
  the candidates graded are in `dev.md` "Try it's chat surface".

## Cross-repo

- [ ] **KIT-01 (M): extract the shared UI kit.** Extract `@maipai/ui`
  from `home/frontend/src/kit` into a package that both repos pin. Until
  then, the Stack carries a copied subset for its admin shell.

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
