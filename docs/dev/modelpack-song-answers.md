# MODELPACK-HOME-05, Stack side: answers to Home's music gaps

Home's gaps are in Home's `docs/dev/modelpack-gaps.md`, section MODELPACK-HOME-05. This is where each one stands in the Stack.

Nothing here is landed or pushed. These commits are in a worktree only. The commons spec release `spec-v0.1.427` carries the fields the first version of this note waited for, and the Stack is pinned to it.

## Done in the Stack (no spec change needed)

| Gap | Answer | Where |
|---|---|---|
| 1. A level is picked after the part | A make request that names a `level` is planned among the parts whose pack serves that level. A song at `boost` or `max` is no longer refused because the standard part is first. The same holds for `song_edit` and every other job. | `lib/makePlan.ts` |
| 1. A level whose part is not ready | When some pack serves the level but no such part is turned on and ready (while another part is), the reply is `not_available` with: "No model that can make songs at max quality is turned on and ready." An adult's line adds "An admin can turn one on or add one in Settings, AI and models." A minor's line stops at the first sentence and names no model. A level no pack serves is still `level_not_served`. | `lib/makePlan.ts` |
| 1. Catalog levels | The catalog's `song` entry (and every job's entry) lists the levels of every part that serves the job, installed or not, with the longest length per level (for example `standard`, `boost`, `max`). The part named in the entry and the capabilities stay those of the part that would serve it now. Home can drop `max_model` and read the levels from here. | `lib/jobsCatalog.ts` |
| 5. `made_with` for songs and stems | Already true in the code: a song, a song edit and a split result each carry `made_with` (part id, label, pack version), both when done (200) and while running (202). A test now guards it. The spec still allows `null` for these jobs; closing that is part of the spec change below. | `tests/makeDispatch.test.ts` |

## Done on spec-v0.1.427 (gaps 2, 3 and 4)

| Gap | Answer | Where |
|---|---|---|
| Pin | `backend/package.json` and `SPEC_TAG` in `scripts/check.sh` name `spec-v0.1.427` (the gate carried a stale `spec-v0.1.412`; it now matches). `docs/api/openapi.json` was regenerated for the new request shapes. | `backend/package.json`, `scripts/check.sh` |
| 2. A song's `bpm`, `key`, `language` | They become words in the caption through the song pack's recipe. The recipe has three new blanks, `{bpm}`, `{key}` and `{language}`; a recipe line that holds one is dropped when the request left it empty, so a song without a tempo says nothing about one. The caption reads: the description, then the recipe lines, then the style words, joined by commas. No code names a model; each song pack's `recipes/song.md` owns the wording. The tempo is rounded to a whole number. | `lib/recipe.ts` (`fillRecipeLines`), `lib/makeDispatchAudio.ts` (`songBody`), `packs/*/recipes/song.md` |
| 2. A cover's description and lyrics | The description goes through the song-edit recipe into the caption (then the style words). The lyrics go to the music route's own `lyrics` field, the way a repaint's already did, not into the caption: the music route reads words to be sung from that field and styles from the caption, so lyrics in the caption would be read as style. The brief for this slice said "into the caption"; this is the safer reading, and it is one line in `songEditBody` if Home needs the other. A repaint's description now also goes through the recipe (same text out, since the recipe is just the description). | `lib/makeDispatchAudio.ts` (`songEditBody`) |
| 3. `wait` | Every JSON route the door forwards to (pictures, clips, songs, song edits, stems) gets `timeout_ms` set to `wait` in milliseconds. `wait: 0` becomes `timeout_ms: 1`, the shortest wait those routes take, so the door answers 202 with the job id after at most one poll step (50 ms) unless the job is already done. A request without `wait` is unchanged. The jobs that go through a form upload (picture edit, character and contact sheets, swap) do not take `wait` yet: a sheet is several pieces made one after another, and an answer at once for each piece would break the sheet. | `lib/makeDispatch.ts` (`withWait`), `routes/jobsMake.ts` |
| 4. `origin: "owned_file"` on stems | The stems request's `origin` is sent to `/v1/audio/stems` when present and left out otherwise (the route then treats the song as made here). | `lib/makeDispatchAudio.ts` (`dispatchStems`) |
| 5. `made_with` never null for songs and stems | The spec now types it so. The code already filled it; the test from the earlier commit now also parses the result with the new schema. | `tests/makeDispatch.test.ts` |

Tests, each written to fail first: `tests/makeDispatch.test.ts` (recipe blanks, the three song packs' captions, a song without the new fields keeps its caption, a cover's description and lyrics, stems `origin`, `withWait`, the door accepting the new fields).

## Still open

- Gap 3 also asked for the `lrc`, `bpm`, `key` and `seed` on the song result, or a poll route for make jobs. The spec 0.1.427 result does not add them, so Home keeps reading them from the music job poll at `/v1/audio/music/<id>`.
- The music route also takes `bpm`, `key` and `language` as their own fields. The door does not send them, as the brief asked for the caption; if the engine reads the fields better than the words, send both.

## What Home must pin

- `@maipai/spec`: `spec-v0.1.427` (Home may keep its own pin if it already has it).
- Stack: the commit that carries "the song door takes bpm, key, language, a cover's description and lyrics, wait and stems origin" and the style-base commits after it. In this worktree that is `211ba31` and the docs commit on top of it. These are not on `main` and not tagged; the sha Home pins is the one `bash scripts/wt.sh land` puts on `main`, which can differ from the worktree's after a rebase. Check with `git branch -r --contains <sha>` before pinning.
- Home's installed Stack matches this only after the Stack ships on the hub; nothing here is on the live hub.
