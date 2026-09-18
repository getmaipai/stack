# Stack plan review, 2026-09-18

## Ranked findings

1. **Release ownership was the highest cost conflict.** `docs/dev.md`
   "The shipping shape" promised a tray with an updater and a published
   one-command install, while "The desktop program" says the Tauri app
   owns first-launch daemon installation and no Tauri updater exists.
   `docs/ux.md` "Install and first open" still called the app a later
   second path. The current Tauri shell is real
   (`desktop/src-tauri/src/main.rs`, `frontend/src/kit/host.ts`), but
   `scripts/build-release.sh` builds only a daemon executable and
   `desktop/src-tauri/tauri.conf.json` has no sidecar entry. More
   seriously, the Rust tray reads protected routes and posts Pause
   without a session (`desktop/src-tauri/src/main.rs`), while
   `backend/src/routes/runState.ts` requires the operator. STACK-76
   makes those actions use the signed-in console. I chose one
   product: the daemon is a service, the app is its native front, and
   both are distributed in v0.1.0. STACK-66 and RELEASE-STACK-01 now
   name the remaining install and build work. The owner decides when
   the tag and public release are cut.
2. **The default helper contradicted the owner's revision.**
   `docs/dev.md` "The helper" prescribed a pinned 1.8 GB model and a
   `helper` role; "The helper without a model" rejected both.
   `docs/ux.md` "Docs and the helper" agreed with the later decision,
   but STACK-37 still required a separate helper process and a 2 GB
   fallback. `backend/src/roles.ts` has no helper role. I selected the
   later model-free decision: local facts and shipped docs first,
   optional read-only questions on the operator's loaded chat engine.
   Phrase templates need measured corpus coverage and the org's rule
   counter; no expanding regex family. This keeps the safety, consent
   and privacy paths unchanged.
3. **The first release was missing recovery and distribution proof.**
   `docs/BACKLOG.md` called STACK-18 done while its acceptance still
   claimed service installation. `desktop/src-tauri/src/main.rs`
   currently calls `launchctl kickstart` but does not install an agent;
   `scripts/build-release.sh` writes a binary and SHA256SUMS but no
   `.dmg` or three update manifests. `docs/user/install.md` already
   describes the future app. STACK-66, RELEASE-STACK-01 and
   SITE-STACK-01 are release gates. STACK-72 adds encrypted state backup and staged restore;
   STACK-77 adds targets and schedule; STACK-78 proves each release
   restores. STACK-73 inventories outbound calls, license terms and
   release artifacts. A first release without these makes upgrade or
   machine loss a data risk.
4. **The Studio proof had no reproducible bench protocol.**
   `docs/plans/build-out-2026-09-17.md` ended Milestone 0 at the
   Studio but placed no fixed request mix, pressure thresholds or
   rollback rehearsal before STACK-14. `backend/src/lib/speedTest.ts`
   measures the current resident chat model; it is not a cross-engine
   residency proof. STACK-74 fixes the protocol before STACK-14.
   STACK-75 pins Stack/Home contract fixtures before STACK-16 removes
   Home supervisors. Only the owner can supply or authorize the
   Studio time and decide the winning profile from measured results.
5. **The API table mixed route existence with capability completion.**
   `docs/integrations.md` called jobs planned even though
   `backend/src/app.ts` mounts `routes/jobs.ts`; that route keeps an
   in-memory lifecycle map, while generator execution and result
   retrieval are still STACK-13. It called updates planned although
   `backend/src/app.ts` mounts `routes/updates.ts` and engine swap and
   rollback exist. `GET /v1/models`, image edits and streaming speech
   sessions are absent from `backend/src/routes/inference.ts` and
   `backend/src/app.ts`. The revised table says which part exists.
   STACK-60 owns model discovery and tool-call contract tests; STACK-13
   owns the generator job contract.
6. **The plan had no single milestone order.** The old build-out file
   still spoke in four first-day blocks; `docs/dev.md` now has the
   desktop program, while `docs/BACKLOG.md` used Milestone 0, 0b,
   0c and 0d as overlapping topic buckets. The backlog now orders
   v0.1.0, Studio, Home migration, later Mac operations, optional
   interfaces and the robot. The build-out file is marked historical.
   Jobs and the real image path precede the Studio's generator test;
   the Home migration follows the measured residency result.
7. **Backlog status was not a reliable input to the dashboard.**
   `docs/BACKLOG.md` repeated STACK-04c, STACK-34, STACK-07b,
   STACK-06b, STACK-09b, STACK-10, STACK-11b, STACK-11c, STACK-12,
   STACK-15b, STACK-19, STACK-35 and STACK-36; some later copies were
   open while their first entry was checked. STACK-33 was open after
   `953eda0` added local Library search. Several completed entries
   had `<hash>` or pre-landing hashes. Each now has one record with a
   main commit. STACK-18 is explicitly the shell; STACK-66 carries
   its unfinished service lifecycle.
8. **The experience chapters still stated replaced layouts.**
   `docs/ux.md` "The shell" prescribed a search field, twelve rows
   and a phone sheet, whereas "The shell, second pass" and "The
   phone, second pass" require an Ask icon, grouped rows and a tab
   bar. "Overview: the console dashboard" prescribed rings and a
   right rail; "Overview, second pass" removed both. The older
   passages are now rewritten in place as the current layout while
   their dated markers remain. The old menu-bar section now names
   the Tauri window and the remaining tray items.
9. **Settings, UI and licensing need a release audit.** Org
   `docs/SETTINGS.md` requires a generated reference, reset, disclosure
   levels and search filters. `backend/src/settings/stackKeys.ts`
   declares levels and sections but no generated reference or reset;
   its port default is 8787 while `backend/src/index.ts` and the desktop
   shell use 8770;
   the Settings UX promised a section named Sources while the code
   puts `huggingFaceEndpoint` in Storage. STACK-71 closes that gap.
   Org `docs/UI.md` sets a 48 px target floor, while the phone UX
   specified 44 px; the design now uses 48 px. `NOTICE` and `LICENSE`
   exist, but the release must check attribution and show model
   license terms before download (STACK-28 and STACK-73). The
   Org `CLAUDE.md` Trademarks mandates a README disclaimer with
   "non-commercial use" word for word, while its Licensing section
   forbids acceptable-use restrictions on AGPL. The owner must decide
   whether the disclaimer describes the target audience or should be
   reworded org-wide; the Stack cannot change that shared block alone.
   Current user docs and README still describe pre-release and
   superseded flows; STACK-70 owns their release rewrite.
10. **Two databases and the seam choices lacked release placement.**
    `docs/dev.md` decided on `stack.db` for precious state and
    `metrics.db` for rebuildable measurements; `backend/src/db/index.ts`
    and `backend/src/lib/paths.ts` still open one `stack.db`. STACK-50
    follows the first release, with default backup excluding metrics
    only after the split. `docs/dev.md` "The seams" rejects a plugin
    runtime, and `docs/integrations.md` lists client-facing routes;
    optional webhook, metrics and native Anthropic pass-through stay
    owner-call items rather than unexplained release blockers.
11. **The Bot API passage blurred the client boundary.**
    `docs/dev.md` "The API boundary" said Bot reaches the Stack
    through Home, while `docs/integrations.md` says Bot runs its own
    Linux Stack without Home. The passage now states Bot calls its
    local Stack directly and Go reads through Home or Bot.
12. **The coding-tool promise still fails on common tiers.**
    `backend/src/roles.ts` declares `coding` sharing chat, while
    `backend/src/profiles.ts` marks it unavailable below p128.
    `backend/src/routes/inference.ts` does not serve `GET /v1/models`.
    STACK-60 resolves the binding and discovery contract; STACK-61
    sizes context from the Studio bench. Agents remain clients and
    never become a Stack runtime.

## Source and scope notes

The review read `AGENTS.md`, all four Stack plan documents, both dated
plan files, all current user pages, the binding org standards, the code
trees and the named routes. The requested `home/spec/design/` directory
does not exist in the available Home checkout. The Stack boundary in
`home/docs/dev.md` lines 37 to 46 and the 2026-09-17 org Stack decision
were available. This review makes no change to Home's safety, consent,
privacy or child-band rules. The Stack remains client-only.

## Queue order after this review

The following entries are the names currently in the queue's `held/`
folder. "Rewrite" means update the existing brief to the revised
acceptance and current base before opening it. No held brief is opened
or claimed by this review.

| Held brief | Decision | Reason |
|---|---|---|
| `codex-107a6b-stack-ask-generated-not-committed` | rewrite | Keep the local Ask work, but split STACK-55 from model-free STACK-37 and bar default outbound search. |
| `codex-112b-stack-found-files-are-rows` | reorder | Ship after the app lifecycle; verify it against the current Add sheet. |
| `codex-114-stack-app-owns-daemon` | keep, first | STACK-66 is the prerequisite for a usable `.dmg`. |
| `codex-115-stack-tray-in-depth` | keep, second | STACK-67 follows a running bundled daemon. |
| `codex-116-stack-notifications-wanted` | rewrite, third | Limit native delivery to durable events and add per-kind controls and action tests. |
| `codex-117-stack-help-in-the-app` | rewrite | Use shipped offline docs; it follows Ask and the local index. |
| `codex-118-stack-user-docs-for-release` | rewrite | Cover the actual `.dmg`, service lifecycle, backup and current UI. |
| `codex-119-stack-release-build` | rewrite | Build the sidecar bundle, checksums, manifests and clean-clone dry run on a runner. |
| `codex-120-stack-site-install-sh` | reorder | Open only after the release assets and checksums exist. |
| `codex-121-stack-maintenance-window` | reorder | Useful after v0.1.0; it must not hold the first release. |
| `codex-122-stack-engines-kept-current` | reorder | Depends on the maintenance window and proven rollback. |
| `codex-123-stack-storage-hygiene` | reorder | Follow the release and the state backup; deletion needs measured byte accounting. |
| `codex-124-stack-licences-plain-words` | rewrite | Pull the pre-download license part into v0.1.0 and preserve full terms. |
| `codex-125-stack-guided-fixes-diagnostics` | keep | Release help needs redacted local diagnostics and exact fix links. |
| `codex-126-stack-connect-a-coding-tool` | reorder | The wire and UI matter, but do not block the desktop release. |
| `codex-127-stack-ready-when-you-sit-down` | reorder | Needs usage evidence and the maintenance scheduler. |
| `codex-128-stack-whats-new-for-your-computer` | reorder | Needs the opt-in index and proven fit measurements. |

The next lane sequence is 114, a new STACK-76 brief, 115, 116, 107a6b, 117, 124, 125,
then new STACK-71, STACK-72, STACK-77, STACK-78 and STACK-73
briefs, then 118, 119 and 120. The coordinator orders any newly briefed release work before
opening the later operations briefs. Studio work starts with STACK-74,
then STACK-13 and STACK-14; STACK-75 precedes STACK-16.
