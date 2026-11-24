import { expect, test } from "bun:test";
import { PROFILE_IDS, profileRank, templateBehavior, workingMarginBytes } from "@/lib/profileIds";
import { PROFILE_TIERS } from "@/profiles";

test("template ids come from the rows, in size order", () => {
  expect([...PROFILE_IDS]).toEqual(PROFILE_TIERS.map((tier) => tier.id));
  expect(PROFILE_IDS.map(profileRank)).toEqual(PROFILE_IDS.map((_, index) => index));
  expect(profileRank("nope")).toBe(-1);
});

test("every template row carries its behavior fields", () => {
  const margins = PROFILE_IDS.map((id) => workingMarginBytes(id));
  expect(margins).toEqual([...margins].sort((a, b) => a - b));
  for (const id of PROFILE_IDS) {
    const row = templateBehavior(id);
    expect(row.minUnifiedGb).toBeGreaterThan(0);
    expect(row.matchCeilingGb).toBeGreaterThan(row.minUnifiedGb);
    expect(row.heavyLaneSlots).toBeGreaterThan(0);
  }
});
