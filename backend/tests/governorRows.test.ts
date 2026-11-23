// The governor reads residentHost and memoryHungry off the feature rows instead of hard-coding chat and video (see featureRows.json).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMemoryHungryRole, residentHostRole } from "@/lib/governor";

test("residentHostRole comes from the residentHost row", () => {
  expect(residentHostRole()).toBe("chat");
});

test("isMemoryHungryRole comes from the memoryHungry row", () => {
  expect(isMemoryHungryRole("video")).toBe(true);
  expect(isMemoryHungryRole("image")).toBe(false);
  expect(isMemoryHungryRole("chat")).toBe(false);
});

test("governor.ts no longer hard-codes role comparisons", () => {
  const text = readFileSync(join(import.meta.dir, "../src/lib/governor.ts"), "utf8");
  expect(text.includes('role === "video"')).toBe(false);
  expect(text.includes('role === "chat"')).toBe(false);
});
