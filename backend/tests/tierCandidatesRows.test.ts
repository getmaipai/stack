// The tier candidate table lives in rows/tierCandidates.json (model ids are data, not logic); this checks the file loads intact and keeps the ids the tiers depend on.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TIER_CANDIDATES, type TierCandidate } from "@/lib/tiers";
import rows from "@/rows/tierCandidates.json";

test("TIER_CANDIDATES is exactly the JSON rows", () => {
  expect(TIER_CANDIDATES).toEqual(rows as unknown as TierCandidate[]);
});

test("the table has at least 26 rows", () => {
  expect(TIER_CANDIDATES.length).toBeGreaterThanOrEqual(26);
});

test("every row has an id, a known category, profiles and numeric peaks", () => {
  const categories = ["chat", "pictures", "video", "music", "voice", "stems"];
  for (const row of TIER_CANDIDATES) {
    expect(typeof row.id).toBe("string");
    expect(categories).toContain(row.category);
    expect(row.profiles.length).toBeGreaterThan(0);
    expect(row.peaks.length).toBeGreaterThan(0);
    for (const peak of row.peaks) expect(typeof peak.peakBytes).toBe("number");
  }
});

test("the video rows include the LTX-2.5 and FastWan ids the routes fall back to", () => {
  const videoIds = TIER_CANDIDATES.filter((row) => row.category === "video").map((row) => row.id);
  expect(videoIds).toContain("ltx-2-5-q8-distilled-mlx");
  expect(videoIds).toContain("fastwan2-2-ti2v-5b-mlx-bf16");
});

test("tiers.ts holds no model id literals", () => {
  const source = readFileSync(new URL("../src/lib/tiers.ts", import.meta.url).pathname, "utf8");
  expect(source).not.toMatch(/["'`](qwen|flux|ernie|ace-step|chatterbox|pocket|voxcpm|htdemucs|ltx|sam2|minimax|fastwan|z-image)/);
});
