# Lane A session log (2026-09-19/20)

Foundation lane of the UI reconcile program
(`docs/plans/ui-reconcile-2026-09-19.md`, work order
`docs/plans/lane-a-2026-09-19.md`, then `docs/plans/lane-b-2026-09-19.md`'s
UI-10/UI-12 sections). Main checkout.

- **UI-10 (`browser/DataTable.tsx`) does not use `@tanstack/react-table`,
  removed as an unused dependency.** The installed version (9.2.4)
  ships a new headless-factory API (`createTableHook`, `ReactTable`)
  built for faceting, grouping and pinning; its v8-compatible
  `useLegacyTable`/`legacyCreateColumnHelper` shim (under `/legacy` and
  `/flex-render`) exists but its generics don't infer cleanly for an
  arbitrary row type under strict TypeScript (unrelated-type errors on
  a minimal column/row setup). What UI-10's table actually needs is
  sorting, row selection, secondary-column priority hiding under
  1280px, and a sticky header, none of which need faceting, grouping
  or pinning. `DataTable.tsx` drives a plain array over the kit's
  existing `Table` primitive instead: full type safety, no fighting an
  API built for a different job. Flagged to the coordinator and
  accepted.
- **`lib/format.ts`'s `formatBytes` duplicates `pages/overview/SegmentedBar.tsx`'s
  own module-local `formatBytes`** (different thresholds and rounding,
  no null handling on the older one). Not migrated here since
  `SegmentedBar.tsx` is Overview's file (UI-11), and UI-11's own spec
  already replaces its Storage widget with a `ResourceRow` built on the
  new shared formatter, noted here so whoever builds UI-11 knows to
  delete `SegmentedBar.tsx`'s copy rather than keep both.
- **UI-12's real data sources are `/stack/v1/models`, `/stack/v1/groups`
  and `/stack/v1/detected` for Installed, not the spec text's literal
  `/stack/v1/components?category=models`**, coordinator-confirmed
  before UI-08 landed a real `/stack/v1/components` route: checked it
  after the fact (`backend/src/routes/components.ts`, `ComponentRowSchema`)
  and it is a generic cross-category summary for Overview's list (no
  roles, usage, licence, groupId, or model actions), not a fit for this
  page's management view. Not switched. Browse combines the
  local catalog route and, when the filter box has text, Hugging Face
  search, reusing `AddSheet`'s own resolve step (unresolved Hugging
  Face rows show "Review", which resolves and opens the same
  `DetailsPane` before Install unblocks). Updates renders the
  aggregate `models` version state from `/stack/v1/updates`; Recommended
  renders that route's `recommendations` array. The nested group tree
  is dropped for a flat table; a model's group name is searchable
  through the filter box instead of a separate dropdown, since the
  approved screenshot (`models-browser-and-pane.png`) does not show a
  distinct group filter control either.
- **Quantization, Runtime (engine assignment) and Context length show
  "Not reported" everywhere in UI-12**, list and pane alike: the real
  `ModelSchema` (`backend/src/routes/models.ts`) never exposes these
  fields today, even though the approved screenshot shows populated
  values. Architecture likewise, except where a model's own
  `provenance.licence` happens to carry it.
- **The pane's Settings and Logs tabs render `Empty` states, not
  fabricated content.** No per-model settings exist server-side
  (`/stack/v1/settings` is one global collection, not model-scoped),
  and no per-model log tail exists (`/stack/v1/logs/{name}` tails a
  named operator log, not a model or engine's own log). Files shows the
  one real file behind `modelPath` and its size; there is no per-model
  multi-file listing outside the Hugging Face resolve step.
- **The action rail's Test button calls the existing, unparameterized
  `/stack/v1/speed-test`**, which always measures whatever the resident
  chat model is (`backend/src/lib/speedTest.ts`'s `residentChatModel()`),
  the same limitation `OverviewPage`'s own "Run Speed Test" button
  already ships with. Disabled with a stated reason on any model
  without the `chat` role, since testing those would silently measure
  a different model than the one the rail is showing.
- **Bug fixed in `pane/DetailsPane.tsx` (shared UI-10 code, not
  UI-12-only): the phone-width sheet still carried the desktop
  `min-w-[480px]`, which wins over the `max-[719px]:w-full` it also
  sets (min-width always overrides width), pushing every phone
  capture 90px past the viewport.** Fixed with
  `max-[719px]:min-w-0`; a regression test in
  `pane/DetailsPane.test.tsx` asserts both classes are present.
  Content inside pane tabs also needs `min-w-0` on any CSS grid item
  holding a long, truncated string (a grid item's automatic minimum
  width is its content's, not zero, unlike a plain block element).
  ModelsPage's Overview/Usage tabs now carry it; worth checking for the
  same shape in any other pane content Session C or B write later.
- **`panels/model.tsx` and `panels/group.tsx` (the pre-rebuild
  `modelPanel`/`groupPanel` property-panel adapters) deleted as
  UI-12 orphaned them**, along with their two cases in the shared
  `panels.test.tsx`. `lib/actions.ts`'s own "model" and "group"
  `ThingKind` branches are now unreachable in production the same way
  but were left in place: narrowing that shared, still-tested function
  is a larger edit than this item's scope, flagged here rather than
  done silently.

## Boundary (2026-09-20, end of this lane's run)

`main` is at `fa3ba8d` (Console (UI-12): Models on the shared
browser), pushed, one commit past `f58e4f6` (Console: read the
stamped role state everywhere, the STACK-87 crash fix, also pushed).
Working tree clean, nothing uncommitted. `git stash list` carries two
entries neither made by this lane (`WIP on c/52-stack-weekly-digest`
and `On codex/119-stack-release-build: preserve preexisting 119
Cargo.toml edit`); left alone. Two pre-existing, order-dependent
backend test flakes were hit while gating (not caused by this lane,
zero backend files touched): the memory-pressure one from Step 0
(getmaipai/stack#1) and a newly filed one, `backend/tests/hardware.test.ts`
failing only inside the full suite (getmaipai/stack#4). Next up per
`docs/plans/lane-a-continue-2026-09-20.md`.

## Stopped mid UI-12b (2026-09-20, second run on this lane)

Edited, all uncommitted in the working tree: `frontend/src/kit/blocks/pane/PaneContainer.tsx`
(new), `kit/ui/sheet.tsx`, `kit/blocks/pane/DetailsPane.tsx` and its
test, `pages/DashboardShell.tsx` (the pane's portal now scopes to the
shell's content region instead of the viewport); `kit/blocks/browser/CategoryBrowser.tsx`
and its test (a `secondaryAction` slot); `pages/ModelsPage.tsx` and its
test (merged detected/installed rows into one table, Type is the
subtype with roles moved to a Roles column and the pane's capability
tags, one licence field, a working Sort control); `backend/src/routes/models.ts`,
`backend/src/lib/gguf.ts` (+`evictGgufFacts`, +tests), `backend/src/lib/modelStore.ts`
(evicts on remove), `backend/src/showroom/fixture.ts`, `docs/api/openapi.json`
(regenerated); five re-captures at `docs/assets/screens/models-*.png`.
All six of the coordinator's UI-12b points (a-f) are done and opened
against the reference; two real bugs code review found (a stale
per-file GGUF cache entry after a model is removed, and the scoped
overlay not following the pane back to a viewport-fixed sheet under
719px) are fixed and tested. The one code-review finding left open:
`selectedIds` now mixes `model:`/`detected:` row ids in one selection
state on the merged table, harmless today since nothing reads
`selectedIds` yet, but a foot-gun for whoever wires the first bulk
action against it. `bash scripts/check.sh` was full green on this
exact diff immediately before the stop order arrived. To resume:
read the diff (`git status`, `git diff`), decide on the open
`selectedIds` finding, run the gate once more, code-review, commit,
push.
