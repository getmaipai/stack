# MODELPACK-HOME-05, Stack side: answers to Home's music gaps

Home's gaps are in Home's `docs/dev/modelpack-gaps.md`, section MODELPACK-HOME-05. This is where each one stands in the Stack.

Nothing here is landed, tagged or pushed. These commits are in a worktree only.

## Done in the Stack (no spec change needed)

| Gap | Answer | Where |
|---|---|---|
| 1. A level is picked after the part | A make request that names a `level` is planned among the parts whose pack serves that level. A song at `boost` or `max` is no longer refused because the standard part is first. The same holds for `song_edit` and every other job. | `lib/makePlan.ts` |
| 1. A level whose part is not ready | When some pack serves the level but no such part is turned on and ready (while another part is), the reply is `not_available` with: "No model that can make songs at max quality is turned on and ready." An adult's line adds "An admin can turn one on or add one in Settings, AI and models." A minor's line stops at the first sentence and names no model. A level no pack serves is still `level_not_served`. | `lib/makePlan.ts` |
| 1. Catalog levels | The catalog's `song` entry (and every job's entry) lists the levels of every part that serves the job, installed or not, with the longest length per level (for example `standard`, `boost`, `max`). The part named in the entry and the capabilities stay those of the part that would serve it now. Home can drop `max_model` and read the levels from here. | `lib/jobsCatalog.ts` |
| 5. `made_with` for songs and stems | Already true in the code: a song, a song edit and a split result each carry `made_with` (part id, label, pack version), both when done (200) and while running (202). A test now guards it. The spec still allows `null` for these jobs; closing that is part of the spec change below. | `tests/makeDispatch.test.ts` |

## Not done: needs a commons spec change and a tag

Gaps 2, 3 and 4 add fields to `StackMakeRequest` (strict Zod, so Home's request is refused with a 400 until the spec has them). The worker that wrote this ran inside the Stack worktree only, and its rules forbid editing another worktree and creating a tag. So the commons change, its tag and the Stack pin were not made. Nothing was invented around it.

The spec change, in `spec/stack/ts/stack-make.ts` and `spec/schemas/stack-make-request.schema.json` and `stack-make-result.schema.json`, with fixtures, one commit, then a `spec-v0.1.425` tag:

- `song`: add `bpm` (positive number, optional), `key` (non-empty text, optional) and `language` (non-empty text, optional).
- `song_edit` cover: add `description` (text, optional) and `lyrics` (text, optional).
- Every request: add an optional `wait` (a short wait in seconds, at most the route's own default). Zero means "answer 202 with the job id at once". Additive only.
- `stems`: add `origin` (`"owned_file"`, optional).
- Result: `made_with` is not null for `song`, `song_edit` and `stems`.

Then in the Stack, after the pin moves (`backend/package.json` path and `SPEC_TAG` in `scripts/check.sh`, then `bun install --force` in `backend/`):

1. `makeDispatchAudio.ts` `songBody` / `songEditBody`: turn `bpm`, `key`, `language`, and a cover's description and lyrics into the caption the music route takes, through the pack's recipe (new blanks in `lib/recipe.ts` and the pack recipes), so Home never writes a model prompt.
2. `routes/jobsMake.ts`: pass `wait` through as the route's `timeout_ms`; a song with `wait: 0` returns 202 and the id at once.
3. `dispatchStems`: send `origin: "owned_file"` to `/v1/audio/stems` when the request has it.
4. Tests for each, written to fail first.

The installer files named in Home's memory note (`scripts/install.sh` and `maipai-engine`) do not exist in this repo, so there is no installer hash to add here.

## What Home must pin

Nothing new yet. Until the spec tag exists, Home keeps `spec-v0.1.424`. The planning and catalog fixes above need no new tag. They take effect when this Stack commit ships.
