import { expect, test } from "bun:test";
import rows from "../src/rows/templateRows.json";
import { PROFILE_TIERS, type ProfileTier } from "../src/profiles";

test("PROFILE_TIERS equals the JSON rows", () => {
  expect(PROFILE_TIERS).toEqual(rows as unknown as ProfileTier[]);
});

test("ids are p16, p32, p64, p128 in order", () => {
  expect(PROFILE_TIERS.map((t) => t.id)).toEqual(["p16", "p32", "p64", "p128"]);
});

test("minUnifiedGb is 16, 32, 64, 128 in order and strictly increasing", () => {
  const values = PROFILE_TIERS.map((t) => t.minUnifiedGb);
  expect(values).toEqual([16, 32, 64, 128]);
  for (let i = 1; i < values.length; i += 1) {
    expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  }
});

test("each row's resident is an array of strings", () => {
  for (const row of PROFILE_TIERS) {
    expect(Array.isArray(row.resident)).toBe(true);
    for (const role of row.resident) {
      expect(typeof role).toBe("string");
    }
  }
});
