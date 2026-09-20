# Home adopts the Stack: what Home's backlog gains, in order

2026-09-20. Step 6 of the refocus
([refocus-work-order-2026-09-20.md](refocus-work-order-2026-09-20.md)).
This is the hand-off to the `home` sessions: the items Home's
`docs/BACKLOG.md` must gain to run on the Stack, each pickup-ready in
the org template, and the order they land in. The Stack's side of every
seam is in [../integrations.md](../integrations.md); nothing here asks
the Stack for a route it does not already serve, and the shapes Home
imports are the six schemas under `backend/src/spec/` (moving to
`shared/spec` at 0c). The owner's rules that shape this note: the Stack
is Home's engine foundation and Home's installer installs it (a person
never installs the Stack by itself); one product on every screen; the
Engines page sits behind Home's existing admin sign-in, and the Stack
itself has no login because it is loopback-only and Home is its only
caller (principle 1: no second copy of identity).

## The order

| # | Item | Why here |
|---|---|---|
| 1 | HOME-STACK-01: install the Stack inside Home's installer | Nothing else can be exercised on a fresh machine until the service exists. |
| 2 | HOME-STACK-02: the Stack client and the role wire | Home's turn engine, embedder and voice path call by role; every later page reads through this one client. |
| 3 | HOME-STACK-03: the event bridge | Repairs, Updates and the Engines page all react to the feed; wire it once before any of them. |
| 4 | HOME-STACK-04: the Engines page | The one human-facing surface over the Stack's declarations, every verb mapped to a route. |
| 5 | HOME-STACK-05: Updates and Repairs wiring | The Updates page and the Repairs list gain the Stack's rows. |
| 6 | HOME-STACK-06: first-run sizing | Part of Home's first run, after the Engines page exists to land on. |
| 7 | HOME-STACK-07: the Studio bench as a Home bench | STACK-14's measurement, run from Home against the Stack it installed. |
| 8 | HOME-STACK-08: the `spec` move (only if 0c has not run) | The wire shapes into `shared/spec`; the Stack then deletes its local mirror (RF-05b). |
| 9 | STACK-16 in Home: dual-run, then delete Home's own supervisors | After the Studio proof; rollback restores the old path. |

## The items

- [ ] **HOME-STACK-01 (M): install the Stack inside Home's installer.**
  Home's installer places the `maipai-stack` binary for the platform,
  creates the Stack's data directory (owner-only) beside Home's own,
  runs `maipai-stack install-service` with `STACK_DATA_DIR` and `PORT`
  set (launchd `com.maipai.stack` on macOS; `systemd --user` on Linux
  once STACK-95 lands), waits for `/healthz` to answer with the version
  it shipped, and records the port in Home's one Stack-side setting.
  Home's updater does the same on a Home release that carries a new
  Stack binary (stop, replace, start, read `/healthz`). Home's watchdog
  sits above the Stack's service unit (org `SERVICES.md`). Files:
  Home's installer and updater, Home's settings declaration (the port
  key). Mirror: `stack/docs/integrations.md` "Install and service
  hand-off"; `stack/backend/src/service/launchd.ts`. Acceptance: a
  clean-account install ends with the Stack's `/healthz` answering and
  the service surviving a reboot; uninstalling Home uninstalls the
  Stack and, on the person's choice, its data. Out of scope: a
  standalone Stack installer (there is none). Exit: Home's
  `scripts/check.sh` and the clean-account install.
- [ ] **HOME-STACK-02 (M): the Stack client and the role wire.** One
  client module in Home's backend that speaks to the Stack on loopback
  by role (`/v1/chat/completions`, `/v1/embeddings`,
  `/v1/audio/transcriptions`, `/v1/audio/speech`,
  `/v1/images/generations`, `/v1/models`) with the `RoleRequest` shape,
  reads the `RoleReplyHeaders` on every reply (Home's `engineIdentity`
  check reads these instead of probing a process), and maps the
  Stack's failure shapes (503 with `offline_reason`, 409 unverified,
  400 unknown, 499 cancelled, 504 timed out) to Home's own errors
  without guessing a different cause. The turn engine, the judge, the
  embedder and the voice path call through it; Home's `/v1` stays the
  household assistant, never a raw pass-through. The voice path keeps
  `spec/voice`'s own shapes at the Stack's audio paths (the transcribe
  form and `SttWireEvent` session for `stt`, the `/tts` form and the
  streaming WAV for `tts`, `stack/docs/dev.md` "The speech roles"),
  and the household's Hugging Face token for voice cloning moves from
  Home's `HF_TOKEN` child environment to the Stack's secret-kind
  setting `stack.engines.tts.hf_token` (a `needs_restart` change the
  Stack applies); Home's `/api/voice/hf-token` becomes a write to it.
  Files: Home's engine
  client, the turn engine's model calls, the voice path. Mirror: the
  request and reply schemas under `stack/backend/src/spec/`; the
  contract tests in `stack/backend/tests/routes.test.ts`. Acceptance:
  every Home model call goes through the client (an inventory in the
  commit); a scripted Stack 503 becomes "I can't think right now" in
  the companion's voice plus a Repairs entry; the identity headers are
  logged per turn. Out of scope: removing Home's own supervisors (item
  9). Exit: Home's `scripts/check.sh`.
- [ ] **HOME-STACK-03 (S): the event bridge.** Home subscribes once to
  `GET /stack/v1/events` (reconnecting with `Last-Event-Id`) and maps
  the ten `StackEvent` ids into its notification system (org
  `NOTIFICATIONS.md`): `update.available`, `update.applied`,
  `model.installed` to admin notifications; `update.failed` to an
  immediate one; `health.changed` to a Repairs entry opened or closed;
  `engine.state` offline to a Repairs entry; `pressure` to a quiet
  status; `job.progress` and `job.done` to the package that submitted
  the job; `role.state` to the Engines page's live state. The Stack
  never notifies a person. Files: Home's notification producers.
  Mirror: `stack-event.schema.json` and its fixtures. Acceptance: each
  id has a mapping and a test fed by the Stack's fixtures; a dropped
  connection replays without duplicates. Out of scope: any UI. Exit:
  Home's `scripts/check.sh`.
- [ ] **HOME-STACK-04 (L): the Engines page.** One page in Home's
  admin, behind Home's existing admin sign-in (the Stack has no login:
  loopback-only, Home is its only caller, and identity lives once, in
  Home), rendered from the Stack's declarations with the kit; the same
  page on the phone, one column (org `UI.md`, "One product on every
  screen"). The person-facing verbs, each mapped to the Stack route
  that serves it:

  | What a person does | Stack route |
  |---|---|
  | See what this computer can run: the hardware facts, the profile tier, measured fit per role, worded for a dad by Home | `GET /stack/v1/hardware`, `GET /stack/v1/roles` (the bound model's measured or estimated footprint), `GET /stack/v1/hardware/budget` |
  | Choose the features you want: roles on or off (a role off is its engine unloaded and not started on demand) | `GET /stack/v1/roles`; `POST /stack/v1/models/{id}/actions` (`load`, `unload`, `pin`, `unpin`); `POST /stack/v1/engines/{name}/{start,stop}` |
  | Install, reinstall or remove an engine or a model, including LoRAs and sidecars for image and video once STACK-13 lands, with progress | `POST /stack/v1/engines/{name}/install`, `PUT /stack/v1/engines/{name}/current`, `DELETE /stack/v1/engines/{name}/builds/{tag}`; `POST /stack/v1/models` (pull by pin), `POST /stack/v1/models/import`, `DELETE /stack/v1/models/{id}`; progress on `job.progress` and `GET /stack/v1/jobs/{id}` |
  | Repairs: the problem list with one fix each, the fix button | `GET /stack/v1/health`; `POST /stack/v1/health/{code}/{fix,resolve,ignore}`; `POST /stack/v1/check` and `GET /stack/v1/check/latest` for "Check now" |
  | Updates as installed, available, last checked, go back | `GET /stack/v1/updates`, `POST /stack/v1/updates/check`, `POST /stack/v1/updates/engines/{name}/{apply,rollback}` |
  | The Stack's settings, in Home's generic settings renderer: no second declaration shape, because every Stack setting is a `home/spec` `SettingsKey` (scope `device`, `lives_in: stack`, keys under `stack.*`) plus `needs_restart`, `in_effect` and `pending` | `GET /stack/v1/settings` (the `StackSetting` list), `PUT /stack/v1/settings`, `POST /stack/v1/settings/apply` |
  | The privacy rows on Home's privacy page; the precious paths in Home's backup | `GET /stack/v1/privacy`, `GET /stack/v1/backup` |
  | A diagnostics bundle for support | `GET /stack/v1/diagnostics` |

  Files: Home's admin routes and the Engines page, the generic
  settings renderer's data source. Mirror: the six schemas under
  `stack/backend/src/spec/` and `stack/docs/integrations.md`'s tables.
  Acceptance: every verb above works end to end against a scripted
  Stack in Home's suite and live against the installed Stack; the
  screenshot matrix captures the page at both widths and the review
  judges each pair as one design; nothing on the page is a second copy
  of a Stack fact (references, not copies). Out of scope: the Updates
  page and the Repairs list themselves (item 5); the user-tier docs
  page ("what your computer can run"), which follows once the page is
  in family use. Exit: Home's `scripts/check.sh` and the screenshots.
- [ ] **HOME-STACK-05 (M): Updates and Repairs wiring.** Home's
  Updates page gains the Stack's engine and model rows (installed,
  available, last checked, notes, apply, go back) beside Home's own
  release row, and its schedule calls `POST /stack/v1/updates/check`
  (only when the person switched `stack.updates.enabled` on) and the
  maintenance actions the Stack no longer schedules for itself
  (`POST /stack/v1/check`, `POST /stack/v1/storage/sweep`). The
  Repairs list shows the Stack's health items as data with their fix
  button. Files: Home's Updates page and scheduler, the Repairs list.
  Mirror: `health-item.schema.json`; the updates route's response.
  Acceptance: a fixture engine index makes an update appear, apply
  swaps and a scripted failed swap shows the rollback fix; the
  schedule runs the check and the sweep and logs each. Out of scope:
  a Stack schedule of its own (there is none). Exit: Home's
  `scripts/check.sh`.
- [ ] **HOME-STACK-06 (M): first-run sizing.** Home's first run gains
  one step: what this computer can run (the Stack's hardware facts and
  proposed tier, worded for a dad), the roles the person wants, and
  the pinned model and engine installs with progress, landing on the
  Engines page. No wizard beyond that step; the Stack's own pins are
  the defaults. Files: Home's first-run flow. Mirror: item 4's routes;
  `stack/backend/src/profiles.ts` for the tier facts. Acceptance: a
  clean account reaches its first chat answer through the Stack with
  the identity headers logged. Out of scope: the Catalog's wider index
  (STACK-97). Exit: Home's `scripts/check.sh` and the clean-account
  run.
- [ ] **HOME-STACK-07 (L): the Studio bench as a Home bench.** STACK-74's
  protocol and STACK-14's measurement run from Home against the Stack
  it installed: the resident set (`chat`, `embed`, `judge`, `stt`,
  `tts`) loaded together, one generator on demand, `mlx-serve` and
  `oMLX` beside `llama-server`, numbers with engine build, model file
  and a sanitized hardware line recorded in the Stack's `dev.md`. The
  bench is explicitly run, never part of a gate. Files: Home's
  `scripts/bench/`, `stack/docs/dev.md`. Mirror: the 2026-09-18 walk's
  numbers in `stack/docs/dev.md` "Measured so far". Acceptance: the
  bench report and a chosen Studio profile. Out of scope: migrating
  Home before the numbers exist. Exit: the bench command in its
  report.
- [ ] **HOME-STACK-08 (S, only if 0c has not run): the `spec` move.**
  `home/spec` moves whole to `shared/spec` (the refocus's 0c); the
  Stack's six wire-shape schemas, fixtures and round-trip test copy
  across unchanged from `stack/backend/src/spec/` and its `gen:ts`
  replaces the hand-written Zod mirror (RF-05b on the Stack's side).
  Home pins `spec-v0.1.0` and removes the workspace; Catalog deletes
  its schema mirror and pins the package. Files: `shared/spec`,
  `home/spec`, `catalog/schema`. Exit: each repo's `scripts/check.sh`.
- [ ] **STACK-16 in Home (L): dual-run, then delete Home's own
  supervisors.** After item 7's proof: Home registers nothing (there
  are no clients), calls every role through item 2's client, runs its
  own supervisors and the Stack side by side with a parity check per
  role, then deletes `llmSupervisor`, `ttsSupervisor`,
  `embedSupervisor`, `backgroundSupervisor`, the resource governor,
  `engineIdentity`, the post-load check, the downloads and the engine
  half of `stt`, `updates`, and the routes that fronted an engine
  rather than a person. A rollback restores the old path. Files: the
  migration list in `stack/docs/dev.md`'s history (d4e088e, "What
  moves out of Home, later"). Acceptance: the dual-run check proves
  each role before removal and a rollback restores the old path. Exit:
  Home's `scripts/check.sh` and the dual-run report.

## What the Stack still owes Home for these

Nothing on this list is blocked on the Stack today except by scope
already in the Stack's backlog: STACK-13 (generator jobs and the
managed ComfyUI, which items 4 and 6 need for images), STACK-94c (the
`tts` role, which item 2's voice path needs; `stt` landed with 94b), STACK-95 (systemd, which
item 1 needs on the robot), STACK-97 (the Catalog engine index, which
item 5 needs for engines to show "available"). Each is filed in
`stack/docs/BACKLOG.md` with its own acceptance.
