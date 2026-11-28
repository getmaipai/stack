# LocalAI port review: Stack engine safety

## Summary

Reviewed the nine requested commits and their backlog rows, implementation, tests, and touched docs.
Verified one medium-severity recovery defect in model updates; other reviewed areas have no verified defects.
No tests were run; this report is read-only review output and is not landed.

## Defects

### MEDIUM

- **AS-1** — commit `af39a88801407e3d68cfc4c5ffa68dab1b0eef82`; [backend/src/updates/models.ts](/Users/jessetorres/Developer/github.com/getmaipai/wt/stack-gentle-falcon-lai-review-a/backend/src/updates/models.ts:152). If the model update journal is malformed or a recovery operation throws, the catch ignores it and the unconditional `clearJournal(id)` deletes the only recovery record. State: interrupted update left a damaged journal and the current model record points to an incomplete new model, or recovery could not finish restoring it -> next boot forgets the transaction and can serve a missing or unverified model. **Fix:** validate the complete journal (including id, phase, managed destination and snapshot) before acting; only clear it after successful recovery, and retain/report an unreadable or failed journal for repair. **Failing test:** insert malformed JSON (and separately a journal whose cleanup throws) while the model record points to a partial destination; call recovery; assert the journal remains and the old valid model is restored or the role is blocked from serving.

## Unwired or dead

- `renderGauges` is called by the metrics route; the route is registered in `app.ts`. The backlog correctly says no scraper consumes the endpoint yet; that is deployment integration, not dead code.
- `captureEngineOutput` is called from the supervisor; `engineLogLines` and `subscribeEngineLogs` are used by the admin routes. The redacted output panel is wired.
- `sweepEngineSwaps` and `recoverModelUpdates` are called from daemon boot. The n-gram option is read when constructing llama-server arguments. The context overflow normalizer is used by chat responses and streamed chat errors. The rerank role reaches the route and llama-server launch path.
- No other reviewed exports were found to be unwired in production code.

## Rows whose status is untrue

- **STACK-METRICS-01** — says the endpoint exposes resource history, tokens per second, and queue depth, and remains open because no scraper reads it. The code exposes sampled memory, CPU, queue depth, and role-held bytes; it does not expose tokens per second. The no-scraper status is accurate, but the stated metric coverage is incomplete.
- **STACK-SPEC-NGRAM-01** — row says “built” and records performance measurements, while also saying the measurement is noisy and should be repeated. Code wiring is present, but the requested quiet-machine repeat and measurement on the default chat model are not done; the row correctly remains open.
- **STACK-RERANK-FILL-01** — row says “built” while remaining open for a real b12589 run and measured memory. The endpoint and role are wired, but current route test uses a scripted engine and does not prove native reranking works on the pinned binary; that remaining status is accurate.
- All other requested rows (`STACK-UPDATE-SAFE-01`, `STACK-SWAP-SWEEP-01`, `STACK-STALL-WATCHDOG-01`, `STACK-ENGINE-LOG-01`, `STACK-CTX-400-01`) describe behavior that is wired in production code and have adjacent named tests. No contrary row status was verified.
