import { expect, test } from "bun:test";
import { IMAGE_FAMILIES, type ImageFamilyId } from "@/images/models";
import { imageInstallModels } from "@/lib/installPlan";

const families = Object.keys(IMAGE_FAMILIES) as ImageFamilyId[];

test("every image family names its pins and its install-plan row", () => {
  for (const family of families) {
    expect(IMAGE_FAMILIES[family].pins.length).toBeGreaterThan(0);
    expect(IMAGE_FAMILIES[family].diskRow.startsWith("pictures")).toBe(true);
  }
  expect(new Set(families.map((family) => IMAGE_FAMILIES[family].diskRow)).size).toBe(families.length);
});

test("imageInstallModels lists a family's own pins", () => {
  for (const family of families) {
    expect(imageInstallModels(family).map((model) => model.id)).toEqual(IMAGE_FAMILIES[family].pins.map((pin) => pin.id));
  }
});

test("plan order covers the four families the plan route adds", () => {
  const ordered = families.filter((family) => IMAGE_FAMILIES[family].planOrder !== null).sort((a, b) => IMAGE_FAMILIES[a].planOrder! - IMAGE_FAMILIES[b].planOrder!);
  expect(ordered.map((family) => IMAGE_FAMILIES[family].diskRow)).toEqual(["pictures", "pictures-ernie", "pictures-zimage", "pictures-qwen"]);
});
