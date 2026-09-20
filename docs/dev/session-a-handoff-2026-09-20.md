# Session A hand-off, 2026-09-20 (Stack coder lane)

For the fresh session that takes the Stack lane on Sonnet. The
coordinator is the `COORDINATOR` session over cross-session messages
(address `uds:/tmp/cc-socks/53184.sock`; Session B, the Home lane, is
`uds:/tmp/cc-socks/65684.sock`); every item arrives from it and every
result goes back to it as `done <item>` with the commit hash, `git show
--stat HEAD`, each command's exit, and the review dispositions. Say
`ready` first and start only on its start message.

## Where the repo stands

`stack` `main` on origin is bf31d5d (the coordinator's Jev and YuE
note) on c73786f (STACK-93, mlx-serve as the second chat engine,
accepted), after a0f5fd5 (torch 2.13.0 and setuptools 84, the macOS 14
floor), a083ba5 (issue #7 closed), fa46457 (STACK-06e), edf1543
(STACK-13b), 6965a1c (13a), 456f420, 537c4a4, 38214d9 (the speech
roles), b8a25b1 (the bench protocol). All seven Dependabot alerts read
fixed. The dashboard artifact
(`https://claude.ai/code/artifact/68f69163-11ad-40ca-a272-9bc46759bbc2`)
is refreshed with the `status-dashboard` skill's `write_db` (pass
`if_version`; the stack area "Roles and the router" is at version 2,
the others at 1); "Speech roles" gets a refresh once 94d lands.

## STACK-94d, unfinished in the working tree

The item: the voice engine online only when needed. Pocket TTS runs
with `HF_HUB_OFFLINE=1` always; the Stack fetches, through its own
pinned and checksummed download path into the hub cache, exactly what
a request needs and does not have, before the engine uses it; the
only outbound calls are the Stack's declared downloads on an explicit
need, never on start; the privacy row says so. Tests asked for: no
request on start, a missing voice fetched once then served offline, a
request for a voice with no token refused with the reason.

`git status` as left (15 modified, 3 untracked, nothing staged):

- `backend/src/speech/voices.ts` (new): the module. The 26 preset
  voices pinned by name, size and sha256 at the embeddings revision
  `e81d79e8…` (`POCKET_TTS_PRESET_VOICES`, read from the hub's
  listing); the gated cloning weights pin
  (`POCKET_TTS_CLONING_WEIGHTS`, `kyutai/pocket-tts` at `39592ff…`,
  sha256 `473f47d9…`, 219,029,196 bytes); `VOICE_FOLDER_LICENCES` for
  `kyutai/tts-voices`, whose card declares no licence and whose
  README states each folder's; `prepareVoice(voiceUrl)` resolves a
  request's voice before the engine sees it (a preset name or its
  `hf://` spelling becomes the name once its embedding is installed
  as a voice component through `installCatalogModel`; an `hf://`
  community voice is resolved with `resolveHuggingFace` to a commit
  and the file's LFS digest, installed, and handed on as
  `hf://repo/path@commit`; an `http(s)://` voice passes only on a
  private host, Home's cloned voices; the rest refused); `ensureCloningWeights()`
  fetches the gated file once with the token as the Authorization
  header (false when no token); `voiceNeedsCloning`, `cloningWeightsPresent`,
  `ttsToken`, `voiceCloningOn`; `VoiceRefusedError` with `status` 400
  (`voice-not-pinnable`) or 409 (`voice-cloning-unavailable`);
  `__setVoiceOptionsForTests` (a downloader, a resolver, a preset
  table and a cloning pin stand-in for the suite).
- `backend/src/speech/pocketTts.ts`: `pocketTtsEnv()` sets
  `HF_HUB_OFFLINE=1` and strips `HF_TOKEN`, `HUGGING_FACE_HUB_TOKEN`
  and the old `HF_HUB_ETAG_TIMEOUT`; `loadedWeightsRepo()` lost its
  `tokenSet` option and reads the gated repository first when both
  snapshots are there (the engine's own order, offline).
- `backend/src/lib/supervisor.ts`: the tts launch plan uses
  `pocketTtsEnv()` with no token; `startSpawnedProcess` calls
  `ensureCloningWeights()` before admission when
  `voiceCloningOn()`, a failure raising the health item
  `voice-cloning-weights.tts` (fix restart_engine) and never
  stopping the start; the two `loadedWeightsRepo()` calls updated;
  the scripted engine's `/tts` accepts any preset name or `hf://`
  voice and answers its own 400 for anything else.
- `backend/src/routes/v1.ts`: the speech route calls `prepareVoice`
  then, for a cloning voice, `ensureCloningLoaded(role)` (fetch if
  possible, else 409; restart the engine when its identity model is
  not `kyutai/pocket-tts`), then `speakRole` with the prepared voice;
  `VoiceRefusedError`, `DownloadVerificationError` and
  `ProvenanceIncompleteError` mapped; `VoiceRefusedSchema` and the
  route's 400 and 409 declared as unions (openapi.json regenerates).
- `backend/src/settings.ts`: `stack.engines.tts.voice_cloning`
  (boolean, default false, section `engines.tts` order 25, level
  advanced, needs_restart); the token's comment says it never reaches
  the engine.
- `backend/src/lib/download.ts`: `DownloadOptions.headers` merged
  into the request (the token for the gated file).
- `backend/src/lib/hf.ts`: `resolveHuggingFace(repo, { revision })`.
- `backend/src/lib/privacy.ts`: the `tts-voices` row rewritten
  (fetched only on a request's need or once for the cloning weights;
  never on start; the token only for the cloning weights).
- `backend/src/lib/componentsDoc.ts`: a paragraph under tts listing
  what is fetched on demand (drawn from `voices.ts`);
  `docs/components.md` regenerated with it and with the ACE-Step row.
- `backend/src/lib/modelCatalog.ts`: `ROLE_CANDIDATES.music` gains
  ACE-Step 1.5 (STACK-99).
- `backend/tests/voices.test.ts` (new, 4 tests): the offline start
  with no fetch and no token in the plan's env; a preset fetched once
  then served offline (through `prepareVoice` and the route); the
  cloning voice refused with cloning off, then with no token, then
  fetched with the token, the engine restarted onto the weights, the
  second ask fetching nothing, the next start fetching nothing; the
  private-host and public-host URLs, the no-digest and no-licence
  refusals, the folder licences. `backend/tests/tts.test.ts`: three
  expectations updated (the Stack's own 400 for `nobody`, the engine's
  400 through `speakRole`; no `HF_TOKEN` and `HF_HUB_OFFLINE=1` in the
  env; the identity test without `tokenSet`).
- `scripts/prove-tts.sh`: step 4 samples the engine's sockets with
  `lsof` through the start (no outbound connection), step 6 refuses
  `nobody` and a public URL, 6b fetches `anna` once then serves it
  offline, 6c refuses the community voice with cloning off and then
  with no token, 6d (only with `HF_TOKEN` in the script's
  environment) sets the token, fetches the gated weights and the
  voice, restarts, renders, and asks again.
- `docs/dev.md`: "The voice engine online only when needed
  (STACK-94d, 2026-09-20)" after the tts live table, with the package
  facts, the design, the licences, the settings, and the live table;
  the 94c paragraph's "never run offline" sentence marked superseded.
  `docs/BACKLOG.md`: STACK-94d ticked under Speech roles, STACK-99
  added after 13b-live. `CHANGELOG.md`: an Added entry.
- `docs/dev/` (this note).

Done: `bunx tsc --noEmit` clean; `bun test tests/privacy.test.ts
tests/voices.test.ts tests/tts.test.ts` 19 pass; the whole suite was
315 pass before the components and candidates edits (both covered by
`componentsDoc.test.ts`, 3 pass). Two live runs of `prove-tts.sh`
(`KEEP_DATA=1`, the second with `HF_TOKEN`): the first proved the
offline start (no outbound socket, first byte 14.6 s), the refusals,
`anna` fetched once (first byte 2.26 s) then offline (8 ms), the two
409s; the second, under Session B's gate load, had the governor refuse
the engine at 3.1 GB free (pressure warn) through step 6b, and then
proved 6d: the gated weights and `casual.wav` fetched, the engine
restarted, `x-maipai-model: kyutai/pocket-tts` at `39592ff2…`, 2.28 s
of audio, first byte 23.8 s, the second ask 1.90 s (3.1.0 does not
cache an encoded voice). Those numbers are already in the dev.md
table.

Left, in order:

1. Wait for "gate slot free" from COORDINATOR.
2. `bash scripts/check.sh` from the repo root; if it exits 1 saying
   `openapi.json` or `components.md` was regenerated, read the diff
   and run it again; expect about 319 pass.
3. Optional but cheap once the slot is yours: `HF_TOKEN="$(cat
   ~/.cache/huggingface/token)" bash scripts/prove-tts.sh` for one
   clean transcript (the token stays in the shell for that run only);
   if steps 4 to 6b pass in the same run as 6d, replace the "two
   runs" sentence in the dev.md table's introduction with the one
   run's numbers.
4. `code-review medium /Users/jessetorres/Developer/github.com/getmaipai/stack`,
   one pass; fix the findings, re-review the fix hunks only, never a
   third pass.
5. Stage by name: the 15 modified files plus `backend/src/speech/voices.ts`,
   `backend/tests/voices.test.ts`, and `docs/api/openapi.json` if the
   gate regenerated it; `git diff --cached --stat`; commit with the
   message below; `git show --stat HEAD`.
6. `git pull --rebase` if behind, `git push origin main`.
7. Refresh the dashboard's stack "Speech roles" area (4 done, 0 open,
   green) with `write_db` and `if_version: 1`.
8. `done STACK-94d` to `uds:/tmp/cc-socks/53184.sock` with the hash,
   the stat, each command's exit, level medium, the pass count, and
   every disposition.

The commit message I planned:

```
The voice engine online only when needed (STACK-94d)

Pocket TTS runs with HF_HUB_OFFLINE=1 always and no token in its
environment. The Stack fetches, through its own pinned and
checksummed download path into the hub cache, exactly what a request
needs and does not have, before the engine uses it: a preset voice
(the 26 English embeddings pinned by name, revision and sha256), a
community voice as an hf:// path (resolved to a commit and the hub's
own digest, installed as a voice component, handed on pinned to that
commit), and the gated cloning weights (kyutai/pocket-tts at
39592ff…, sha256 pinned) once, with the token as the request's
Authorization header, when stack.engines.tts.voice_cloning is on and
a token is set, at the engine's start or the first cloning request,
after which the engine is restarted onto them. An http(s) voice
passes only on the household's own network (Home's cloned voices); a
voice that cannot be pinned, a repository or folder with no stated
licence, and cloning that is off or has no token are refused with
the reason before the engine (400 voice-not-pinnable, 409
voice-cloning-unavailable). The identity read keeps the engine's own
order, gated first. The privacy row says so.

Proven live (scripts/prove-tts.sh): no outbound socket through the
engine's start; anna fetched once (2.26 s first byte) then served
offline (8 ms); the community voice refused with cloning off and
with no token; with the operator's token the gated weights and the
voice fetched, the engine restarted, x-maipai-model kyutai/pocket-tts
at 39592ff2, 2.28 s of audio.

Also: STACK-99 (the music role on ACE-Step 1.5, the owner's pick)
filed in the backlog and ACE-Step listed as the music candidate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Rd9mTHwXRWuqgfNj1zw8Ba
```

(The fresh session replaces the two attribution lines with the ones
its own prompt gives.)

## The open Stack items, in the order I would take them

1. **13b-live (S)**: rerun `bash scripts/prove-image.sh` with about
   2 GB more free than the laptop had (the render needs 5.2 GB with
   the p16 margin of 4 GB) or on the Studio; docs only.
2. **STACK-75 (M)**: the Stack/Home contract test suite under
   `backend/tests/contract/`, every route in `integrations.md`'s
   tables, run from a sibling checkout with one command.
3. **STACK-99 (M)**: the music role on ACE-Step 1.5, a managed
   engine through the uv pattern behind the job API; mirror STACK-13b
   (`generators/comfyui.ts`, `lib/uvEnvironment.ts`, a hashed
   requirements file compiled here with `MACOSX_DEPLOYMENT_TARGET=14.0
   uv pip compile --generate-hashes`, the prove script pattern); the
   two clips measured on the Studio before the pin is final.
4. **STACK-14 (L)**: the Studio bench (`scripts/bench/studio-bench.sh`),
   mlx-serve beside llama-server on the one model both pins share.
5. **STACK-17 (L)**: the Linux ARM profile for the robot.

Not mine: STACK-06c (the governor lane; `governor.ts` and
`lib/memory/*` stayed untouched all day, keep it so unless the
coordinator says the lane is done), RF-05b (Session B), the HOME-STACK
items in `docs/plans/home-adoption-2026-09-20.md`.

## The gate slot rule

One gate or live proof on the machine at a time. The laptop has 24 GB
and Session B's Home gate was OOM-killed once today with everything
resident; the coordinator holds a memory slot and messages "gate slot
free". Do not start `scripts/check.sh`, a prove script, a bench or an
engine while the hold is on; editing and single-file `bun test
tests/<file>.test.ts` runs are fine. If a message arrives mid-gate,
let it finish and say so. The governor refuses an engine start at
under 4 GB free after the margin on this tier (p16), so a prove run
under a parallel load fails on the governor, not the code: rerun when
the slot is yours.

## The review budget

From the owner (2026-09-20, `.github` 32c38de): `code-review` at
level low for an S item or docs and config, medium for M or anything
touching a route, guard or wire shape; one pass per commit with the
explicit target path `/Users/jessetorres/Developer/github.com/getmaipai/stack`;
after fixes, re-review the fix hunks only; never a third pass (a
second pass still finding real defects is a finding about the item's
size, reported to the coordinator); a review whose subagents sit
"searching for" a tool or file for over a minute is stopped
(`TaskStop`) and rerun once with the target. The done report states
the level, the pass count and every disposition. STACK-93 took eight
passes before the rule arrived; the coordinator recorded the chunking
as its brief's miss.

## Facts a fresh session needs that the docs do not say

- The checkout is shared: the coordinator commits docs into the same
  working tree. Stage by name (`git add <file>`), read `git diff
  --cached --stat`, commit at once, never `git add -A`; `git pull
  --rebase` before a push when `git status -sb` says the branch is
  behind.
- The prove scripts (`scripts/prove-{stt,tts,image,mlx}.sh`,
  `scripts/prove-pin-rollback.sh`) run a daemon on port 8771 in a
  setsid process group with `data-scratch/` as its data directory,
  removed at the end unless `KEEP_DATA=1`; `PORT=` picks another port.
  The tests' scratch is `backend/data-test/run-<pid>` (git-ignored,
  swept when stale).
- `scripts/prove-tts.sh` step 6d (the cloning fetch) runs only with
  `HF_TOKEN` in the script's environment. Jesse's own token is at
  `~/.cache/huggingface/token`; export it for one run, never write it
  anywhere in the repo or a doc. It has access to the gated
  `kyutai/pocket-tts` (a 302 on the resolve URL), which is how the
  cloning weights' sha256 (`473f47d9…`) was read from the hub's listing.
- The installed Pocket TTS 3.1.0 source is readable at
  `~/.cache/uv/archive-v0/mO0EgXiewUgpdaNo/lib/python3.12/site-packages/pocket_tts/`
  (uv's archive of the wheel); `utils/utils.py` has the preset table
  and `download_if_necessary`, `models/tts_model.py` the weights
  fallback and the voice prompt path, `config/english.yaml` the pins.
  A filesystem-wide `find` for it takes minutes and was killed once;
  search under `~/.cache/uv` only.
- mlx-serve facts not in its docs: `--host` defaults to `0.0.0.0`
  (the Stack passes `127.0.0.1`); `/props` has no `build_info` or
  `model_path` (the Stack stamps the identity from the pin's tag and
  the model directory's name); it writes logs under `HOME`, which
  `managedEnv()` points under `data/`.
- `STACK_SCAN_ROOTS` is `:`-separated (issue #7's fix).
- Bun fires neither `exit` nor `beforeExit` for a test preload's
  handlers (measured with marker files), hence the in-repo scratch
  design with the stale sweep.
- The HF hub API hides LFS digests of a gated repository's files
  from an anonymous listing (`****`); with a token they are plain.
- `check.sh` fails the prose lint on an em dash, an exclamation
  point, or the filler words in `.github/docs/STYLE.md`; commit
  messages end with the two attribution lines the session prompt
  gives.
- The memory file for this lane is
  `~/.claude/projects/-Users-jessetorres-Developer-github-com-getmaipai-home/memory/session-a-stack-refocus-2026-09-20.md`;
  update it and `MEMORY.md` at each stop point.
