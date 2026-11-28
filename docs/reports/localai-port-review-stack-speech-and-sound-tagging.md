# LocalAI port review: Stack speech and sound tagging

## Summary

Reviewed the six requested commits and their row-specific follow-ups against the current Stack code and tests.
Verified one MEDIUM defect: sound tagging accepts an unbounded request body and allocates it and a second float buffer before inference.
Parakeet v3 remains unselected by profiles; sound tagging is installed only on request and has no production caller.

## Defects

### MEDIUM

- **CS-1** - Commit `471cfadf4317ba744575388d48bd9031b27ef1ed`; [server.ts](/Users/jessetorres/Developer/github.com/getmaipai/wt/stack-clever-tiger-lai-review-c/backend/src/speech/server.ts:160).
  - **Failure:** a request to `POST /v1/audio/tags` with an arbitrarily large even-length PCM body passes validation. `request.arrayBuffer()` materializes the full body and the handler then allocates a `Float32Array` at half the byte count, before resampling and inference. A large authorized internal request can exhaust worker memory and take down STT as well as tagging.
  - **Fix:** enforce a request byte cap before conversion and a maximum audio duration based on the supplied sample rate; reject oversize bodies with 413. Bound accepted sample rates to the model's supported range.
  - **Failing test:** exercise the real HTTP route with a body just over the byte/duration cap and assert 413 and that the injected tagger is never called. Include malformed and extreme sample rates.

## Unwired or dead

- `POST /v1/audio/tags` (`SOUND_TAGS_PATH`, `server.ts`) is reachable only inside the spawned speech worker. Repository-wide production search finds no caller of the path. `tagSounds`, `loadAudioTagger`, and the worker option are wired into that route, but nothing invokes the route from the Stack role API or a Home-facing path. This matches the requested optional, off-by-default implementation; it is not an end-to-end sound-tagging feature yet.
- The Parakeet v3 catalog pin is referenced by model catalog registration/tests and the voice helper part list. No profile binds it, and the STT selection logic keeps the existing default. It is intentionally available as an optional part, not a default runtime model.

## Rows whose status is untrue

- **STACK-SOUND-TAG-01.** The checkbox remains open, which is accurate. The prose says “Status: built” and lists the animal clip measurements, but the acceptance requirement is an automated fixture test that tags correctly, and the committed test only supplies a fake tagger to `tagSounds`; it never exercises the HTTP route or a real clip/model. Alarm and glass behavior is also explicitly left unmeasured. The status should say implementation built, acceptance incomplete, until a reproducible real-model fixture test covers the required sounds. The model pin has an Apache-2.0 label and checksum in the catalog, but I did not independently verify the upstream licence or checksum in this read-only review; those claims are unverified here.
- **STACK-PARAKEET-V3-01.** The checked status is supported for the comparison deliverable: the row records the synthesized-clip comparison and caveats. Its wording does not mean v3 is selected or streaming is implemented; the row explicitly says neither. The comparison report under `data-scratch/` was not present in the tracked source read during this review, so the stated measurements are unverified here beyond the script and backlog text.
