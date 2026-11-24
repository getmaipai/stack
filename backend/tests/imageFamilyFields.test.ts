// IMGGEN-STACK-01: family behavior comes from fields on IMAGE_FAMILIES, not
// from family id literals scattered through the routes and the engine. These
// values must equal the behavior the id comparisons used to encode.
import { expect, test } from "bun:test";
import { STACK_IMAGE_H3_ID, STACK_IMAGE_KLEIN3_ID, STACK_IMAGE_QWEN_ID } from "@/lib/modelCatalog";
import { DEFAULT_FAMILY, IMAGE_FAMILIES, type ImageFamilyId } from "@/images/models";

const EXPECTED: Record<ImageFamilyId, { deadlineMinutes: number; acceptsLoras: boolean; acceptsInitImage: boolean; editFamily: string | null }> = {
  "flux2-klein-4b": { deadlineMinutes: 2, acceptsLoras: true, acceptsInitImage: true, editFamily: null },
  "z-image-turbo": { deadlineMinutes: 4, acceptsLoras: true, acceptsInitImage: true, editFamily: null },
  "ernie-image-turbo": { deadlineMinutes: 2, acceptsLoras: true, acceptsInitImage: true, editFamily: null },
  [STACK_IMAGE_QWEN_ID]: { deadlineMinutes: 8, acceptsLoras: true, acceptsInitImage: true, editFamily: null },
  [STACK_IMAGE_H3_ID]: { deadlineMinutes: 2, acceptsLoras: false, acceptsInitImage: true, editFamily: null },
  [STACK_IMAGE_KLEIN3_ID]: { deadlineMinutes: 2, acceptsLoras: false, acceptsInitImage: false, editFamily: STACK_IMAGE_KLEIN3_ID },
};

test("every family carries the new behavior fields with today's values", () => {
  for (const key of Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]) {
    const info = IMAGE_FAMILIES[key];
    const expected = EXPECTED[key];
    expect([key, info.deadlineMinutes]).toEqual([key, expected.deadlineMinutes]);
    expect([key, info.acceptsLoras]).toEqual([key, expected.acceptsLoras]);
    expect([key, info.acceptsInitImage]).toEqual([key, expected.acceptsInitImage]);
    expect([key, info.editFamily]).toEqual([key, expected.editFamily]);
  }
});

test("deadlineMinutes reproduces the old deadlineMs id comparisons", () => {
  for (const key of Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]) {
    // The comparison this field replaces: qwen got 8 minutes, Z-Image-Turbo 4, everything else 2.
    const minutes = key === STACK_IMAGE_QWEN_ID ? 8 : key === "z-image-turbo" ? 4 : 2;
    expect([key, IMAGE_FAMILIES[key].deadlineMinutes]).toEqual([key, minutes]);
  }
});

test("DEFAULT_FAMILY keeps the wire value non-klein3 edits used before", () => {
  expect(DEFAULT_FAMILY).toBe("flux2-klein-4b");
  for (const key of Object.keys(IMAGE_FAMILIES) as ImageFamilyId[]) {
    // What went on the wire before: klein3 stayed itself, every other family was the default edit family.
    const wireBefore = key === STACK_IMAGE_KLEIN3_ID ? STACK_IMAGE_KLEIN3_ID : DEFAULT_FAMILY;
    expect([key, IMAGE_FAMILIES[key].editFamily ?? DEFAULT_FAMILY]).toEqual([key, wireBefore]);
  }
});
