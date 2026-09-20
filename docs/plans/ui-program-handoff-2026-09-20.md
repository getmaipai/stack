# UI program handoff (2026-09-20, 02:25): paused for a new direction

The owner paused the UI true-up program
([`ui-reconcile-2026-09-19.md`](ui-reconcile-2026-09-19.md)) at 02:15
to change direction. This is the exact state.

## On main (db0551c, pushed)

Landed and verified: UI-05 taxonomy, UI-01 tokens (both themes, the
contrast test), UI-02 the shell (rail, header with typeable search,
footer, drawer, the fixes against the reference), UI-03 the pulse,
UI-04 the machine selector and Lock MaiPai, UI-06 the network route,
UI-07 resource history, UI-08 the components aggregate with activity
and host CPU, UI-10 the shared browser, pane, cards, states and hooks,
UI-12 Models on the browser, plus the STACK-87 role-state drift fix
(the console crashed on the board without it) and the governor test
fix (issue #1). The live daemon on 8770 serves this build.

## Not on main

- **UI-12b (Models against the reference)**: all six points done,
  gate green, review findings fixed, but UNCOMMITTED in the main
  checkout's working tree (`git status` there shows the edits). A
  resuming session in that checkout reads `docs/dev/session-a.md`
  "Stopped mid UI-12b", re-runs the gate, commits by file name as
  "Console (UI-12): Models against the reference", pushes. One open
  finding documented (selectedIds mixes model and detected row ids).
- **UI-15 (Settings workspace)**: on branch `b/ui-data` at 0975cd5 in
  the worktree `stack-b`: Codex's page (56acc0b), the fix for the
  full-suite segfault (2a12c3c: it was two global ⌘K and "/"
  listeners moving focus twice in one dispatch, not Bun), a shared
  SearchField and route-level lazy pages, three captures. Not landed
  because the page itself has twelve defects against the real routes
  (four high: a reset route that does not exist, a cache-clear id the
  hygiene route rejects, two toggles writing `chatWarmupEnabled`, a GB
  value saved into `historyRetention`). List and resume steps in
  `docs/dev/session-b.md` "B stopped". The UI-15 tick on that branch
  is false until they are fixed.

## Open items of the program

UI-09, UI-11 Overview, UI-13 Runtimes, UI-14 the other categories,
UI-16 search, UI-17 notifications, UI-18 Monitoring, UI-19 the
remaining destinations, UI-20, UI-21 responsive and accessibility
pass, UI-22 remote stacks, UI-23 docs; then RT-01 (llama.cpp, Ollama,
ComfyUI, oMLX as managed runtimes) and BENCH-01 (the runtime bench).
Lane orders that still apply: `lane-a-continue-2026-09-20.md` (items
1 to 4), `lane-b-continue-2026-09-20.md` (items 1 to 5).

## Issues filed tonight

stack #1 (closed), #2 (closed), #3 memory reader fallback persisted
into history, #4 a backend test flake, #5 two ConfirmDialog tests under
Bun 1.4.2, #6 Bun 1.3.14's `toBe` on two DOM nodes; org .github #1 the
status dashboard skill does not read the stack repo.

## Lanes

Sessions A (`getmaipai-b8`) and B (`home-5a`) stopped clean at 02:20.
Codex and Session C were retired from this program at 01:20 (Codex
low on credits, C's model server down). Shared stashes on the repo:
`c/52-stack-weekly-digest` WIP and `codex/119` Cargo.toml, both old
and not this program's.
