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

## Not built yet

The resolver does not read a stored pick when a job picks its model; Home still sends the model today. The admin page and Home views, the shared page component and the spec shapes follow (plan: `docs/plans/shared-ai-models-page-2026-11-21.md`).
