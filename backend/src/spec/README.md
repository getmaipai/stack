# The Stack's wire shapes (moving to `shared/spec`)

The shapes Home builds against, declared once and defined nowhere else
in this backend: the role request and reply headers, the event feed
envelope with its ten ids, the health item, the settings declaration
(a `SettingsKey` from `home/spec` plus the Stack's value half), the
precious-state declaration, and the speech session's `SttWireEvent`
and `SttTranscribeResponse` (mirrors of `home/spec/voice/ts/sttTypes.ts`,
STACK-94b; the Stack adds nothing to them). Each is a JSON Schema 2020-12 file under
`schemas/` with the `$id` it will carry once moved, a hand-written Zod
mirror under `ts/` the backend imports, and fixtures under `fixtures/`
(`valid-*.json`, `invalid-*.json`). `backend/tests/spec.test.ts`
validates every fixture against both the schema (Ajv 2020) and the Zod
mirror and fails when they disagree, so the two cannot drift.

This folder is a temporary home in exactly `home/spec`'s shape so the
move to `shared/spec` at the refocus's step 0c is a copy, never a
translation; after the move the backend imports `@maipai/spec` and
this folder is deleted (BACKLOG.md, the refocus milestone).
