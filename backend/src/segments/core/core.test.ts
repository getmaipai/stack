import { describe, expect, test } from "bun:test";
import { MediaSegmentsSchema as MediaSegmentsRecord, type MediaSegment as MediaSegmentT, type MediaSegmentsRecord as MediaSegmentsRecordT, skipPlan } from "@maipai/spec/media/ts/segments";
import { applyDecisions, decideStatus, normalizeSegments } from "./validate";
import { mapTime, renderKeepRanges, unmapTime } from "./skipPlan";
import { parseSilenceDetect, snapAll, snapToSilence } from "./boundarySnap";

let n = 0;
function seg(startSec: number, endSec: number, over: Partial<MediaSegmentT> = {}): MediaSegmentT {
  return { id: `s${n++}`, kind: "ad", startSec, endSec, confidence: 0.9, source: "llm", status: "auto", ...over };
}
function rec(segments: MediaSegmentT[], durationSec = 1000): MediaSegmentsRecordT {
  return {
    fileSha256: "a".repeat(64),
    durationSec,
    segments,
    producedBy: { transcriptRevision: "t1", modelId: "m", pipelineVersion: "1", createdAt: "2026-11-27T00:00:00Z" },
    created_at: "2026-11-27T00:00:00Z",
    hlc: "1:0:segmentsnode",
    provenance: "stack:media.segments",
  };
}

describe("types", () => {
  test("accepts a valid record", () => {
    expect(MediaSegmentsRecord.safeParse(rec([seg(10, 40)])).success).toBe(true);
  });
  test("rejects bad confidence, kind, hash and inverted range", () => {
    expect(MediaSegmentsRecord.safeParse(rec([seg(10, 40, { confidence: 1.2 })])).success).toBe(false);
    expect(MediaSegmentsRecord.safeParse(rec([seg(10, 40, { kind: "x" as never })])).success).toBe(false);
    expect(MediaSegmentsRecord.safeParse({ ...rec([]), fileSha256: "zz" }).success).toBe(false);
    expect(MediaSegmentsRecord.safeParse(rec([seg(40, 10)])).success).toBe(false);
  });
});

describe("normalizeSegments", () => {
  test("empty", () => expect(normalizeSegments([], 100)).toEqual([]));
  test("sorts and clamps", () => {
    const out = normalizeSegments([seg(90, 130), seg(-5, 20)], 100);
    expect(out.map((s) => [s.startSec, s.endSec])).toEqual([[0, 20], [90, 100]]);
  });
  test("drops under 1 s and fully outside", () => {
    expect(normalizeSegments([seg(10, 10.5), seg(120, 140)], 100)).toEqual([]);
    expect(normalizeSegments([seg(10, 11)], 100)).toHaveLength(1);
  });
  test("merges overlap, keeps max confidence and unions sources", () => {
    const out = normalizeSegments(
      [seg(10, 30, { confidence: 0.6, source: "text-pattern" }), seg(25, 50, { confidence: 0.9, source: "llm" })],
      100,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ startSec: 10, endSec: 50, confidence: 0.9, source: "llm" });
    expect(new Set(out[0]!.sources)).toEqual(new Set(["text-pattern", "llm"]));
  });
  test("merges gap under 2 s, not gap of 2 s or more", () => {
    expect(normalizeSegments([seg(10, 20), seg(21.5, 30)], 100)).toHaveLength(1);
    expect(normalizeSegments([seg(10, 20), seg(22, 30)], 100)).toHaveLength(2);
  });
  test("touching merges", () => expect(normalizeSegments([seg(10, 20), seg(20, 30)], 100)).toHaveLength(1));
  test("different kinds never merge", () => {
    expect(normalizeSegments([seg(10, 20), seg(15, 30, { kind: "intro" })], 100)).toHaveLength(2);
  });
  test("a different kind in between does not block a same-kind merge", () => {
    const out = normalizeSegments([seg(10, 20), seg(12, 14, { kind: "intro" }), seg(21, 30)], 100);
    expect(out.filter((s) => s.kind === "ad")).toHaveLength(1);
  });
  test("chain merges and confirmed wins", () => {
    const out = normalizeSegments([seg(10, 20), seg(19, 30, { status: "confirmed", confidence: 0.3 }), seg(31, 40)], 100);
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("confirmed");
    expect(out[0]!.endSec).toBe(40);
  });
  test("does not mutate input", () => {
    const a = seg(-5, 20);
    normalizeSegments([a], 100);
    expect(a.startSec).toBe(-5);
  });
});

describe("decideStatus", () => {
  test("thresholds", () => {
    expect(decideStatus(seg(10, 40, { confidence: 0.8 }), 1000).status).toBe("auto");
    expect(decideStatus(seg(10, 40, { confidence: 0.79 }), 1000).status).toBe("held");
    expect(decideStatus(seg(10, 40, { confidence: 0.5 }), 1000).status).toBe("held");
    expect(decideStatus(seg(10, 40, { confidence: 0.49 }), 1000).status).toBe("rejected");
  });
  test("ad length flags", () => {
    expect(decideStatus(seg(10, 14), 1000).status).toBe("held");
    expect(decideStatus(seg(10, 15), 1000).status).toBe("auto");
    expect(decideStatus(seg(0, 600), 10000).status).toBe("auto");
    expect(decideStatus(seg(0, 601), 10000).status).toBe("held");
  });
  test("position prior: over 40% of file is held", () => {
    expect(decideStatus(seg(0, 450), 1000).status).toBe("held");
    expect(decideStatus(seg(0, 400), 1000).status).toBe("auto");
  });
  test("length rules apply to ads only", () => {
    expect(decideStatus(seg(0, 450, { kind: "recap" }), 1000).status).toBe("auto");
    expect(decideStatus(seg(0, 3, { kind: "sponsor" }), 1000).status).toBe("auto");
  });
  test("person decisions are kept", () => {
    expect(decideStatus(seg(10, 40, { status: "confirmed", confidence: 0.1 }), 1000).status).toBe("confirmed");
    expect(decideStatus(seg(10, 40, { status: "rejected", confidence: 0.99 }), 1000).status).toBe("rejected");
  });
  test("applyDecisions normalizes then decides", () => {
    const out = applyDecisions([seg(10, 40, { confidence: 0.6 }), seg(100, 130, { confidence: 0.2 })], 1000);
    expect(out.map((s) => s.status)).toEqual(["held", "rejected"]);
  });
});

describe("skipPlan", () => {
  const r = rec([
    seg(10, 20),
    seg(20.5, 30),
    seg(100, 110, { status: "held", confidence: 0.6 }),
    seg(200, 210, { status: "rejected" }),
    seg(300, 310, { kind: "intro" }),
    seg(400, 410, { confidence: 0.82 }),
  ]);
  test("merges gaps under 1 s, skips held and rejected by default", () => {
    expect(skipPlan(r, { kinds: ["ad"] })).toEqual([
      { startSec: 10, endSec: 30 },
      { startSec: 400, endSec: 410 },
    ]);
  });
  test("includeHeld", () => {
    expect(skipPlan(r, { kinds: ["ad"], includeHeld: true })).toHaveLength(3);
  });
  test("kinds filter and minConfidence", () => {
    expect(skipPlan(r, { kinds: ["intro"] })).toEqual([{ startSec: 300, endSec: 310 }]);
    expect(skipPlan(r, { kinds: ["ad"], minConfidence: 0.85 })).toEqual([{ startSec: 10, endSec: 30 }]);
  });
  test("confirmed ignores minConfidence; empty record", () => {
    const c = rec([seg(10, 20, { status: "confirmed", confidence: 0.2 })]);
    expect(skipPlan(c, { kinds: ["ad"], minConfidence: 0.9 })).toHaveLength(1);
    expect(skipPlan(rec([]), { kinds: ["ad"] })).toEqual([]);
  });
  test("gap of exactly 1 s stays separate; clamps to duration", () => {
    expect(skipPlan(rec([seg(10, 20), seg(21, 30)]), { kinds: ["ad"] })).toHaveLength(2);
    expect(skipPlan(rec([seg(90, 130)], 100), { kinds: ["ad"] })).toEqual([{ startSec: 90, endSec: 100 }]);
  });
});

describe("time mapping and keep ranges", () => {
  const plan = [
    { startSec: 10, endSec: 20 },
    { startSec: 50, endSec: 80 },
  ];
  test("mapTime", () => {
    expect(mapTime(plan, 5)).toBe(5);
    expect(mapTime(plan, 10)).toBe(10);
    expect(mapTime(plan, 15)).toBe(10);
    expect(mapTime(plan, 20)).toBe(10);
    expect(mapTime(plan, 30)).toBe(20);
    expect(mapTime(plan, 100)).toBe(60);
    expect(mapTime([], 42)).toBe(42);
  });
  test("unmapTime", () => {
    expect(unmapTime(plan, 5)).toBe(5);
    expect(unmapTime(plan, 10)).toBe(20);
    expect(unmapTime(plan, 20)).toBe(30);
    expect(unmapTime(plan, 60)).toBe(100);
  });
  test("round trip for kept times", () => {
    for (const t of [0, 5, 9.9, 20, 25, 49, 80, 99]) expect(unmapTime(plan, mapTime(plan, t))).toBe(t);
  });
  test("renderKeepRanges", () => {
    expect(renderKeepRanges(plan, 100)).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 20, endSec: 50 },
      { startSec: 80, endSec: 100 },
    ]);
    expect(renderKeepRanges([], 100)).toEqual([{ startSec: 0, endSec: 100 }]);
    expect(renderKeepRanges([{ startSec: 0, endSec: 100 }], 100)).toEqual([]);
    expect(renderKeepRanges([{ startSec: 0, endSec: 10 }, { startSec: 90, endSec: 100 }], 100)).toEqual([
      { startSec: 10, endSec: 90 },
    ]);
  });
});

describe("snapToSilence", () => {
  const sil = [
    { startSec: 9, endSec: 9.6 },
    { startSec: 30.2, endSec: 31 },
  ];
  test("snaps each edge to nearest silence edge", () => {
    expect(snapToSilence({ startSec: 10, endSec: 30 }, sil)).toEqual({ startSec: 9.6, endSec: 30.2 });
  });
  test("no silences or out of window: unchanged", () => {
    expect(snapToSilence({ startSec: 10, endSec: 30 }, [])).toEqual({ startSec: 10, endSec: 30 });
    expect(snapToSilence({ startSec: 10, endSec: 30 }, sil, 0.1)).toEqual({ startSec: 10, endSec: 30 });
  });
  test("edge inside a silence stays", () => {
    expect(snapToSilence({ startSec: 9.3, endSec: 30 }, sil).startSec).toBe(9.3);
  });
  test("blocked by neighbour bounds", () => {
    const out = snapToSilence({ startSec: 10, endSec: 30 }, sil, 2.5, { minSec: 9.8 });
    expect(out.startSec).toBe(10);
    const out2 = snapToSilence({ startSec: 10, endSec: 30 }, sil, 2.5, { maxSec: 30.1 });
    expect(out2.endSec).toBe(30);
  });
  test("never inverts a short range", () => {
    const out = snapToSilence({ startSec: 10, endSec: 11 }, [{ startSec: 11.5, endSec: 12 }, { startSec: 8.5, endSec: 9 }], 2.5);
    expect(out.endSec).toBeGreaterThan(out.startSec);
  });
  test("snapAll respects neighbours", () => {
    const out = snapAll(
      [{ startSec: 10, endSec: 20 }, { startSec: 20.5, endSec: 30 }],
      [{ startSec: 20.2, endSec: 20.4 }],
      2.5,
      100,
    );
    expect(out[0]!.endSec).toBeLessThanOrEqual(out[1]!.startSec);
    expect(out).toEqual([{ startSec: 10, endSec: 20.2 }, { startSec: 20.4, endSec: 30 }]);
  });
  test("snapAll empty", () => expect(snapAll([], [])).toEqual([]));
});

describe("parseSilenceDetect", () => {
  const stderr = [
    "[silencedetect @ 0x6000] silence_start: 12.5",
    "[silencedetect @ 0x6000] silence_end: 13.75 | silence_duration: 1.25",
    "size=N/A time=00:01:00 bitrate=N/A",
    "[silencedetect @ 0x6000] silence_start: -0.0013",
    "[silencedetect @ 0x6000] silence_end: 0.5 | silence_duration: 0.5013",
    "[silencedetect @ 0x6000] silence_start: 58",
  ].join("\n");
  test("parses pairs and clamps negatives", () => {
    expect(parseSilenceDetect(stderr)).toEqual([
      { startSec: 12.5, endSec: 13.75 },
      { startSec: 0, endSec: 0.5 },
    ]);
  });
  test("closes an unterminated silence at duration", () => {
    expect(parseSilenceDetect(stderr, 60).at(-1)).toEqual({ startSec: 58, endSec: 60 });
  });
  test("empty and noise", () => {
    expect(parseSilenceDetect("")).toEqual([]);
    expect(parseSilenceDetect("random\nlines")).toEqual([]);
  });
});

describe("normalizeSegments keeps bumper parts", () => {
  test("keeps short adjacent stinger, slot and stinger parts apart and sorted", () => {
    const part = (slotRole: "lead-stinger" | "slot" | "tail-stinger", startSec: number, endSec: number) => ({ id: slotRole, kind: "bumper" as const, startSec, endSec, confidence: 0.9, source: "fingerprint" as const, sources: ["fingerprint" as const], status: "auto" as const, slotRole, groupId: "g1" });
    const out = normalizeSegments([part("tail-stinger", 11.95, 13), part("lead-stinger", 10.1, 11), part("slot", 11, 11.95)] as never, 60);
    expect(out.map((s) => s.slotRole)).toEqual(["lead-stinger", "slot", "tail-stinger"]);
    expect(out.every((s) => s.groupId === "g1")).toBe(true);
  });
});
