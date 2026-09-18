# Can we build the machinery under MaiPai Stack?

2026-09-18. This is a feasibility judgment for one owner, a coordinator,
and two coding lanes. It is a code and documentation review, not a release
test. **Verified** means checked in the cited project documentation or
this checkout today. **Inference** means a design judgment from those
facts. Time ranges are engineering estimates for this team, not promises;
they exclude waiting for downloads, signing credentials, external review,
and the live Mac and robot trials. The product review is
[`stack-product-review-2026-09-18.md`](stack-product-review-2026-09-18.md).

## Decision boundary

**Build a dependable Mac service for one curated chat setup first.** Its
model and engine must have immutable pins, verified bytes, a measured
footprint, a real answer, a visible failure, and a way back after an update.
The Stack can grow from that working path. A promise to install and govern
any model and any engine on any machine would be a continuing compatibility
program, not a v0.1.0 feature. The existing single chat pin and single
verified Mac engine pin make the narrow path credible
(`backend/src/lib/modelCatalog.ts`, `backend/src/lib/engineCatalog.ts`).

The four verdicts below judge the *bounded* mechanism unless the section
says otherwise. A component can exist in code without passing the release
claim. In particular, the live walk in `docs/dev.md` proves a real chat
response on one Mac; it does not prove a clean install, a signed update, or
multi-engine operation.

## 1. Model URLs and metadata

**Source of truth and stability.** **Verified:** Hugging Face supplies repo
revisions, file lists and downloads through its [Hub API and official JS
client](https://huggingface.co/docs/huggingface.js/main/hub/README). A
branch such as `main` is mutable; the [Hub cache](https://huggingface.co/docs/hub/local-cache)
maps it to a commit and stores files under that commit. Hub cache ETags can
be SHA-1 for Git files or SHA-256 for LFS files, so a blob name is not a
universal SHA-256 proof. [Gated models](https://huggingface.co/docs/hub/models-gated)
require a person's own access and can be revoked. Repository metadata is
an upstream report, not our licence or role approval. Hub availability,
redirect hosts, authors' file names and cards are outside our control.

**Current code.** The signed Catalog is described in `docs/dev.md` under
"The model store and provenance"; the local starter is a hard-coded GGUF
URL, SHA-256 and licence but still says revision `main`
(`backend/src/lib/modelCatalog.ts`). The endpoint can be changed
(`backend/src/lib/hf.ts`, `backend/src/settings/stackKeys.ts`); its search
returns repo-level hits with null licence, null digest, no files and
`revision: "main"` (`backend/src/routes/catalog.ts`). Model pull refuses
missing URL, SHA-256, licence or revision (`backend/src/routes/models.ts`),
which is a useful safety boundary. The Hub cache-shaped store and imports
are in `backend/src/lib/store/`; STACK-80 and STACK-81 in
`docs/BACKLOG.md` already name the missing metadata and downloader proof.

**Household failures.** A GGUF repo can hold many quants or shards; choosing
the repo URL downloads no specific runnable file. `main` can change
between discovery and transfer. A card can omit or misstate licence,
ability and required files. A gated file can return 401 or 403 after a
successful search. A selected mirror can be stale. Low disk or a broken
redirect can interrupt a large pull. Show each as a specific result, keep
the old verified model, and never mark an unknown candidate installable.

**Field handling.** **Verified:** [LM Studio's downloader](https://lmstudio.ai/docs/developer/rest/download)
accepts exact Hub links and a quantization choice, with a download job;
its [CLI](https://lmstudio.ai/docs/cli/local-models/get) exposes GGUF and
MLX filters. This is the right level of choice to reuse, not evidence that
every Hub repo has complete metadata. **Cost:** roughly one to two weeks
for selected-repo resolution, supported GGUF file selection, licence and
gating states, immutable revision and digest capture, plus a live pinned
pull. Each new model format or modality adds qualification work.

**Verdict: achievable with a bounded design.** Hub is the upstream file
source and discovery service. MaiPai Catalog should be the only source of
*promised* starter models: a small signed index of revision, exact file
set, checksums, tested engine, measured fit and licence decision. Do not
mirror model weights by default; the configured Hub endpoint or an
operator-chosen mirror supplies bytes, which are verified locally. General
Hub search is optional exploration and never a fit or install promise.

## 2. Engine builds

**Source of truth and stability.** **Verified:** [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases)
publish platform-specific nightly assets; its [release document](https://github.com/ggml-org/llama.cpp/blob/master/docs/release.md)
says semantic version tags do not currently carry GitHub release binaries.
The GitHub [release API](https://docs.github.com/en/rest/releases/releases)
reports asset names and SHA-256 digests. Asset names, supported GPU builds
and cadence can change. **Verified:** [mlx-serve](https://github.com/ddalcu/mlx-serve)
now ships a signed Mac app and a Homebrew server for macOS 26.2 or later;
its [build guide](https://github.com/ddalcu/mlx-serve/blob/main/docs/building.md)
pins a more complex native toolchain. **Verified:**
[ComfyUI Desktop](https://github.com/Comfy-Org/desktop) manages Python
dependencies and its own updates. These are different release contracts.

**Current code.** `backend/src/lib/engineCatalog.ts` pins one verified
macOS arm64 llama-server archive by exact URL and SHA-256; its Windows CUDA
pin is explicitly unverified. `backend/src/lib/engineInstall.ts` installs
an archive and checks readiness. `docs/dev.md` "Updates" describes
`nightly-tag.txt` and GitHub digest comparison, but
`backend/src/updates/engines.ts` currently extracts `bNNNN` from text and
swaps an already installed tag. The semver-to-nightly resolution and live
qualification are design intent, not a working update feed. No pinned
mlx-serve or ComfyUI package is in `backend/src/lib/engineCatalog.ts`.

**Household failures.** A renamed, withdrawn or wrong-architecture asset
fails to install; a checksum catches altered bytes but not a binary that
starts and then fails the chosen model. CUDA runtime and macOS minimum
version matter. A nightly can regress speed or memory while returning
`/health`. A ComfyUI node or Python dependency update can break a workflow
without changing the host's health endpoint.

**Field handling.** llama.cpp publishes builds and attestations; mlx-serve
ships its own app and Homebrew path; ComfyUI Desktop updates its own runtime
(sources above). **Inference:** each project is better placed to build its
engine than MaiPai. **Cost:** about one week to qualify and publish one
new llama-server Mac pin with digest, launch, model completion and rollback
proof; budget more for each OS/GPU matrix cell. Owning a cross-platform
mirror and rebuild farm would be a separate ongoing job.

**Verdict: achievable with a bounded design.** Pin and verify approved
upstream assets, retain the previous build, and qualify before adding a
Catalog record. Do not promise a daily upstream tag. Mirror our own
release metadata and, only if upstream retention or availability actually
fails, pinned binary bytes that distribution rights allow. Run mlx-serve
and ComfyUI first as separately installed managed hosts; do not silently
take over their updaters.

## 3. Update notices

**Source of truth and stability.** Our release process must publish the
three Stack manifests. Upstream GitHub tags and Hub commits are signals,
not instructions to install. ETags and conditional GET save bandwidth but
do not make a stale or missing manifest correct. A model pinned to a commit
does not change when a branch moves; the notice compares the new branch
head with the installed commit. This is a design inference from the Hub's
[revision cache](https://huggingface.co/docs/hub/local-cache) and the
GitHub [release API](https://docs.github.com/en/rest/releases/releases).

**Current code.** `backend/src/updates/manifests.ts` defines app, engine
and model URLs and a target shape with signature and digest;
`backend/src/updates/check.ts` performs a conditional GET and records
`available`, notes and last check. `backend/src/updates/app.ts` and
`backend/src/updates/models.ts` delegate to that same generic check.
`backend/src/updates/models.ts` does not yet watch each installed Hub
revision. `backend/src/updates/check.ts` parses a signature field but does
not verify it or prove a newer version before presenting `available`.
`docs/dev.md` "Updates" specifies a weekly revision watch, and
RELEASE-STACK-01 in `docs/BACKLOG.md` still has to publish the manifests.

**Household failures.** An unpublished manifest leaves a false "current"
badge. A cached 304 can hide a removed asset. A moved Hub branch can be
reported as an available revision even if its licence, file set or fit
changed. A notice without the installed version, check time and undo path
is not actionable. Engine updates need a real post-swap check beyond an
available tag.

**Field handling.** **Verified:** [Tauri's updater](https://v2.tauri.app/plugin/updater/)
requires a signature and supports a static JSON feed. **Verified:**
[mlx-serve](https://github.com/ddalcu/mlx-serve) uses GitHub releases for
its app update and Homebrew for its CLI. **Cost:** three to five days for a
signed, tested feed and honest badge states after the release builder
exists; another several days for per-model revision watch and changed
metadata review. Each release still needs human qualification.

**Verdict: achievable with a bounded design.** A notice should say "last
checked at", installed and available revisions, what changes, size, and
"Go back" where a rollback is supported. A failed or stale check says
"could not check", never "current". Do not auto-apply model revisions.

## 4. Automated install and upgrade

**Source of truth and stability.** **Verified:** Apple requires Developer
ID signing and notarization for direct Mac distribution; Gatekeeper can
still expose signing errors, so [Apple says to test the delivered
artifact](https://developer.apple.com/documentation/Security/notarizing-macos-software-before-distribution).
[Tauri](https://tauri.app/distribute/) supports a `.dmg` and signing, and
its [updater](https://v2.tauri.app/plugin/updater/) produces a signed Mac
app archive. macOS, launchd, Tauri and Bun versions are moving inputs.
Linux service management is a distinct target, not the Mac installer with
a different file name.

**Current code.** `installer/install.sh` downloads a daemon and a
`SHA256SUMS` from the same release URL, checks the digest, installs a
LaunchAgent and waits for `/healthz`. It has no independent signature
check and no atomic replacement of an installed daemon. The LaunchAgent
writer and launchctl actions exist in `backend/src/service/launchd.ts`.
The app has a Tauri shell (`desktop/src-tauri/tauri.conf.json`,
`desktop/src-tauri/src/main.rs`), but its bundle config does not list the
daemon sidecar. STACK-66, STACK-84 and RELEASE-STACK-01 in
`docs/BACKLOG.md` cover lifecycle, compatibility and release work.

**Household failures.** A fresh app may lack its daemon; an app update can
ship a console that speaks a newer API than a still-running daemon. A
replaced executable can fail Gatekeeper or launchd while the old process
keeps answering `/healthz`. A failed upgrade can strand a service until
restart. A one-line command cannot create a trusted first checksum if it
trusts the script and checksum file from the same mutable location.

**Field handling.** **Verified:** Tauri supplies installer and signed
updater tooling, while Apple supplies signing and notarization verification
(sources above). **Inference:** use those tools rather than building an
updater. **Cost:** roughly two to four weeks for a reproducible Mac
release, sidecar and LaunchAgent handoff, signing, notarization, clean
user test, upgrade and uninstall. Much of that is test and repair time.
Linux ARM needs its own service, packaging and hardware proof later.

**Verdict: achievable with a bounded design.** Treat app and daemon as
one compatibility unit. Stage both, verify signature and checksum,
install, restart, call the real role, and keep the previous unit until
that passes. Offer the command-line daemon path to developers. Release
the `.dmg` as the parent path only after its fresh-account walk passes.

## 5. Knowing whether it works

**Source of truth and stability.** There is no upstream status page for
this household. The source of truth is a recent local request through
the same role route a client uses, against the declared engine build and
model revision. Process health, loaded status and request readiness are
different claims. This is a local design decision.

**Current code.** `backend/src/lib/supervisor.ts` has post-load completion
and state; `backend/src/lib/identity.ts` reads engine health and identity
and adds response headers. `backend/src/lib/health.ts` keeps durable
problem items. `backend/src/lib/checkMyStack.ts` requests installed or
ready roles, records time and result, and can sample memory during a
generator. `backend/src/routes/check.ts` exposes a running state and the
latest run. However `backend/src/lib/checkMyStack.ts` marks non-chat roles
as skipped when there is no injected request handler, accepts skipped
roles in the overall `ok`, and its default fit-together path makes a
second chat request without starting a generator or sampling a multi-host
load. This is a false-green risk for a broad "all abilities work" badge.

**Household failures.** A PID and HTTP health endpoint stay up while a
model is missing, a first token times out, a role key is refused, a
workflow lacks a node, or concurrent work exceeds memory. A stale last
check can look green after a model or engine change. An external host can
report an identity that Stack cannot verify. Status must show declared,
installed, loaded, ready, checked-at and failure reason separately.

**Field handling.** **Verified:** [Ollama's API](https://docs.ollama.com/api/introduction)
lets clients make the real generation request; [LM Studio's headless
service](https://lmstudio.ai/docs/developer/core/headless) exposes an API
for the same purpose. **Inference:** an API response proves one request,
not future availability. **Cost:** about one week to make the chat release
status honest, including authentication and stale timestamps; each added
role needs a real probe, expected output and failure fixture. Concurrent
fit proof requires a separate live bench.

**Verdict: achievable with a bounded design.** For v0.1.0, make "ready"
mean a recent authenticated chat request passed through the public route
with the expected engine and model identity. Show "not checked" or
"checked before this change" when appropriate. Keep non-chat roles out
of the ready count until their own wire has a real check.

## 6. Sizing before download

**Source of truth and stability.** File bytes, GGUF metadata, hardware
memory and free disk are measurable. Resident memory and speed depend on
context, batch, engine build, concurrent models and other apps; a profile
tier is a proposal, not a guarantee. **Verified:** [LM Studio's CLI](https://beta.lmstudio.ai/docs/cli/load)
has an estimate-only load; its [model discovery](https://lmstudio.ai/docs/bionic/models/download-local-models)
labels device fit. **Verified:** [Ollama's FAQ](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)
describes queuing when memory cannot hold another model. These tools
still rely on a load to establish actual performance.

**Current code.** `backend/src/profiles.ts` maps hardware memory to p16
through p128 and lists resident or on-demand roles and wide speed ranges.
`backend/src/routes/catalog.ts` uses tier order for
`runsOnThisComputer`; this does not check free memory or a selected GGUF
variant. `backend/src/lib/governor.ts` admits against file-size
multipliers or a measured peak and kernel pressure. `backend/src/lib/speedTest.ts`
runs `llama-bench` after install and stores throughput. The live result in
`docs/dev.md` is one machine and one chat model, not a tier calibration.

**Household failures.** A 16 GB machine can meet a tier and still lack
free RAM or disk. Context length and another loaded tool can turn a
previous fit into an out-of-memory failure. A model that fits may answer
too slowly to be useful. A new quant can change disk and memory needs.

**Field handling.** LM Studio shows a fit estimate and offers an
estimate-only load; Ollama admits work according to available memory
(sources above). **Cost:** several days for a conservative starter-model
preflight using exact file bytes and free disk, then about one to two
weeks of measured tier calibration across the Mac classes we claim.
Unseen hardware remains an estimate until loaded and timed.

**Verdict: achievable with a bounded design.** Before download say
"expected to fit" with disk bytes and a stated memory margin, or "we
cannot tell yet". After the first load, replace the estimate with peak
memory, load time and speed for that machine and context. Never promise
that a search result "runs on this computer" from tier alone.

## 7. Several engines, rollback and other stores

**Source of truth and stability.** The kernel reports memory pressure;
each owned process reports its build and model, if it exposes them.
Third-party stores and process protocols are private contracts that can
change without notice. **Verified:** [LM Studio](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)
has its own TTL and eviction, and [Ollama](https://github.com/ollama/ollama/blob/main/docs/faq.mdx)
queues model loads against available memory. Their decisions can race
with Stack's. There is no universal cross-engine residency API.

**Current code.** `backend/src/lib/governor.ts` has admission, a queue,
pressure samples, idle unload hooks and a run state. Its ledger is in
memory. `backend/src/updates/engines.ts` relinks the current engine tag
and offers drain and post-load hooks, but the generic update route
(`backend/src/routes/updates.ts`) calls it without either hook. The
engine-specific current route (`backend/src/routes/engines.ts`) supplies
hooks, yet its `postLoadCheck` returns true after `restartChatEngine()`
without directly checking the new identity there. `backend/src/lib/store/importScan.ts`
can scan Hugging Face, Ollama, mlx-serve, oMLX and LM Studio folders and
link or copy a selected file. `backend/src/lib/detect.ts` probes local
servers. Neither lets Stack safely control another app's memory or
guarantees a whole multi-file model import.

**Household failures.** Two engines can each believe memory is free and
load together. An external app can load outside Stack's ledger. A drain
can wait on a stuck request, and a generic swap can redirect new work to
an untested build. An imported file can be half of a shard set, be
deleted by its owner, or have unknown licence. Rewriting another tool's
store risks corrupting it.

**Field handling.** LM Studio and Ollama govern their *own* models;
[ComfyUI Desktop](https://github.com/Comfy-Org/desktop) manages its own
runtime. **Inference:** no existing tool supplies a trustworthy governor
for arbitrary independent processes. **Cost:** one to three weeks of
live Mac tuning for two *owned* processes and rollback, after the chat
path is stable; every extra engine needs an adapter and a simultaneous
load bench. Reliable control of arbitrary third-party servers and stores
has unbounded maintenance cost for this team.

**Verdict: nightmare, stop** for a universal residency, update and
adoption promise. The bounded replacement is achievable: govern only
Stack-launched processes; give detected servers an explicit, read-only
"use this host" path; import by verified copy or safe link after the
operator selects a complete model. A third-party host's own loader owns
its memory. A failure in its memory report must narrow Stack's claim,
not produce a green machine-wide budget.

## 8. Team and release shape

**Source of truth and stability.** The release evidence is the source:
offline fixtures, a built signed app, a clean user account, a real local
answer, a failed download, a restart and an update rollback. The upstream
projects above keep changing, so this evidence must be rerun for each
pin. `docs/BACKLOG.md` currently has app, trust and distribution work
before a Studio proof and Home migration; this is a sensible boundary.

**Current code.** The core service, one chat pin, model store, supervisor,
governor, health, checks, installer script and Tauri shell exist at
`backend/src/`, `installer/install.sh` and `desktop/src-tauri/`. The
unfinished release and proof items are STACK-66, STACK-74, STACK-79,
STACK-80, STACK-83, STACK-84 and RELEASE-STACK-01 in `docs/BACKLOG.md`.
The product review in `docs/plans/stack-product-review-2026-09-18.md`
rightly says the current catalog has one chat model and the generator
path is future work.

**Household failures.** Two coding lanes can create code and fixtures
faster than one owner can qualify upstream assets and observe clean
installs. A checklist with every modality and platform before first
release turns a working chat service into a permanently unreleased
product. A quick demo can hide the installer, auth, status and rollback
work that determines whether a household keeps it running.

**Field handling.** **Verified:** Tauri, Hugging Face, llama.cpp, LM
Studio and Ollama each own a bounded part of the stack (sources above).
**Inference:** borrowing their distribution, metadata and inference
primitives is the only plausible shape for this team. **Cost:** the
remaining Mac chat release is several focused weeks plus live acceptance
time, even with parallel coding. A broad cross-platform, multi-modal
compatibility service would require continuing release engineering and
support capacity well beyond two coding lanes.

**Verdict: achievable with a bounded design.** The coordinator should
enforce one qualified release path and refuse new engine or model families
until that path survives a clean install and rollback. The owner decides
which promises appear in public copy after seeing that evidence.

## Build order and calls

1. Qualify one immutable chat model and one llama-server Mac build, with
   exact bytes, licence, revision, disk check and conservative fit
   (STACK-86). Broader Hub search and downloader replacement (STACK-80
   and STACK-81) follow the proven starter path.
2. Finish app plus daemon installation and a first authenticated answer
   from a clean user account (STACK-66, STACK-76, STACK-79).
3. Make health and update states truthful: real role request, timestamps,
   signed release feed, staged app/daemon pair and rollback
   (STACK-87, RELEASE-STACK-01, STACK-84).
4. Run the Studio bench and clean-install trials (STACK-74, STACK-83).
   Only then widen the model list, add a second owned engine, or move Home.

Stop three promises now: arbitrary Hugging Face results labeled as runnable;
machine-wide memory control of other apps; and automatic multi-modal
installation before each engine, model and role wire has a live check.
Defer Linux robot distribution and a mirrored engine-build farm until the
Mac release and Studio profile have proof.

**Whole-program verdict:** a trustworthy, narrow Mac chat Stack is
achievable by this team; a universal local AI installer and manager is a
nightmare at v0.1.0 and must not be the release promise.

**Owner question, recommendation:** May v0.1.0 publicly promise only the
verified Mac chat service and one address for clients, while images,
voice, Linux and control of other tools wait for their own live proof?
Recommendation: yes. This is a release-scope decision for the owner; the
mechanism plan and backlog below assume that narrow promise.

**Owner question, recommendation:** Should MaiPai host copies of upstream
engine assets now? Recommendation: no. Publish signed metadata for the
exact upstream asset and digest, retain the previous installed build, and
add a mirror only after an observed retention or availability problem.
