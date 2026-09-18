# Stack product review, 2026-09-18

This is a product and plan review, not a live installation test. "Verified"
means checked against the linked project's own current documentation on
2026-09-18 or against a named file in this checkout. It does not mean a
competitor was installed or benchmarked. "Inference" marks a conclusion
drawn from those facts. The older survey in `dev.md` contains claims that
have aged; the current field is the comparison below. Screens were judged
from `docs/assets/screens/`, including `overview-console-dark.png`,
`showroom-models.png`, `models-add.png`, `models-panel.png`,
`overview-console-phone.png`, `models-phone.png`, `tester-phone.png`
and `settings-phone.png`. Code findings cite paths rather than a demo.

## 1. The goal

The first customer is someone with one capable Mac who wants local AI to
work for their own tools without learning which process, model file, port
and memory setting each tool needs. The second is the Home installer and,
later, the robot's local runtime. A parent who only wants to chat already
has easier choices. The Stack earns its own product only when it makes a
machine a dependable source of local AI for more than one client, survives
changes in models and engines, and explains failures in plain words.

**Recommended one-sentence promise:** "Run private AI for your apps on
your own computer, with one address, clear health and updates you can
undo." It describes what the product must prove. The canonical brand
sentence in `../.github/brand/COPY.md` says "the whole stack installed,
watched, tested and kept up to date" for "you and anything you build on
it." That is a good ambition, but "whole" implies every modality works
on day one, and "tested" implies a measured, repeatable proof. The current
catalog has one chat model in `backend/src/routes/catalog.ts`; image,
video and music still depend on future jobs and bindings
(`docs/BACKLOG.md`, STACK-13). The public sentence should be tested
against a clean install before it is used as a release claim. The brand
source is owned by the org, so this review does not silently rewrite it.

"Clients, not people" is essential. A second user system would duplicate
Home's consent, identity and safety work (`AGENTS.md`,
`docs/integrations.md`). Home building on Stack makes the contract
valuable and gives it an immediate real client. It complicates the
standalone pitch only when the console tries to act like a family chat
app. Keep Tester stateless and put the Home handoff at the moment someone
wants another person's account. Do not imply that a role-scoped key is a
child safety policy.

**Decision:** Keep the separate service and the client boundary. Change
the release claim from breadth to a proven local service, then widen it
as each modality passes a clean-install test. Drop "every local AI task"
as a day-one implication. **Owner question:** Should the public brand
sentence be narrowed before v0.1.0? Recommendation: yes, if the release
still has only a chat catalog entry and incomplete generator jobs.

## 2. The field

The table asks whether a person should use Stack, the named tool, or
both. "Does not" means the cited product description does not supply the
specific Stack contract; it is not a claim that the project can never
add it. Each comparison needs a fresh check before public marketing.

| Project | What it does well | What Stack adds, and where to reuse it |
|---|---|---|
| [Ollama](https://docs.ollama.com/api/introduction) | **Verified:** easy local API and downloads; its [app](https://ollama.com/blog/new-app) handles chat and files, and [image generation](https://ollama.com/blog/image-generation) exists on macOS. | **Inference:** Stack adds role-scoped clients, one budget across independent hosts, health and Home's handoff. Correct the old "chat only" claim. Adopt Ollama's simple install and model verbs; support adoption as a managed host. |
| [LM Studio](https://lmstudio.ai/docs/developer/core/headless) | **Verified:** polished model discovery, a headless service, on-demand loading, [idle TTL and eviction](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), API auth and LAN service settings. | **Inference:** its standalone Mac experience is a serious substitute. Stack needs to prove cross-engine admission, provenance and client contracts in use. Copy its clear loading language; detect its local server and files. |
| [Jan](https://www.jan.ai/docs/desktop/api-server) | **Verified:** desktop chat, model downloads and a local OpenAI API; its [API reference](https://www.jan.ai/docs/desktop/api-preference) includes model discovery. | **Inference:** Stack is for a shared service and machine operations, not Jan's chat, agents or projects. Point people who want a chat workspace there or to Home. |
| [Open WebUI](https://docs.openwebui.com/) | **Verified:** a strong self-hosted, multi-user UI over local and cloud providers, with a desktop path. | **Inference:** it is a better conversation frontend today. Stack should expose an ordinary compatible API to it and keep its own Tester small. Do not build Open WebUI's people, history or plugin system. |
| [LocalAI](https://localai.io/docs/features/index.html) | **Verified:** many backends and a gallery across text, speech, images, video and music. | **Inference:** modality breadth is not a differentiator. Treat it as a possible managed host; build only the cross-host budget, trust and recovery that it cannot promise for every separate process. |
| [llamafile](https://github.com/mozilla-ai/llamafile) | **Verified:** a model and server in one portable file, plus a speech transcription variant. | **Inference:** the fastest path for a portable one-off run. Stack adds long-running service management, roles and update history. Do not recreate its packaging. |
| [Harbor](https://github.com/av/harbor) | **Verified:** prewired Docker-based AI services and a fast exploratory setup. | **Inference:** use its prewired first-run lesson; Stack owns native Mac service operation and measured admission. Point Docker users to Harbor unless they need the Stack contract. |
| [GPT4All](https://www.nomic.ai/gpt4all) | **Verified:** simple private local chat and LocalDocs on major desktop systems. | **Inference:** Stack should not clone its document chat. Keep the service and model provenance, and link Home for a lasting assistant. |
| [Msty](https://docs.msty.app/getting-started/onboarding) | **Verified:** easy local onboarding and detection of existing Ollama models; [LAN service](https://docs.msty.app/how-to-guides/make-local-ai-service-available-on-the-network) is documented. | **Inference:** its onboarding is a better model for "first useful answer" than Stack's admin dashboard. Stack's difference must be independent-client operations. |
| [Pinokio](https://github.com/pinokiocomputer/pinokio) | **Verified:** one-click installation and launch of many AI projects through scripts. | **Inference:** it solves exploration, not a stable role API and one memory governor. Point experimenters there; do not add a script marketplace to Stack. |
| [oMLX](https://github.com/jundot/omlx) | **Verified:** Apple silicon language serving, continuous batching and cached context. | **Inference:** a candidate engine and a strong lesson in residency controls, not a reason to rewrite its inference core. Machine-wide behavior still needs Stack's measurement and bench proof. |
| [mlx-serve](https://github.com/ddalcu/mlx-serve) | **Verified:** one native server and app for language, images, video, music and speech on recent Apple silicon macOS. | **Inference:** it overlaps both the multi-modal and desktop claim. Keep it as a pinned engine candidate and compare actual resident memory, stability and model fit on the Studio. Do not promise Stack is broader. |
| [text-generation-webui, now TextGen](https://github.com/oobabooga/textgen) | **Verified:** portable desktop LLM app, several backends, vision, tools, API and image generation. | **Inference:** its tuning and chat UI are for experimenters. Stack should reuse its ordinary API shape, not copy its lab controls into a parent's first screen. |
| [Docker Model Runner](https://docs.docker.com/ai/model-runner/) | **Verified:** model packaging in OCI, GUI and CLI, OpenAI/Ollama-shaped serving and Compose integration. | **Inference:** strong developer distribution and a good option for Docker homes. Stack's Mac native governor and Home contract remain the proposed distinction. Do not invent another general package format for model weights. |
| [Home Assistant Conversation and Assist](https://www.home-assistant.io/voice_control/) | **Verified:** local voice pipelines and home-control intent UX; [Conversation](https://www.home-assistant.io/integrations/conversation/) owns sentences and actions. | **Inference:** reuse its appliance lesson of a short repair path. Stack must not absorb home automation or user intent. Home is the appropriate MaiPai layer for that. |
| [ComfyUI](https://github.com/Comfy-Org/ComfyUI) | **Verified in the existing plan and engine seam:** workflow graphs and queued media generation. | **Inference:** wrap it as a managed job host for images and edits. Do not invent a competing media graph. |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | **Verified in `backend/src/lib/engineCatalog.ts`:** Stack already pins llama-server. | **Decision:** keep using its inference and fit tools. Stack's value is selection, admission and recovery around it. |

For every row, a third-party host enters through the four seams in
`docs/dev.md` "The seams": spawned, managed, URL host or client. There
is no plugin runtime. The Stack already pins llama-server and
mlx-serve; retaining those pins is more credible than claiming a new
inference engine. A role router alone is also a solved pattern, so the
router needs to stay small and open-protocol-shaped. The unproven part
worth building is the governor over independent processes, with a
meaningful recovery story.

**Decision:** Keep Stack as an operating layer for local clients. Adopt
the existing engines, ordinary API shapes and Hugging Face tooling
where they work. Change the comparison table in `dev.md` and any
marketing that relies on Ollama or LocalAI being narrow. Drop plans
to match competitor chat and agent features.

## 3. The approach

| Choice | Judgment |
|---|---|
| Roles rather than concrete model names | Right for Home and stable clients. Keep concrete model IDs available for developer tools, and finish `GET /v1/models` (STACK-60). A parent should choose "Chat" or "Make images"; API docs can show `chat`, `image` and `embed`. |
| One daemon and a governor using the kernel ledger | Right only if the Studio bench proves fewer memory failures and predictable recovery than an engine's own controls. The Mac FFI and Linux `/proc` paths are platform-specific, so a scripted governor test is insufficient. On Linux the robot body supplies thermal and power limits; Stack cannot claim one effective budget until GOV-01 is integrated and measured. |
| Declared settings | Right. The current list, defaults and renderer need STACK-71. Keep advanced engine knobs near the engine and do not make first run a settings exercise. |
| Hugging Face cache-shaped store | Interoperability is right; a private reimplementation is risky. The [Hub cache](https://huggingface.co/docs/huggingface_hub/guides/manage-cache) uses blobs, refs and snapshots, and its official [JavaScript hub library](https://github.com/huggingface/huggingface.js) provides cache downloads. Check whether that library can own HF downloads under Bun before maintaining eight-part transfers and hand-built cache metadata. HF blob names can be ETags with different hash rules, so the Stack's SHA-256 provenance must remain a separate verified value. |
| Detect and adopt | Useful, especially for a Mac that already has Ollama or LM Studio. Detection is a suggestion, never control of someone else's process. A discovered server's advertised model list and ability labels are untrusted until probed and the operator selects it. |
| Desktop app around the console | Right: native pickers, tray and notifications with a daemon that survives window close. Current shell and sidecar distribution remain incomplete (STACK-66, STACK-76, RELEASE-STACK-01). |
| `.dmg` and one-line install | Right as two ways to install the same service. The `.dmg` is the parent path; the command is for headless and developer use. A one-line script is a high-trust operation: show its exact source, checksum/signature and uninstall path before inviting a user to pipe it to a shell. |

Day one must answer four questions without reading a manual: what will
run, how much disk it will use, whether it is ready, and what to do when
it is not. The current catalog route returns one local model and a raw
Hugging Face query mapped mostly to `chat`
(`backend/src/routes/catalog.ts`). It cannot yet honestly support
"choose any ability" on the first screen. A narrow, curated, measured
starter path beats a wide list of models with unknown fit.

**Decision:** Keep the architecture and desktop split. Change the
first-run sequence to a small proven starter plan with measured fit and
an immediate Tester result. Evaluate the official HF client before
extending the custom downloader. Drop a claim of full Mac/Linux parity
until the robot budget input and Linux profile have a live proof.

## 4. The terminology

The test is whether a busy parent with basic tech knowledge knows what
the word means before opening a help page. API identifiers stay stable
even when display copy improves. Competing products use "model" for
both a file and a running choice, "runtime" for an engine, and
"integration" for an external connection. Stack should define each in
one sentence in Help, not invent a new layer of synonyms.

| Current words | Judgment and display copy |
|---|---|
| Stack, This computer, Overview | Keep the product name and "This computer." "Overview" is familiar for an admin page, but first run should say "Get started" until a plan is running. |
| Engines, Models, Clients | Keep in administration. Add first-use explanations: engine is the program that runs a model; model is the downloaded AI file; client is an app allowed to use this Stack. "Access" may be a clearer navigation word than "Clients" for a parent. |
| Abilities, roles, chat, coding, judge, router, embed, stt, tts, image, video, music | "Abilities" is clear. Keep wire IDs in API docs; display "Chat," "Coding," "Check answers," "Choose a task," "Find related items," "Voice to text," "Text to voice," "Images," "Video," "Music." The last four technical IDs should not be a first-run checklist. |
| Plans and tiers | "Plan" is confused with a paid subscription. Use "Setup for this computer" or "Recommended setup"; show "Small," "Everyday" and "Full" only if they correspond to measured capacity, not memory-size marketing. |
| Adopt, detected, import | "Found on this computer" and "Use it here" are clearer. "Import" is acceptable for a folder; explain that Stack leaves the original alone. |
| Group, nickname | Fine for organizing installed models, but optional. A group is a folder-like organizer, not a household or a permissions boundary. A nickname changes only the display name. |
| Tester, Ask, the helper, Library | "Try it" is clearer than Tester for a parent. "Ask" should search Stack help and status, while the chat box tests a model. "Helper" as a separate persona is misleading. "Library" needs "Model and engine guides" under the title. |
| Pause everything, Check my Stack, Speed test | Keep the verbs, but describe effect and limit beside each action. "Pause everything" must state that new work stops while the app and health check remain available. "Check my Stack" is an operational check; "Speed test" measures the currently loaded chat model, not all AI on the computer. |
| Monitoring, Settings, Logs, Alerts | Keep Settings and Logs. "Activity and memory" may be clearer than Monitoring; "Needs attention" may be clearer than Alerts when the page is a repair list. Do not rename the route or API. |
| Health words: ready, loaded, installed, on demand, stopped, offline, current, needs restart | Keep distinct meanings, display a short reason and next action. "Installed" is on disk, "loaded" is in memory, "ready" can answer now, "on demand" will load when asked, "offline" is unreachable. "Current" means the selected build matches the latest known pin, not that the computer is healthy. |

**Decision:** Keep technical role IDs and public API terms stable.
Change the first-run and visible labels above after a short usability
test. Drop raw `stt`, `tts`, `embed` and "adopt" from parent-facing
copy. **Owner question:** Should the desktop navigation say "Access"
or "Clients"? Recommendation: "Access" in the sidebar, "Apps with
access" as the page title, with "clients" in API docs.

## 5. The UI

The UniFi reference in `ux.md` works where the console has a clear
device state, quiet actions and drill-down panels. The X reference
works where typography, spacing and few primary actions keep the
product calm. The captures show a consistent kit and restrained
color. They also show a management app before a useful first result.
LM Studio and Msty put "download one model, then try it" much closer
to the entrance; their documented onboarding is a better first-run
benchmark than their visual style.

The Overview is the right **return** screen, after setup. In
`overview-console-dark.png` the largest area is a usage chart whose
different units share one axis, with a large empty future range;
"Chat ready" and "2 items need attention" give no direct action.
The first screen should lead with the next action, the ready abilities
and whether the computer has room. Move detailed charts to Monitoring.
The health list should link each item to its fix and state what work is
affected. This is closer to UniFi's operational hierarchy.

The things pages have a useful desktop table and a useful panel
pattern, but `showroom-models.png` puts discovered engines in Models,
then mixes them with model groups. `models-panel.png` has an icon-only
action row whose meaning is impossible to guess. `models-add.png`
does the right three-source split but shows one catalog item and a
separate search button; fit, license and file size need to be legible
before Install. Use one primary "Add model" action, named panel actions,
and a separate "Found on this computer" section or page. Groups should
come after individual models and never stand in for a model list.

The phone renderer is a sensible bottom-tab pattern, but the captures
need a real interaction pass. `overview-console-phone.png` puts
"Charts" behind a status block and cards while an activity card runs
under the tab bar. `models-phone.png` labels the tab "Things" and
lists engines on the Models tab. `tester-phone.png` places six modes
in a tall bare column. In code, `frontend/src/pages/DashboardShell.tsx`
passes `onAction={() => undefined}` to the phone header's Add/Search
control; phone detail Group also has a no-op. Those are visible dead
ends, not polish issues. The Settings phone capture is a long stack of
cards, including unavailable sections. Its section index should land
on the chosen card and hide advanced sections until requested.

The tray should answer "running?", "what needs attention?" and "open
the fix" in one glance. A role-by-role menu is useful only if it can be
scanned; the top line should be a short status, with more detail inside
the app. Protected actions must pass through the signed-in console
(STACK-76), and "Quit" must say the service keeps running.
Screenshots from several design passes coexist and disagree on nav
labels and status. Release review should regenerate and inspect one
coherent set from real code and a truthful seeded state.

**Decision:** Keep the visual kit, return dashboard, things table,
detail panel and phone tab bar. Change the first-run route, the
Overview hierarchy, Models information architecture, named actions
and phone interaction wiring. Drop empty hero charts and decorative
badges that imply a feature works before it does. **Owner question:**
May the release defer charts from the first screen? Recommendation:
yes; keep them in Monitoring, with one measured status sentence on
Overview.

## 6. The mechanisms

| Mechanism | Judgment, reuse, and first failure |
|---|---|
| Listings: Catalog, HF search, detection | A curated signed list is the safe first view. HF search is an opt-in discovery path, not a fit or license authority. `backend/src/routes/catalog.ts` currently ties search to `updatesEnabled()`, marks almost every result `chat`, gives `revision: main`, and provides no size, license or files. That breaks install expectations first. Use the official [Hub JS API](https://github.com/huggingface/huggingface.js) for metadata and an immutable revision when it meets Bun and privacy requirements. Local scans must remain bounded to known paths and loopback ports. |
| Downloads and store | Pins, SHA-256 verification, atomic visibility and resume are right. The [official HF cache layout](https://huggingface.co/docs/huggingface_hub/guides/manage-cache) and [download client](https://huggingface.co/docs/huggingface_hub/guides/download) already solve much of the HF case. Compare them with `backend/src/lib/download.ts`, `modelStore.ts` and `hfCache.ts`; use a maintained client if it preserves pinned revisions, checksum checks and progress. Imported links can break when another app prunes its store, so verify before every binding. |
| Status and health | Roles plus a durable health list and a read-only check are the right layers. The UI must distinguish on disk, in memory, ready to answer and offline. A stale "all good" check after a role fails is the first trust break. Keep one state declaration for API, tray and UI; test state transitions and time stamps. On Linux, service and kernel probes need live robot tests. |
| Updates | Three independent manifests make sense. A staged engine swap, health probe and rollback are the core value. A Tauri app update is a different trust path: evaluate [Tauri's signed updater](https://v2.tauri.app/plugin/updater/) for the app while keeping engine and model revisions in Stack. Do not claim app rollback until a damaged bundle can be recovered on a clean machine. The first failure is a partially upgraded app/daemon pair; pin a compatibility range and rehearse it. |
| Documentation | Shipped offline help, model cards and engine docs are useful. The Library currently fetches remote pages only after an explicit action (`backend/src/lib/library.ts`), which fits privacy. Its search route uses a lowercase substring scan even though it builds a Pagefind index. [Pagefind's Node API](https://pagefind.app/docs/node-api/) is the maintained local search option; use it for the shipped and fetched indexes if size and Bun packaging work, and keep the tiny substring path only as a measured fallback. Missing docs should say "not fetched" and link Help. |
| Search and Ask | The palette's section and action links are useful; the optional model tier should answer only from local, read-only status and cited docs. A growing intent table of phrasing rules is a classifier by another name. Start with finite, explicit commands and ordinary search results; use the existing loaded chat model only after the operator asks. Its first failure is a fabricated repair instruction, so show sources and exact action links. |
| Notifications and channels | Local durable events, native tray notifications and Home's own bridge are right. Telegram and ntfy are explicit outbound choices, so show recipient and data sent at setup (`docs/user/privacy.md`). A failed or repeated delivery must not become a false system fault or a notification storm. Use native OS notification APIs through Tauri; keep remote channels as adapters. |
| Backups | Encrypted state backup and a tested restore before release are necessary, but the current plan is broader than the first proof needs. Back up precious state first; downloaded weights and metrics are replaceable. Reuse OS keystore and standard cryptography, preserve a recovery path when the old Mac is gone, and test restore into an empty directory. The first failure is an archive that only decrypts on the original machine or a restore that references missing model files. STACK-72, STACK-77 and STACK-78 own the detailed work. |

These mechanisms fit a single Mac if each reports its actual state and
its next step. They fit the robot only after the Linux service,
power/thermal input and role contract are tested with the body. No
Stack mechanism should create a Person, household or history record.

**Decision:** Keep manifests, roles, health, explicit channels and
encrypted state restore. Change HF metadata and cache ownership, the
app update path, search implementation and status language after
compatibility tests. Drop any assumption that a UI label or an
unmeasured model estimate is an operational guarantee.

## 7. Needed, great, works

**Needed:** Yes, if Home uses it and independent clients can rely on
one address across model and engine changes; the standalone Mac
pitch still needs evidence from new users. Raise confidence by
shipping the Home contract proof, measuring one shared memory budget
against the existing hosts, and watching three clean-install users
reach a first answer.

**Great:** The operating promise is strong, while the present first-run
path and wording lag the field's best apps. Raise quality by replacing
the admin-first entrance with a guided starter setup, making every
visible action work on phone and desktop, and showing repair actions
before charts.

**Works:** The code is a substantial foundation, but the release
claim is not yet proven: the app lifecycle, model breadth, app update,
backup restore and robot profile have open gates. Raise confidence by
passing the bundled-app clean install, the Studio admission and
rollback bench, and a clean restore with an actual client request.

**Decision:** Continue building Stack. Do not publish a broad
"everything local AI" claim or cut a release from screenshots alone.
Use the gates above as evidence, then revisit scope. **Owner
question:** Is a standalone release worth shipping before Home is its
first real client? Recommendation: yes only as a clearly scoped Mac
preview with a clean-install proof, not as the finished family
foundation.

## 8. Changes to make

The product findings add STACK-79 through STACK-85 in `BACKLOG.md`.
They complement, rather than replace, STACK-60, STACK-66, STACK-71
through STACK-78 and RELEASE-STACK-01. The first release should take
STACK-79 through STACK-83 before the distribution gate; STACK-84 and
STACK-85 can follow the measured first release if the UI states their
limits clearly.

The confident wording changes made with this review are the three
competitor rows in `dev.md` "Why the Stack" and the owner-directed
release-notes order in `dev.md` "The desktop program" item 7.
The org's release rule still says a links-only preamble; its owner is
the coordinator in `../.github`. The review recommends, but does not
change, canonical brand copy in `../.github/brand/COPY.md`.

**Decision:** Land the wording corrections now. Build the backlog
items against named acceptance checks, then review the promise against
the release evidence.
