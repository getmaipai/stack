# Video face checks

The Stack has pure face decision logic in `backend/src/lib/faceCheck.ts`. It checks whether each person's best matching face in a candidate first picture reaches the pack gate, retries a bounded number of times, and measures per-person clip medians. It does not load pictures, make pictures, or run a face model.

`FaceTools` is the seam: an injected `faces` function returns face vectors or `null` when unavailable, and `cosine` compares two vectors. First-picture checks can refuse a candidate. Clip measurement is advisory and returns `null` when tools or usable photo vectors are missing. `faceCheckReceipt` creates the typed receipt fragment; dispatch is not wired to it yet.

Home gets the thresholds from the clip pack through the Catalog pack data, using `referenceClipRules(part)`. The receipt records only role indexes and scores, without names or pictures. A future real Stack face engine must provide a detector and embedder that return compatible vectors, plus the same cosine comparison. That engine is a separate build; this change adds no model or runtime.

## Build brief for a real face engine in the Stack (not built)

Goal: the Stack can answer `FaceTools` on its own, so the reference clip's face gate and clip measure run in the Stack with no help from Home.

What it must provide:
- `faces(image)`: the faces in a picture, biggest first, each with an embedding vector (up to eight faces), or `null` when the models are missing or fail.
- `cosine(a, b)`: the same comparison the pack numbers were measured with (`face_gate` 0.5 and `clip_face_low` 0.35 are cosines of these embeddings; a different embedder needs its numbers measured again and set in pack data, rule E7).
- Models: a small face detector and a small face embedder. Home uses the YuNet detector and the SFace embedder from the OpenCV Zoo (two files, 38.9 MB together, both permissive licences). Use the same pair so the measured numbers hold. They are installed as Stack parts with a pinned size and SHA-256 and shown in the parts list and the wizard like any other part; nothing is downloaded outside that flow.
- Runtime: run them the way the Stack runs its other small vision tools (the image tools worker or an ONNX runtime in the Stack's own process pool), loaded when used and released after an idle minute. They never share the video engine's memory budget: a face check is a few hundred megabytes at most and must be admitted by the governor like any job.
- Frames: the clip check needs `clip_face_frames` (6) evenly spaced frames of a finished clip; use the Stack's existing media tooling to extract them.

Where it plugs in: a `FaceTools` implementation in `backend/src/lib/`, then `runFirstPictureLoop` and `measureClipFaces` called from the reference clip dispatch when the request carries identity pictures, with `faceCheckReceipt` written into the receipt (`face_check`, spec 0.1.466). The first-picture loop needs a `draw` that makes a candidate first picture; that is the Stack's picture edit job fed by the identity, object and place inputs, so the loop and its re-draw bound live in the Stack.

Not part of this build: the wording of any look-alike notice (Home owns the copy), who may be cast (Home decides), and any face enrollment or identification of household members (the engine compares a picture with the pictures sent in the same request and keeps nothing).

Tests: unit tests with the real embedder on three small synthetic faces are not possible without a model; the gate is fake-tool tests (already there) plus a bench-lane test (`check.sh --bench`) that runs the real pair on two fixture photos of the same person and one of a different person and checks the same-person score is above 0.35 and the different-person score is below it. A real reference clip run is parked until the GPU is free.
