# MaiPai Stack: the experience

Design for the pages a person sees. The rule from
`getmaipai/.github/docs/STYLE.md` applies to every word on them: the dad
test. A busy parent with basic tech knowledge reads it once and knows what
to do. Layout, kit and responsive rules come from
`getmaipai/.github/docs/UI.md`; the Stack's pages use `@maipai/ui` and
the lucide icon set, the same as Home, so the two products look like one
family and nothing is drawn twice.

Three people use the Stack, and the pages are ordered for the first one:

- **The operator**, who installed it. Wants green lights, a number for
  "how much can this machine do", and to try each thing once.
- **A client's author**, writing a tool against the API. Wants a key,
  the explorer at `/api/docs`, and the event feed.
- **Home**, which is a client and never sees these pages; it reads the
  same facts over the API and shows them in its own Admin.

## Install and first open (decided 2026-09-17, evening)

The owner's rule, after seeing the five-step wizard: no wizard. One
command installs, the board opens, and the board itself shows what
to add. Ollama proved the shape; the products that make people click
through steps before they see anything are the ones people abandon.

**Install** is one line in Terminal, hosted by us, and downloads only
our own compiled binary from our own GitHub release (nothing from a
third party at install time; engines and models arrive later, when an
ability is chosen):

    curl -fsSL https://getmaipai.github.io/stack/install.sh | sh

The script installs the checksum-verified daemon under the person's home folder, registers its launchd service, starts it, and opens
the board in a browser. The hosted script and real release asset are
SITE-STACK-01 and RELEASE-STACK-01. The current local script is not
a published release. The Tauri desktop app is the other install path. Its shell exists, but
its first-launch service install and release bundle are STACK-66 and
RELEASE-STACK-01.

**The first screen is the full app.** No modal, no steps. The board:

- **This computer**, measured automatically and said in plain words
  ("Apple silicon Mac, 24 GB of memory, 153 GB free"), with the plan
  this machine can run and a "Change" link.
- **Add abilities**: cards for Chat, Voice, Images, Video and Music,
  each with its size, "can run" or "not on this computer", and an
  Install button; a "Start small" suggestion preselected (a fast chat
  model plus small voice in and out, about 1 GB) so one click starts a
  conversation within minutes. Model names sit behind a "details"
  disclosure for tinkerers.
- **Downloads** as a background job with the honest bar (size, speed,
  time left, pause, resume, source and licence in one line) and the
  sentence "This is your internet speed. The Stack is ready; your
  bigger model is on its way." A notification when a row lands.
- The status strip, notifications and Repairs as before, empty and
  calm on a fresh install.
- A one-line note the first time, dismissible: "MaiPai Stack runs AI
  on this computer. Nothing leaves it. The AI can be wrong, and it is
  never medical, legal, or professional advice."

**No login until it matters.** On this computer, on loopback, the
board opens without a password (Ollama has none either). The first
time the person creates a client key for a tool, or switches on LAN
access, the Stack asks them to set the operator password once, right
there, and the admin routes require it from then on. The adult
acknowledgment stays as one dialog before the first image or video,
never a step.

When the same page is opened from another device, the rule changes
before any dashboard data loads: every route is the sign-in screen. If
the host has no password yet, the phone says "Set the operator password
on the computer that runs the Stack first." and shows no password
field. LAN access cannot be opened into a pending restart until that
password exists.

**Tester** appears on the board the moment the small set lands, so
the first thing the person does with the Stack is talk to it.

## The shell: a professional AI management dashboard (decided 2026-09-17, evening; revised 2026-09-18, 01:20)

The responsive shell has a sticky page title, one search icon opening
Ask, a bell and profile menu, and a centered Running or Paused control.
The desktop sidebar has common rows above administrative rows. Common:
Overview, Engines, Models, Library, Clients, Tester and Monitoring.
Administrative: Settings, Logs and Alerts. Abilities is an action on
Overview and Models; Updates and Backups live in Settings. When there is
room, the administrative group stays at the bottom above the memory and
disk block; otherwise both groups are labeled in one scrolling list.
At phone width, the five-tab bar and one-line phone header replace the
sidebar. The phone rules below are the current decision.

A section row shows at most one actionable indicator. Every route has a
useful empty state. The copied dashboard kit in `frontend/src/kit/` owns
the shell until KIT-01 extracts the shared package.

**The list and the panel (the UniFi pattern, decided 2026-09-17).**
Every page that holds things (Engines, Models and their groups,
Clients under Access, Alert channels, detected items) is the same
shape: a table of rows on the left of the page, and a **property
panel** on the right that opens when a row is clicked and stays open
as the person moves between rows (arrow keys work). Each row shows the
name, a status badge (ready, loading, offline with the reason,
detected and not adopted, update available, updating, needs restart),
the version or size inline, and what it holds or serves. The panel's
header carries the name, the status badge and a row of quick-action
icon buttons for that kind of thing (an engine: Start, Stop, Restart,
Update when one is available, Make current, Logs, Forget; a model:
Load, Unload, Pin, Update, Remove; a detected item: Adopt, Forget; a
group: the seven group actions; a client: Revoke), each with a
tooltip and the kit's inline confirmation where it destroys. Beneath,
tabs: **Overview** (the metadata: kind, version and whether it is
current, where it lives, roles or abilities, provenance and licence,
measured footprint and speed, last used, the docs links), **Settings**
(the declared configuration rendered generically, pending and
in-effect values), **Insights** (usage over time, the tail of its
log). On phone width the panel is a full-height sheet. The block's
data table provides the rows; the panel is one component used by
every page, never rebuilt per page.

**Empty and first states are designed, not blank**: a fresh install
shows Overview with This computer and Add abilities, every other
section shows one calm sentence and the one action that fills it
("No models yet. Add an ability and the models it needs arrive
here."). A spinner never stands in for content longer than a beat.

## Overview: the console dashboard (decided 2026-09-17, late; revised 2026-09-18, night)

Overview uses two columns: a facts and activity column, and one wide area
for the status strip, the Usage, Memory and Speed hero chart, model and
engine tiles, storage and headroom. The range is 1h, 1D, 1W or 1M, and
empty time buckets stay visible. Recent activity shows durable events.
The detailed second-pass decision below is the source for layout and copy.
Speed results and memory values come from local measurements.

## The shell, second pass: common on top, administrative at the bottom (decided 2026-09-18, 01:20)

The owner, with UniFi's rail beside ours, on five points; each is a
decision:

1. **Abilities leaves the sidebar.** A plan and its ability cards are
   not a place a person visits; they are an action. "Add abilities"
   lives on the Models page's action row and on the Overview's status
   strip (and on the board, which is the first screen until a plan
   exists). The `/abilities` route stays as the destination of those
   actions; it has no sidebar row.
2. **Common on top, administrative at the bottom**, UniFi's rail, the
   rows named by the owner (01:25; Overview stays first, confirmed 09:30):
   the top group is Overview (the console's home, first as UniFi's
   Dashboard is), then Engines,
   Models, Clients, Tester, Monitoring; the bottom group, above the
   resource block, is Settings, Logs, Alerts. That renames two rows and
   folds three: "Try it" becomes **Tester** everywhere a person reads
   it (the route may stay `/try`); "Access" becomes **Clients** (the
   client keys table, the operator card, LAN access); **Updates** and
   **Backups** become sections of Settings (UniFi keeps them under
   System), reachable from the palette and from the Overview facts
   ("Update available" opens Settings at Updates); **Logs** gets its
   own administrative row (the log viewer that "Monitoring" carried:
   tail per engine and the daemon, filter, copy). Library, when built,
   joins the top group after Models. A hairline separates the groups;
   the bottom group stays at the bottom of the sidebar (flex, not a
   scroll away) while the window is tall enough to hold both groups
   and the resource block without scrolling. When it is not (the owner,
   01:30: "if it doesn't make sense to bottom-align, use categories"),
   the sidebar renders the same two groups as labeled categories in
   one list, "Manage" over the top rows and "Administer" over the
   bottom rows, the way UniFi's Settings nav labels its groups; the
   switch is by measured height, never by device type.
3. **The header search is a magnifying glass**, an icon button that
   opens the command palette (typing anywhere in the palette is the
   input); the header carries no text field at any width. The right
   group is search, bell, profile (theme toggle in the profile menu).
4. **The sidebar's bottom block is resources, not a health line**: two
   compact meters with a label and a value, memory ("12.3 of 24 GB
   used") and disk ("157 GB free"), drawn from the budget and hardware
   routes, plus a third line when the governor is paused or under
   pressure; the health sentence moves out (the health dot is on
   Alerts and on the instance line below). When collapsed to icons, the
   block is the memory ring alone.
5. **The instance is a subtitle under the logo**, not a header item: the
   top-left reads "MaiPai Stack" with, under it in muted text, the
   computer's name (the machine's own name from the OS; the showroom
   uses a persona name) and the health dot. "This computer" leaves the
   header.
6. **A run state pill in the header's center.** The owner asked whether
   a play and pause control for all services belongs there. Yes, as a
   state that is also the control, because the header center is empty
   once search is an icon and a stack of engines has exactly one
   emergency lever: "Running" with a pause glyph; pressed, it drains
   the roles, unloads the models, pauses downloads and jobs (the tray's
   "Pause everything", one implementation shared with the tray and the
   palette), and the pill reads "Paused" in amber with a play glyph.
   The state comes from the governor; a pause never stops the daemon or
   the UI. The kit's inline confirmation applies to pause when a
   request is in flight ("2 requests in flight; pause anyway?").

## Overview, second pass: the chart is the hero, prose is gone (decided 2026-09-18, night)

The owner put the live Overview beside UniFi's Dashboard and called ours
ugly. He is right, and the reasons are specific. Ours is a grid of
rounded boxes, each opening with a title and a sentence of prose
("Requests and tokens served in the selected range.") before any
number; three ring cards spend a third of the top row on "Ready 0,
Roles 13, Attention 0" with a badge under each; the charts are small
and their axes zoom to whatever minute has data; Recent activity is a
feed of progress events ("Check chat is running."); the Speed sentence
prints a file name and a full revision string. UniFi's page has one
sentence of prose on it (the status line under the density scale), one
big chart, dense tile strips and segmented bars, and every number is a
thing the person recognizes.

The decisions, replacing widgets 1 to 6 of "Overview: the console
dashboard" above where they differ:

1. **No prose in widgets.** A widget is a title row (the title left,
   its controls right) and its content. Descriptions move to tooltips
   on an info glyph, or go. The page keeps zero sentences of
   explanation; the one sentence allowed is a status sentence with a
   check glyph.
2. **The status strip is one line, in words with counts**, at the top
   of the middle column: "Chat ready · 1 model loaded · 2 engines
   current · All clear", each segment a link to its page, the health
   segment colored by severity. The three ring cards go. A count is
   shown only when the thing exists; "Ready 0" never appears.
3. **One hero chart.** Usage, Memory and Speed are tabs on a single
   chart panel that spans the middle column (UniFi's Internet | WiFi
   tabs): the toolbar row holds the tabs on the left, the series
   toggles with swatches and the 1h/1D/1W/1M control on the right; the
   chart fills the panel's width and a fixed height (280 px desktop).
   The axis always spans the chosen range; sparse data leaves empty
   space rather than zooming to a minute. Under the chart, one status
   sentence with a check glyph for the active tab ("Memory headroom is
   good", "94 tokens per second on Qwen3 1.7B, up from 63 on b10797").
4. **Tile strips.** Below the chart, three strips of small square
   tiles with a glyph, a name under it and a count in a tooltip, the
   way UniFi shows Top APs and Top Clients: Models (loaded first, then
   ready, then on demand; size in the tooltip), Clients (by requests in
   the range), Engines (by role served). Each tile opens its panel. A
   strip with nothing shows one row of the empty sentence.
5. **Segmented bars.** Storage by category as one segmented bar with the
   legend as key-value rows; memory headroom as a gradient scale with
   the current point on it and the pressure word; both with the check
   sentence beneath.
6. **The facts column** is one card, not two: the computer row (glyph,
   "This computer", the counts joined by connector marks) at the top,
   the key-value facts, "Up to date" with the history glyph, the two
   full-width outline buttons, then the last Check my Stack result as a
   sentence ("Checked 17m ago, all good").
7. **The rail** holds Recent activity and Health as list cards with a
   muted meta line, and Recent activity shows durable events only:
   installs, updates applied, checks finished with their verdict,
   health items opened or resolved; progress events ("is running", "is
   N percent complete") never appear there. Every sentence names things
   by display name (Qwen3 1.7B, build b10797), never by file name,
   role id or full revision string.

8. **Two columns, not three** (the owner, 01:15: "you crammed
   everything into too many columns"). UniFi's Dashboard is a facts
   column and one wide area of full-width rows; ours had a 3-6-3 grid
   with the middle split again into pairs, so nothing had room. The
   Overview is a left column of about 320 px and one wide area. The
   left column, top to bottom: a health card when anything needs
   attention (UniFi's "IPv6 detected" card sits in the same place;
   nothing when clear), the computer facts card (decision 6), then
   **Clients** as a compact list (name, requests in the range, last
   seen, a dot for a key that is failing), then Recent activity
   (decision 7). The wide area, top to bottom, every row full width:
   the status strip, the hero chart, the Models tile strip, the
   Engines tile strip, the storage bar and the headroom scale side by
   side as the one pair the page allows. The right rail goes. Tablet
   stacks the left column above the wide area; phone follows the
   codex-107a order.

Every number stays a recorded one. The showroom fixture carries a full
day of samples so the captures show the hero chart with data across
the whole range.

## Look and feel references: UniFi's structure, X's modernism (decided 2026-09-17, night)

The owner's direction, with screens in hand: every page and feature of
the Stack takes the UniFi Network console as its structural reference
(Settings, Devices with its filter column and property panel, the
Dashboard, the Overview tables), and takes X (Twitter) as its reference
for modernism (the black dark mode, the one pill button, the sticky page
header, the stream of rows with relative times). The org's trade-dress
rule frames both: what is listed here is a convention shared by three or
more consoles or feeds and is free to use; the exact look of either
product (UniFi's blue-on-white with its icon set, X's black with its
blue) is a signature and stays out. Everything is drawn in the Stack's
palette (orange accent, the kit's neutrals), the kit's type and lucide
icons, and the squint test says "a well-made console", never a copy.

**From UniFi, the structure and the density.**

1. **Real tables for things.** Column headers, one line per row, a
   leading status dot (green ready, amber loading or attention, red
   offline, grey detected and not adopted), tabular numbers
   right-aligned, hairline dividers between rows and no card chrome
   around each row. A row's cross-references (a model's engine, an
   engine's roles, a client's key) are links in the accent that open
   that thing's panel. The table fills the width it has; long names
   truncate with a tooltip.
2. **A quiet action row under every table**: "Add" and "Manage" as text
   links separated by a hairline, under the last row, instead of a
   large button floating in the page's corner. A page keeps at most one
   filled primary button, for its one main action.
3. **Section cards on overview-shaped pages**: a header with the
   section's icon and title and a collapse chevron on the right; the
   body is a table or a form, never prose.
4. **Settings are rows**: the label on the left with an info glyph that
   opens the explanation, the control on the right (a radio group
   inline, a checkbox, a select, or a small inline table with its own
   quiet action row); related rows under a bold group heading. The
   generic renderer (org SETTINGS.md) renders this shape for the
   Settings page and for every panel's Settings tab.
5. **Things pages are three columns on a wide screen**: a collapsible
   filter column on the left (a search field; collapsible checkbox
   groups with counts: status, kind, role; a Clear filters link), the
   table in the middle, the property panel on the right. Below tablet
   width the filters become a sheet behind a Filter button and the panel
   becomes the full-height sheet it already is.
6. **The property panel**, refined: the header carries the name and the
   status badge; beneath it an icon-tab strip (overview, insights,
   settings) with tooltips instead of text tabs; a quick-facts block of
   two or three lines, each a fact with its value; two side-by-side
   outline buttons for the two most-used actions of that kind (an
   engine: Logs and Restart; a model: Load and Pin); a "Used by" row of
   client tiles when usage exists; a sparkline with a small time range;
   then the key-value list, label muted on the left, value on the
   right, a copy glyph after ids and paths, and inline actions beside a
   value where they belong ("Revert" beside a version). Quick actions
   are icon buttons with tooltips, never letters in circles.
7. **Time controls are a segmented control** (1h, 1D, 1W, 1M) at the top
   right of the chart; series toggles are checkboxes with colored legend
   swatches beside it; every chart on the page honors the one range.
8. **A facts column on the dashboard**: the computer as a card (icon,
   name, counts of things by kind joined by connector marks), key facts
   as label and value rows, versions with "Up to date" and a history
   glyph, then two full-width outline action buttons (Speed test, Check
   my Stack).
9. **Status sentences**: a check glyph and a plain sentence ("Memory
   headroom is good"), segmented percentage bars, a gradient scale with
   the measured points on it.
10. **The top bar**: the page title, the centered run-state pill, and
    Ask, bell and profile actions. The instance lives under the sidebar
    logo. White surfaces and hairline borders have no card shadows.

**From X, the modernism.**

1. **Dark mode is true black**: near-black surfaces, hairline dividers
   in place of raised cards, white headings, one accent, muted grey for
   every secondary line. A card in dark mode is a hairline-bordered
   region, never a lighter raised slab.
2. **One pill**: the single primary action on a screen is a fully
   rounded filled button; everything else is a text action or an icon
   button. Two filled buttons on one screen is a bug.
3. **The page header is sticky** and is the page's title: the body does
   not repeat it. The eyebrow, the large heading and the subtitle
   triple at the top of every page goes; a page keeps at most one muted
   sentence under the sticky header when it needs one.
4. **Relative times** everywhere a time is shown ("3m", "2h",
   "Yesterday", then the date), the absolute time in a tooltip and in
   the panel's key-value list.
5. **Rows read as a stream**: a primary line, a muted meta line under
   it, hairlines between rows, avatars or icons leading the row, the
   actions as small icons on hover or at the row's end.
6. **The sidebar breathes**: larger icons, the active row bold, a
   generous row height, and an icon-only rail when collapsed (the c-42
   density item). Underline tabs for switching views within a page.
7. **The left facts column on Overview** holds the health card when
   needed, computer facts, clients and durable recent activity. The
   second-pass two-column decision replaces the former right rail.

The showroom (`bun run showroom`) is where every one of these is judged:
a change to the shell or a page is not done until its showroom capture
is opened and reads as this section describes.

## The board

The home page, and what the menu-bar item opens. A grid of role tiles,
each a status and one line:

| Tile | Green | Yellow | Grey | Red |
|---|---|---|---|---|
| Chat | "Ready, 62 GB loaded" | "Loading" | "Off" | "Stopped: <reason>" |
| Coding | same | | | |
| Voice in / Voice out | "Ready" | | | |
| Images / Video / Music | "Ready when asked" (on-demand) | "Working, 40%" | "Not installed" | |
| Memory | "78 of 128 GB in use, 30 GB free for jobs" | "Tight: a image job will wait" | | "Over: something was unloaded" |

Under the tiles: the last five notifications, and a "Repairs" list backed
by the daemon's health items if the Stack noticed anything (a model whose
checksum no longer matches, an engine that crashed twice, a managed host
that vanished). The header carries the active count. Each card shows the
title and why, severity only as color, and exactly one Fix or Learn more
action, plus Ignore.

## Tester (formerly Try it)

One page, one tab per role the profile can serve. Every tab is stateless
and says so ("This box forgets when you leave it. For a real assistant
that remembers, install MaiPai Home.").

- **Chat**: a streaming reply box. Under each reply, in small text: the
  engine, the model, first-token time, tokens per second.
- **Speak**: type a sentence, hear it. Voice picker for the installed
  voices. Latency shown.
- **Listen**: a mic button, live words as they arrive.
- **Image, Video, Music**: a prompt, a quality choice (fast, everyday,
  best), a progress bar, the result, and the memory delta the job caused.
  Before the first generation, the one-time adult acknowledgment: one
  clear dialog, one confirmation, never again.

Nothing here is saved. The point is that a person, or a tool's author,
can prove each role works in under a minute.

## Models

A list, one row per installed model: name, roles it serves, size on disk,
measured loaded size, licence, source and revision, last used, and its
state (resident, loaded now, on demand, pinned). Row actions: pin, unload,
remove, "check for update". An "Add" button opens the Catalog's model
packages first (signed, provenance filled in), and a "from a URL or
Hugging Face" option for the operator, which fills the provenance record
before the model turns on. Multi-select with remove and clear-all, per the
org's batch rule. The Add menu also has Import. It scans the Hugging Face,
Ollama, mlx-serve, oMLX and LM Studio stores without changing them, shows
the source path and digest, and imports one selected file by link when
possible. Storage usage is shown by ability, engines, logs and backups so
Remove can say what bytes the Stack will actually free.

**Docs on every model.** A model's detail carries quick links derived
from its provenance, never typed: the model card, the licence, the
file list at its revision, the engine's own documentation, and the
tool and path it was imported from. A link the record lacks is not
shown.

**Nicknames and groups.** A model can be given a nickname (shown
everywhere a person reads; the API keeps the model id and the role
ids, so a nickname never changes what a client sends). Models live in
groups that nest like folders, each model in exactly one group, so a
rollup counts nothing twice: "Family chat", "Kids", "Experiments" and
so on, with an ungrouped default. The Models page shows the tree with
each group's size on disk, memory while loaded, and utilization
(requests, tokens, time loaded, last used) rolled up from its models
and subgroups; Monitoring shows utilization by group over time.
Every group row also carries **status** (how many of its models are
loaded, ready, on demand or failed, and the worst health item beneath
it as the row's dot), **consumption** (memory now, disk, requests and
tokens over the period, rolled up), and **management**: actions on the
group that apply to everything beneath it, with an inline confirmation
naming the count ("Unload 4 models?"): load, unload, pin, unpin, check
for updates, move, remove. Drag to move a model or a group; batch
select works across groups.

## Things pages, second pass: add, act, name, adopt, group (decided 2026-09-18, 01:35)

The owner walked the live Models and Engines pages and named six gaps.
Each is a decision:

1. **One Add button, with search and browsing built in.** Every things
   page has one pill, "Add" with a plus glyph, in the header row. It
   opens a sheet with tabs: **Catalog** (the MaiPai Catalog's models or
   engines for this page, searchable, each with size, licence in plain
   words, "runs on this computer" from the tier, and Install), **Hugging
   Face** (search a repo, pick the GGUF file, licence and size shown,
   Install), and **Import** (things already on this computer: the
   detected tools' folders and any path typed or picked, imported by
   link; and "Upload from this device" for a browser on another
   machine, a streamed upload with a progress row in the downloads
   list), and **A server you run** (a server the person runs: a
   `managed` or `url` engine kind, declared by address, STACK-56).
   Adding is never spread across pages or hidden in a menu.
2. **Three dots on every row.** A kebab icon button at the right end of
   each row (visible on hover on a pointer device, always on touch)
   opens the row's actions: the same declared list the panel header
   uses for that kind (one declaration per kind drives both), so an
   engine offers Start, Stop, Restart, Update, Make current, Logs,
   Forget; a model Load, Unload, Pin, Rename, Move to group, Update,
   Remove; a detected item Adopt, Forget; a group Rename, Move,
   Load all, Unload all, Remove group; a client Rotate key, Revoke.
   Destructive actions carry the kit's inline confirmation.
3. **Nicknames are a first-class action.** "Rename" in the row menu and
   in the panel header edits the display name inline (Enter saves,
   Escape cancels); the display name is what every table, sentence,
   tile and chart shows; the id is the subtitle only when it differs.
4. **Adopted is visible.** A detected thing's status cell reads "Not
   adopted" with the grey dot and Adopt as its primary action; once
   adopted it reads like any other row ("Ready"); the Status filter
   offers "Not adopted"; the sidebar's Engines count includes it (the
   quiet rule).
5. **Groups are a real feature.** Groups are shown as metadata the way
   roles are: a Group column with a chip, and the collapsible group
   headers in the Models tree. They are managed in Settings, Groups
   section (create, rename, nest by drag or a parent select, delete
   moves children to the parent, counts and memory per group) and in
   the Models page's action row ("New group" opens the same dialog).
   Assignment happens where the things are: "Move to group" in a row's
   three dots (a submenu with the tree), and on a selection of rows
   through the batch bar. A group header's three dots offer the group
   actions.
6. **A row's title is its display name, once.** The name cell shows the
   display name (nickname or humanized id, "Qwen3 27B Instruct") and,
   under it, the id only when it differs, then the roles as small
   chips; a group's name never appears as a row's title (the screenshot
   showed "Family chat" as the title of every model in the group with
   the model id under it).

## The phone, second pass: a tab bar, list rows, grouped detail cards (decided 2026-09-18, 01:45)

The owner sent four screens of UniFi's phone app beside our phone view.
What they do that we do not, each a decision for phone width (below
`--breakpoint-sm`); tablet and desktop keep the sidebar shell:

1. **A bottom tab bar, not a sidebar sheet.** Five tabs: Overview,
   Things (Engines and Models under a segmented control at the top),
   Tester, Alerts, Settings (Clients, Monitoring and Logs live under
   Settings' nav on the phone). Icons with a label, the active one in
   the accent, safe-area padding underneath. The sidebar and its
   trigger do not exist at phone width.
2. **The phone header is one line**: the Stack glyph, the computer's
   name as a pill with the health dot (tap: the health sentence), and
   on the right the one Add button (a plus in a circle, on pages that
   add) or the search glyph. No title row: the tab bar says where you
   are; a page's title appears as the first line of its content.
3. **List rows are the phone's table.** Every things page renders rows
   instead of columns: a leading glyph tile, the display name with the
   id or kind as a muted subtitle, and on the right the status word
   in its color with a sub-status under it, the dot, and a chevron.
   Filters are pill chips in a horizontal row above the list ("All ·
   Groups · Not adopted"). Tapping a row opens the detail page (the
   panel as a full page with a back chevron), the three dots sit at
   the row's end behind a long press or the detail page's action list.
4. **Detail pages are grouped cards**: key-value rows (label left, value
   right in muted text) in a card; editable rows show a placeholder in
   the value slot ("Enter a nickname", "Add a note"); rows that lead
   somewhere end in a chevron ("Group ›", "Settings ›"); the actions
   are a list card at the end, one per row, the destructive one in
   red, exactly UniFi's Reconnect and Block card.
5. **The phone Overview** opens with the status strip as words, then a
   2 by 2 grid of ability tiles (icon, name, one line of state, a
   three-dots for the tile's actions), then Recent activity as rows,
   then the facts as a "This computer" card of key-value rows with
   Speed test and Check my Stack as its action rows. The hero chart is
   a tap away ("Charts ›") on the phone.
6. **Touch sizes**: 48 px minimum on every tappable thing; row height 56
   px with a subtitle, 48 px without; the tab bar 56 px plus the safe
   area.

## Docs and the helper, where they live in the console (decided 2026-09-18, 01:50)

The owner could not find the docs or the assistant in the console. The
docs exist (the user docs site at `getmaipai.github.io/stack`, the API
explorer at `/api/docs`, and the Library for what is installed) and the
helper is designed (dev.md "The helper", three tiers) but neither has a
door. Decisions:

1. **Ask is the door to both.** The header's magnifying glass becomes a
   sparkles glyph labeled "Ask" (UniFi's phone app puts the same glyph
   in the middle of its tab bar). It opens the command palette, whose
   input reads "Search or ask", and the palette answers in tiers: pages
   and things (search), the intent table for the enumerable questions
   ("how many engines", "is chat up to date"), Library and docs hits
   under "From the docs", and, when none of that answers, "Ask the
   helper" which opens the helper as a panel in the right slot (the
   property panel's place). On the phone Ask is the middle tab.
2. **The helper is the Stack's, stateless, and model-free by default.**
   It answers from what the console already knows and from a pre-built
   index, and reads like an assistant because its answers are shaped
   as answers (one sentence, the number, the link), never as a list of
   search hits. It keeps no history past the panel being closed and
   knows no people: it is the operator's helper for this Stack, which
   is why it can live here and still honor the line. A good household
   assistant that remembers is Home's, and the helper's empty state
   says so once.
3. **Docs have three doors**: "Help" in the profile menu (the docs site,
   the API explorer, the Library); a "Learn more" link on every health
   item and every disabled unbuilt section, pointing at the docs page
   for that item; and the "From the docs" group in Ask. The docs site
   opens in a new tab; the Library opens in the console.
4. **Priority.** STACK-37 moves from low to normal: tier 1 (the intent
   table) and tier 3 (the helper panel) are built with Ask; tier 2
   arrives with the Library (STACK-32).
5. **No model ships with the helper, and none is required** (the owner,
   02:00: people will hate a bundled model that costs disk and memory
   and cannot be removed). The default helper has two model-free
   tiers and one optional tier:
   - *Answered by the console*: the intent table over live numbers
     ("how many engines", "is chat up to date", "how much disk do
     models use"), each intent with a hit counter (the org rule).
   - *Answered from the index*: one pre-built full-text index, built
     at release into the app, over the user docs, every declared
     setting's label and help, every health item's title, cause and
     fix, every page's purpose sentence, and the Library's pages when
     they exist (indexed on the machine when fetched). One tool for
     all of it: Pagefind, which the docs site already uses; the
     console queries the shipped index and the local Library index
     together. The answer is the best passage rewritten by shape, not
     by a model: the passage's first sentence, the value when the hit
     is a setting or a health item, and "Open" to the page or the
     docs. Fuzzy and prefix matching so a misspelled question still
     lands.
   - *Open questions with your own model*, off by default: a Settings
     switch, "Let the helper use my chat model for open questions",
     enables the tool-calling turn on the person's loaded chat engine
     only, when one is up and supports tools; nothing is downloaded
     for it, and with the switch off or no engine loaded the panel
     answers from the two tiers above and says, once, that the switch
     exists. The Stack never installs a model of its own.
   Removal is trivial because nothing was added: the index ships inside
   the app build.

## Scan, and real over mock (decided 2026-09-18, 05:30)

The owner's last two notes before bed: focus on things that actually
work instead of mock-ups, and add a Scan button that searches the
system.

1. **Scan now** is a text action beside Add on Engines and Models ("Scan
   this computer") and the first row of the Add sheet's Import tab; it
   runs the detection sweep (`POST /stack/v1/detected/scan`) and shows
   what it found as rows with Adopt, with the sentence "Found 2 tools
   and 6 model files" or "Nothing new found" and the time of the last
   scan. The sweep runs on boot and hourly as designed; the button is
   the person's hand on it.
2. **Real over mock.** The showroom is for judging the design; the
   product is the real console on the real data directory. Every
   action a page offers is exercised against a real data directory
   (a copy of the owner's, on this Mac) before it is called done, and
   an action that cannot work yet shows its one sentence and a
   disabled control, never a working-looking button that does
   nothing. The live acceptance walk (STACK-65) is the list.

## Library

One page per installed model and engine: where it came from, its
licence in plain words, the model card or the engine's documentation
kept locally, the file list at its revision, and our own measured
numbers for it (footprint, speed, last used). The Library is what the
search box and the command palette search, alongside the pages; and it
is what the `stack-library` MCP server serves, so the household's
assistant and a coding tool answer from the docs the person actually
has, never from a guess. Fetching a page is a download the person
switched on, listed on the privacy page.

## Engines

One row per engine: name, kind (spawned, managed, url), the roles it
holds, health, the running build, and a version state that is a real
fact: **current** (the running build is the tag marked current and no
newer pinned build exists), **not current** (a newer pinned build is
installed or available; the row says which), **needs restart** (the
current tag changed while the old build is still running). Last
restart and why, a log link. A managed host shows its probe result,
its version against the one we tested, and `offline_reason` in words
when it is gone ("ComfyUI is not running. Start it and this row turns
green.").

**Detect and adopt** (the Ubiquiti model). The Stack looks on this
computer, never on the network, for engines it did not install: a
running server on a well-known loopback port (Ollama, LM Studio's
`llmster`, ComfyUI, oMLX, mlx-serve, a bare `llama-server`), an
installed app or binary in the usual places, a folder of models
another tool downloaded. Each shows on the Engines page (or the Models
page, for a folder) as a row in a **Detected, not adopted** state with
what it is, its version, where it is, and what it could hold, and it
stays there, plainly, until the person acts. **Adopt** probes it,
records its identity and version against the one we tested, asks
which roles it may hold, and from then on the Stack manages it as a
`managed` engine (health, the version state, offline reasons, the
roles it serves) without ever starting or stopping it. For a folder,
adopt is the import: the models are linked, never copied, with their
provenance. **Forget** hides a detected row; the next detection sweep
does not bring it back unless it changes. Adopting is never
automatic, and detection never leaves the machine.

**Controls** per row: Start, Stop, Restart (spawned only; a managed
host gets Probe), Install a build (from the pinned list for this
machine, with the honest download bar), Make current (switch the tag
with a drain and swap, the previous kept for Go back), Remove a build
(never the current one; never a build a role is bound to).

**Configuration** per engine, declared once and rendered by the
generic settings renderer: context length, slots, threads, prompt
cache size, flash attention, for `llama-server`; the host URL and the
expected version for a managed host; the port is shown, never edited.
A change that needs a restart says so and offers it; the values in
effect and the values pending are both visible until then.


## Hardware and memory

The probe card, the chosen profile with a "Change" link, the governor's
rules stated as sentences ("One image or video job at a time. A job
waits when less than 20 GB is free."), and a live bar of what is loaded
with each model's measured share. This is the page that answers "what
can this machine do" honestly, and every number on it was measured on
this machine.

The memory numbers come from the kernel ledger: available percentage,
pressure level, reclaimable free bytes, and each process's footprint. A
badge says `(estimated)` until a dry run or successful load records the
model's measured footprint and context length.

The profile names resident and on-demand models; measured peaks replace
file-size estimates after the first-run bench, and estimates are labeled
`(estimated)`. An on-demand load starts only when free memory after its
requested peak leaves the tier's working margin: 4 GB on p16, 8 GB on p32,
12 GB on p64, or 20 GB on p128. One generator runs at a time; a request
waits in a four-place queue or is refused with a reason. A JIT model
expires after 600 seconds idle, and pressure unloads the least recently
used unpinned JIT model; a pinned model never unloads. The cap is total
memory minus the 8 GB OS margin, and `keep_alive` extends idle time only
within that cap and never for generators.

## Clients and keys

A row per client: name, key prefix, allowed roles, counters, created,
last seen, revoke. "New client" asks for a name and the roles, shows the
key once, and offers a copy button. Home appears here as a client the
day it installs, with its roles already chosen.

## Updates

The Updates page keeps installed and available versions side by side. It
starts with checking off, offers the choice on the second launch, and shows
the last check, release notes, size, and a Skip action. Engine updates drain
before swapping and keep the previous tag for rollback. Model revision
changes are reported weekly and never installed automatically.

Three sections: the Stack, engines, models. Each shows the installed
version and, if checking is on, what is available with release notes.
"Update" drains the role, swaps, and keeps the old build; "Roll back" is
one click until the next update. Checking is off until the operator turns
it on, and the page says what the check sends (a version number, nothing
else).

## Notifications

The event feed in words, newest first, grouped by day: updates, repairs,
jobs finished, pressure warnings. Clear-all. The menu-bar badge counts
unread.

## Settings

The current declared settings include name, theme, update checks, LAN,
port, history retention, log level and a Hugging Face endpoint.
`backend/src/settings/stackKeys.ts` owns their defaults, help and
sections; `GenericForm` renders them. Idle timeout and language are
future keys, not current controls. Basic and advanced disclosure, reset,
the generated reference and section master toggles still need an audit
against org SETTINGS.md.

**Second pass (decided 2026-09-18, 01:30).** The owner put our Settings
(two checkboxes, a filled Save button, a page of empty space) beside
UniFi's (a settings nav with search, section cards with an icon, a
title and a chevron, tables with a quiet action row, live apply). The
org standard already asks for most of UniFi's shape (Rule 5: one index
and search; Rule 6: live apply, defaults and reset, a master toggle per
section); ours had none of it. The decisions:

1. **Settings has its own second-level nav**, UniFi's Settings pattern:
   a column on the left of the page with "Find a setting" at the top
   (the settings index, `@modified` filter) and the sections as rows;
   below a hairline, the machine-specific group under the computer's
   name. The content area shows one section, or all of them stacked
   when "Overview" is chosen.
2. **Sections are cards**: an icon, the title, a chevron to collapse; the
   body is settings rows (label, info glyph, control) or, where the
   section holds things, the things table with its quiet action row
   ("Add a channel", "Manage"). Never a heading floating over bare
   rows.
3. **The sections**, each drawn from a declaration: Overview; General
   (this Stack's name, theme, language later); Updates (the check
   switch, the last check, the three manifests' state, the update and
   go-back actions, moved here from the former Updates page); Sources
   (the Hugging Face endpoint, default `huggingface.co`, STACK-57);
   Backups
   (target, schedule, retention, restore, the emergency kit, moved
   here from the former Backups page); Network and access (LAN access,
   port, the operator password card, sessions); Alert channels (the
   table and its panel); Storage (the data directory, the two
   databases and their sizes, history retention, "Sweep unreferenced
   files"); Maintenance (the window, bandwidth cap, "Run maintenance
   now", from STACK-22); Engines (one row per installed engine linking
   to its panel's Settings tab, Rule 1: a setting lives with the thing
   it configures). Under the computer's name: Hardware (the measured
   facts, read-only), Diagnostics (log level, "Open Logs", "Copy a
   support bundle" later), Reset (clear caches, forget detected things,
   the destructive ones with the kit's confirm).
4. **Live apply, no Save button.** A control applies on change and shows
   the kit's inline saved tick; a key marked `needsRestart` collects
   into a sticky bar at the bottom of the page ("2 changes need a
   restart of the chat engine", Apply now, Discard), UniFi's Apply
   Changes bar; the page keeps zero filled buttons until that bar
   appears, which is then the one.
5. **Every section has something in it.** A section whose feature is not
   built yet shows its declared rows disabled with one muted sentence
   naming the item ("Backups arrive with STACK-72"), never an empty
   card and never a hidden section, so the shape is judged now.

## Share with your family: the Home hand-off

The card that appears on the Ready step and stays on the board until Home
is installed. Wording:

> **Share with your family.** The Stack is yours alone. MaiPai Home adds
> people, kid-safe profiles, memory, and companions on top of it, on this
> same computer. [Install MaiPai Home]

That button is the answer to "can my kid use this": the Stack never gets
an "Add a person" button, so the operator is never left looking for one.
The install puts Home beside the Stack, registers Home as a client with
its roles, and hands the operator to Home's own first run, where the
household is created. Nothing is imported, because there is nothing to
import.

## The desktop app and menu bar (decided 2026-09-18, 07:00)

The Tauri app opens the daemon's console in one native window. Its tray
item observes health independently and offers Open, Pause everything,
Resume and Quit. It keeps the daemon running when the window closes.
STACK-66 installs and starts the bundled daemon; STACK-67 completes the
role, memory and check summary in the menu; STACK-68 adds per-kind native
notifications with an Open action. Native pickers come from the app's
host adapter. The browser remains a complete console, with typed-path
fallbacks for local file selection.

## Copy rules for this repo

The org's writing standards apply. In addition, on every Stack page:
memory numbers are measured or absent; an error names what to do next;
a model is named only after its role; and no page mentions a person,
because the Stack has none.
