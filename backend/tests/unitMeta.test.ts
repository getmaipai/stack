// UNITMETA-01: the five video units read their group, role and tiers from
// rows/unitMeta.json through the unitMeta helper instead of literals in the
// push calls. The units are found in the real component list the way
// components.test.ts does (the override cleared, then the defs read).
import { expect, test } from "bun:test";
import { __setComponentUnitsForTests, componentDefs, unitMeta, type UnitDef } from "@/lib/components";
import { STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_MASK_MODEL_ID, STACK_VIDEO_MODELS } from "@/lib/modelCatalog";

const VIDEO_UNIT_IDS = [STACK_VIDEO_MODELS[0]!.id, STACK_VIDEO_LTX25_MODEL_ID, STACK_VIDEO_H3_MODEL_ID, STACK_VIDEO_LTX25_MAX_MODEL_ID, STACK_VIDEO_MASK_MODEL_ID];
const EXPECTED_TIERS: NonNullable<UnitDef["tiers"]>[] = [["p128"], ["p128"], ["p16", "p32", "p64", "p128"], ["p128"], ["p64", "p128"]];

test("the five video units keep group video, role video and their original tiers from the metadata rows", () => {
  __setComponentUnitsForTests(null);
  const units = componentDefs();
  const expected = VIDEO_UNIT_IDS.map((id, index) => ({ id, group: "video" as const, role: "video", tiers: EXPECTED_TIERS[index]! }));
  const found = units.filter((unit) => VIDEO_UNIT_IDS.includes(unit.id)).map((unit) => ({ id: unit.id, group: unit.group, role: unit.role, tiers: unit.tiers }));
  expect(found).toEqual(expected);
});

test("unitMeta throws for an id with no metadata row", () => {
  expect(() => unitMeta("no-such-unit")).toThrow("no unit metadata for no-such-unit");
});
