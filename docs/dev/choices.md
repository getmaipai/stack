# Model choices

The Stack stores every model choice. Home and the admin page are two views over one API (owner decision, 2026-11-21; the Home half is `docs/plans/stack-owns-model-choices-2026-11-21.md` in `getmaipai/home`). The routes are documented in [integrations.md](../integrations.md); this page says where the values live and how a read is built.

## Where a choice is stored

All in `meta`, the key and value table the settings and the part order already use. There is no new database.

| Choice | Key | Shape |
|---|---|---|
| Model per hardware profile, category and level | `choices.picks` | `{ p128: { chat: { standard: { model, options? } } } }`; `model` may be `off` (a Reduced, Boost or Max level switched off) |
| Models added by link | `choices.added` | `{ <id>: { repo, file, url, revision, sha256, size_bytes, licence, ram_bytes, ... } }`; the file is an ordinary installed model |
| One-time import of Home's values | `choices.migration` | `{ done_at, accepted, refused }` |
| Order and off list | `parts.choices` | unchanged; `PUT /choices/{category}/order` merges one category into it |
| Role on or off and priority | `stack.roles.<role>.enabled`, `.priority` | unchanged settings; the read shows them, `POST /choices/recommended` writes them as `profiles/apply` does |

Who may use a level (people, audiences) is not stored here. Home keeps it.

## How the read is built

`lib/choices.ts` joins what already exists and decides nothing new:

- Candidates come from the tier table (`lib/tiers.ts`), plus the parts a single-model category names (speech to text, embeddings, vision, wake word, coding) and the added chat models. A tier-table model that is not a part yet (Chatterbox Nano) is listed as `unsupported`, with its words from `lib/candidateInfo.ts`.
- State, sizes, labels and summaries come from the parts list (`lib/partsList.ts`, adult audience); the pin's repo, licence, engine and quantization from the component declarations. `lib/candidateInfo.ts` is the one place that turns a raw quantization tag into plain words, derives the version, names the smallest profile and builds `search_text`.
- Fit is the tier table's decision (`tierCandidateLists`, `customPickRefusal`), judged against this computer's room. The recommended pick is the resolver's, skipping a model the adult list does not carry; `why` says in a sentence how it was chosen. `role_plan` is the profile planner's row for the role.
- A pick saved for this computer's profile is `household`. A pick that names a model no longer offered is shown as a `problem`, and the recommended model is `chosen` until it is fixed.

## Writes

- A pick is judged before anything is stored: category and level exist, the model is a candidate, it is offered for that level on the profile, it fits (this computer's own profile only; another profile is judged on being offered there), it is not unsupported, and it is installed or can start installing. A missing model starts downloading first, so a level is never set to something that cannot be had.
- A Standard voice pick sets `stack.voice.engine` (`lib/tierPick.ts`, shared with `PUT /tiers/choice`). A Standard chat pick sets `stack.engines.chat.model` once the model is installed.
- `POST /choices/recommended` calls `applyProfile` (`lib/profileApply.ts`, moved out of the profiles route unchanged) for the role switches and the plan's installs, then stores the recommended pick for every level.
- Unused means installed, removable, chosen at no level, not in a category's explicit order (unless switched off), required by no other part, and not bound to a role by this computer's setup. Removal judges each id again on fresh state and goes through the component uninstall (its own in-use and required guards apply); an added model is removed with its record and picks. `tidy: true` also runs the existing tidy.
- Every write is audited (`admin.action.choices.*`) with its source, `admin` or `home`.

## What runs (CHOICES-RESOLVE-01, 2026-11-21)

A stored choice is the model that runs. `lib/choiceResolver.ts` is the one definition of "which model does this level of this category use"; the choices read, the role view and every place the Stack starts a model ask it. It reads two small rows and the settings, probes nothing and starts nothing, so a Stack with picks stored still listens first (STACK-START-01; `tests/flashNextMode.test.ts` holds the test).

Precedence, in one place:

1. The session's "load this model" (`preferModel`). Every write to the choices clears it, so a stored choice is never shadowed by a stale one.
2. The household's pick for this computer's profile, category and level, when it is still offered here, is not switched off and fits.
3. The legacy setting Home's older builds write (`stack.engines.chat.model`, `stack.voice.engine`). It is mirrored into the Standard pick the moment it is written (`updateSettings` tells `mirrorSettingToPick`), and a pick written on the page writes the setting, so the two hold one value. A value that names no candidate, or an empty one (`auto`), clears the pick. Clearing a Standard pick (`model: recommended`) clears the setting too.
4. The category's order (`parts.choices`): the first listed model that is offered, fits and is not switched off.
5. The Stack's own recommended model (the tier table, or the profile's binding for a single-model category). A switched-off model is never chosen at any step; if every installed model of a role is switched off, the role keeps one rather than none.

Where each category takes it:

| Category and level | What reads the choice |
|---|---|
| Chat, judge and router, Standard | `selectedModel("chat")` (the supervisor). A running chat engine is swapped by the existing model load when the pick is made and the model is installed |
| Chat, Reduced | `reducedLightModel()`: the Reduced pick when installed and startable, else the profile's light model |
| Chat, Max (and coding mode) | `codingModeHeavy()` in `splashStore.ts`: Flash Next or Qwen3.8 27B with its draft; a pick that is not ready leaves the old rule. Other models are refused at the write (`not_runnable_at_level`), as are non-27B picks at Boost, which runs through the coding model |
| Coding, speech to text, embeddings, vision | `selectedModel(role)` |
| Voice, Standard | `activeTtsChoice()` takes the engine of the picked row; a voice that cannot start falls back to Pocket with the reason, so the role is never dead. Changing the pick restarts the voice engine when no request is running |
| Pictures and video | A request that names no model (or `image` / `video`) runs the level's chosen model when it is installed and fits; otherwise the model that ran before. A request that names a model keeps it. A level switched off answers 409 `level_off` |
| Music, stems, wake word | One model each; the choice and the answer are the same model |

A pick whose model is not installed (or does not fit) is saved, never loaded silently: the model that was answering keeps answering, and the role and the choices read say so in plain words (`running.reason`, `choice.reason`). A model that fails to start is rolled back by the model load and held there until the pick is made again. Reduced voice is recorded but the Stack does not run a smaller voice by itself; the row says so. Options stored with a pick (`customization`) are recorded and shown, and are not applied by the Stack yet.

Both views come from `lib/choiceRuntime.ts` (`runningFor`): every level row has `running { active, model, answering, reason }`, and every role in `GET /stack/v1/roles` has `choice { category, level, chosen, chosen_by, model, answering, reason }` for the level in use (chat is Standard, Reduced while swapped down, Max in coding mode). `tests/choiceResolver.test.ts` asserts the two agree for every category.

## Views

The admin page renders `StackModelsPage` from `@maipai/ui` (STACK-MODELS-PAGE-02). `admin-ui/src/stackClient.ts` is its `StackClient`: one call per method over same-origin `/stack/v1/*` through `api.ts` (cookie, CSRF header), with the Stack's own sentence and code on a refusal. The Helper's `get_models` and the top-bar search read the same `GET /choices`. Home's view (its `/api/ai/*` forwarder) and the spec-shape generation check are still to come (plan: `docs/plans/shared-ai-models-page-2026-11-21.md`).
