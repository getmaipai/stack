# Lane A continuation (2026-09-20, fresh session on Opus)

**First message back:** `ready UI-A2`, the model named in your system
prompt, checkout and branch, one line of assignment. Start on `start`.
Coordinator: session `getmaipai-47 [486133]`; SendMessage with
`notify_when_idle: true` on every report.

You are Session A, main checkout `~/Developer/github.com/getmaipai/stack`
on `main`, port 8770 (the owner's live daemon; I restart it, you do not).
Read, in order: `docs/plans/ui-reconcile-2026-09-19.md` (the program,
sections 3 and 4), `docs/plans/ui-spec-2026-09-19/spec.md` (the browser,
Models and reuse sections; open `models-browser-and-pane.png` and
`overview-dashboard.png`), `docs/plans/lane-a-2026-09-19.md` and
`lane-b-2026-09-19.md` only for the standing rules, `docs/dev/session-a.md`
(the previous session's notes), `git log --oneline -25`, and
`docs/BACKLOG.md` area "UI specification reconciliation" for what is
ticked.

Standing rules (unchanged): every test, gate and capture runs in the
foreground with the tool timeout raised, never in the background; wait
for any other gate (`while pgrep -f 'bash scripts/check\.sh' >/dev/null;
do sleep 15; done`) then gate as `TMPDIR=/tmp STACK_DATA_DIR=$(mktemp -d)
bash scripts/check.sh`; code review at medium before each commit; docs
and the BACKLOG tick "(verified at <hash>)" in the same commit; stage by
name; rebase onto origin/main and push your own commit; every report
names the capture paths you opened. No background agent runs git or
edits files. Files: you own `frontend/src/pages/**` except
`SettingsPage.tsx`, `pages/settings/**`, `OverviewPage.tsx`,
`pages/overview/**` (Lane B's), and the kit blocks you built in UI-10.

Your items, in order, each one commit:

1. **UI-13 Runtimes** on the CategoryBrowser (`pages/EnginesPage.tsx`
   becomes the Runtimes page at `/runtimes`): Installed from
   `/stack/v1/engines` plus detected installs from `/stack/v1/detected`
   (status "detected", action Adopt); facets Ollama, llama.cpp, vLLM,
   Diffusers from the taxonomy, with a kind absent from this platform's
   catalog shown in Browse as one row "Not available on this computer"
   with the reason from the engine catalog; Updates from
   `/stack/v1/updates` engines; pane tabs Overview (kind, version and
   whether current, where it lives, roles it serves, provenance, measured
   footprint and speed), Settings (its declared configuration), Logs
   (the tail); action rail Start, Stop, Restart, Update, Make current,
   Open logs, Forget. Captures: list and pane at 1440.
2. **UI-14 the other categories**, one commit per two pages: Adapters,
   Apps, Workflows, Extensions, Training, System / Drivers, Packages,
   each a CategoryBrowser configuration with the data source or the
   designed empty state from the program note's section 3 table
   (decision 1); System / Drivers always has rows (accelerators from
   `/stack/v1/hardware` and `/stack/v1/live` gpus, drivers, engine
   build pins); Packages is the install catalog (`/stack/v1/catalog/search`)
   across categories; Apps: Chat and Image rows link to Tester, Coding
   and Agents rows are clients holding `coding` from `/stack/v1/clients`,
   Knowledge is the Library. The ComingSoonPage placeholder is deleted
   when the last of these lands. Captures of each page at 1440.
3. **UI-19 the remaining destinations** inside the shell rules: Logs,
   Alerts, Clients (AccessPage), Tester, Docs (Help and Library in one
   page with one search): no duplicate title beneath the header,
   toolbars below the header, tokens only, states from `kit/blocks/states`.
4. **UI-16 global search**: the header field's results cover components
   (from `/stack/v1/components` once B lands UI-08, else models and
   engines), packages (the catalog), docs (`/stack/v1/docs/search` and
   the knowledge index), logs, settings (the settings keys), commands
   (Pause everything, Resume, Check for updates, Run speed test), and
   "Ask the helper about …"; ⌘K focuses the field; keyboard navigation
   of results; the helper panel opens from the result.

Report `done <item>` with hash, gate line and capture paths after each.
