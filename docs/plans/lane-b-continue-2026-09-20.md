# Lane B continuation (2026-09-20, fresh session on Opus)

**First message back:** `ready UI-B2`, the model named in your system
prompt, checkout and branch, one line of assignment. Start on `start`.
Coordinator: session `getmaipai-47 [486133]`; SendMessage with
`notify_when_idle: true` on every report.

You are Session B, worktree `~/Developer/github.com/getmaipai/stack-b`
on branch `b/ui-data` (rebase onto origin/main first), port 8771,
`TMPDIR=/tmp STACK_DATA_DIR=/tmp/claude-501/stack-b-data` for every
gate. Read, in order: `docs/plans/ui-reconcile-2026-09-19.md` (sections
3 and 4), `docs/plans/ui-spec-2026-09-19/spec.md` sections 3, 5, 6 and
7 (open `overview-dashboard.png`), `docs/dev/session-b.md`, `git log
--oneline -25`, `docs/BACKLOG.md` area "UI specification reconciliation".

Standing rules: as in `lane-a-continue-2026-09-20.md` (foreground only,
the gate wait line, review before commit, docs and tick in the same
commit, push your own, captures named in every report, no background
agent touches git or files). Files: `backend/**`, `frontend/src/pages/
OverviewPage.tsx`, `pages/overview/**`, the dashboard shell components
you built (header, footer, pulse, selector), `hooks/useStackCounts`.

Your items, in order, each one commit:

0. **Land UI-15 (Codex's Settings workspace) past a Bun segfault** (S/M,
   first, 45 minutes cap). State in `stack-b`: the cherry-pick sits as
   commit 0538687 (unpushed) plus a docs note 9764cb8; uncommitted on
   top: route-level `React.lazy` for the heavy pages and a shared
   `kit/blocks/dashboard/components/search-field.tsx` used by the header
   and the Settings navigator (both worth keeping). The full frontend
   suite (`bun test` in `frontend/`, Bun 1.3.14) segfaults ("panic(main
   thread): Segmentation fault at address 0x0", the bun.report link is
   in `docs/dev/session-b.md`) only when SettingsPage's rendered search
   subtree is reachable in a full-suite run; every file passes alone and
   main at f4a9866 passes whole. Not a runner flag, not a red push. In
   order: (a) read the bun.report trace and `docs/dev/session-b.md`'s
   isolation notes; look for what the crashing subtree does that the
   header's does not (a `ref` callback, a `Link` inside a labelled
   control, an effect touching `document` after happy-dom teardown) and
   fix that in SettingsPage; (b) if the trace points at Bun itself, pin
   a newer Bun for the repo (`.bun-version` plus `packageManager` in the
   root package.json, `bun upgrade` locally is fine as a dev-machine
   choice, recorded in `docs/dev.md` and the README's setup line) and
   re-run; (c) if neither closes it inside the cap, make the Settings
   navigator's search an in-page filter without the shared search
   field, commit, and file the crash as an issue with the reproduction.
   Then gate, push (UI-15 tick "(verified at <hash>)" with the captures
   Codex made re-taken by you at 1440 and 800), and report.

1. **UI-11 Overview**, spec section 3 exactly, on A's templates
   (`kit/blocks/cards`, `browser/DataTable`, `states`) over
   `/stack/v1/components/summary`, `/stack/v1/series/resources`,
   `/stack/v1/components?status=running`, the activity feed and
   `/stack/v1/updates` (recommendations): four MetricCards; System
   Resources (CPU, Memory purple, GPU teal named for the device or the
   Apple accelerator, Storage orange, each a ResourceRow with a
   sparkline; the 1h/1D/1W/1M control; View All Resources to
   `/monitoring`); Active Components (Name, Type, Status, Resources,
   Uptime, Actions; View All violet); Installed Components tiles (eight,
   counts, Browse All to `/packages`); Recent Activity; Updates &
   Recommendations (badge, rows with Update, Install or View); Quick
   Actions (Install Component to `/abilities`, Check for Updates posts
   `/stack/v1/updates/check`, Run Speed Test, View Logs). Equal-height
   cards; tiers per section 7; the first-run board remains the first
   state when no plan exists. Delete `pages/overview/SegmentedBar.tsx`'s
   local formatBytes in favor of `lib/format.ts`. Captures at 1440,
   1100, 800 and 390, judged against `overview-dashboard.png`.
2. **UI-18 Monitoring**, spec section 6: CPU (host-wide, processes and
   per-runtime allocation), Memory (pressure and attribution), GPUs
   (summary then a row per device, "Not reported" for missing metrics,
   Apple unified memory wording), Storage (summary then a row per
   drive, warnings first); real series only; the invented eight-point
   series in the old MonitoringPage is removed and a test forbids
   synthesized chart points. Captures with zero, one and two GPUs and
   one and three drives from the showroom's scripted stand-ins.
3. **UI-09 recommendations** as the c-70 brief specified
   (`home/data-scratch/c/queue/pulled/c-70-*.md`), if UI-11 needed it
   reshaped; else tick it as satisfied by the existing route.
4. **UI-17 notifications** polish: the bell's badge counts only unread
   actionable items, the list marks read and opens the target.
5. The two review-fix briefs pulled from Session C:
   `pulled/c-72-stack-digest-review-fixes.md` and
   `pulled/c-73-stack-hygiene-review-fixes.md`, one commit each.

Report `done <item>` with hash, gate line and capture paths after each.
