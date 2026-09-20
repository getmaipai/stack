# Is the Stack realistic and necessary? Review, 2026-09-20

The owner's question, in his words: the goal is a central and ideally
simple way to manage a local AI stack (engines, models, apps and so
on): see and control what is running, get update notifications and
update, browse, find, install and uninstall, configure. He does not
want to keep building it if it is not feasible, not realistic, or if
existing tools already do it.

This is a desk review, not a live test. **Verified** means read today
in the linked project's own page or in this checkout. **Inference** is
a judgment drawn from those facts. The two earlier reviews
([achievability](stack-achievability-2026-09-18.md),
[product](stack-product-review-2026-09-18.md)) answered "can we build
the machinery" and "is the product good"; this one answers the question
underneath both: should this exist as a product at all.

## The short answer

1. **The general goal ("one place to manage my local AI stack") is
   already served, several times over, by maintained projects with
   more contributors than this one.** Building a new general-purpose
   manager for its own sake in September 2026 is not a gap in the
   field. The field check is in section 2.
2. **The narrow goal ("Home and Bot need one governed engine layer with
   one address by role") is real and nobody ships it in that exact
   shape.** But that need is a library inside Home's process, or at
   most a private daemon Home installs, not a public product with a
   console, a model showroom, a documentation library, a tray app, a
   command palette and alert channels.
3. **Feasibility was already answered on 2026-09-18:** a narrow Mac
   chat service is achievable; a universal local-AI installer and
   manager is "nightmare, stop". Nothing since then changes that. What
   the last two days added was mostly console surface (section 3).
4. **Recommendation: stop building the Stack as a standalone product.
   Keep the engine layer, and put it back under Home.** Drop the public
   surface. Details and the two ways to do it are in section 5.

The "apps" part of the owner's goal is worth naming separately: the
Stack's own line (`AGENTS.md`: no packages, no apps, no extension
system) already excludes it. App management on the Stack was never in
scope, and Pinokio already owns that job (section 2).

## 1. What was actually asked for, split in two

The one sentence hides two products with different customers.

**The personal-manager goal.** One person, one Mac, several AI tools,
wants a dashboard: what is running, what is out of date, install this,
remove that, change a setting. Customer: anyone running local AI.
Competition: every tool in section 2.

**The platform-runtime goal.** MaiPai Home (and later Bot) need engines
spawned, sized, governed for memory, checksummed, and addressed by role
so that swapping an engine never breaks a client. Customer: two MaiPai
products and their author. Competition: none in that exact shape, but
also no market, because the only clients are ours.

The 2026-09-17 decision (`.github/docs/DECISIONS.md`) fused these on
principle 5 (a different cadence and audience earn a repo). The
product review of 2026-09-18 already found the seam: "A parent who only
wants to chat already has easier choices" and "the standalone Mac
pitch still needs evidence from new users." Two days later the evidence
is still zero users, and the console is where the commits went.

## 2. The field, checked today

The question for each row: does it do what the owner described, on a
Mac, today. Sources are the projects' own pages unless marked.

| Project | Manages | Runs as a service, one API | Modalities | Updates | Open source, telemetry | Read |
|---|---|---|---|---|---|---|
| [Msty Nexus](https://msty.ai/resources/blog/introducing-msty-nexus/) (announced 2026-06-11, available now, macOS/Windows/Linux) | **Verified:** "local engines such as Ollama, llama.cpp, and MLX alongside cloud providers"; provider credentials; model presets; **per-application access tokens** | **Verified:** "exposes those models through a single OpenAI-compatible API" as a shared gateway for several apps | Text only in the announcement | Not described | **Verified:** "will also be open source"; telemetry not stated | The closest thing to the Stack's pitch, by name ("One Runtime for Your AI Stack") and by shape (managed engines, one address, per-app keys). No memory governor, no health-with-a-fix, no rollback described. |
| [LocalAI](https://github.com/mudler/localai) (MIT) | **Verified:** "60+ backends" each "in its own image, pulled only when a model needs it"; model gallery; Hugging Face, Ollama and OCI sources | **Verified:** one OpenAI-shaped API; native macOS DMG and Homebrew, no Docker needed | **Verified:** text, vision, image, video, STT, TTS, embeddings, reranking | Backends install and remove from a gallery | MIT; WebUI has user auth, API keys, per-user quotas, metrics; telemetry not stated | Broader than the Stack's whole roadmap, and shipping. Its cost is weight (OCI-packaged backends) and that provenance is theirs. |
| [AMD Lemonade](https://lemonade-server.ai/docs/guide/faq/) (Apache-2) | **Verified:** llama.cpp, whisper.cpp, sd-cpp, Kokoro TTS, ONNX, vLLM, FastFlowLM backends; a web Model Manager; reads LM Studio and llama.cpp caches | **Verified:** background service, tray, CLI, OpenAI, Ollama and Anthropic-shaped APIs; "a macOS installer (.pkg) is available for Apple Silicon Macs" with Metal | Chat, STT, TTS, image | In-app | Apache-2; has a telemetry doc section | An AMD-backed team doing the Stack's service shape on three OSes. [InfoWorld's first look](https://www.infoworld.com/article/4169474/first-look-lemonade-serves-up-local-ai-with-limitations.html) faults the thin knobs, not the concept. |
| [LM Studio](https://lmstudio.ai/docs/developer/core/headless) (closed) | **Verified:** llama.cpp and MLX runtimes updated inside the app; model discovery with fit labels; `llmster` headless daemon since 0.4.0 (January 2026) | **Verified:** OpenAI and Anthropic-shaped endpoints, JIT load, idle TTL, API auth, LAN toggle | Text, vision | Its own | Closed; update checks and model searches are outbound events with no named opt-out (per the 2026-09-18 review) | The best standalone Mac experience. The privacy objection is real and is the Stack's only clean argument against it. |
| [Ollama](https://github.com/ollama/ollama/releases) (MIT) | **Verified:** models, `pull`/`run`/`ps`, MLX backend since March 2026, experimental image generation on macOS | **Verified:** background service, one API | Text, vision, embeddings, experimental image | Its own app | MIT; **Verified:** first run now offers "sign in or continue locally" and cloud models exist | Drifting toward its cloud; still the default engine most tools assume. |
| [Pinokio](https://desktop.pinokio.co/) (open source, 8.0.40 on 2026-07-22) | **Verified:** one-click install and run of AI *apps* (ComfyUI, Fooocus, TTS, music, stem separation) with Python, Node, Git and Conda bundled; a supply-chain guard ("Bluefairy") since 7.2 | Apps each run their own server | Whatever the app does | Per app | Open source | This is the "apps" half of the owner's sentence, done. The Stack's line excludes apps anyway. |
| [Stability Matrix](https://lykos.ai/) | **Verified:** installs and updates ComfyUI, A1111, Forge, InvokeAI and others; one shared model folder; one-click updates of UIs, extensions and itself; macOS supported | No; a launcher | Image, video UIs | One click | Open source | The image-generation package manager. |
| [llama-swap](https://github.com/mostlygeek/llama-swap) (MIT) | **Verified:** a YAML of model name to launch command; groups for models that must coexist; TTL; macros; `${PORT}` | **Verified:** one Go binary, OpenAI and Anthropic-shaped front door, swaps or spawns the upstream per request | Any upstream server | None | MIT, no telemetry | The Stack's router and supervisor for spawned engines, in one file. |
| [Docker Model Runner](https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/) | **Verified:** models as OCI artifacts, `vllm-metal` on Apple silicon (Docker Desktop 4.62+), Compose `models:` element | Native host process, OpenAI API | Text | Docker's | Docker Desktop's telemetry | Docker absorbing the runtime layer for developers. |
| [Nexa SDK](https://github.com/qualcomm/nexa-sdk) (Qualcomm) | **Verified:** LLM, VLM, ASR, TTS, image, OCR, embeddings in "a single runtime"; MLX on Apple silicon; NPUs | OpenAI-compatible server, one CLI | All of the above | Its own | Open source | A silicon vendor doing the multimodal single-runtime. |
| ToolPiper, Msty Studio, Jan, AnythingLLM, Open WebUI ([ModelPiper's Mac comparison](https://modelpiper.com/blog/local-ai-platforms-compared-mac)) | Chat and workspace apps that manage or delegate engines; ToolPiper bundles STT, TTS, OCR, upscale behind an HTTP API and MCP server on the Mac | Mostly yes | Varies | Varies | Jan open; the rest closed or partly | The comparison's own conclusion: "most setups end up combining two or three." |

Three things follow from the table.

**The generic manager exists.** Msty Nexus, Lemonade and LocalAI each
ship "several engines, one service, one API, a model manager" on a
Mac today, and two of the three are open source. LM Studio does it
better for a single person and is closed. Between them they cover every
verb in the owner's sentence except cross-engine memory admission.

**The one thing nobody ships is the Stack's stated difference**
(`dev.md`, "Why the Stack"): one measured memory budget across
independent engines, provenance before selection, health with one fix
per problem, updates with rollback, alerts with no vendor, and a
household hub that installs on top. Every earlier review agreed. But
the 2026-09-18 achievability review also marked the cross-engine part
"nightmare, stop" for anything the Stack did not launch itself, and
narrowed it to "govern only Stack-launched processes". Once it is only
Stack-launched processes, the difference against llama-swap groups plus
a TTL is a memory ledger, which is a feature, not a product.

**The market says "combination", not "one".** The Mac comparison's
verdict that people combine two or three tools is the same finding the
owner made when he asked the question: the field is fragmented. The
question is whether a fourteenth tool consolidates it or fragments it
further. **Inference:** with zero users and one author, it fragments it.
The projects that could consolidate are the ones with a vendor (AMD,
Docker, Qualcomm) or a company (Msty, LM Studio) behind them, and one
of them (Msty Nexus) announced the Stack's exact pitch three months
before the Stack's first commit.

## 3. What has been built, and what it cost

**Verified in this checkout:** 247 commits over four days (103 on
2026-09-17, 100 on 2026-09-18, 27 on 2026-09-19, 17 on 2026-09-20),
about 20,900 lines of TypeScript across `backend/src` and
`frontend/src`, 88 backlog items ticked and 51 open. The engine layer
(router, governor, supervisor, model store with checksums, health,
updates skeleton, launchd service, installer script) exists and
answered a real chat request on one Mac (the live walk in `dev.md`).
The Tauri shell exists without its daemon sidecar. No signed build, no
clean-account install, no second engine under the governor, no Studio
bench (STACK-14), no Home migration (STACK-16), no release.

**Inference:** roughly a third of the backlog by line count is the
Console area (`BACKLOG.md` lines 509 to 998: showroom, panels, palette,
library, Try-it studio, phone layouts, theme), which is the standalone
product's surface and is what the last two days' lanes were building
(UI-12b, UI-15, the pane container in today's dirty tree). None of it
is needed by Home, whose shell already exists and whose settings
renderer already draws from a declaration. That is the cost of the
product framing: a second admin UI, a second docs site, a second
notification center, a second update feed, all of which the org's
principle 1 ("a second copy of anything is wrong even when it is
faster") forbids inside one product and which the repo split made
permissible by naming them a different product.

The four days are sunk and not the point. The point is the continuing
cost the achievability review named: qualifying every upstream nightly
per OS and GPU, an adapter and a simultaneous-load bench per engine,
Apple signing and notarization, an upgrade and rollback proof per
release, and support for people who are not the household. That is
release engineering for a public runtime, done by one owner and a
coordinator, on top of Home, which is the product that actually has a
family waiting for it and which principle 7 says comes first.

## 4. What Home and Bot genuinely need

This is the part that survives, and it should be stated precisely so
that nothing needed is dropped with the product.

- **A role router** (`chat`, `embed`, `stt`, `tts`, `wakeword`, later
  the generators) so that Home's turn engine and Bot's dialogue loop
  never name a binary. Small, and already in `backend/src`.
- **A supervisor for spawned engines** with post-load identity checks
  and restart. Exists; Home's legacy `llmSupervisor.ts` and
  `ttsSupervisor.ts` were the source.
- **One residency budget** for the handful of processes *Home itself
  launches* on a 24 to 128 GB box: chat plus embed plus TTS plus STT
  plus wakeword must coexist, and a generator must queue. This is the
  one thing no field tool does across processes, and it is needed
  because a family hub cannot crash the chat when a kid asks for a
  picture. Exists as the in-memory governor.
- **Pinned, checksummed engine and model downloads** with a retained
  previous build for rollback. Exists for one llama-server pin and one
  GGUF.
- **Health as a list of problems with one fix each**, surfaced through
  Home's existing notification system (principle 7 already says the
  Stack's feed is bridged into Home's; if the Stack is inside Home, the
  bridge disappears).
- **The Linux/ARM shape for the robot**, which Lemonade, LocalAI and
  llama-swap all also have, so the robot is not the argument for
  building it ourselves.

What Home does *not* need: an operator login separate from its own
admin, per-client API keys (Home's packages are the clients, and the
package manifest already declares what a package may reach), a model
showroom with Hugging Face search, a Try-it studio, a documentation
library with Pagefind, a command palette, Telegram and ntfy channels of
its own, a tray app, or a public release cadence.

## 5. Options

**A. Fold the engine layer back into Home, stop the product.**
Move `backend/src/lib/{router,governor,supervisor,store,health,
identity,checkMyStack}` and the engine and model catalogs into
`home/backend/src/lib/engine/` as the hub's engine layer (which is
where the 2026-09-17 decision took them from). Home's admin gets one
"Engines" settings page drawn from the same declaration everything
else uses. The Stack repo is archived with a pointer, the console,
docs site, tray, library, palette and channels are dropped, and the
STACK-14 Studio bench becomes a Home bench. Nothing the family needs is
lost; the second UI, second docs and second update feed are. Bot gets
the same layer by the existing rule (hub first, robot for parity).
This is the recommendation.

**B. Keep the Stack as a private daemon with no product surface.**
Same code, its own process and port, because a separate process
survives a Home crash and can be shared by Bot on the same box. Keep
`/v1/*` and `/stack/v1/*`, a health endpoint and a JSON status page;
delete the React console, the docs site, the tray, the library, the
palette and the channels. No public release; Home's installer installs
it. This costs a service boundary and an events bridge that option A
does not, and buys process isolation. Worth it only if a live bench
shows Home's Bun process and the engine layer must not share a crash
domain; that has not been measured.

**C. Adopt an existing runtime under Home.** Have Home spawn and talk
to llama-swap (for the router and supervisor) or Lemonade (for the
service, STT, TTS and image in one binary), and keep only the residency
budget and the provenance pins in Home. **Inference:** llama-swap
replaces about two of the six needs in section 4 cleanly and is a
single Go binary with no telemetry, which fits the org's prebuilt-over-
hand-built rule. Lemonade replaces four but is a Python service with
AMD's priorities. Neither gives cross-process admission, which Home
would still own. This is a good second step after A, decided by the
Studio bench, not before it.

**D. Continue as a public product.** Only justified if there is a
reason to want users who are not the household: a business, a
community, or a distribution channel for Home. None has been stated,
and the product review's "watch three clean-install users reach a
first answer" gate has no candidates. If the owner does want this,
the honest scope is the narrowed one from 2026-09-18 (Mac, chat, one
engine, one address) and the honest comparison in the README is
against Msty Nexus and Lemonade, not against "doing it yourself".

## 6. Where the earlier reviews were right and where they stopped short

Both earlier reviews said "continue building, narrow the claim". They
were right about feasibility and right about the claim. They stopped
short on necessity because the question they were given assumed the
product: "is the plan good" and "can the machinery be built". Neither
asked whether Home is better served by the engine layer as a module
than as a sibling product, and neither had Msty Nexus in the table
(the 2026-09-17 survey has Msty's older Studio only; Nexus, announced
2026-06-11, is the same pitch as the Stack).

The one argument for the product that still stands is privacy: every
open runtime in the table is either silent on telemetry or has a
telemetry section, LM Studio phones home, and Ollama now asks people to
sign in. "A local runtime that provably never phones home" is a real
value. It is also exactly what Home already promises, on the same page
(`docs/user/privacy.md`), for the same process, so it is not lost by
folding the layer into Home; it is lost only by option C with the
wrong runtime, which the privacy page rule would catch.

## 7. Decision for the owner

This is a go/no-go and it is his call. The recommendation is **option
A: stop the standalone product, keep the engine layer, move it under
Home, archive the repo.** If he wants a process boundary for the robot's
sake, option B, with the same deletions. If he wants a public product,
option D with the narrowed claim and a stated reason for wanting
strangers as users.

What happens on a yes to A, in order: a decision entry in
`.github/docs/DECISIONS.md` reversing the 2026-09-17 one; a migration
item in `home/docs/BACKLOG.md` that moves the six pieces in section 4
with their tests; the Studio bench (STACK-14) re-homed as a Home bench;
this repo's README rewritten to a two-paragraph pointer and the repo
archived on GitHub. The dirty tree in this checkout (three console
files and the new pane container) is console work and would be
discarded, not committed.
