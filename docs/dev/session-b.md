# Lane B session log (2026-09-19)

Data and templates lane of the UI reconcile program
(`docs/plans/ui-reconcile-2026-09-19.md`, work order
`docs/plans/lane-b-2026-09-19.md`). Worktree `stack-b`, branch
`b/ui-data`, off `main` at `3cb7183`.

- **UI-06 (network signal).** `GET /stack/v1/network` reads the default
  route and link speed with platform-specific commands (macOS `route
  -n get default` and `ifconfig`; Linux `/proc/net/route` and
  `/sys/class/net/<if>/speed`), and measures the gateway round trip
  with a plain TCP connect to port 80 (three samples, median, 1 s
  timeout each) rather than shelling out to `ping`, which uses an
  inconsistent timeout flag unit between macOS and Linux. Cached 30 s.
- Local `bun test` runs on this Mac leave `STACK_DATA_DIR` unset so
  `tests/preload.ts` assigns its own temp directory; that guard refuses
  any `STACK_DATA_DIR` not under the OS temp root
  (`os.tmpdir()`, which resolves under `/var/folders/...` here, not
  `/tmp`), so the work order's literal
  `STACK_DATA_DIR=/tmp/claude-501/stack-b-data bash scripts/check.sh`
  will hit the same refusal on this machine. Flagged to the coordinator;
  using the auto-assigned temp dir for gates run from here until told
  otherwise.
