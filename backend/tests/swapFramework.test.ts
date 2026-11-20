import { describe, expect, test } from "bun:test";
import {
  kindNotServedLine, servedKinds, blendWeights, buildRegionTrack, convexHull, isSwapKind, likenessFrames, planWindows, polygonArea, regionFileBody, simplifyHull, swapVerdict,
  type Outline, type OutlineProvider, type Point, type WindowRules,
} from "@/lib/swapFramework";

// A stand-in segmentation part: a circle of points that moves right one pixel per frame, absent in a range of frames.
const circle = (cx: number, cy: number, r: number, n = 24): Point[] => Array.from({ length: n }, (_, i): Point => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
const standIn = (absent: (k: number) => boolean): OutlineProvider => ({ outlines: async (count) => Array.from({ length: count }, (_, k): Outline => (absent(k) ? null : circle(100 + k, 80, 30))) });
const opts = { width: 320, height: 240, holdFrames: 2, maxPoints: 12 };
const rules: WindowRules = { maxFrames: 56, baseFrames: 22, stepFrames: 17, blendFrames: 8 };

describe("swap kinds", () => {
  test("three kinds and nothing else", () => {
    expect(["face", "head", "person"].every(isSwapKind)).toBe(true);
    expect(isSwapKind("body")).toBe(false);
    expect(isSwapKind(undefined)).toBe(false);
  });
});

describe("hull and simplify", () => {
  test("hull of a square with an inside point drops the inside point", () => {
    const hull = convexHull([[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]]);
    expect(hull.length).toBe(4);
    expect(polygonArea(hull)).toBe(100);
  });
  test("simplify keeps at most the points asked and most of the area", () => {
    const hull = convexHull(circle(50, 50, 30, 40));
    const small = simplifyHull(hull, 8);
    expect(small.length).toBe(8);
    expect(polygonArea(small) / polygonArea(hull)).toBeGreaterThan(0.85);
  });
  test("never fewer than three points", () => { expect(simplifyHull(convexHull(circle(50, 50, 30, 10)), 1).length).toBe(3); });
});

describe("region track", () => {
  test("one polygon entry per present frame, at most maxPoints each", async () => {
    const track = buildRegionTrack(await standIn(() => false).outlines(10), opts);
    expect(track.entries.length).toBe(10);
    expect(track.entries.every((e) => e !== null && e.polygon.length <= 12 && e.polygon.length >= 3)).toBe(true);
    expect(track.absentFrames).toBe(0); expect(track.firstFrame).toBe(0);
  });
  test("a short loss is held at the last outline, a long loss is absent", async () => {
    const track = buildRegionTrack(await standIn((k) => k >= 5 && k <= 9).outlines(14), opts);   // frames 5-9 lost, hold 2
    expect(track.entries[5]).toEqual(track.entries[4]); expect(track.entries[6]).toEqual(track.entries[4]);
    expect(track.entries[7]).toBeNull(); expect(track.entries[9]).toBeNull();
    expect(track.entries[10]).not.toBeNull();
    expect(track.heldFrames).toBe(2); expect(track.absentFrames).toBe(3);
  });
  test("frames before the first outline are absent and never held forward", async () => {
    const track = buildRegionTrack(await standIn((k) => k < 3).outlines(6), opts);
    expect(track.entries.slice(0, 3)).toEqual([null, null, null]); expect(track.firstFrame).toBe(3);
  });
  test("outline points outside the frame are clamped inside it", () => {
    const track = buildRegionTrack([[[-50, -50], [500, -50], [500, 400], [-50, 400]]], opts);
    for (const [x, y] of track.entries[0]!.polygon) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(319); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(239); }
  });
  test("a speck or a line is no person", () => {
    const track = buildRegionTrack([[[1, 1], [2, 1], [1, 2]], [[0, 0], [50, 50], [100, 100]], [[1, 1]], null], { ...opts, holdFrames: 0 });
    expect(track.entries).toEqual([null, null, null, null]);
  });
  test("unknown clip size says what to do", () => { expect(() => buildRegionTrack([null], { ...opts, width: 0 })).toThrow("Try again"); });
  test("the region file is the worker's one-entry-per-frame JSON", async () => {
    const parsed = JSON.parse(regionFileBody(buildRegionTrack(await standIn((k) => k === 3).outlines(5), { ...opts, holdFrames: 0 })));
    expect(parsed.length).toBe(5); expect(parsed[3]).toBeNull(); expect(Array.isArray(parsed[0].polygon)).toBe(true);
  });
});

describe("windows and blends", () => {
  const covered = (total: number): void => {
    const windows = planWindows(total, rules);
    const seen = new Set<number>();
    for (const w of windows) { expect([22, 39, 56]).toContain(w.frames); for (let f = w.start; f < w.start + Math.min(w.covers, w.frames); f++) seen.add(f); }
    expect(seen.size).toBe(total);
    for (const w of windows.slice(1)) expect(w.blendIn).toBeGreaterThanOrEqual(8);
    expect(windows[0]!.blendIn).toBe(0);
  };
  test("a clip inside one window is one window of a drawable length", () => {
    expect(planWindows(10, rules)).toEqual([{ index: 0, start: 0, frames: 22, blendIn: 0, covers: 10 }]);
    expect(planWindows(40, rules)[0]!.frames).toBe(56);
  });
  test("every frame is covered, for a spread of clip lengths", () => { for (const n of [1, 22, 23, 56, 57, 90, 104, 183, 240, 241]) covered(n); });
  test("the last window ends exactly at the clip end when it can", () => {
    const last = planWindows(183, rules).at(-1)!;
    expect(last.start + last.frames).toBe(183);
  });
  test("blend weights ramp and never reach 0 or 1", () => {
    const w = blendWeights(8);
    expect(w.length).toBe(8); expect(w[0]!).toBeGreaterThan(0); expect(w[7]!).toBeLessThan(1);
    expect(w.every((v, i) => i === 0 || v > w[i - 1]!)).toBe(true);
  });
  test("bad rules and empty clips say what to fix", () => {
    expect(() => planWindows(10, { ...rules, maxFrames: 50 })).toThrow("longest window");
    expect(() => planWindows(10, { ...rules, blendFrames: 11 })).toThrow("blend");
    expect(() => planWindows(0, rules)).toThrow("no frames");
  });
});

describe("likeness frames", () => {
  test("evenly spaced over present frames only", async () => {
    const track = buildRegionTrack(await standIn((k) => k >= 40).outlines(60), { ...opts, holdFrames: 0 });
    const frames = likenessFrames(track, 5);
    expect(frames.length).toBe(5); expect(frames.every((k) => k < 40)).toBe(true);
    expect(new Set(frames).size).toBe(5);
  });
  test("fewer present frames than asked returns all of them", async () => {
    expect(likenessFrames(buildRegionTrack(await standIn((k) => k > 2).outlines(10), { ...opts, holdFrames: 0 }), 5)).toEqual([0, 1, 2]);
  });
});

describe("the verdict", () => {
  test("the numbers come from one rules object a pack can override", () => {
    const l = { scores: [0.3, 0.3, 0.3, 0.3, 0.3] };
    expect(swapVerdict({ kind: "head", preservation: "pass", likeness: l }).verdict).toBe("fail");
    expect(swapVerdict({ kind: "head", preservation: "pass", likeness: l, rules: { line: 0.25, minFrames: 5, minShare: 0.75 } }).verdict).toBe("pass");
  });
  test("a back view (no scored frames) is inconclusive, never a fail", () => {
    const v = swapVerdict({ kind: "person", preservation: "pass", likeness: { scores: [] } });
    expect(v.verdict).toBe("inconclusive"); expect(v.likenessChecked).toBe(false);
  });
  const good = { scores: [0.5, 0.55, 0.6, 0.48, 0.52, 0.58], actorScores: [0.01, -0.02, 0.03] };
  test("pass needs the preservation pass and enough matching frames", () => {
    const v = swapVerdict({ kind: "head", preservation: "pass", likeness: good });
    expect(v).toEqual({ verdict: "pass", lines: [], likenessFrames: 6, likenessPassing: 6, likenessChecked: true });
  });
  test("a preservation fail fails whatever the likeness", () => { expect(swapVerdict({ kind: "head", preservation: "fail", likeness: good }).verdict).toBe("fail"); });
  test("inconclusive preservation and missing evidence are never a pass", () => {
    expect(swapVerdict({ kind: "head", preservation: "inconclusive", likeness: good }).verdict).toBe("inconclusive");
    expect(swapVerdict({ kind: "head", preservation: null, likeness: good }).verdict).toBe("inconclusive");
    expect(swapVerdict({ kind: "head", preservation: "pass", likeness: null }).verdict).toBe("inconclusive");
  });
  test("fewer than five scored frames is inconclusive and the line says so plainly", () => {
    const v = swapVerdict({ kind: "face", preservation: "pass", likeness: { scores: [0.5, 0.5, 0.5] } });
    expect(v.verdict).toBe("inconclusive"); expect(v.lines[0]).toContain("The swap was made"); expect(v.lines[0]).toContain("only 3 frames"); expect(v.likenessChecked).toBe(false); expect(v.lines.join(" ")).not.toMatch(/fail|bad|wrong/i);
  });
  test("a weak match fails", () => {
    const v = swapVerdict({ kind: "person", preservation: "pass", likeness: { scores: [0.5, 0.2, 0.1, 0.3, 0.4, 0.1] } });
    expect(v.verdict).toBe("fail"); expect(v.likenessPassing).toBe(2);
  });
  test("the source actor still showing fails even with a good match", () => {
    expect(swapVerdict({ kind: "head", preservation: "pass", likeness: { ...good, actorScores: [0.5, 0.6] } }).verdict).toBe("fail");
  });
  test("a fail is never softened by a later inconclusive", () => {
    expect(swapVerdict({ kind: "head", preservation: "fail", likeness: { scores: [] } }).verdict).toBe("fail");
  });
  test("no line uses resource words or the word model", () => {
    const all = [swapVerdict({ kind: "face", preservation: null, likeness: null }), swapVerdict({ kind: "head", preservation: "fail", likeness: { scores: [0.1, 0.1, 0.1, 0.1, 0.1], actorScores: [0.9] } })].flatMap((v) => v.lines).join(" ");
    expect(/\b(memory|RAM|GB|model|VRAM)\b/i.test(all)).toBe(false);
  });
});

describe("which kinds a pack serves", () => {
  test("no kinds line means the head only", () => { expect(servedKinds("{description}\n---measured---\nfps: 24")).toEqual(["head"]); expect(servedKinds("{description}")).toEqual(["head"]); });
  test("a kinds line lists them", () => { expect(servedKinds("x\n---measured---\nkinds: head, person")).toEqual(["head", "person"]); });
  test("an unknown kind says which recipe line to fix", () => { expect(() => servedKinds("x\n---measured---\nkinds: head, body")).toThrow("recipes/swap.md"); });
  test("the refusal line names what to ask for", () => { expect(kindNotServedLine("face", ["head"])).toBe("Swapping only the face is not available on this computer yet. Ask for a swap of the whole head instead."); });
});
