# Reference clip sheet route

Object and place only reference clips are not wired through the generic Stack make route. The existing `clip_from_sheet` request accepts a prepared `sheet` path, while the Ingredients endpoint accepts one or two sheet images as multipart files. The Stack has no pure contact sheet compositor that combines arbitrary object and place pictures into the Ingredients sheet format, and the contact sheet job makes separate prompted tiles rather than a composed Ingredients sheet.

Smallest plan: add a pure, injected sheet compositor that accepts the validated object/place image bytes, creates the exact sheet PNG required by Ingredients, and returns bytes plus role-to-source mapping. Then adapt the generic clip dispatcher to hand those prepared sheet bytes to the existing Ingredients route with the existing Max admission and receipt path. Keep the compositor behind an injected `makeSheet` seam and test it with a fake; do not add a new engine call shape.
