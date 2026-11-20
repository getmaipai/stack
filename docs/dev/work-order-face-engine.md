# Work order: face engine in the Stack (VF-FACE-ENGINE-01)

Status: queued, not started. Read `docs/dev/video-face-role.md` first (the seam, the numbers and the build brief).

Depends on: reference clip step 1 and the face-check logic (landed), spec 0.1.466.

Steps, in order, each its own landing:
1. Parts: add the detector and embedder as two pinned Stack parts (size, SHA-256, licence, source), in the parts list, with the install flow and a plain wizard line. No download without the install flow.
2. `FaceTools` implementation: detect, embed, cosine; load on use, release when idle; admitted by the governor; typed `not_installed` answer when the parts are missing.
3. Frame extraction for the clip check (six evenly spaced frames).
4. Wire the reference clip dispatch: with identity inputs and a start picture, measure the clip after it is made, write `face_check.clip` into the receipt (advisory, never blocks the clip); with no start picture the planner still answers `needs_start_picture` (Home derives, or the Stack derives once its picture edit step is wired, step 5).
5. First-picture derivation in the Stack: the picture edit job composes the first picture from the identity, object and place inputs, `runFirstPictureLoop` re-draws up to `redraws`, a typed refusal after the bound, `face_check.first_picture` in the receipt.
6. Bench test with the real pair on fixture photos (same person above 0.35, different person below it).

Done means: fake-tool tests green, the bench test green on a machine with the parts, docs updated, and one real reference clip run checked by eye once the GPU is free. Home still owns who may be cast and the look-alike wording.
