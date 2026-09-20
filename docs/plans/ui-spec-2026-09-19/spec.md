# MaiPai Stack UI Design Specification (approved 2026-09-19)

The owner's approved UI specification, transcribed from the supplied
document into the repo so every session builds from the same words and
pictures. The six reference images beside this file are the visual
authority; this text is the contract. Where this specification and any
earlier section of `docs/ux.md` disagree, this specification wins (the
reconciliation program is [`../ui-reconcile-2026-09-19.md`](../ui-reconcile-2026-09-19.md)).
Punctuation was normalized to the org writing standard; wording is
otherwise the supplied document's.

The supplied blue-black MaiPai Stack Overview dashboard
([overview-dashboard.png](overview-dashboard.png)) is the visual source
of truth. This specification preserves its taxonomy-first sidebar,
layered navy panels, luminous category accents, dense live monitoring,
actionable cards, and desktop-control-center clarity. It supersedes the
earlier scratch reference entirely.

## Source of truth and design principles

| Decision | Implementation rule |
|---|---|
| Primary purpose | A package manager, runtime manager, and system monitor for the entire local AI stack. |
| Dashboard priority | Answer: what is installed, what is running, what needs attention, and what is consuming the machine. |
| Visual character | Premium technical desktop UI: dark navy depth, luminous semantic accents, rounded modular panels, calm high-density layout. |
| Preservation rule | Keep the screenshot's Overview composition and hierarchy. Add functionality through the existing card, row, and sidebar patterns rather than redesigning the shell. |

## 1. Foundations and visual tokens

| Token | Hex | Use |
|---|---|---|
| Page canvas | `#07111F` | Main background and empty space. |
| Sidebar | `#0A1A2E` | Persistent left navigation; subtle vertical depth. |
| Panel | `#102238` | Metric cards, tables, resource groups, lower dashboard cards. |
| Raised panel | `#142A43` | Hover, segmented selection, search field, action tile. |
| Border | `#294563` | 1 px panel, row, and control boundaries. |
| Primary text | `#F4F8FF` | Titles, values, selected controls. |
| Secondary text | `#A9BED7` | Descriptions, versions, timestamps, supporting labels. |
| Electric blue | `#21A6FF` | Models, app/runtimes, search, links, resource UI. |
| Violet | `#A434FF` | Adapters, profile affordances, selected navigation. |
| Teal | `#00E3AE` | Healthy, running, success, GPU activity. |
| Orange | `#FF8A35` | Workflows, storage, urgent resource activity. |
| Pink | `#FF3E9A` | Image components / image apps. |
| Red | `#FF4B62` | Errors, critical notices, notification count. |

Use translucent depth sparingly: panel shadow `0 12px 28px rgba(0,0,0,.24)`,
16 px card radius, 12 px control radius, 999 px status pills. Avoid flat
black, generic gray cards, orange-only accents, and oversized empty space.

### Typography and layout

| Role | Rule |
|---|---|
| Page title | Aptos Display 28 to 32 px semibold; sentence case. |
| Section and card title | 16 to 18 px semibold; concise noun labels. |
| Metric | 26 to 30 px semibold for top totals; tabular figures. |
| Body / row primary | 13 to 14 px medium; never below 12 px for primary UI. |
| Supporting / version | 11 to 12 px regular, `#A9BED7`. |
| Grid | 24 px page gutter; 12 px card gap; 16 px inner padding; 8 px micro gap. |

## 2. Navigation and global controls

The full sidebar taxonomy is mandatory. Preserve its stacked mark,
"MaiPai Stack," subline "Your AI. On Your Terms.", active Overview
treatment, grouped dividers, and bottom machine-health card (revised
below: the bottom-left area is the system pulse).

| Group | Labels |
|---|---|
| STACK | Overview; Models; Adapters; Apps; Runtimes; Workflows; Extensions; Training. |
| System | System / Drivers; Clients; Monitoring; Tester. |
| Resources | Packages; Docs. |
| MANAGE | Settings; Logs; Alerts. |

Models exposes LLMs, Image, Video, Audio, and Embeddings. Adapters
exposes LoRAs, ControlNets, and VAEs. Apps exposes Chat, Image, Coding,
Agents, and Knowledge. Runtimes exposes Ollama, llama.cpp, vLLM, and
Diffusers. Workflows exposes ComfyUI workflows, n8n, and Langflow.
Extensions exposes Plugins, MCP Servers, and Integrations. Training
exposes Trainers, Fine-tuning, and Datasets. System / Drivers exposes
Drivers, Accelerators, and Dependencies.

The header places the Overview title and subtitle at left, a global
search centered ("Search models, apps, drivers, anything…"), then
appearance, notifications, and the machine/stack selector (the selector
replaces the profile menu; see "Machine stack selector reference").
Search supports ⌘K, returns components, packages, logs, docs, and
actions. Notifications use a red count badge only for unread/actionable
items.

## 3. Dashboard composition

| Region | Required content |
|---|---|
| Top metric cards | Installed Components; Running Now; Clients Connected; Updates Available. Each has an outlined neon icon, bold count, descriptive label, and state line/link. |
| System Resources | CPU, Memory, GPU, Storage rows with icon tile, percentage, bar, sparkline, supporting capacity/device label, and 1h / 1D / 1W / 1M range control. |
| Active Components | Dense table: Name, Type, Status, Resources, Uptime, Actions. "View All" is a violet link. |
| Installed Components | Horizontal category tiles for Models, Adapters, Apps, Runtimes, Workflows, Extensions, Training, System; show installed count and Browse All. |
| Operational cards | Recent Activity; Updates & Recommendations; Quick Actions. Keep equal-height modular panels. |
| Footer | Version, update count, installed/running counts, and green operational status. |

## 4. Components, icons, and data behavior

| Category | Icon and color | Examples |
|---|---|---|
| Models | Cube, `#21A6FF` | LLM, Image, Video, Audio, Embeddings. |
| Adapters | Puzzle, `#FF3E9A` | LoRAs, ControlNets, VAEs. |
| Apps | Four-square grid, `#21A6FF` | Chat, Image, Coding, Agents, Knowledge. |
| Runtimes | Cube / chip, `#21A6FF` | Ollama, llama.cpp, vLLM, Diffusers. |
| Workflows | Connected nodes, `#FF8A35` | ComfyUI workflows, n8n, Langflow. |
| Extensions | Puzzle / plug, `#00E3AE` | Plugins, MCP Servers, Integrations. |
| Training | Cap / flask, `#A434FF` | Trainers, Fine-tuning, Datasets. |
| System | Chip, `#00E3AE` | Drivers, Accelerators, Dependencies. |

Use one 20 to 22 px rounded outline-icon family. Put the category icon
in a 40 to 48 px tinted square tile; category chips use the matching hue
at restrained opacity. Never rely on hue alone: every badge includes a
text type label. The active table supports one row per live component,
a three-dot action menu, row details on click, and safe truncation with
hover/focus tooltip.

| State | Visual and copy rule |
|---|---|
| Running / healthy | Teal dot plus "Running" or "All systems normal." |
| Update | Blue/violet link or compact neutral action button; state installed → available version. |
| Warning | Orange/amber icon and direct corrective copy, e.g. "Storage nearing limit." |
| Error | Red icon/label and recovery action, e.g. "View logs" or "Restart." |
| Loading | Skeleton matching final card geometry; spinner only inside a local action. |
| Disabled | Muted text, 45% opacity, no hover; explain availability. |
| Hover / selected | Raised navy surface; selected nav uses violet glow/fill and white label. |
| Focus | 2 px `#21A6FF` ring with separation; always keyboard-visible. |

## 5. Updates, recommendations and quick actions

Updates & Recommendations lists the component icon, name/version,
meaningful reason, and action: Update, Install, or View. Recommendations
are evidence-led: include storage need, compatibility, or impact. Quick
Actions are four tiles: Install Component, Check for Updates, Run Speed
Test, View Logs. Primary actions may use luminous blue/teal; destructive
actions use red only at the confirmation step. No drivers, runtimes, or
large model updates proceed without explicit confirmation and
compatibility/rollback context.

## 6. Resource monitoring and multiple devices

| Resource | Dashboard rule | Detail rule |
|---|---|---|
| CPU | Show percentage, utilization bar, blue sparkline, and time range. | Processes and per-runtime allocation. |
| Memory | Show percentage and used / total; purple accent. | Pressure state and component attribution. |
| Multiple GPUs | Summary "2 GPUs · combined utilization," then a row/card for every detected device with name, GPU index, utilization, VRAM used/total, temperature/power when reported, and assigned components. | Expand individual GPUs; unsupported metrics read "Not reported." |
| Apple unified memory | Use Memory and Model budget, not invented VRAM. GPU card names the Apple accelerator. | Explain MPS/Metal allocation and pressure. |
| Multiple disks / storage | Summary counts volumes and total free space; rows show label, mount/path when useful, used/total, free, health, library/model usage, external/offline status. | Sort warnings first and make writable state explicit only after verification. |
| Charts | Thin 1.5 px neon sparkline on navy with hover/focus tooltip: timestamp, value, device. | No false precision or heavy fills. |

## 7. Responsive, accessibility and future consistency

At 1280 px and wider: preserve sidebar and dashboard grid. 960 to 1279
px: reduce card columns and hide secondary table fields. 720 to 959 px:
icon rail or drawer; stack metrics and move the resource summary before
the lower cards. Under 720 px: drawer nav, stacked panels, and labeled
rows instead of unreadable table columns.

Every icon-only button has an accessible name and tooltip. Resource
bars provide text equivalents. Use semantic headings, landmarks,
keyboard-operable menus, Escape close, logical focus order, and no
focus theft from live updates.

Meet WCAG AA contrast; pair all color states with text and icon.
Respect reduced motion; sparklines may update without animated
distraction.

Use sentence case and direct verbs: Install Component, Check for
Updates, View Logs, Browse All, View All. Relative activity time has an
absolute timestamp in detail/tooltip.

New MaiPai Stack screens inherit these tokens, category icon map,
metric cards, data rows, status pills, panels, action tiles, and
responsive priorities. Do not introduce a second visual language.

### Implementation acceptance checklist

| Area | Acceptance criterion |
|---|---|
| Correct reference | The exact supplied blue-black dashboard is embedded and named as the source of truth. |
| Taxonomy | All eight Stack categories and their supplied subcategories are represented consistently in sidebar, cards, filters, and data. |
| Monitoring | The UI handles zero, one, or many GPUs/disks without false single-device assumptions. |
| Interaction | Search, notifications, selector, lock, actions, status, loading, errors, and accessibility behavior are specified. |
| Continuity | A future screen clearly belongs to the same navy/neon MaiPai Stack system without redesigning the approved direction. |

This superseding specification replaces the prior version. The approved
image accompanies it as the visual authority for implementation.

## Machine stack selector reference

[machine-stack-selector.png](machine-stack-selector.png) is the visual
authority for the upper-right machine and stack selector. It replaces
any avatar, user profile, account menu, identity-provider row, or
sign-out pattern. The approved full dashboard remains the source of
truth for the overall shell.

- Closed control: monitor icon; green health dot; active machine name;
  downward chevron. Example: Jesses-MBP.
- Menu heading: Current stack.
- Selected stack row: monitor icon, machine name, operating system and
  health subtitle, green dot, violet-blue selected background.
- Switch stack: a distinct section label followed by other managed
  machines/stacks. Offline uses a muted gray dot and "Offline";
  unconfigured remote uses "Connect."
- Utility actions: divider followed by Lock MaiPai, Settings, and Help.
  No profile, avatar, team switcher, person name, sign out, or
  identity-provider control.
- Behavior: clicking a reachable stack selects it after readiness
  validation; an offline stack opens its details or offers retry rather
  than silently switching. Lock MaiPai immediately protects the
  application while leaving managed services unchanged.

## Application shell standards

Every primary MaiPai Stack screen uses the same persistent shell: a
collapsible left navigation column, a fixed top header, a fixed footer,
and a scrollable content region between them. This is a product-wide
standard, not an Overview-only layout.

| Region | Size and placement | Purpose |
|---|---|---|
| Left navigation | Expanded: 252 px. Collapsed: 72 px. Fixed full height between top chrome and footer. | Orient the user in the canonical Stack taxonomy and preserve access to the current machine. |
| Top header | 64 px fixed across the content region; does not scroll. | Page context, direct global search, system notifications, and machine/stack switcher. |
| Footer | 40 px fixed across the content region; does not scroll. | Quiet operational summary: product version, update count, installed/running counts, and overall system health. |
| Content region | Occupies remaining viewport; independently scrollable with 24 px desktop padding. | All page-specific content; scrolling never moves the navigation, header, or footer. |

### Left navigation rail

| State | Required content and behavior |
|---|---|
| Expanded | MaiPai mark and wordmark; optional tagline; collapse button; full text labels; canonical groups and labels: STACK (Overview, Models, Adapters, Apps, Runtimes, Workflows, Extensions, Training), System (System / Drivers, Clients, Monitoring, Tester), Resources (Packages, Docs), MANAGE (Settings, Logs, Alerts); bottom system pulse. |
| Collapsed icon rail | Same information architecture, rendered as 20 to 22 px outlined icons only. The active item retains violet selected fill/indicator. Every icon has a tooltip and accessible name. Group dividers remain, but group labels are hidden. |
| Toggle | A visible double-chevron control beside the wordmark. It toggles expanded/collapsed state, uses a 44 × 44 px hit target, supports keyboard activation, and persists the preference per installation. |
| System pulse | A compact bottom-left five-icon health row: Stack health, Memory, Storage, GPU, Network. No machine name or OS; current-machine identity belongs exclusively in the top-right machine/stack selector. |
| Responsive | At 960 to 1279 px default to the collapsed rail. Below 720 px replace it with an off-canvas drawer; do not force icon-only navigation into an unusably narrow mobile layout. |

### Fixed top header

| Position | Content and specification |
|---|---|
| Left | Page title and concise contextual subtitle. The title identifies the current destination; it is not a duplicate app wordmark. |
| Center | Directly typeable global search field. Placeholder: "Search models, apps, drivers, anything…". Search supports components, packages, docs, logs, settings, and commands. ⌘K focuses the same field and opens results below it; it is not a separate blank modal. |
| Right | Appearance control; Notifications; Machine/stack selector. Use 40 to 44 px icon-control targets with tooltips. Notifications show a red badge only for unread/actionable items. |
| Machine/stack selector | Monitor icon, green/health dot, active machine name, chevron. Menu contains the Current stack selected row, Switch stack rows, then Lock MaiPai, Settings, Help. No profile/avatar, user name, account menu, sign out, team switcher, or identity-provider control. |
| Behavior | Header remains visible during page scroll. Search and selector menus layer above page content, close on Escape/click outside, and preserve focus correctly. |

### Fixed footer

| Segment | Content and behavior |
|---|---|
| Left | MaiPai Stack version, e.g. "MaiPai Stack v1.0.0". |
| Center | Compact, low-emphasis operational counts separated by dividers: updates available; components installed; components running. Each count links to its corresponding filtered view. |
| Right | Green dot and plain-language aggregate health, e.g. "All systems operational." Use amber/red only when the state needs attention; do not use footer color as the sole warning mechanism. |
| Behavior | Footer is 40 px high, fixed, low visual contrast, and remains visible while content scrolls. It never contains primary actions or dense diagnostics. |

### Shell consistency rules

Do not add a competing navigation system, page-level account/profile
affordance, or alternate search pattern. Page-specific toolbars belong
below the fixed header. The content region must reserve header/footer
space to prevent overlap. At all sizes, keyboard focus moves in visual
order: navigation, header controls, page content, footer links. The
shell respects reduced motion and preserves state when changing pages
or switching stacks where safely possible.

## Bottom-left system pulse reference

[system-pulse.png](system-pulse.png) is the visual authority for the
bottom-left status area of the MaiPai application shell. It replaces
mini-bars, a machine identity card, text-heavy resource summaries, and
any larger card treatment in that location.

- Placement: below the final sidebar divider at the bottom-left of the
  app shell. The row is always visible; only hover/focus tooltips float
  above it.
- Five signals: Stack health, Memory, Storage, GPU, Network, in exactly
  that left-to-right order. Icons are 20 to 22 px outlined symbols with
  ample horizontal spacing; there are no labels in the resting row.
- State treatment: each signal uses a small semantic dot: green healthy,
  amber attention soon, red action needed, muted blue-gray
  unavailable/not applicable. Stack health may also carry a red numeric
  badge for the affected monitored-component count. GPU may carry a
  blue numeric badge for the detected GPU count.
- Tooltips: tooltips carry the detail, e.g. "Stack health · 2
  components need attention" and "Network · 1.2 Gbps · 12 ms." They
  appear only on hover or keyboard focus and do not permanently consume
  sidebar height.
- Actions: click Stack health to open Alerts filtered to monitored
  component errors. Memory, Storage, GPU, and Network open the matching
  Monitoring view/filter. The Network signal reports effective
  bandwidth and latency, not a generic network-health label.
- Responsive: the row remains icon-only in both expanded and collapsed
  rails. On small-screen drawer navigation, retain the row at the
  drawer bottom or expose it in the drawer footer.

## Component browser and details pane reference

[models-browser-and-pane.png](models-browser-and-pane.png) is the visual
authority for category browsers and right-side component detail panes.
The pattern begins with Models and is reused for every managed
component category: Adapters, Apps, Runtimes, Workflows, Extensions,
Training, and System.

- Category browser layout: use the canonical app shell. The page header
  contains the category icon, page name, concise purpose line, directly
  typeable global search, appearance, notifications, and machine/stack
  selector. Below it: Installed, Browse, Updates, and Recommended tabs;
  subtype chips; filter/sort controls; list/grid switch; and a primary
  install/add action appropriate to the category.
- List rows: rows are data-dense, selectable, and consistently
  structured. Models use Name, Type, Size, Quantization, Status,
  Runtime, Last used, Notes, Actions. Other categories retain Name,
  Type, Status, Version/size or relevant metric, dependency/runtime,
  Last activity, Notes, Actions. Keep status, name, and primary state
  visible at every supported width.
- Selection: selecting a row leaves the browser in place, visually
  marks the selected row, and opens the component detail pane. One
  detail pane is open at a time. The list remains scrollable and
  retains filters, sort, and scroll position when the pane closes.
- Pane geometry: the desktop pane slides over the right side of the
  browser, not into a separate page. Width: 560 px preferred, 480 px
  minimum, 640 px maximum; 16 to 20 px inset from the app shell edges;
  16 px radius; navy surface; thin blue border; subtle elevation
  shadow. The browser behind it dims only enough to make pane focus
  clear and remains recognizable.
- Motion: open: translate from right 24 px to 0 with opacity 0 to 1 in
  180 to 220 ms, ease-out. Close reverses in 140 to 180 ms. No bounce.
  Respect reduced motion by using an immediate opacity transition.
  Escape, the close button, or selecting the same row closes the pane;
  opening another row replaces content without closing the pane frame.
- Pane header: category icon tile; display name; stable
  identifier/subtitle; live status pill; close button. Do not use a
  user/profile affordance here.
- Pane tabs: Overview, Settings, Usage, Files, Logs. Tabs are shown
  only when meaningful: e.g. Workflows may expose Runs; System may
  expose Compatibility; Extensions may expose Permissions; Training may
  expose Jobs. Never show empty tabs.
- Overview content: description; capability tags; identity and version
  fields; installation/source/path; compatibility; dependencies;
  runtime/endpoint when relevant; last-used/activity. Resource cards
  show relevant live metrics, such as memory, GPU utilization,
  tokens/s, requests/s, disk use, job progress, or connection health.
- Actions: contextual, state-aware controls in a stable action rail:
  Open/Chat, Start, Stop, Restart, Update, Install, Test, Open logs,
  Remove/Uninstall. Destructive action is visually separated in red and
  requires an explicit confirmation explaining affected files and
  dependents.
- Responsive: under 960 px use a full-width overlay panel above
  content; preserve the browser state underneath. Under 720 px present
  the details as a full-screen sheet with a clear Back/Close affordance
  and sticky action region. Never squeeze a desktop table and pane
  side-by-side below readable width.
- Accessibility: opening moves focus to the pane heading; closing
  restores focus to the selected row. The pane uses dialog semantics
  only when background interaction is blocked; otherwise use a labelled
  complementary region. Tabs, row actions, close, and action rail are
  fully keyboard accessible. Do not convey status only by color.

## Settings workspace reference

[settings-workspace.png](settings-workspace.png) is the visual authority
for the Settings destination. Settings uses a VS Code style workspace
within the canonical MaiPai application shell: a local settings
navigator at left and an editor-like settings content pane at right. It
does not replace the global Stack navigation.

- Shell integration: Settings remains a primary destination in the
  global left navigation. Once opened, the page adds a local settings
  navigator; it is not a second app-wide sidebar. Retain the standard
  fixed header, machine/stack selector, fixed footer, and bottom-left
  System pulse.
- Settings navigator: width 280 to 320 px desktop. It contains a
  directly typeable "Search settings…" field with ⌘K focus behavior
  scoped to settings, then grouped settings labels with 20 px outlined
  icons and a violet active state. The navigator scrolls independently
  when needed.
- Canonical groups: General: General, Appearance, Notifications, Privacy
  & Security. Components: Models, Adapters, Apps, Runtimes, Workflows,
  Extensions, Training. System: Hardware, Drivers, Storage, Network,
  Updates. Advanced: Environment, Developer, Reset. The component group
  mirrors the canonical Stack taxonomy; it must not introduce alternate
  names.
- Main settings pane: uses a readable single-column editor surface with
  a 760 to 960 px content measure. Page title and subtitle establish
  scope, e.g. "General: Basic settings for MaiPai Stack." Group related
  controls into bordered panels: Startup, Updates, Data & Storage,
  Diagnostics, and category-appropriate equivalents.
- Control patterns: use labelled toggles for Boolean preferences; select
  fields for policies/limits; text fields with validation for
  paths/endpoints; folder picker for local directories; primary
  check/test buttons for explicit diagnostics. Each setting has a
  concise one-line description below or beside its control. Make
  automatic-save behavior explicit: show a quiet "Setting updated"
  confirmation after a valid change.
- Apply and risk behavior: low-risk preferences apply immediately.
  Settings that start/stop services, relocate files, delete/cache-clean
  data, change drivers, alter credentials, or reset the app require
  review/confirmation and explain impact, affected paths/components,
  restart need, and rollback where possible. Never imply a change is
  active before its validation completes.
- Search: search returns matching setting labels, descriptions, and
  group paths; keyboard selection navigates and focuses the control. It
  does not search component inventory; use the global header search
  for that.
- Diagnostics: keep Open Logs and Run System Check available as explicit
  actions. Results appear in Logs/Monitoring or an inline non-blocking
  status area with timestamp, outcome, and a route to detail.
- Responsive: under 960 px, local settings navigation becomes a
  collapsible rail or a context drawer. Under 720 px, open it as a
  settings-category sheet above the editor. Controls remain full-width
  and never rely on side-by-side label/control columns that collapse
  unreadably.
- Accessibility: every control has a persistent visible label,
  description, keyboard focus, accessible name, and programmatic state.
  Do not use toast-only confirmation. Toggle changes announce outcome
  without stealing focus; destructive/reset actions require explicit
  confirmation and default to the safe option.

## Current destination header rule

The fixed right-content header is the single owner of the currently
selected destination title and subtitle. On first launch it reads
"Overview" with its Overview subtitle. Every primary navigation
selection must update this same fixed header immediately: Settings
becomes "Settings" with its Settings subtitle; Models becomes "Models"
with its Models subtitle; and the same applies to Apps, Monitoring,
Docs, and every other destination. The destination icon changes with
the selection when an icon is used. The title, subtitle, and icon stay
synchronized with the selected sidebar item; they are never static or
left showing the prior destination.

- No duplicate page header: do not place a second page title, subtitle,
  hero header, or repeated destination label beneath the fixed top
  header. Page content begins directly with its first working control,
  panel, tab row, or content section.
- Header composition: at left, the destination icon where useful, the
  current destination title, and one concise contextual subtitle. At
  center, directly typeable global search. At right, appearance,
  notifications, and the machine/stack selector.
- Navigation behavior: each primary sidebar selection updates the fixed
  header icon, title, and subtitle in place before its corresponding
  page content is shown. Do not add another header region or reset
  persistent header controls. The content region may scroll beneath
  the fixed header.
- Exception: a local section heading is allowed only when it names a
  distinct working area inside the page, such as "Updates," "Data &
  Storage," or "Active Components." It must never simply repeat
  "Overview," "Settings," "Models," or the active destination name.

## Footer summary reference

[footer.png](footer.png) is the visual authority for the fixed MaiPai
Stack footer. It confirms a quiet, global operational summary rather
than a sensor strip or diagnostic surface.

- Purpose: provide a quiet, always-visible stack summary. The footer is
  not a component monitor, a navigation bar, or a place for detailed
  telemetry.
- Left: show plain text product version only, e.g. "MaiPai Stack
  v1.0.0". Do not add a logo, card, machine identity, profile
  information, or decorative treatment in this footer position.
- Center: show compact linked operational counts in this order: "2
  updates available", "38 components installed", "18 running". Separate
  items with quiet vertical dividers. The update count opens Updates;
  installed and running counts open their corresponding filtered
  component views.
- Right: show one semantic status dot and plain-language aggregate
  health, e.g. "All systems operational". Use amber or red with direct
  corrective copy when attention is needed; it opens the matching
  Alerts or Monitoring overview.
- Exclusions: do not place individual Stack health, Memory, Storage,
  GPU, or Network sensors in the footer. Their richer status, tooltips,
  bandwidth, latency, device counts, and trends belong in the existing
  System Resources and Monitoring surfaces.
- Sizing and alignment: keep the footer 40 px high, fixed below the
  independently scrolling content region, and low contrast. Version is
  left-aligned, counts are visually centered, and aggregate health is
  right-aligned. Content must remain vertically centered with a minimum
  36 px target for any interactive count or status item.
- Responsive: at constrained widths, preserve version, update
  availability, and aggregate health first. Hide the installed count
  before the running count only when necessary; never wrap the footer
  onto two rows. Provide the hidden summary counts in the Overview and
  in accessible labels.

## Models page scrolling and pinned regions

Models follows the persistent MaiPai shell and uses one explicit scroll
hierarchy. The active destination title and subtitle remain in the
fixed global header only; the page never repeats a Models title beneath
it.

- Always pinned: the left navigation rail, 64 px global header, and 40
  px footer remain fixed. The main Models canvas scrolls only in the
  space between the global header and footer.
- Models controls dock: immediately below the fixed global header, use
  one sticky local controls dock. It contains, in visual order: the
  Installed, Browse, Updates, and Recommended mode tabs; subtype facets
  such as All, LLM, Image, Video, Audio, and Embedding; then Filter,
  Sort, list/grid switch, and Install Model. The dock has a
  low-contrast navy surface and bottom border, remains pinned while the
  list moves beneath it, and must not introduce a duplicate page title.
- Table header: the model-list column header is sticky directly beneath
  the Models controls dock. It keeps the selection checkbox, Name, Type,
  Size, Quantization, Status, Runtime, Last Used, Notes, and Actions
  aligned with the scrolling rows.
- Scrolling content: only model rows and any empty/loading results
  state scroll under the sticky controls and table header. The selected
  row remains visually marked; filter, sort, active mode, facet, view
  preference, and scroll position persist when the user opens or
  closes details.
- Details pane: selecting a row opens the existing right-side floating
  detail pane above a dimmed but unchanged browser. The pane frame
  stays pinned to the viewport; its identity header, status, close
  control, tabs, and action rail remain visible while its
  overview/settings/usage/files/logs content scrolls internally. One
  pane may be open at a time.
- Layering: the global header is highest among standard page layers.
  The sticky Models dock and sticky table header sit below it. The
  details pane and its overlay layer above the browser but do not cover
  global header controls. Menus, tooltips, and confirmations layer
  above the pane only while open.
- Responsive: under 960 px, keep the global header/footer fixed and
  retain the Models controls dock; make subtype facets horizontally
  scrollable rather than wrapping. The details pane becomes a
  full-width overlay. Under 720 px it becomes a full-screen sheet with
  a Back or Close control and sticky actions; never compress the
  desktop table and pane side by side.

## Implementation reuse standards

MaiPai implementation must favor dependable, already-proven building
blocks. Reuse preserves behavior, accessibility, and visual consistency
while allowing the MaiPai theme to remain distinct.

- Component foundation: use existing shadcn/ui primitives and any
  established project components before building a new primitive.
  Typical foundations include Button, Input, Tabs, Select, Checkbox,
  Switch, Tooltip, Popover, Dropdown Menu, Command, Sheet, Dialog,
  Table, Scroll Area, Skeleton, and Toast. Theme them through MaiPai
  tokens and wrappers; do not accept default shadcn styling as the
  visual design.
- Shared templates: build and reuse application-level templates for the
  App Shell, destination header, footer summary, page controls dock,
  category browser, data table, right-side details pane, confirmation
  dialog, empty/loading/error states, and settings workspace. Every
  taxonomy category should configure the shared browser/detail
  templates rather than fork a page layout.
- Shared functions: centralize repeated behavior in shared hooks or
  utilities: direct global search and keyboard shortcut focus; debounced
  filtering; sort and facet state; list selection and pane state;
  status-to-color/label mapping; resource and version formatting;
  responsive breakpoints; telemetry/sensor formatting; focus return;
  and destructive-action confirmation. Do not copy-paste these
  behaviors page by page.
- Reuse decision: before creating a component, template, hook, or
  helper, check whether an existing shadcn/ui primitive, project
  component, shared template, or function already satisfies the need.
  Extend or compose it when possible. Create something new only for a
  demonstrably new behavior, then make it reusable if another taxonomy
  category can use it.
- Consistency gate: new screens must use the shared tokens, primitives,
  templates, and state conventions. A one-off implementation is
  acceptable only when documented with its reason, accessibility
  behavior, responsive behavior, and expected reuse boundary.
