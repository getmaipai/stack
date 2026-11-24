import { expect, test } from "bun:test";
import { IMAGE_FAMILIES, type ImageFamilyId } from "@/images/models";
import { imageInstallModels } from "@/lib/installPlan";

const families = Object.keys(IMAGE_FAMILIES) as ImageFamilyId[];

test("every image family names its pins", () => {
  for (const family of families) {
    expect(IMAGE_FAMILIES[family].pins.length).toBeGreaterThan(0);
  }
});

test("imageInstallModels lists a family's own pins", () => {
  for (const family of families) {
    expect(imageInstallModels(family).map((model) => model.id)).toEqual(IMAGE_FAMILIES[family].pins.map((pin) => pin.id));
  }
});

test("plan order covers the four families the plan route adds", () => {
  const ordered = families.filter((family) => IMAGE_FAMILIES[family].planOrder !== null).sort((a, b) => IMAGE_FAMILIES[a].planOrder! - IMAGE_FAMILIES[b].planOrder!);
  expect(ordered).toEqual(["flux2-klein-4b", "ernie-image-turbo", "z-image-turbo", "qwen-image-2512-q8"]);
});
