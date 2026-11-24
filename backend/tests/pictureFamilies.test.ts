// PICTURE-FAMILY-ROWS: the six picture family units come from
// rows/pictureFamilies.json. This checks the units the component list builds
// from those rows: same ids in the same order, with the tiers, usedBy text
// and licence notices the code used to hardcode.
import { afterEach, expect, test } from "bun:test";
import pictureFamilyRows from "@/rows/pictureFamilies.json";
import { __setComponentUnitsForTests, componentDefs } from "@/lib/components";
import { H3_LICENCE_NOTICE, KLEIN3_LICENCE_NOTICE, STACK_IMAGE_H3_ID, STACK_IMAGE_KLEIN3_ID } from "@/lib/modelCatalog";
import type { LicenceNotice } from "@/lib/licenceAcceptance";

const EXPECTED: { id: string; tiers: ("p16" | "p32" | "p64" | "p128")[]; usedBy: string; licenceNotice?: LicenceNotice }[] = [
  { id: "flux2-klein-4b", tiers: ["p32", "p64", "p128"], usedBy: "Pictures in chat and the Pictures app", licenceNotice: undefined },
  { id: STACK_IMAGE_KLEIN3_ID, tiers: ["p64", "p128"], usedBy: "Pictures, when chosen as the model", licenceNotice: KLEIN3_LICENCE_NOTICE },
  { id: "z-image-turbo", tiers: ["p128"], usedBy: "Pictures, when chosen as the model", licenceNotice: undefined },
  { id: "ernie-image-turbo", tiers: ["p64", "p128"], usedBy: "Pictures, when chosen as the model", licenceNotice: undefined },
  { id: "qwen-image-2512-q8", tiers: ["p128"], usedBy: "Max pictures", licenceNotice: undefined },
  { id: STACK_IMAGE_H3_ID, tiers: ["p16", "p32", "p64", "p128"], usedBy: "Pictures in chat and the Pictures app", licenceNotice: H3_LICENCE_NOTICE },
];

afterEach(() => { __setComponentUnitsForTests(null); });

test("the row file holds one row per picture family, in this order", () => {
  expect(pictureFamilyRows.map((row) => row.id)).toEqual(EXPECTED.map((row) => row.id));
});

test("the picture family units keep their tiers, usedBy text and licence notices, in order", () => {
  __setComponentUnitsForTests(null);
  const defs = componentDefs();
  const ids = defs.map((def) => def.id);
  let last = -1;
  for (const want of EXPECTED) {
    const at = ids.indexOf(want.id);
    expect(at).toBeGreaterThan(last);
    last = at;
    const def = defs[at]!;
    expect(def.tiers).toEqual(want.tiers);
    expect(def.usedBy()[0]).toBe(want.usedBy);
    expect(def.licenceNotice).toEqual(want.licenceNotice);
  }
});
