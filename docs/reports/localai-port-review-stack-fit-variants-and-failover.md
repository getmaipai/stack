# LocalAI port review: Stack fit, variants and failover

## Summary

- Reviewed `f665c5f7`, `841a10ab`, `c4c0721f`, `7fe46811`, `303893e2`, and `2074d173`, their adjacent tests, and current production call sites.
- Verified one medium defect in fit wording; the standalone failover chooser has unsafe unknown-health behavior, and the variant pin bypasses support/fit checks.
- Fit UI is otherwise wired; variant selection and failover remain incomplete as their backlog rows state.

## Defects

### MEDIUM

**BS-1 - `f665c5f7d7d61a4da9b1757a5a02cecbde86b17` - `admin-ui/src/fitCell.ts:24`**

When a planner row is `unavailable` but has a known peak and a reason, `fitCell` returns null. The planner creates such rows when no generator slot fits (`backend/src/lib/profilePlanner.ts:209`) or when a tier marks a role unavailable (`:213`). `PlanTable` then shows the refusal and reason but omits the row's need and headroom, despite the row having enough data to calculate them. Example: an image model peak exceeds the machine's cap; the UI says no image fits but never says the amount needed or how far over it is.

**Fix:** allow unavailable rows with a non-null peak through `fitCell`; compute overage against available room/cap consistently, and keep rows with no known peak blank. Preserve the planner's refusal reason.

**Failing test:** pass an unavailable/refused role with a peak larger than `budget.room_bytes`; assert the cell names the need and overage. Also render a no-slot planner row and assert the estimate appears.

### LOW

**BS-2 - `841a10ab09f9d9b8f6ceed1255efc4d851f460c4` - `backend/src/lib/variantSelect.ts:28-33`**

A matching `pin` returns before supported-engine and size checks. For example, a pinned variant on an unsupported engine, or one larger than `roomBytes`, is returned as the chosen variant with reason `pinned`. The comment explicitly makes this behavior intentional, but it conflicts with this selector's stated “filters by engine” and “known size fits” purpose. The production recommendation currently supplies no pin, so this is a defect in the exported selector contract, not an observed production route failure.

**Fix:** validate a pin against supported engines and report its fit state; make an over-budget/unsupported pin explicit or reject it rather than presenting it as a usable choice.

**Failing test:** pin an unsupported variant and an over-budget variant separately; assert neither is reported as a normal serving choice or `fits`.

**BS-3 - `2074d173d7efa149d7b4f0a4846ff0c84e1f57fc` - `backend/src/lib/failoverChoice.ts:25-33`**

Missing or `unknown` health is treated as usable. If the primary has failed before a health probe completes, a fallback with absent health is selected and reported as serving. The existing test at `backend/tests/failoverChoice.test.ts:33-34` locks in this behavior. A failover mechanism should not claim a candidate is healthy when its state is unknown.

**Fix:** accept only `healthy` candidates (or represent “not yet checked” separately and defer failover); preserve unknown candidates in the result as skipped with an explicit reason.

**Failing test:** mark the primary unhealthy and leave the fallback health missing/unknown; assert it is not selected and no success notice is emitted. Retain a separate test for a healthy fallback.

## Unwired or dead

- `backend/src/lib/failoverChoice.ts` / `chooseServing` is only imported by its unit test; no production caller exists. The failover policy therefore cannot change a request route or supervisor behavior.
- `backend/src/lib/variantSelect.ts` is called by `variantRecommend.ts`, so it is wired into the multi-file model-inspection refusal only. It is not used by model import, planner selection, download, or engine launch; variants are not automatically selected for installation.
- `parseGgufFilename` and `groupShards` are production-called by `hf.ts`; the importer now returns variant metadata. `HfVariant.projector` is recorded but not consumed by model inspection or installation.
- `ggufVariants` accepts `_repoId` but does not use it; harmless unused parameter.

## Rows whose status is untrue

- **STACK-FIT-UI-01:** The row says every model row shows need and free/over memory. The implementation omits the fit cell whenever `state` is `unavailable`, including rows with a known refusal reason (BS-1). Marking it built overstates this case.
- **STACK-VARIANT-FIT-01:** The row remains open and accurately says the selector is not wired into planner/import selection. Current code has since wired variant metadata into HF resolution and a recommendation into the multi-file refusal, so the status text is stale: importer grouping is partly wired; automatic fit-aware choice is still absent. Projector pairing is metadata only, not an installed component.
- **STACK-FAILOVER-01:** The row remains open and accurately says no supervisor integration, role fallback setting, or health notice exists. No status correction needed.

## Scope notes

- `docs/design/RULES.md` and `docs/plans/localai-port-plan-2026-11-27.md` are absent from this checkout; `AGENTS.md` points to no Stack-local equivalent. The relevant Stack rules and row descriptions were read in `AGENTS.md` and `docs/BACKLOG.md`.
- No tests were run, per the read-only review brief.
