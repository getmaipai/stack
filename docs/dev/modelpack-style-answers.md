# MODELPACK-HOME-04, Stack side: answers to Home's style-base gaps

Home's gaps are in Home's `docs/dev/modelpack-gaps.md`, section MODELPACK-HOME-04. This is where each one stands in the Stack, against `@maipai/spec` `spec-v0.1.427`.

Nothing here is landed or pushed. These commits are in a worktree only.

## Done

| Gap | Answer | Where |
|---|---|---|
| 1. No pack has any style bases | The two video packs that serve the 2.5 base now carry `style_bases`: the 2.5 base, and the retired 2.3 base with `retired` set. The data is copied from Home's `backend/src/lib/loras/baseFamilies.ts` and Home deletes its copy later: Home's plain `words` is the pack's `label`, Home's `short` is `short`, the family's media is `media`, Home's Civitai `labels` are `civitai_labels`, Home's regular expressions are `text_patterns` as their source text (matched against lower-case text, as Home does), Home's browse value is `browse` (a one-item list), and the family's generic labels are `generic_labels` on both bases. | `packs/*/model-pack.json` (the two video packs) |
| 2. The spec shape is smaller | spec-v0.1.427 added the missing fields to `style_bases`: `short`, `media`, `civitai_labels`, `text_patterns`, `generic_labels` and, on a retired base, `retired.tested_on` and `retired.marks`. The retired base's `mark` names the field the bench mark lives in (`tested_on_25`), `tested_on` is the base it is judged on, and `marks.tested` and `marks.no_effect` say in words what each mark means. "Installable" is answered by presence: a base is listed when a pack that serves the job lists it, and a retired base is not listed. | `packs/*/model-pack.json` |
| The catalog serves them | `styles.bases` on a jobs catalog entry now carries every field the spec's catalog base allows (`id`, `label`, `short`, `media`, `civitai_labels`, `text_patterns`, `generic_labels`), not just `id` and `label`. A retired base is left out, and `browse` stays the pack's own business, as the spec says. The entry is the serving pack's list: a job whose pack lists none still answers `{ bases: [], max: 0 }`. | `lib/jobsCatalog.ts` |
| `styles[]` on `picture` and `clip` | It did not reach dispatch. It now does: each id becomes an entry of `loras` (`{ id }`) on the picture route and the video route, which check the file's base against the part and refuse a style the part cannot run, with their own plain line. No `styles` sends no `loras`. The ids are the household's style library ids, the same ones the routes already take. `picture_edit` also has a `styles[]` field in the spec; its route takes no styles, so it is left unwired. | `lib/makeDispatch.ts` (`pictureBody`, `clipBody`) |

Tests, written to fail first: `tests/styleBases.test.ts` (the pack data against Home's values, a name read the way Home's table reads it, the catalog's entry, an empty list for a job with no bases, `loras` on both routes).

## Not done, and why

- **The picture bases are not filled.** The picture styles Home browses are for three picture parts (three families in Home's table). None of them has a pack in `backend/src/packs/`, and the one picture pack that serves the job today belongs to a part whose route refuses styles (`unsupported_lora`), so listing a base on it would say something false. Adding a pack needs that part's measured limits, shapes and peak, and would make the make door start routing pictures to it; those values are not Home's to supply and were not guessed. Until those packs exist, the `picture` entry's `styles.bases` stays empty and Home keeps its picture rows.
- **The video base list is per pack, not per part that can run styles.** Both video packs list the bases, but today only the larger video part runs styles at all (the profile reports `loras.supported` false for the other). The catalog entry names the part that would serve the job now, so a caller may see the bases while that part cannot apply one. `styles.max` stays 0 for the same reason: the Stack has no per-job maximum it can state for a job whose parts differ. Gap 3 of Home's note (the retired-base bench mark living on the LoRA files, not on the pack) is answered in the data (`retired.mark`, `marks`) but the Stack's LoRA routes still carry `tested_on_25` on each file; that does not change.
- **Wan** has a row in Home's table with an unconfirmed label and no pack serves it, so it is not listed.

## What Home must pin

- `@maipai/spec`: `spec-v0.1.427`.
- Stack: the commits "the video packs list their style bases and the jobs catalog serves them in full" and "a picture's and a clip's styles reach the old routes as loras", `719e8b5` and `211ba31` in this worktree, plus the docs commit on top. Not on `main`, not tagged. The sha Home pins is the one `bash scripts/wt.sh land` puts on `main`; check it with `git branch -r --contains <sha>`.
- Home's Stack on the hub has none of this until the Stack ships.
