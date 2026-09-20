# Reconciling the console to the approved UI specification (2026-09-19)

The owner approved a UI design specification on 2026-09-19
([`ui-spec-2026-09-19/spec.md`](ui-spec-2026-09-19/spec.md), six
reference images beside it). This note is the audit of what `main`
does against it, the decisions that reconcile the two, and the program
of work that takes the console to the specification in full. It is the
coordinator's record; the lanes' briefs cite it.

## 1. What main does today (audited at 4b01c1c)

The console is a shadcn dashboard-kit shell (`frontend/src/kit/`, the
copied `@maipai/ui` subset) with a black dark theme and an orange
accent (`kit/tokens.css`), a shadcn sidebar (`kit/ui/sidebar.tsx`),
and one header (`kit/blocks/dashboard/components/site-header.tsx`)
carrying a sidebar trigger, the page title, a search control that opens
a command palette, a Running/Paused pill, a bell and a profile menu.
`pages/DashboardShell.tsx` owns the routes and a phone shell (tab bar,
list rows) under 640 px. Destinations: Overview, Engines, Models,
Library, Help, Clients, Tester (`/try`), Monitoring, Settings, Logs,
Alerts, plus the first-run board (`/`, `/abilities`) and the login and
setup cards (`pages/LoginPage.tsx`, STACK-98). The list-and-panel
pattern exists (`kit/blocks/things-table`, `things-page`,
`property-panel`, `filter-column`), as do the Add sheet, the helper
panel, generic settings forms, the Live section and a two-column
Overview (`pages/overview/`).

The daemon already serves most of what the specification's surfaces
need: models, engines, roles, clients (with `lastSeenAt`), detected
installs, hardware (`computerName`, `osVersion`, CUDA devices, Apple
silicon), budget and pressure, live samples (per-process, per-GPU,
per-drive, per-client), storage drives, series (usage, memory, speed;
hour, day, week), health, repairs, updates and skips, logs, events over
SSE, run state, check, speed test, catalog, library and docs search,
helper, jobs, settings and the operator session. What it does not serve
yet: CPU, GPU and storage history, a month range, a network signal
(link speed and gateway latency), one unified component list across the
specification's eight categories, and a notifications read state.

## 2. The gap, surface by surface

| Specification | Main today | Verdict |
|---|---|---|
| Tokens: navy canvas and panels, seven luminous accents, 16/12/999 radii, panel shadow, 2 px blue focus ring | Black dark theme, orange accent, kit defaults | Replace the token set (UI-01). |
| Rail 252/72 px, double-chevron toggle persisted, four labeled groups, 17 destinations, collapsed icon rail, drawer under 720 | shadcn sidebar with two groups and 11 rows, no persisted collapse, a tab-bar phone shell | Rebuild the rail on the sidebar primitive (UI-02); retire the phone shell. |
| 64 px fixed header: destination icon, title, subtitle; a typeable search centered; appearance, notifications, machine/stack selector | Title, palette trigger, run pill, bell, profile menu | Rebuild (UI-02, UI-04, UI-16); the run pill leaves the header (section 3). |
| 40 px fixed footer: version, three linked counts, aggregate health | None | New (UI-02, counts from UI-08). |
| System pulse: five icons with dots, badges, tooltips, click targets | A memory and disk meter block | Replace (UI-03, network from UI-06). |
| Machine/stack selector with Lock MaiPai, Settings, Help; no profile or sign out | Profile menu with theme toggle and sign out | Replace (UI-04); remote stacks later (UI-22). |
| Overview: four metric cards, System Resources with sparklines and 1h/1D/1W/1M, Active Components table, Installed Components tiles, Recent Activity, Updates & Recommendations, Quick Actions | Status strip, hero chart, facts column, Live, tiles | Rebuild on the templates (UI-11) over the aggregate and series routes (UI-07, UI-08, UI-09). |
| Category browser: sticky controls dock (mode tabs, facets, filter, sort, list/grid, primary action), sticky table header, selectable rows, floating details pane with tabs and an action rail | Things table with a filter column and a docked property panel | Build the shared templates (UI-10); Models first (UI-12), then every category (UI-13, UI-14). |
| Settings: VS Code style workspace, four canonical groups, editor pane, inline "Setting updated", risk confirmations, diagnostics | One page with sections and generic forms | Rebuild (UI-15). |
| Search: typeable, results below the field, components, packages, docs, logs, settings, commands | Command palette dialog | Rebuild (UI-16); the helper stays a result group. |
| Monitoring: zero, one or many GPUs and disks, "Not reported", Apple unified memory wording, real series | One memory chart with an invented eight-point series, a governor card | Rebuild (UI-18) on UI-07; the invented series goes. |
| Responsive tiers 1280, 960, 720; accessibility rules | 640 and 1024 breakpoints, phone shell | New tiers in the tokens (UI-01) and a pass with captures (UI-21). |

## 3. Decisions that reconcile the specification with the design record

The specification wins wherever it and `ux.md` disagree; the sections
of `ux.md` it supersedes carry a one-line pointer here. The decisions
below are the coordinator's reading of the specification against the
platform rules; the owner's two open calls are in section 6.

1. **The taxonomy is the console's information architecture, backed by
   truthful data.** Every one of the 17 destinations exists, in the
   specification's groups and order, from one declaration
   (`frontend/src/lib/taxonomy.ts`, UI-05). A category the daemon
   manages today shows its real rows; a category it does not manage
   yet shows the browser template with a designed empty state that says
   what fills it, never a mock row and never a spinner. The mapping:

   | Destination | Data behind it today | Empty state until then |
   |---|---|---|
   | Models (LLMs, Image, Video, Audio, Embeddings) | the model store, by kind | the Add flow |
   | Adapters (LoRAs, ControlNets, VAEs) | none (STACK-96 noted LoRA as future) | "Adapters arrive with the first engine that loads them." |
   | Apps (Chat, Image, Coding, Agents, Knowledge) | Chat and Image: the Tester surfaces; Coding and Agents: clients holding the `coding` role (STACK-60, the "connect a coding tool" flow); Knowledge: the Library and the served `stack-library` MCP server | the Connect flow |
   | Runtimes (Ollama, llama.cpp, vLLM, Diffusers) | the engine catalog and detected installs (`detect.ts`); a kind absent from this platform's catalog is listed in Browse as not available here, with the reason | the Add flow |
   | Workflows (ComfyUI, n8n, Langflow) | ComfyUI: the managed ComfyUI and its jobs when STACK-13 lands; n8n and Langflow: hosts a person points at (seam 2) | "Point the Stack at a workflow server you run." |
   | Extensions (Plugins, MCP Servers, Integrations) | MCP Servers: the servers this Stack serves; Integrations: alert channels, the Hugging Face mirror, backup targets (seam 4); Plugins: none, and the empty state says the Stack takes no plugin code | the channel and target settings |
   | Training (Trainers, Fine-tuning, Datasets) | none | "Training arrives after the first release." |
   | System / Drivers (Drivers, Accelerators, Dependencies) | hardware (Apple silicon or CUDA), the engine builds and their pins, Check my Stack results | n/a (always has rows) |
   | Clients | the client keys, `lastSeenAt`, live per-client counts | the key dialog |
   | Monitoring | budget, live, series | n/a |
   | Tester | `/try` | n/a |
   | Packages | the Stack's own install catalog (models and engines it can install and update), the Browse source for every category | n/a |
   | Docs | Help and the Library, one local search (STACK-85) | n/a |
   | Settings, Logs, Alerts | as today, restyled | n/a |

   "Agents" lists clients: the platform rule that the Stack never runs
   an agent loop (`dev.md`, "Agents and harnesses") is untouched; the
   destination shows the harnesses connected as clients, which is what
   the rule says they are. "Plugins" and the "no extension system"
   rule (`dev.md`, "The seams") likewise stand: the sub-page says so in
   its empty state. The owner's call on whether the product's scope
   grows to manage Ollama, vLLM, ComfyUI, n8n, Langflow, adapters and
   training as first-class components is section 6, question 1; it
   changes what fills the pages, not the pages.

2. **Pause everything leaves the header.** The specification's header
   center is the search field and its right group is appearance,
   notifications and the selector. The run state stays a first-class
   control in the tray, in the search's commands group ("Pause
   everything", "Resume"), on Settings > General, and as the footer's
   health text while paused ("Paused by you"). One implementation, as
   before.

3. **Lock replaces sign out.** "Lock MaiPai" ends the operator session
   (`POST /stack/v1/operator/logout`) and shows the login card with the
   word "Locked"; the daemon, the engines and the clients continue. No
   sign-out control exists anywhere else.

4. **The machine identity lives only in the selector.** The rail's
   bottom block is the pulse; the logo subtitle "Your AI. On Your
   Terms." replaces the computer name under the wordmark.

5. **One theme system, dark first.** The specification defines the dark
   navy palette; it is the default and the reference. The appearance
   control offers System, Light and Dark; the light palette is derived
   from the same hues on light surfaces and passes the same AA test.
   No screen may depend on the light theme for legibility.

6. **The type face is the system stack at the specification's sizes.**
   Aptos Display is not licensed for redistribution and is absent from
   a stock Mac; the console uses the platform's system face (SF on
   macOS) at 28 to 32 px semibold for the destination title and the
   specification's scale below it. Recorded as the one token deviation.

7. **Icons are lucide, one family**, already the kit's, at 20 to 22 px;
   the category icon map (`kit/icons.ts`) is extended with the eight
   category glyphs and their hues from one declaration.

8. **The first-run board becomes Overview's first state.** The header
   reads "Overview" from first launch; before a plan exists, the content
   region shows the board's Add abilities flow. The `/abilities` route
   remains the destination of "Install Component".

9. **The phone shell retires.** Under 720 px the shell is the drawer
   navigation with the pulse in the drawer footer, stacked panels and
   labeled rows; the details pane is a full-screen sheet. No tab bar.

10. **Real data or nothing.** A sparkline draws recorded samples or an
    empty track with "No samples yet"; the invented eight-point memory
    series in `MonitoringPage` is removed in UI-18 and a test forbids
    synthesized points in a chart.

11. **Remote stacks are a later item.** The selector's "Switch stack"
    section renders only when another stack is configured; UI-22 designs
    and builds connecting one (address, client key, readiness check,
    offline retry). Nothing in the first release pretends a second
    machine exists.

12. **Templates before pages.** No category page is written by hand:
    UI-10 builds the browser, table, pane, dock, confirm, metric card,
    resource row, tile and state components once, with the shared
    hooks the specification names; every category is a configuration.

## 4. The program

Four blocks. Block 1 is the foundation and lands first, on `main`,
from the main checkout. Blocks 2 and 3 run in parallel worktrees and
rebase onto Block 1 before landing. Block 4 closes.

| Block | Items | Lane |
|---|---|---|
| 1. Foundation | in-flight landing; UI-05 taxonomy; UI-01 tokens; UI-02 shell (rail, header, footer, content region, responsive tiers); UI-03 pulse; UI-04 selector and Lock | Session A (Claude, Opus; integrator; main checkout) |
| 2. Data | UI-06 network; UI-07 resource series; UI-08 components aggregate, activity and notifications; UI-09 recommendations | Session B (Claude, Sonnet or Opus; worktree `stack-b`) |
| 3. Surfaces | UI-10 templates; UI-11 Overview; UI-12 Models; UI-13 Runtimes; UI-14 the other categories; UI-15 Settings workspace; UI-16 search; UI-17 notifications; UI-18 Monitoring; UI-19 the remaining destinations; UI-20 first run | B (templates, Overview, Models), Codex (Settings workspace, then category pages), Session C (tests, formatters, status map, the removal items) |
| 4. Close | UI-21 responsive and accessibility pass with captures; UI-23 docs and screenshots; ux.md pointers | A |

Landing rules: one commit per item, gated with `bash scripts/check.sh`
in the lane's worktree with `STACK_DATA_DIR` pointed at a temp dir;
the integrator cherry-picks or fast-forwards in program order, gates
`main`, pushes, deletes the landed branch. Captures are regenerated once
per block, not per item, until UI-21 (the old captures are all
superseded). Every UI item's acceptance is the flow exercised and the
capture opened and judged at 1440 and at the responsive tiers the item
names.

## 5. What was in flight, and what happens to it

Seven commits from the night of 2026-09-18/19 were reported done and
not landed: the weekly digest (STACK-27, `c/67-stack-weekly-digest`),
the desktop setup field (`c/67-stack-desktop-setup`), storage hygiene
(STACK-24), guided fixes (STACK-29), connect a coding tool (STACK-60),
ready when you sit down (STACK-23) and What's new for your computer
(STACK-21). All are daemon behavior or small console changes the
specification keeps (Updates & Recommendations, Quick Actions,
Diagnostics, Clients); they land first, then the console work begins
over them. Their captures were not made and are not needed: the
surfaces they touched are rebuilt in Block 3.

The Codex queue from the 2026-09-18 handoff (107a6b, 112b, 113 to 128)
is complete or superseded: 113 to 128 landed or sit in the seven above;
107a6b (the Pagefind index at build) and 112b (found files as rows) are
folded into UI-19 (Docs) and UI-14 (Packages). The look-and-feel items
STACK-38 to -47 and the second-pass sections of `ux.md` are superseded
by the specification; their tick lines stay as history.

## 6. The owner's calls

1. **Scope of the managed categories.** The specification's primary
   purpose line reads "a package manager, runtime manager, and system
   monitor for the entire local AI stack", and its taxonomy names
   Ollama, vLLM, Diffusers, ComfyUI, n8n, Langflow, LoRAs, ControlNets,
   VAEs, trainers and datasets. The design record says the Stack
   manages its own pinned engines and models and reaches everything
   else through four seams. The console is built to the taxonomy
   either way (decision 1); the call is whether the daemon grows to
   install and run those third-party runtimes and workflows itself
   (each an L item with its own design pass: Ollama and vLLM as engine
   kinds, ComfyUI as STACK-13, n8n and Langflow as pointed-at hosts,
   adapters as STACK-96, training new), and in what order after the
   first release.
2. **The light theme.** Decision 5 derives one; if the owner wants
   dark only, the appearance control is dropped and UI-01 loses half
   its work.

## 7. Verification of the whole

The block is done when every row of the specification's acceptance
checklist has evidence: the reference images in the repo and named in
`ux.md` (this note); the taxonomy test (UI-05) and the four group
captures; the Monitoring captures with zero, one and two GPUs and one
and three disks from the showroom's scripted stand-ins (UI-18); the
interaction list exercised in the capture script (search, notifications,
selector, lock, a row action, a loading state, an error state, keyboard
order) in UI-21; and a fresh destination built from the templates in
under a day (UI-14's last category is that proof). An independent
review of the whole diff against the specification closes the block
(the coordinate skill, section 4).
