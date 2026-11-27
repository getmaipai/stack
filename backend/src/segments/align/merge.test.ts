import { describe, expect, test } from "bun:test";
import real from "./fixtures/real-levels.json";
import { mergeInsertions } from "./merge";

describe("mergeInsertions on real levels (72 minute episode, 4 breaks)", () => {
  test("recovers the four breaks within 6 s", () => {
    const r = mergeInsertions(real.levels, real.refDurSec, real.stDurSec);
    expect(r.length).toBe(4);
    r.forEach((span, i) => {
      expect(Math.abs(span.startSec - real.truth[i]![0]!)).toBeLessThan(6);
      expect(Math.abs(span.endSec - real.truth[i]![1]!)).toBeLessThan(6);
    });
    const total = r.reduce((a, s) => a + (s.endSec - s.startSec), 0);
    expect(Math.abs(total - (real.stDurSec - real.refDurSec))).toBeLessThan(10);
  });
  test("no levels, no breaks; identical copies, none", () => {
    expect(mergeInsertions([], 100, 100)).toEqual([]);
    expect(mergeInsertions([{ deltaSec: 0, fromSec: 0, toSec: 100 }], 100, 100)).toEqual([]);
  });
});
