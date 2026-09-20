# Session A: the Stack rewrite (work order, 2026-09-20)

Coordinator: the `COORDINATOR` session. Lane: A. Model floor: Opus.
Checkout: `getmaipai/stack` on `main` at `5ec0f57` (plus the
`.github` checkout for step 1). Launched with
`claude --dangerously-skip-permissions`.

**Ready handshake first.** Before any edit, reply `ready` with: the
model named in your own system prompt (or "unknown"), the checkout
path and branch, and your assignment in one line. Then wait for
`start`. Step 0's reading and its calls are part of the ready report,
so the report comes after the read, not before.

## The assignment

Implement steps 0, 1, 2, 3, 4, 5 and 6 of
[refocus-work-order-2026-09-20.md](refocus-work-order-2026-09-20.md)
in the `stack` checkout. That file is the full prompt: the decision,
the goals, the limits, the ownership table, the steps and the
one-liner. This order adds only what the coordinator settled after
reading the tree. Where the two differ, this order wins and says why.

Steps 0b and 0c are Session B's, in a fresh `getmaipai/shared`
checkout plus `home` and `catalog`. You never edit `home`, `catalog`
or `shared`; B never edits `stack`. B reads the Stack's kit from the
committed tree (`git archive 5ec0f57`), never from your working tree,
so nothing you do in step 0 races it.

## Files owned and forbidden

Owned: everything in `stack/`; `.github/docs/DECISIONS.md`,
`.github/CLAUDE.md`, `.github/brand/COPY.md`, `.github/docs/UI.md`
for step 1 only. Forbidden: `home/`, `catalog/`, `shared/`, every
other `.github` file, the `stack-codex` folder (Codex's fixed
worktree; leave it as it is).

Setup: no ports and no data directory are needed until step 4's
gate; if you start the daemon for a live check, use its default
loopback port with `data-scratch/` as the data directory, record pid
and port when you start it, stop it by pid, and confirm the port is
free afterward.

## Settled facts (do not re-derive)

- **Lane A and Lane B are stopped.** Checked by the coordinator: no
  file in `stack-b`, `stack-c` or `stack-codex` is newer than
  `5ec0f57`, and the session that wrote the order reported both
  stopped. Step 0's "confirm with the coordinator" is satisfied by
  this line.
- **Stray worktrees and branches are yours to remove at step 0**, the
  org branch rule applied: `git worktree remove --force` for `stack-b`
  and `stack-c`, then delete every `b/*`, `c/*` and `codex/*` branch
  except the one `stack-codex` has checked out (`git worktree list`
  shows it). Nothing on them is merged, stashed or looked at; the
  owner discarded the in-flight lane work. List what you removed in
  the ready report.
- **The dirty tree at step 0** is the console work the order names
  plus `backend/src/lib/gguf.ts`, `backend/src/lib/modelStore.ts`,
  `backend/src/routes/models.ts`, `docs/api/openapi.json`,
  `backend/tests/gguf.test.ts`, `backend/tests/models.test.ts` and
  five untracked screenshots under `docs/assets/screens/`. `git
  checkout --` and `git clean` on the named paths only; never a
  bare `git clean -fd` (this checkout also holds the coordinator's
  committed plans). The gguf and models changes survive only if they
  serve goals 2 to 5 and their tests pass as they stand; say which
  way you went and why.
- **Step 4 waits for two tags, not for Home's adoption.** The
  order says "only after both adoptions does step 4 remove
  `frontend/`". The coordinator relaxes that to: step 4 starts once
  `core-v0.1.0` and `ui-v0.1.0` exist in `getmaipai/shared` (B will
  message you the tag and commit; you do not poll). Reason: the kit is
  extracted from commit `5ec0f57`, which git keeps regardless, so
  Home's adoption does not need `frontend/` to still exist here. Steps
  1, 2 and 3 do not wait on anything.
- **The Stack's own `core` adoption is yours, at step 4.** The new or
  kept backend imports `@maipai/core` for `log`, `withTimeout`,
  `paths`, `archive`, `diagnostics`, `hardware`, `openapi` and
  `secretThrottle`, and deletes its copies in the same commit.
  `engineCatalog.ts` and `modelCatalog.ts` stay product-side. B will
  tell you how the package is pinned (sibling checkout at a tag with a
  `MAIPAI_SHARED_DIR` override, the `@maipai/standards` pattern) in
  its tag message; mirror it in `scripts/check.sh` so the gate fails
  loud when the sibling is missing or its version is not the pin.
- **Step 5's spec shapes.** Decided when you get there. Report
  `done` for step 4 and stop; the coordinator will say whether spec
  exists yet (B's 0c) or whether you declare the wire shapes locally
  under `backend/src/spec/` for B to move. Do not start step 5 on your
  own.
- **The kept design** (the reconciled kit and shell, owner-approved
  2026-09-19) is B's to move; you do not touch `frontend/` before
  step 4 and delete it whole at step 4.

## The ready report (step 0 output)

After the discard and the worktree cleanup, read `backend/src` once,
end to end (`app.ts`, `index.ts`, every file in `lib/`, `routes/`,
`service/`, `settings/`, `updates/`, `db/`, `store/`, `memory/`,
`mcp/`, `events.ts`, `roles.ts`, `profiles.ts`). Then report `ready`
with, per module or module group, one of keep / rewrite / delete and
a clause of reasoning, and the overall call: fresh start or in-place.
The owner's rule applies: the fastest route to the design with the
gate green, sunk cost weighs nothing. If fresh start, name the modules
you copy in unchanged and the shape of the new `backend/` tree. The
coordinator confirms the call in the `start` message.

## Exit checks per step

Each step is one commit at most. Docs-only steps (1, 2, 3, 6) gate
on `bash scripts/check.sh --docs`; code steps (4, 5) on the full
`scripts/check.sh` in the background or with the tool timeout raised
(a foreground command dies at 120 s and looks like a random failure),
then a `code-review` at medium with an explicit target (this checkout
on `main`), the reported path checked against your own before any
finding is acted on. `git status` then stage by name; never `git add
-A`; `git show --stat HEAD` read before each `done`. Docs land in the
same commit as the change they describe. Step 4's commit message
inventories what was removed and what was kept. Push `.github` at
step 1 (Home sessions read it). **Never push `stack` until the
coordinator says so.**

## Reporting contract

Messages to `COORDINATOR`, first line the event and the step:

- `ready` as above.
- `done step N`: the commit hash and `git show --stat HEAD`; each
  command run with its exit (`check.sh`, the review and each finding's
  disposition); where the evidence is.
- `blocked [owner: what]`: the exact failing output, what you tried,
  your guess at the class (environment, unclear requirement, context,
  reasoning).
- `question`: only for what the order, the review, `AGENTS.md`,
  `dev.md`, `integrations.md` and the org docs cannot answer; try the
  `design-resolver` agent first.
- `low context`: sent early; write the handoff note to
  `docs/dev/session-a-refocus.md` first, with what is in the tree and
  what is left.

Never re-check git for another session's work, never send "still
waiting", never message to say nothing changed. B messages you
directly when a tag you need exists.
