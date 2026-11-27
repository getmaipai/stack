import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/episode-excerpts.json";
import { blocksFromSegments, findHeuristicCandidates, findRepeats, jaccard, shingles } from "./heuristics";
import type { TranscriptSegment } from "./transcript";

const segments = fixture.segments as TranscriptSegment[];
const breaks = fixture.breaks as [number, number][];
const TOL = 15;

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/** Content seconds covered by the excerpts, minus the true ad time inside them. */
function contentSeconds(): number {
  let total = 0;
  for (const s of segments) total += s.endSec - s.startSec;
  let ad = 0;
  for (const s of segments) for (const b of breaks) ad += overlap([s.startSec, s.endSec], b);
  return total - ad;
}

describe("heuristics-only pass on the fixture", () => {
  const cands = findHeuristicCandidates(segments);

  test("recovers every break within 15 s at both ends", () => {
    for (const [a, b] of breaks) {
      const hit = cands.find((c) => Math.abs(c.startSec - a) <= TOL && Math.abs(c.endSec - b) <= TOL);
      expect(hit, `break ${a}-${b}; got ${JSON.stringify(cands.map((c) => [c.startSec, c.endSec]))}`).toBeDefined();
      expect(hit!.reasons.length).toBeGreaterThan(0);
    }
  });

  test("extends the toy car read back to its start without crossing the prior banter", () => {
    const hit = cands.find((c) => Math.abs(c.startSec - 1190) <= TOL && Math.abs(c.endSec - 1363) <= TOL);
    expect(hit).toBeDefined();
    expect(hit!.startSec).toBeGreaterThanOrEqual(1189);
    expect(hit!.startSec).toBeLessThanOrEqual(1205);
  });

  test("flags under 5% of the content time", () => {
    let falsePos = 0;
    for (const c of cands) {
      let covered = 0;
      for (const b of breaks) covered += overlap([c.startSec, c.endSec], b);
      falsePos += c.endSec - c.startSec - covered;
    }
    const content = contentSeconds();
    console.log(`heuristics: recall ${breaks.length}/${breaks.length} breaks, false-positive ${falsePos.toFixed(1)}s of ${content.toFixed(0)}s content (${((100 * falsePos) / content).toFixed(2)}%)`);
    expect(falsePos / content).toBeLessThan(0.05);
    expect(falsePos / content).toBeLessThan(0.05);
  });
});

describe("repeat detector", () => {
  test("finds the same read heard again in one episode", () => {
    const { ranges } = findRepeats(segments);
    const inBreak = (t: number) => breaks.some(([a, b]) => t >= a && t <= b);
    const zil = ranges.filter((r) => inBreak(r.startSec) && r.startSec > 1100);
    expect(zil.length).toBeGreaterThan(0);
  });

  test("matches against prior blocks from another episode", () => {
    const prior = [{ startSec: 0, endSec: 10, text: "Zilbrisk may lower your ability to fight infections and increase risk for serious infections", label: "zilbrisk" }];
    const segs: TranscriptSegment[] = [
      { startSec: 500, endSec: 520, text: "Zilbrisk may lower your ability to fight infections and increase risk for serious infections including meningococcal" },
    ];
    const { ranges } = findRepeats(segs, prior, { blockWords: 5 });
    expect(ranges[0]?.priorLabel).toBe("zilbrisk");
  });

  test("unrelated text does not match", () => {
    expect(jaccard(shingles("the quick brown fox jumps over the dog"), shingles("completely different words appear in here now"))).toBe(0);
    expect(blocksFromSegments([]).length).toBe(0);
  });
});
