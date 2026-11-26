# Model relationship map

Decided 2026-11-25. The Stack records what drives a model and what extends it, so a delete, move, tidy or upgrade shows its impact first.

## The problem

Links between parts lived only in scattered code: a pin's `engine` and `companions`, the projector in `imageInput`, `superseded_by`, a LoRA's `base_model`, and `tidy.ts` hard-coding one LoRA base. Nothing knew which data folder belongs to which engine. A cleanup could not tell that `data/splash` (19 GB) is the Splash engine's, and a move of hub-layout models lost files.

## Options weighed

| Option | For | Against |
|---|---|---|
| New table in `stack.db` | Queryable | A second copy of facts the catalog already states; it drifts when a pin changes, needs a migration and a backfill, and holds nothing per install that the pins plus the model store do not already say. |
| A new catalog rows file of links | One visible file | Same second copy of the pins' own links. |
| **Code that derives the graph from the rows that already say it, plus one small rows file for folder owners** | One definition, cannot drift, no migration, testable with plain data | Folder owners are the only new data. |

## Pick

Derive. `lib/relationships.ts` (pure) builds the links from pins and installed LoRAs and answers `impactOf(id, action)` for delete, move and upgrade. `rows/dataFolders.json` is the one new row file: each top-level data folder and its owner (the engine, the model store, a feature, or the Stack). `lib/relationshipsLive.ts` feeds it real state (what is installed, chosen or loaded).

Link kinds: `driven_by` (model to engine), `draft` and `vision` (base model to its extender; an extender also runs on the base's engine), `style` (LoRA to its base model), `replaced_by`.

## Rules

- **Blocking** (the action is refused): an installed, in-use model depends on the target. Deleting an engine's last build, deleting a draft or vision add-on of a model in use, moving a model that lives in the shared hub layout (moving the file alone breaks the engine's links).
- **Warnings** (said first, not refused): extenders that go with a delete or stay behind in a move, models restarted by an engine upgrade, styles made for a base.
- Wired into `uninstallComponent` (409 `in_use`), `planModelMove`, and engine build removal. `GET /stack/v1/choices/impact/{id}?action=delete|move|upgrade` reads the same answer without doing anything.
- `GET /stack/v1/choices/unused` now has `folders`: every top-level data folder with owner, size, what depends on it and plain advice (`splash` is labelled the Splash engine's).

## Adding a link

Say it in the row that already owns the fact (the pin, the LoRA record). A new data folder goes in `rows/dataFolders.json`; until it is there the report shows it with owner `null` and the advice to check before removing it.
