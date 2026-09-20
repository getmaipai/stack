# Work order: refocus MaiPai Stack as the engine foundation of MaiPai Home

2026-09-20. Owner decision following
[stack-necessity-review-2026-09-20.md](stack-necessity-review-2026-09-20.md).
This is the prompt for the session that carries it out. Model floor:
Opus (spans repos and subsystems, every step is a scope decision).
Run with `claude --dangerously-skip-permissions` in the `stack`
checkout; the org rules in `../.github/CLAUDE.md` apply throughout.

---

You are refocusing the `getmaipai/stack` repo. Read this whole order,
then `AGENTS.md`, `docs/dev.md` "What the Stack is" through
"Architecture", `docs/integrations.md`, and
`docs/plans/stack-necessity-review-2026-09-20.md` before touching
anything. Report `ready` when you have read them and named the model in
your system prompt; start only on the coordinator's start message.

## The decision you are implementing

MaiPai Stack is no longer a product. It is **the engine foundation of
MaiPai Home**: the headless daemon that installs, sizes, runs, watches,
updates and tests the engines and models Home uses, and gives Home (and
Bot, which runs the same platform code) one stable address by role.
Nothing broader. No standalone audience, no public release, no user
interface, no user docs, no "run it alone" pitch.

The name stays. "Stack" is now the name of Home's engine layer, the way
"turn engine" is the name of Home's conversation layer. It ships inside
Home's installer and updates with Home's releases.

## The existing code is not a constraint (owner rule, 2026-09-20)

Four days of code, 247 commits and every in-flight lane item are sunk
cost, and sunk cost weighs nothing. There is no migration, no
preservation and no salvage requirement anywhere in this order. For
each piece of the repo the question is only: **what is the fastest
route to the design above, with the gate green?** Three answers are
allowed, per piece, and the session decides without asking:

- **Keep as is** when the piece already matches the new design and its
  tests pass unchanged (the governor, the supervisor, the pins, the
  model store are the likely cases).
- **Rewrite** when adapting it would cost more than writing it fresh
  against the new shape, or when the old shape (a client-key check
  threaded through a route, an operator concept in a table) would
  leave debris. Delete the old file in the same commit.
- **Delete** everything else. Nothing is kept "in case", moved to an
  archive folder, or commented out.

Scrapping the whole backend and starting fresh is a legitimate answer
if, after reading it, the session judges that faster; say so in the
`ready` report with the reasoning and the coordinator confirms. The
same rule applies to the docs: `dev.md`, `integrations.md` and
`BACKLOG.md` may be rewritten from a blank file if that is quicker than
editing, as long as the surviving design facts (the residency and
provenance sections, the measured numbers, the survey history moved to
`plans/`) are carried over, since those are the only expensive things
in them. Git history preserves everything; nothing needs a copy.

The one thing kept regardless is the **approved design** of the kit
and shell from the 2026-09-19 UI reconciliation, because that is the
owner's decision, not code. Its files move to `shared/ui` only if
moving them is faster than regenerating them to the same spec; the
session checks this before step 0b and picks the faster route.

In-flight lane work (the dirty tree, the open UI-xx and console items,
the Lane A and B continuation plans) is discarded, not finished, not
merged, not stashed. Their plan files under `docs/plans/` are left as
history.

## Goals (what the Stack is for)

1. **One address by role.** Home asks for `chat`, `embed`, `stt`, `tts`,
   `wakeword`, later `image`, `video`, `music`, on an OpenAI-shaped
   endpoint, and never names an engine or a file. Every reply says which
   engine and model answered, in a header.
2. **The processes Home launches, and only those.** Spawned engines
   (llama-server, mlx-serve or oMLX, the speech runtimes) and managed
   sidecars (ComfyUI) behind one supervisor with post-load identity
   checks and restart. No adoption or governance of engines Home did
   not start; a detected third-party server is at most a read-only
   "use this host" binding.
3. **One residency budget on one machine.** Chat plus embed plus TTS
   plus STT plus wakeword coexist; a generator queues or is refused with
   a reason; admission is decided from kernel pressure and measured
   peaks, never file sizes. This is the one thing no field tool does
   and the reason the layer is ours.
4. **Provenance before selection.** Every engine build and model file
   is pinned by exact URL, revision and checksum, with licence
   recorded, and the previous build is retained so an update can roll
   back. The Catalog is the index; the Stack is the verifier.
5. **Honest state.** "Ready" means a recent authenticated request
   through the public route succeeded with the expected identity.
   Health is a list of problems with one fix each. An update is
   "installed X, available Y, last checked at T, go back".
6. **Same shape on every OS, Mac first, Linux for the robot.** One
   config, one API; service manager and engine builds differ per OS as
   `SERVICES.md` lists.
7. **Nothing leaves the house.** Loopback only. Update checks and model
   downloads are the only outbound calls, opt-in, and listed on Home's
   privacy page, since Home is where the person reads it.

## Limits (what the Stack is not, and never grows into)

- **No user interface.** No React console, no dashboard shell, no tray
  app, no Tauri desktop, no command palette, no Try-it studio, no
  model showroom, no library. Home's admin renders the Stack's state on
  one Engines page from the Stack's own declarations.
- **No people, no clients, no keys.** The Stack knows one caller: the
  Home process on the same machine (Bot is a Home replica). No operator
  login, no per-client API keys, no role-scoped tokens, no LAN
  exposure. If a developer's own tool should reach the engines, that
  is a Home feature (Home already owns identity and permissions), not
  a Stack one.
- **No second copy of any Home fundamental.** The table below is the
  rule. Anything human-facing lives in Home and reads the Stack's
  facts through the API and the event feed.
- **No apps, no packages, no extension system.** Unchanged from the
  old line.
- **No general model search as an install promise.** A curated, signed
  list of pinned models per role. Hub search may exist as exploration
  behind Home's UI, never as "runs on this computer".
- **No public release, no standalone installer, no docs site, no
  brand pitch.** The repo README is a developer pointer.
- **No control of other tools.** Ollama, LM Studio, Msty and the rest
  are not governed, updated or adopted. Their model files may be
  imported by verified copy or safe link after an explicit choice.

## Ownership of fundamentals (one definition, one place)

Three kinds of thing, three homes. **Libraries** (code that is
imported: the kit and shell, tokens, the logging helper, notification
types, backup crypto) live once as `@maipai/*` packages and every
product imports them. **Services** (one running instance per machine:
the notification center, the backup schedule, the log store, the
engines) are each owned by exactly one product on the machine; Home
owns every human-facing one, the Stack owns the engines, and Bot gets
Home's by being a replica of Home. **Standards** live in
`.github/docs`. The Stack is a service. It houses no library and no
second instance of a Home service. The table is that rule applied.

The libraries live in one new repo, **`getmaipai/shared`** (owner
decision 2026-09-20), with three workspaces tagged on their own:

| Workspace | Package | Contents | Consumers |
|---|---|---|---|
| `ui` | `@maipai/ui`, tags `ui-vX.Y.Z` | kit, tokens, icons, shell, settings and permission renderers, the kit's ESLint config | Home, Go, catalog packages |
| `core` | `@maipai/core`, tags `core-vX.Y.Z` | log, withTimeout, paths, archive, hlc, id, secrets and keystore, secretThrottle, rateLimiter, singleflight, ssrfGuard, diagnostics, the openapi helper, the hardware probe, backup crypto | Home, Stack, Bot |
| `spec` | `@maipai/spec`, tags `spec-vX.Y.Z` | everything now in `home/spec` (records, schemas, settings declaration format, UI schema, errors, safety vocab, streaming and voice shapes, fixtures, the Python package) | Home, Stack, Catalog, Bot (Python body pins it directly), Go |

Dependency direction, never reversed: `shared` is imported by
`stack`, `home`, `catalog`; `bot` gets `ui`, `core` and `spec`
through Home's pinned runtime package and pins `spec` directly for
its Python body at the same version; `go` pins `spec`. Nothing in
`shared` imports a product. `@maipai/standards` stays in `.github`
(org tooling, not product code). Catalog stays its own repo (the one
community-PR surface, its own cadence and trust gate) and becomes a
consumer of `spec`, deleting its schema mirror. Home's backend itself
is published from `home` as Bot's runtime package when Bot is built;
it does not move into `shared`.

The `shared` repo follows every org rule from its first commit:
AGPL-3.0 LICENSE, NOTICE, README skeleton, `scripts/check.sh` pinned
to `@maipai/standards`, `docs/BACKLOG.md`, `CHANGELOG.md` per
workspace, no push-triggered Actions. Its `check.sh` runs each
workspace's lint, format and tests, then the standards core.

| Fundamental | Stack owns | Home owns |
|---|---|---|
| API | The role routes (`/v1/*` OpenAI shape) and the control routes (`/stack/v1/*`: roles, engines, models, jobs, health, updates, events), Zod-typed, OpenAPI generated | Calling them; exposing anything to people or packages |
| Notifications | One SSE event feed (engine state, pressure, update available, health item opened or closed) | The notification system, its audiences, its channels (Telegram, ntfy, tray, phone); the Stack has none of its own |
| Updates | Knowing engine and model versions; performing the drain, swap, post-load check and rollback when told to | The Updates page, the notice, the button, release notes, the schedule |
| Health | The problem list with one fix action per item, as data | Showing it, the Repairs list, the fix button |
| Settings | The declaration of every Stack setting (key, type, default, level), once | The generic renderer, the page, persistence of the person's choice |
| Sizing | Hardware probe, profiles, measured fit, the admission decision | Wording it for a dad, the "what your computer can run" page |
| Jobs | The generator queue (submit, progress, cancel, result) | Any UI over it |
| Backups | Declaring which state is precious (pins, measurements, keys) | Taking, encrypting and restoring the backup |
| Privacy page | The list of its outbound endpoints, as data | The page |
| Install and service | Its own launchd/systemd unit, exit codes that mean what they say | Installing the Stack as part of installing Home; the watchdog above it |
| Auth | Loopback only | Everything |
| Logs and tracing | Structured logs to its own file, trace ids passed through | Log viewing, retention |

## Steps, in order

Each step is one commit at most (docs-only steps use
`bash scripts/check.sh --docs`; code steps run the full
`scripts/check.sh` and a `code-review` at medium or higher first).
Stage files by name after `git status`; other sessions may have
edited this checkout.

0. **Stop point check.** Confirm with the coordinator that Lane A and
   Lane B are stopped. Discard, do not commit, the console work in the
   dirty tree (`frontend/src/kit/blocks/pane/*`,
   `frontend/src/kit/ui/sheet.tsx`, `frontend/src/pages/DashboardShell.tsx`,
   `frontend/src/pages/ModelsPage.tsx`, `CategoryBrowser*`,
   `backend/src/showroom/fixture.ts`). The gguf and models backend
   changes and tests are kept only if they serve goals 2 to 5 and pass
   as they stand; otherwise discarded with the rest. Then read the
   backend once, end to end, and write in the `ready` report the
   keep / rewrite / delete call per module and whether a fresh start
   is faster overall.
0b. **Create `getmaipai/shared` and extract `ui` and `core`.** Create
   the repo (private, AGPL-3.0, the org skeleton above) with the three
   workspaces, `spec` empty with a README pointing at `home/spec` until
   step 0c. Then:
   - `ui` (KIT-01, pulled forward): the Stack's `frontend/src/kit/` and
     `DashboardShell.tsx` are the reconciled kit and shell the owner
     approved (the 2026-09-19 UI reconciliation); Home's
     `frontend/src/kit/` and `shell/Shell.tsx` are the older copy. Move
     the Stack's kit, tokens, icons, dashboard blocks, pane, panel,
     table, filter and phone blocks and the shell into `shared/ui`
     with their tests; tag `ui-v0.1.0`. Home adopts it in its own
     commit, replacing its older kit and shell, visual captures
     compared. Nothing UI stays in this repo: the shell, theming, UI
     schema and settings renderer are the kit's and Home's by `UI.md`
     and `home/spec/`.
   - `core`: the ten same-named files in `home/backend/src/lib` and
     `stack/backend/src/lib` (`log`, `withTimeout`, `paths`, `archive`,
     `diagnostics`, `hardware`, `openapi`, `secretThrottle`; the two
     catalogs stay product-side) have already diverged (`log.ts` and
     `withTimeout.ts` differ today). For each, take whichever side is
     better or write it fresh if that is quicker, carry the tests that
     still describe behavior a caller cares about, and add the
     Home-only helpers listed in the table (`hlc`, `id`, `secrets`, `keystore`,
     `rateLimiter`, `singleflight`, `ssrfGuard`, `backupCrypto`). Tag
     `core-v0.1.0`. Home and the Stack each pin it and delete their
     copies in their own commits, full gate green in each.
   Only after both adoptions does step 4 remove `frontend/` here.
0c. **Move the spec (a Home item, may run in parallel after 0b).**
   Move `home/spec` to `shared/spec` whole, including `pyproject.toml`
   and the Python package, `gen/`, `schemas.resolved` and the fixture
   round-trips; tag `spec-v0.1.0` at the current shape. Home pins it
   and removes the workspace; Catalog deletes `catalog/schema/` (its
   README already says "mirrored, not hand-edited", and
   `manifest.schema.json` has drifted) and pins the package; the
   Stack declares its control API and settings shapes there in step 5.
   The org rule "shared record changes go through the spec first" now
   means a commit in `shared/spec` before the hub commit.
1. **Org record first.** In `../.github/docs/DECISIONS.md` add a
   2026-09-20 entry that supersedes the 2026-09-17 one: the Stack is
   Home's engine foundation, not a product; the reasons in one
   paragraph, citing the necessity review. A second entry the same
   day: the `shared` repo (`ui`, `core`, `spec`), why one repo and not
   three, why Catalog stays separate, the dependency direction, and
   that Bot pins `spec` at Home's version. Update the product table in
   `../.github/CLAUDE.md` (the `stack` row rewritten; a `shared` row
   added; the `catalog` row notes it pins `spec`) and the Stack
   sentence in `../.github/brand/COPY.md` to the new one-liner below.
   Update org `UI.md` so `@maipai/ui` names `shared/ui` as its home.
   Commit and push `.github`.
2. **Rewrite the repo's own charter.** `AGENTS.md`: replace the opening
   and "The line" with the goals, limits and ownership table above,
   compressed; the layout section drops `frontend/` and `desktop/`.
   `README.md`: two paragraphs, developer tier, no logo strip, no
   screenshots, no "Why the Stack", no features list; link to
   `docs/dev.md` and to Home. Delete `docs/ux.md` and `docs/user/`
   entirely (the privacy table's endpoint rows move to
   `docs/integrations.md` as data Home's page reads). Rewrite
   `docs/dev.md`: keep "What the Stack is" (rewritten), the design
   principles (drop 3 "clients not people" in favour of "one caller,
   Home"; drop 6 "complete without Home"), the architecture (drop the
   admin UI, tray, operator, clients and keys boxes), the residency,
   provenance, supervisor, updates and health sections; delete the
   console, palette, library, Try-it, tray and desktop sections. Move
   the field survey tables to `docs/plans/` as history.
   `docs/integrations.md` becomes the central document: the role
   contract, the control API, the event feed shape, the settings
   declaration format, the install handoff, and how Bot consumes it.
3. **Backlog.** Rewrite `docs/BACKLOG.md`. Keep, re-scoped, only items
   under goals 1 to 7: the Studio bench (STACK-14) and the migration
   gate (STACK-16), the governor bench and second-engine adapter, pin
   and rollback proof, health honesty (STACK-87), the Linux service,
   generator jobs, the speech roles. Drop every Console, UI-xx,
   showroom, library, palette, tray, desktop, operator, client-key,
   channel, docs-site and RELEASE-STACK item, and the capability-matrix
   gates that exist only for a public release. Every surviving item
   follows the org template. Then run the `status-dashboard` skill.
4. **Delete the surface, or start fresh.** Remove `frontend/`,
   `desktop/`, `installer/`, `docs/site/`, `docs/assets/screens/`,
   `backend/src/showroom/`, the library, palette and Try-it backend
   modules, the operator login and client-key routes and tables, the
   Telegram and ntfy channel code, and their tests. If the `ready`
   report chose a fresh start, this step is instead: new `backend/`
   against the goals, importing `core` and `spec`, with the kept
   modules copied in and everything else written new; the old tree
   deleted in the same commit. Either way: regenerate
   `docs/api/openapi.json`, update `scripts/check.sh` and
   `package.json` so nothing references a deleted tree, full gate
   green, one commit whose message inventories what was removed and
   what was kept.
5. **Make the seam explicit.** Add or tighten in `backend/src` the one
   event feed (SSE, typed), the settings declaration export, the health
   problem list shape and the precious-state declaration, each with a
   test that Home's side can import as a fixture. The wire shapes
   themselves (role request and reply headers, event feed, health
   item, settings declaration, precious-state declaration) are
   declared in `shared/spec` and imported here, never defined twice.
   `docs/integrations.md` is updated in the same commit.
6. **Hand-off.** Write `docs/plans/home-adoption-2026-09-xx.md`: what
   Home's backlog must gain (the Engines page, the Updates and Repairs
   wiring, installing the Stack inside Home's installer, the Studio
   bench as a Home bench, the `spec` move if 0c has not run) and the
   order. Report `done` with
   `git show --stat` for each commit and the dashboard link.

## The one-liner for every doc

"MaiPai Stack is the engine foundation of MaiPai Home: the headless
service that installs, sizes, runs, watches, updates and tests the
engines and models behind Home, and gives Home one stable address by
role. It has no interface and no users of its own; Home is its only
caller."

## Reporting contract

`ready` (read everything, model named), `done` per step with the
commit shown, `blocked [owner: what]`, `question` (only for what the
docs cannot answer; try `design-resolver` first), `low context` (write
the handoff note to `docs/dev/` first). Never push `stack` until the
coordinator says so; push `.github` at step 1 because Home sessions
read it.
