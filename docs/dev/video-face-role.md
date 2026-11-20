# Video face checks

The Stack has pure face decision logic in `backend/src/lib/faceCheck.ts`. It checks whether each person's best matching face in a candidate first picture reaches the pack gate, retries a bounded number of times, and measures per-person clip medians. It does not load pictures, make pictures, or run a face model.

`FaceTools` is the seam: an injected `faces` function returns face vectors or `null` when unavailable, and `cosine` compares two vectors. First-picture checks can refuse a candidate. Clip measurement is advisory and returns `null` when tools or usable photo vectors are missing. `faceCheckReceipt` creates the typed receipt fragment; dispatch is not wired to it yet.

Home gets the thresholds from the clip pack through the Catalog pack data, using `referenceClipRules(part)`. The receipt records only role indexes and scores, without names or pictures. A future real Stack face engine must provide a detector and embedder that return compatible vectors, plus the same cosine comparison. That engine is a separate build; this change adds no model or runtime.
