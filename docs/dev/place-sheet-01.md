# PLACE-SHEET-01: a multi-angle reference sheet for a place and a prop

Status: 01b, 01c and the attached-picture part of 01d are wired and tested without an engine. Reference clips compose attached object/place pictures and forward them through Ingredients. Generated extra angles are not used by reference clips yet. No model runs are needed. A real run is parked.

## What exists

- `character_sheet` (SHEET-01, `backend/src/lib/makeDispatchSheets.ts`): `kind` is `person`, `object` or `pet`. Each panel is one picture-edit run from the attached references, panels made one after another, the panel list a table in code (`PANELS`), the answer `panels: text[]`.
- `contact_sheet`: tiles of one subject.
- The Ingredients sheet (the single image the reference-video engine takes) is composed in Home today (`lib/films/sheetMaker.ts`: 768 by 448, up to two place panels 288 wide, gaps of 2). The Stack has no compositor, which is why a reference clip made only from objects and places is refused (`docs/dev/video-reference-clip.md`).

## One sheet maker, not two

Both needs are the same operation: turn several panels into one sheet picture with a recorded layout. Build it once, in the Stack, as a pure function with no model and no engine:

`composeSheet({ panels: [{ role, label, image }], layout })` returns `{ png, panels: [{ index, label, slot }] }`. It uses the Stack's managed ffmpeg; it adds no image dependency.

- Lives in `backend/src/media/sheetCompose.ts` (ffmpeg). The layout numbers (sheet size, place panel width, gap, panel cap) are pack data on the reference clip job, not code (E7); the Ingredients numbers above are the first values.
- Used by the reference clip's object and place route (REFCLIP step 3): attached object and place pictures become the sheet the engine takes. Place panels use pack place columns. Generated angles are not connected to this route yet.
- Used by this row: the "composed" answer of a place or prop sheet. A composed place sheet lays the place's six views out as a grid; `max_places` applies to attached place pictures in a reference clip, not views of one place.
- Home's `makeSheetFromPictures` becomes a caller of the Stack and is deleted in the Home half, after a Home test that the same layouts come out.

## Rows

1. **PLACE-SHEET-01a, spec (commons, additive):** `character_sheet.kind` gains `place`; `object` stays the prop kind. Optional request field `compose` (boolean): also return one composed sheet. Result gains optional `composed` (a file name, the sheet picture) next to `panels`. Pack job gains `sheet_angles` (per kind, the list of panel instructions) so the angles are pack data. Receipt: the sheet result records, per panel, its label only (no prompt text, no names). Typed refusals reuse `input_not_supported` and `too_many_references`, with plain lines. Tag it, pin it, then 01b.
2. **PLACE-SHEET-01b, angles as pack data:** move the `PANELS` table out of code into the serving picture pack's `sheet_angles`, with the person, pet and object lists unchanged (golden: same panel instructions as today, byte for byte). Add the `place` list: a wide view from the entrance, the left side, the right side, from above, one close detail of the main feature, the same place at night. Make the object list the prop list: front, side, back, three-quarter, from above, with a hand or a scale cue. Refuse `place` with a person as the only reference by a plain line only if the pack says so; the Stack never decides who may be shown (Home gates).
3. **PLACE-SHEET-01c, the shared sheet maker:** `composeSheet` and its tests (golden PNG dimensions and slot order, panel cap, layout from pack data, odd shapes fitted without cropping the subject), then `compose: true` on `character_sheet`. A pure test with fake panels; no engine.
4. **PLACE-SHEET-01d, REFCLIP step 3:** the reference clip's object and place route calls `composeSheet` (with generated angles when the pack asks for them, else the attached pictures) and hands the sheet to the Ingredients route through the existing Max admission and receipt path. Closes the gap in `docs/dev/video-reference-clip.md`.
5. **PLACE-SHEET-01e, Home half (after the Stack rows are tagged):** the "Make a look for this place or prop" action in the cast and places screens calls `character_sheet` with kind `place` or `object`; Home keeps the tool offer, the plain lines and who may be shown; the composed sheet becomes the place's reference picture; delete Home's compositor after its own test. Home never names the panels.

## Not part of this

A real run of any sheet (parked until the GPU is free), face checks on places (places hold no faces), and any change to who may be cast.
