import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { StackVideoReceipt } from "@maipai/spec/stack/ts/stack-video-receipt.js";
import { faceCheckReceipt, measureClipFaces, runFirstPictureLoop, scoreFirstPicture, type FaceTools } from "@/lib/faceCheck";
import { referenceClipRules } from "@/packs/loader";

const rules = referenceClipRules("ltx-2-5-bf16-distilled-mlx-max");
if (!rules) throw new Error("Test pack has no reference clip rules");
const vec = (x: number, y = 0): Float32Array => Float32Array.from([x, y]);
const tools = (faces: FaceTools["faces"]): FaceTools => ({ faces, cosine: (a, b) => a[0]! * b[0]! + a[1]! * b[1]! });
const close = tools(async () => [ { vec: vec(1) } ]);
const base = JSON.parse(await readFile(new URL("../node_modules/@maipai/spec/fixtures/stack-video-receipt/valid-native-delivered.json", import.meta.url), "utf8"));

describe("face checks", () => {
  test("redraws until the first picture passes and records redraw count", async () => {
    let calls = 0;
    const result = await runFirstPictureLoop({ photoVecs: [vec(1)], rules, tools: close, async draw(attempt) { calls++; return Uint8Array.of(attempt); } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.redraws).toBe(0);
    expect(calls).toBe(1);
  });

  test("passes on a later attempt and refuses after redraw bound", async () => {
    let calls = 0;
    const later = await runFirstPictureLoop({ photoVecs: [vec(1)], rules, tools: tools(async () => [ { vec: vec(calls++ === 0 ? 0 : 1) } ]), async draw() { return new Uint8Array(); } });
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.receipt.redraws).toBe(1);
    calls = 0;
    const never = await runFirstPictureLoop({ photoVecs: [vec(1)], rules, tools: tools(async () => []), async draw() { calls++; return new Uint8Array(); } });
    expect(never.ok).toBe(false);
    expect(calls).toBe(rules.redraws + 1);
    if (!never.ok) expect(never.receipt.redraws).toBe(rules.redraws);
  });

  test("a thrown draw counts as failure while abort propagates", async () => {
    let calls = 0;
    const result = await runFirstPictureLoop({ photoVecs: [vec(1)], rules, tools: close, async draw() { calls++; if (calls === 1) throw new Error("failed draw"); return new Uint8Array(); } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.receipt.redraws).toBe(1);
    await expect(runFirstPictureLoop({ photoVecs: [vec(1)], rules, tools: close, async draw() { throw new DOMException("Aborted", "AbortError"); } })).rejects.toMatchObject({ name: "AbortError" });
  });

  test("measures per-person median, skips empty frames, rounds, and flags low", async () => {
    const matched = [vec(0.5), vec(0.354), vec(0.6)];
    let n = 0;
    const result = await measureClipFaces({ frames: [0, 1, 2, 3].map((x) => Uint8Array.of(x)), photoVecs: [vec(1)], rules, tools: tools(async () => { const i = n++; return i === 1 ? [] : [{ vec: matched[i === 0 ? 0 : i - 2]! }]; }) });
    expect(result).toEqual({ frames: 3, people: [{ index: 0, median: 0.5, low: false }] });
    const lowRules = { ...rules, clip_face_low: 0.51 };
    expect(result?.people[0]?.median).toBe(0.5);
    const low = await measureClipFaces({ frames: [new Uint8Array()], photoVecs: [vec(1)], rules: lowRules, tools: tools(async () => [{ vec: vec(0.354) }]) });
    expect(low?.people[0]?.low).toBe(true);
  });

  test("returns null when face tools or usable photo vectors are unavailable", async () => {
    expect(await measureClipFaces({ frames: [new Uint8Array()], photoVecs: [vec(1)], rules, tools: tools(async () => null) })).toBeNull();
    expect(await measureClipFaces({ frames: [], photoVecs: [null], rules, tools: close })).toBeNull();
  });

  test("scores failures and emits a receipt accepted by the pinned spec", async () => {
    const scored = await scoreFirstPicture(new Uint8Array(), [null, vec(1)], rules, tools(async () => null));
    expect(scored).toEqual({ ok: false, people: [{ index: 0, score: null, pass: false }, { index: 1, score: null, pass: false }] });
    const face_check = faceCheckReceipt({ rules, first: { redraws: 1, people: scored.people }, clip: { frames: 0, people: [{ index: 0, median: null, low: false }] } });
    expect(StackVideoReceipt.parse({ ...base, face_check })).toMatchObject({ face_check });
  });
});
