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
- [ ] **STACK-05 (M): the supervisor.** `spawned`, `managed`, `url`
  engine kinds; spawn, watch, restart, the generation guard, the post-load
  check, the memory report; identity headers on every reply. Copy the
  restart semantics from `home/backend/src/lib/llmSupervisor.ts`,
  `backgroundSupervisor.ts`, `engineIdentity.ts`, `enginePostLoadCheck.ts`.
  Acceptance: a scripted engine's crash is restarted without cutting an
  in-flight request (test); a managed host that vanishes shows
  `offline_reason`. Out of scope: the governor's rules.
- [ ] **STACK-06 (M): the governor.** Profile, admission, one generator,
  eviction (TTL, LRU, pin), the cap, `keep_alive` as a hint; every rule
  readable as a sentence on the Hardware page. Seed from
  `home/backend/src/lib/resourceGovernor.ts`. Acceptance: a test per
  rule with scripted memory readings; a queued job reports its position.
- [x] **STACK-07 (M): roles and the router.** The role declaration, role
  by name in `model`, the OpenAI-shaped endpoints for text, embeddings,
  audio and images, the streaming speech sessions. Acceptance: an
  unmodified OpenAI client library completes a chat, an embedding, a
  transcription and a speech render against scripted engines; role
  scoping refuses a disallowed role with a clear error. Committed, engine binding outstanding (STACK-05).
- [ ] **STACK-08 (M): operator login and client keys.** Password login,
  keys hashed at rest and shown once, allowed roles, counters, revoke;
  loopback requires a key. Mirror the hub's `auth.ts` and `lib/secrets`
  pattern. Acceptance: a revoked key is refused within one request; the
  key never appears in a log or a response after creation (test).
- [ ] **STACK-09 (M): events and notifications.** The SSE feed with the
  typed events in `dev.md`; the Notifications page; the Repairs list.
  Acceptance: an engine crash produces `engine.state` and a Repairs row
  with one action (test); Home's bridge shape documented in the API.
- [ ] **STACK-10 (M): updates.** Opt-in check, download beside the
  current build, drain under the guard, swap, keep the old build, one-click
  rollback; for the Stack, engines and models. Per
  `getmaipai/.github/docs/UPDATES.md`. Acceptance: an update and a
  rollback of a scripted engine build with no request cut (test); the
  privacy page lists the check.
- [ ] **STACK-11 (M): the admin UI, first run and the board.** The five
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
