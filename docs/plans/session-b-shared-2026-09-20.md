# Session B: the shared repo (work order, 2026-09-20)

Coordinator: the `COORDINATOR` session. Lane: B. Model floor: Sonnet.
Checkouts: a fresh `getmaipai/shared` created and cloned as a sibling
of the other repos (`~/Developer/github.com/getmaipai/shared`), plus
`home` and `catalog` on `main`. Launched with
`claude --dangerously-skip-permissions`.

**Ready handshake first.** Read
[refocus-work-order-2026-09-20.md](refocus-work-order-2026-09-20.md)
whole (the decision, the "Ownership of fundamentals" section with its
two tables, steps 0b and 0c), `../.github/docs/UI.md` "The kit",
`../.github/standards/README.md` "How a repo pins this" and "Why
shell, not an npm package", `home/spec/README.md`, and
`catalog/schema/README.md`. Then reply `ready` with: the model named
in your own system prompt (or "unknown"), the three checkout paths,
your assignment in one line, and the two plans asked for below.
Start only on the coordinator's `start`.

## The assignment

Steps 0b and 0c of the refocus order: create `getmaipai/shared`, land
`core-v0.1.0` and `ui-v0.1.0`, adopt both in Home, move `home/spec`
to `shared/spec` as `spec-v0.1.0`, and make Home and Catalog pin it.
Session A rewrites the Stack in parallel and adopts `core` there
itself; you never edit `stack/`, A never edits `shared/`, `home/` or
`catalog/`.

## Files owned and forbidden

Owned: all of `shared/`; in `home/`: `frontend/`, `backend/src/lib/`
(the eight helper copies and the Home-only helpers you move),
`spec/` (removed at 0c), `package.json`, `bun.lock`,
`scripts/check.sh`, `docs/dev.md`, `docs/BACKLOG.md`, `CHANGELOG.md`;
in `catalog/`: `schema/`, `scripts/refresh-schema.sh`, `package.json`,
`scripts/check.sh`, `docs/`, `README.md`. Forbidden: `stack/`,
`.github/` (A updates the org docs at its step 1), the `home-a1`,
`home-c-stack4`, `home-codex` and `stack-*` folders (other lanes'
worktrees), and `home/undefined/` (a stray untracked folder of
screenshots; never stage it, never delete it, mention it in your
first `done`).

Ports and data: Home's screenshot script derives its port and
`DATA_DIR` from `PORT`; use `PORT=8990` for every Home run you make,
headless only (a headless engine that cannot start after one retry
is a recorded finding, never a reason to open a window).

## Order of work (differs from the refocus order; this wins)

The refocus order lists `ui` before `core`. Session A's step 4 needs
`core` to exist and does not need Home's adoption, so:

1. **Skeleton.** `gh repo create getmaipai/shared --private`, clone
   as the sibling. AGPL-3.0 `LICENSE` ("Copyright (c) 2026 Jesse
   Torres"), `NOTICE`, README per the org skeleton at developer tier
   (no screenshots), `scripts/check.sh` that runs each workspace's
   lint, format check and tests then the `@maipai/standards` core
   (`MAIPAI_STANDARDS_DIR`, the same block every repo has),
   `docs/BACKLOG.md` in `home`'s shape, `docs/dev.md`, three
   workspaces `ui/`, `core/`, `spec/` (spec a README pointing at
   `home/spec` until step 6), a `CHANGELOG.md` per workspace, no
   push-triggered Actions. One commit, `check.sh` green, pushed.
2. **`core-v0.1.0`.** For each of `log`, `withTimeout`, `paths`,
   `archive`, `diagnostics`, `hardware`, `openapi`, `secretThrottle`:
   read both `home/backend/src/lib/X.ts` and
   `stack/backend/src/lib/X.ts` (read-only; `stack` is A's), take the
   better one or write it fresh, and carry the tests that describe
   behavior a caller cares about. Add Home's `hlc`, `id`, `secrets`,
   `keystore`, `rateLimiter`, `singleflight`, `ssrfGuard` and the
   backup crypto from `home/backend/src/lib` with their tests. Nothing
   in `core` imports a product or reads a product's config; a helper
   that needs a path or a setting takes it as an argument. Tag
   `core-v0.1.0` (annotated), push, then **message Session A directly**
   (`SESSION A`, the row with ref `43f779`): the tag, the commit, and
   how a consumer pins it (below).
3. **`ui-v0.1.0`.** Extract from the committed Stack tree only:
   `git -C ../stack archive 5ec0f57 frontend/src/kit
   frontend/src/pages/DashboardShell.tsx | tar -x -C <scratch>`;
   never read `../stack`'s working tree. The kit has 26 imports of
   Stack-specific modules (`@/lib/api`, `useApiResource`, `taxonomy`,
   `status`, `health-severity`, `unavailable`, `relativeTime`,
   `names`, `intents`, `format`, `detectedScan`, `catalogSearch`,
   `use-stack-counts`, `use-remote-stacks`, `use-mobile`) and the
   shell imports the Stack's pages, `@/kit/host` (tray) and recharts.
   A kit block that is generic once its data comes through props is
   generalized; a block that exists only for the Stack console (a
   remote-stacks hook, catalog search, detected-scan) is left out. The
   shell ships as the layout and navigation contract with routes and
   nav items passed in; it imports no product page and no tray. Add
   from Home's kit what `UI.md` says is the kit's and the Stack never
   had: `primitives/` and the UI-schema renderer `schema/`; for
   `settings/`, compare the two and take the one that renders the
   spec's declaration format (say which). `assistant-ui/` is chat and
   stays in Home. `react` and `react-dom` are peer dependencies. Tag
   `ui-v0.1.0`, push, message Session A the tag and commit.
4. **Home adopts `core`.** Pin, replace every import, delete the
   copies in `home/backend/src/lib`, full `scripts/check.sh` green,
   review, one commit, push.
5. **Home adopts `ui`.** Pin, replace `@/kit` and `shell/Shell.tsx`
   with `@maipai/ui` (45 consumer files today), delete the older kit
   and shell, keep `assistant-ui` and whatever else the report placed
   in Home. Before the change run `bun run screenshots` (PORT=8990)
   and keep the set; after it run it again, open the pairs for the
   shell and two apps at desktop and phone, judge them, and describe
   the differences in `docs/dev.md` (the owner approved the Stack's
   reconciled design, so a difference that is the new design is
   expected and stated; a broken layout is a finding to fix). Full
   gate green, review, one commit, push.
6. **`spec-v0.1.0` (0c).** Move `home/spec` whole (`pyproject.toml`,
   the Python package, `gen/`, `schemas.resolved`, fixtures, tests,
   `uv.lock`) to `shared/spec`; its own tests and the Python round
   trips green inside `shared/check.sh`. Tag, push. Then Home pins it
   and removes the `spec` workspace (its `check.sh` "spec: standards
   gen/ presence" block moves to `shared`); full gate, review,
   commit, push. Then Catalog deletes `catalog/schema/` and
   `scripts/refresh-schema.sh`, pins the package, and its lint reads
   the resolved schemas from it; `check.sh` green, review, commit,
   push.

## How consumers pin a `shared` workspace (decided)

Mirror `@maipai/standards`: no registry. A consumer resolves the
package from the sibling checkout, `MAIPAI_SHARED_DIR` overriding
`../shared`, and states the tag it pins (`core-v0.1.0`) in its own
`package.json` dependency and dev docs. Its `check.sh` fails loud
when the sibling is missing or the workspace's `package.json` version
does not match the pin. You pick `file:` or `link:` on one test: the
consumer must end with exactly one React instance and one copy of
each `core` module (hooks break across two Reacts). Prove it with a
test or the app booting, record which form and why in
`shared/docs/dev.md`, and tell A the form in the `core` tag message.

## The two plans in the ready report

1. **Kit placement:** per directory of the Stack kit and of Home's
   kit, where it goes for `ui-v0.1.0` (shared, Home, dropped), with
   the tangled imports listed against their treatment (props,
   generalized, left out).
2. **Home adoption risk:** which Home screens change shape when the
   Stack's shell replaces `Shell.tsx` (phone nav, profile switcher,
   sign-in, notification bell, search are Home's shell today; the
   Stack shell has none of them), and how each is kept: as a Home
   component mounted in a shell slot, or moved into the kit. The kit
   gets a slot; Home keeps the feature.

## Exit checks

Every code commit: the repo's full `scripts/check.sh` (background or
tool timeout raised; a foreground command dies at 120 s), a
`code-review` at medium with the explicit target checkout and the
reported path checked against yours, `git status` then stage by
name, docs in the same commit (`dev.md`, `BACKLOG.md`, the
workspace's `CHANGELOG.md`), `git show --stat HEAD` read before
`done`. Tags are annotated. Pushes: `shared` after each tag; `home`
and `catalog` after each verified adoption commit (a verified item on
`main` is the org's natural boundary).

## Reporting contract

Messages to `COORDINATOR`, first line the event and the step:

- `ready` as above.
- `done <step>`: commit hash and `git show --stat HEAD`, each command
  run with its exit, the review's findings and their disposition,
  where the evidence is (screenshot paths you opened, the React
  instance proof).
- `blocked [owner: what]`: the exact failing output, what you tried,
  your guess at the class (environment, unclear requirement, context,
  reasoning).
- `question`: only for what the order, `UI.md`, the spec README and
  the org docs cannot answer; try the `design-resolver` agent first.
- `low context`: sent early; write the handoff note to
  `shared/docs/dev/session-b.md` first.

Never poll another session's git, never send "still waiting". You
message A directly when a tag exists; A never needs anything else
from you.
