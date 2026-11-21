# Admin page and standalone Stack (plan, 2026-11-21)

Owner-approved: 2026-11-21 (Jesse). Rule text: AGENTS.md, "Standalone and admin exception".

## Goal

A person can install the Stack alone, open one web page, sign in, see what
runs, choose which features and models run, set their priority and tier,
restart things, and apply updates. Home uses the same routes. Nothing new
leaves the machine.

## Shape

One static single-page app bundled in `backend/`, served by the Stack. It is
a second caller of the existing `/stack/v1/*` API. No second copy of any
logic. Look: Uptime Kuma and UniFi calm, Apple clean, light and dark, phone
width, live through the SSE feed.

## Access and login

- First run prints a one-time setup code to the log and a 0600 file. The
  page then sets the one admin password. Salted hash in the Stack database.
- Session cookie (HttpOnly, SameSite strict, idle timeout), login rate limit.
- Reset: local command `stack admin reset` on the machine.
- Listens on loopback. Tailscale address only when the admin turns it on
  (declared setting, off by default). Never the LAN, never 0.0.0.0, unless
  the admin explicitly chooses LAN in standalone mode (open question 1).
- Home keeps its own key and skips the login page.

## Screens

1. **Overview:** overall status, version, uptime, memory pressure, one card
   per role with state and answering engine.
2. **Features:** switch each role on or off (chat, embed, speech to text,
   text to speech, wakeword, image, video, music).
3. **Models and priority:** per role, the pinned catalog choices, installed
   state, download, remove, and the order roles win memory when it is tight
   (priority). Tier picker (the existing profiles) with the fit decision
   explained in plain words.
4. **Engines:** installed versions, restart one engine, last log lines.
5. **Health:** problem list, one fix button each.
6. **Settings:** generic renderer over the declared settings, Apply.
7. **Updates:** installed, available, last checked, check, apply, go back.
8. **Resources:** the beautiful part (see "Resource utilization" below).
9. **Helper:** the admin chat assistant (see "The Helper" below).
10. **Tools:** diagnostics zip, readiness check, restart Stack, reboot
   computer (confirm, needs a sudoers line the installer adds).

## Look and feel (Valet as the reference)

Valet (`askvalet/valet`, MIT, React 19, Tailwind, Radix, cmdk, motion,
lucide, Geist, shadcn components) is the quality bar: one calm front door,
live cards with real numbers, hover details in a top bar, `⌘K` to jump to
anything, `/` commands in chat, smooth motion, light and dark, installable
to a phone Home Screen. We take its ideas, not its code: our org rule is
prebuilt kit primitives from `@maipai/ui` (commons) restyled by tokens, so
the Stack page imports those and adds no library of its own. If any Valet
code is ever copied, MIT notice goes in `NOTICE`. A design-resolver pass
checks the page against the org UI rule before build.

### Design bar (owner, 2026-11-21)

A simplified UniFi app, as Apple would have designed it, with the polish
of Apple, Spotify and Valet.

- **UniFi, simplified:** one calm dashboard of live device-style cards
  (each role is a "device" with status, load and a tap-through detail
  sheet), a topology-like view of roles and engines, big clear numbers,
  few controls per screen, advanced settings tucked behind "More".
- **Apple:** generous space, a strict type scale, soft glass and blur on
  bars and sheets, continuous corners, spring motion that respects
  reduced-motion, sheets instead of page jumps, SF-style system font
  stack with Geist as the fallback, dark mode that is designed, not
  inverted.
- **Spotify:** confident dark default, one accent color, big tappable
  rows and cards, smooth transitions between states, skeletons that
  never flash empty, the "now playing" bar idea reused as a persistent
  live status bar (what is running now, memory pressure).
- **Valet:** the live-everything, hover details, `⌘K` and approve-first
  chat feel.
- **Rules that keep it honest:** one accent color, status colors only for
  status, no more than two type weights per screen, every number live,
  every empty and error state written in plain words with a fix button,
  phone first for layout, 60 fps animations, no spinner longer than a
  skeleton.
- **Gate:** before screens are built, `design-resolver` produces a design
  note and I build a clickable mockup of Overview, Resources and Helper
  on seeded data; I open it in the browser pane at desktop and phone
  width, judge the screenshots against this bar, and only then build the
  rest. The UI is tokens on `@maipai/ui` only, never a fork.

Adopted from Valet: command palette (`⌘K` for screens, roles, settings,
actions), top bar with hover details (CPU, memory, tier), live everything
over SSE, approvals before any change from chat, a `/wall` read-only
display mode for a spare screen (later, not v1), installable web app.

## Resource utilization (live and history)

Existing data: `GET /stack/v1/memory` (5 s samples: available, wired,
compressed, swap and growth, kernel pressure, the Stack's own processes by
name and bytes, top consumers, other programs' load, admission queue) and
`lib/dailyResources.ts`. New: a bounded history ring (for example 24 h at
5 s, then hourly for 30 days, in the Stack database) behind
`GET /stack/v1/resources/history?range=`, plus CPU, GPU where the OS gives
it, disk used by models, and tokens per second per role.

Screen:
- A large **memory budget bar**: total, split by each loaded engine and
  model (colored per role), other programs, free, with the pressure level
  as a plain-words badge ("Comfortable", "Tight", "Critical").
- **Live line charts** (1 h, 24 h, 7 d): memory by role stacked, swap, CPU,
  GPU, tokens per second, queue depth.
- **Per-engine rows:** memory now and peak, requests, last answer time,
  load or unload timestamps.
- **Admission queue and decisions:** who is waiting and why a request was
  refused, in sentences.
- **Disk:** models and engines by size, with the prune button.
- Hover shows exact values; nothing needs a refresh.

## The Helper (admin chat assistant with its own small model)

A chat box in the admin page ("Ask the Stack") that answers questions
about the machine and, with approval, changes things. It has its own model
so it works when the `chat` role is down, which is exactly when you need it.

- **Own role, own process.** A separate `helper` role on `llama-server`
  (the baseline engine), its own model file, not routed through the `chat`
  role and not exposed on `/v1` to Home. Declared in `components.md` like
  every role. If `chat` is broken, the Helper still runs; it needs only the
  `llama-server` build and its model file.
- **Small but smart.** Target a 3 to 4 billion parameter instruct model
  with solid tool calling, Q4, roughly 2.5 to 3 GB resident. The exact
  model is chosen by a bench (tool-call accuracy on a fixed set of admin
  questions, answer quality, speed, memory), then pinned by URL, revision,
  checksum and licence like every model. No model is named in advance.
- **On demand.** Loads on the first message, shows "waking up" for a few
  seconds, unloads after N idle minutes (setting, default 5, never below
  1). It takes a slot through the admission governor like any engine, so it
  cannot starve chat; under critical pressure it is first to unload. Idle
  cost is zero.
- **What it can do.** Read tools run freely: roles, health, memory and
  history, logs (redacted), settings, updates, hardware. Write tools need
  an Approve click in the chat: change a setting, switch a feature, set
  priority or tier, restart an engine or the Stack, check or apply an
  update, roll back. It cannot reboot the computer, edit files, run shell
  commands, read the admin password or tokens, or reach the network.
- **Calls the same routes** as the page, in-process, with the signed-in
  admin's authority, so one definition and one audit log. Every approved
  change is logged with "by Helper, approved by admin".
- **Safety.** Log lines, engine output and setting text are data, never
  instructions; the Helper's system prompt says so and writes always need a
  human click, which is the real barrier. It speaks only to the signed-in
  admin, never to a household member, so Home's child and adult gates are
  untouched. Chat history stays in the Stack database, with a clear button.
  Nothing is sent anywhere.
- **Chat niceties from Valet:** `/` commands (`/restart`, `/health`,
  `/new`), `@role` to point it at one role, a context meter, a thinking
  indicator while the model wakes.
- **If the model is not installed:** the page shows "Install the Helper
  (about 2.5 GB)" with one button; the standalone installer offers it as an
  optional step.

## Profiles: matched, custom recommended, custom (owner, 2026-11-21)

Today the Stack picks the highest fixed tier (`p16`, `p32`, `p64`, `p128`
in `backend/src/profiles.ts`) whose memory floor the machine clears. A 48 GB
Mac mini lands on `p32` and wastes a third of its memory. The admin page
and Home's setup wizard both offer three ways to choose, from one Stack
route, so there is one definition:

1. **Matched.** A shipped template (tier) that fits well. A tier counts as
   a good match when it is the highest tier the machine clears and the
   machine is within 25 percent above that tier's floor (24 GB matches
   `p16`, 32 to 40 GB match `p32`, 48 GB matches nothing well).
   Shown as "Matches the 32 GB setup".
2. **Custom recommended.** Computed for this exact machine by a
   deterministic planner, not a template. It takes the measured memory
   budget (sizing memory minus the OS reserve and the governor margin),
   the role priority order, and each pinned model's measured footprint
   (pinned estimate, flagged "estimated", when never measured here), then:
   fills resident roles by priority, upgrades models (for example a larger
   chat model, a separate judge) while they fit with headroom, and keeps
   the largest on-demand generator slot that still fits. Output has the
   same shape as a tier plus model bindings and a plain-words "why"
   ("Chat uses the 14B model because 11 GB are spare"). Same inputs always
   give the same plan; golden tests at 16, 24, 32, 48, 64, 96 and 128 GB.
3. **Custom.** The person chooses roles, models and priority by hand on
   the Features and Models screens; a live budget bar says what fits, what
   will queue, and what will be refused, using the same fit check.

The wizard and the admin page show Matched when it is good, and always
show Custom recommended beside it when it differs ("Recommended for your
48 GB Mac mini"), with a Customize button into mode 3. A saved choice
records its mode (`matched`, `custom_recommended`, `custom`) and, for the
first two, re-plans when the memory changes (new RAM, a changed budget)
and asks before switching.

Stack routes (additive, Zod, OpenAPI): `GET /stack/v1/profiles/recommend`
returns `{ memory, matched: {tier, quality, reason} | null,
custom_recommended: {plan, why[]}, templates[] }`;
`POST /stack/v1/profiles/apply {mode, plan?}` validates through the fit
check and installs what is missing as normal pull jobs.
`GET /stack/v1/install-plan` keeps working unchanged for Home today.

**Planner rules chosen where this plan was ambiguous (step 4b, built).**
The planner is `backend/src/lib/profilePlanner.ts`; the routes are `POST`
(not `GET`) `/stack/v1/profiles/recommend` and `/apply`, because the page
sends its live role choices in the body (send `{}` for the defaults).

- Matched ceiling: the plan's rule says 25 percent above the floor, and its
  own example puts 24 GB on `p16` (25 percent would end at 20 GB). The
  rule stands for `p32` (to 40), `p64` (to 80) and `p128` (to 160); `p16`
  carries an explicit ceiling of 24 GB, so the example holds. Anything
  above a ceiling matches nothing (41 to 63, 81 to 127, over 160).
- Budget: memory less the governor's 8 GB OS reserve is the resident cap;
  the room left for on-demand work is the governor's own, the smaller of
  total minus reserve minus residents and total minus residents minus the
  tier's working margin.
- The tier template is the floor: its resident roles are kept even when the
  pinned estimates read over the cap (16 GB does, flagged `tight`).
- An upgrade (a larger chat model) is taken only if it leaves 4 GiB of room
  and every generator slot the tier offers still resolves, and only when no
  picture, video or music role is ranked above chat. The automatic chat
  ladder holds pinned chat models on a standard or boost slot that are not
  under vetting; the uncensored Huihui build is excluded by name and is
  Custom only. Today that ladder is empty, so chat stays on the tier's 8B
  model at every size; the planner's gain is the generator slots.
- Generator slots look at the tier's candidates and the next tier up's, and
  take the highest standard or boost slot that fits (a Max-only fit shows as
  `queues`), so a 48 GB computer gets music and a boost picture slot that
  the 32 GB template lacks. Coding and vision stay tier-defined.
- Not built: measured peaks from this machine (the planner takes them as
  input; the route passes none, so every unmeasured peak is `estimated`) and
  a judge or router upgrade (their bindings are the tier's own).
- Apply writes role `enabled` and `priority`, and `stack.engines.chat.model`
  when the plan names a chat model other than the tier's; a role the
  computer cannot run is left unchanged. Custom writes only what the person
  sent and starts no installs.

**Home today (read-only audit, 2026-11-21).** Home's wizard reads the plan
from Home's own backend (`/api/setup/plan`, client `setupPlan` in
`frontend/src/lib/api.ts`, screen `frontend/src/apps/setup/PlanStep.tsx`,
choices in `planChoices.ts`), stores `{option: "recommended", tier}`
(`backend/src/lib/installActions.ts`), and trusts the Stack's tier; it does
not score hardware itself, which is right. It has no whole-setup
"customize" choice, only per-job picks. So Home needs the three-way choice
too.

**Validate that Home works this way.** A read-only audit of Home's setup
wizard first (which routes it calls, whether it picks a profile itself or
trusts the Stack, how "customize" works today). Then a Home change, landed
spec first in this repo's contract, to call `profiles/recommend` and
`profiles/apply` and never choose a tier itself, plus a contract test on
each side that pins the wire shape, so the two can't drift. Home work goes
to Home's own worktree and lane.

## New backend pieces

- Admin auth routes (setup, login, logout, change password).
- `POST /stack/v1/service/restart`, `POST /stack/v1/engines/{name}/restart`,
  `POST /stack/v1/host/reboot`, `GET /stack/v1/logs?tail=` (redacted).
- `GET /stack/v1/resources/history`, plus the history ring that feeds it.
- The `helper` role: declaration, pinned model, on-demand load and idle
  unload, `POST /stack/v1/helper/chat` (SSE stream, tool calls, approval
  round trip) and `GET/DELETE /stack/v1/helper/history`.
- Role enable/disable and role priority as declared settings (if not
  already), so Home and the page read one definition.
- Every new route: Zod types, OpenAPI regeneration, `integrations.md` rows,
  test. Admin actions logged with time and source; the privacy route lists
  the admin listener.

## Standalone pieces

- Standalone installer (macOS first, Linux next) that installs the Stack
  as a launchd or systemd service, prints the setup code, opens the page.
- README for GitHub (written last, with the `docs-writing` skill), user
  docs (grade 6), dev docs, generated screenshots from seeded data.
- Public release flow: tagged builds, checksums, update path that works
  without Home.

## Open questions (decide before step 6; defaults in bold)

1. Other apps (Open WebUI, scripts) calling the Stack's `/v1`: **optional
   API keys made on the admin page, loopback by default, LAN off unless
   chosen.**
2. Model choice beyond the pinned catalog: **catalog only in v1; "add by
   Hugging Face repo" later, still pinned and checksummed on install.**
3. Windows: **out of v1** (the pins exist for Windows CUDA, the service
   unit does not).

## Build order (each lands separately, gated)

1. Rule exception and this plan (this commit).
2. Admin account, sessions, listener binding, tests.
3. Restart, logs and reboot routes, tests.
4. Role enable and priority settings, tests.
4b. Profile planner (`lib/profilePlanner.ts`), `profiles/recommend` and
    `profiles/apply`, golden tests, then the Home audit and Home change.
    Planner and routes go to the API worker; the Home audit is a read-only
    scan (Haiku).
5. Design note and clickable mockup, judged against the design bar.
5b. Page shell (on `@maipai/ui`, `⌘K`, top bar) with Overview, Health, Engines.
    Built 2026-11-21 (`admin-ui/`, `lib/adminUi.ts`; `bun run build:admin`).
6. Resource history ring and the Resources screen.
    Built 2026-11-21 (`admin-ui/src/Resources.tsx`, ADMIN-07). Gaps that need
    new route fields are listed in the ADMIN-07 backlog row.
7. Features, Models and priority, Settings, Updates, Tools screens.
   Built 2026-11-21 (`admin-ui/src/{Features,Models,SettingsScreen,Updates,Tools}.tsx`,
   helpers in `manage.ts`, ADMIN-08). Route gaps are listed in the ADMIN-08 backlog row.
8. Helper: model bench and pin, role, on-demand load and unload, tools and
   approvals, chat screen.
9. Screenshots from seeded data, opened and judged on desktop and phone.
10. Standalone installer and update path.
11. README, user and dev docs, backlog rows, release.
12. Update org `DECISIONS.md` in `getmaipai/.github` with the 2026-11-21
    entry (separate repo, separate commit).

## Routing

Steps 2 to 4, 6 (backend half) and 10: Claude API worker or Codex (decided,
testable). Helper model bench (8): local-lane or Codex runs it, I judge the
result. Step 1, page design (5 to 9), the README and docs: this session.
