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
