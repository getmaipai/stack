// DISKGATE-01: which hardware templates may offer an optional disk-plan row comes from rows/diskRowGates.json through rowAllowed.
import { expect, test } from "bun:test";
import { rowAllowed } from "@/lib/diskPlan";

const t = (id: string, notAvailable: string[] = []) => ({ id, notAvailable });

test("a row appears from its minimum template up", () => {
  expect(rowAllowed(t("p32"), "voice-voxcpm2")).toBe(false);
  expect(rowAllowed(t("p64"), "voice-voxcpm2")).toBe(true);
  expect(rowAllowed(t("p16"), "voice-voxcpm2-reduced")).toBe(false);
  expect(rowAllowed(t("p32"), "voice-voxcpm2-reduced")).toBe(true);
  expect(rowAllowed(t("p64"), "pictures-zimage")).toBe(false);
  expect(rowAllowed(t("p128"), "pictures-zimage")).toBe(true);
  expect(rowAllowed(t("p128"), "pictures-qwen")).toBe(true);
  expect(rowAllowed(t("p16"), "sound-effects")).toBe(false);
  expect(rowAllowed(t("p32"), "sound-effects")).toBe(true);
});

test("a row that belongs to a feature is hidden where the template lists that feature as not available", () => {
  expect(rowAllowed(t("p128", ["music"]), "music-boost")).toBe(false);
  expect(rowAllowed(t("p128"), "music-boost")).toBe(true);
  expect(rowAllowed(t("p128"), "music-max")).toBe(true);
  expect(rowAllowed(t("p64"), "music-max")).toBe(false);
  expect(rowAllowed(t("p64", ["video"]), "video-mask")).toBe(false);
  expect(rowAllowed(t("p64"), "video-mask")).toBe(true);
  expect(rowAllowed(t("p32"), "video-mask")).toBe(false);
  expect(rowAllowed(t("p128"), "video-ltx25")).toBe(true);
  expect(rowAllowed(t("p128", ["video"]), "video-ltx25-max")).toBe(false);
  expect(rowAllowed(t("p128", ["image"]), "pictures-clearer")).toBe(false);
  expect(rowAllowed(t("p64"), "pictures-clearer")).toBe(true);
  expect(rowAllowed(t("p32"), "pictures-clearer")).toBe(false);
});

test("a row with no gate is refused loudly", () => {
  expect(() => rowAllowed(t("p128"), "no-such-row")).toThrow("no disk row gate for no-such-row");
});
