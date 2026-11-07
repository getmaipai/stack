import { describe, expect, test } from "bun:test";
import { imageDimensions, validateStillMaskPrompt } from "@/media/maskStill";
import { maskWorkerScript } from "@/video/mask";

describe("still-picture SAM prompts", () => {
  test("accepts a box together with positive and negative points", () => {
    expect(validateStillMaskPrompt({ box: [2, 3, 20, 30], points: [{ x: 5, y: 6, label: 1 }, { x: 15, y: 15, label: 0 }] }, 40, 50)).toEqual({ box: [2, 3, 20, 30], points: [{ x: 5, y: 6, label: 1 }, { x: 15, y: 15, label: 0 }] });
  });
  test("rejects malformed boxes, outside points, too many points and an empty prompt", () => {
    expect(validateStillMaskPrompt({ box: [1, 2, 3] }, 40, 50)).toBeNull();
    expect(validateStillMaskPrompt({ points: [{ x: 40, y: 1, label: 1 }] }, 40, 50)).toBeNull();
    expect(validateStillMaskPrompt({ points: Array.from({ length: 17 }, () => ({ x: 1, y: 1, label: 1 })) }, 40, 50)).toBeNull();
    expect(validateStillMaskPrompt({}, 40, 50)).toBeNull();
  });
  test("still worker passes box and points together; video request branch remains box-or-points", async () => {
    const source = await Bun.file(maskWorkerScript).text();
    expect(source).toContain('if req.get("op") == "segment":');
    expect(source).toContain('predictor.add_new_points_or_box(state, frame_idx=0, obj_id=1, **kwargs)');
    expect(source).toContain('kwargs["box"] = prompt["box"]');
    expect(source).toContain('kwargs["points"] = np.array');
  });
});

test.skipIf(process.env.STACK_TEST_REAL_MASK !== "1")("real SAM still smoke test is opt-in", () => {
  // The live model is intentionally never loaded by default.
});

test("reads PNG dimensions without running a media tool", () => {
  const png = new Uint8Array(24); png.set([137, 80, 78, 71]); new DataView(png.buffer).setUint32(16, 400); new DataView(png.buffer).setUint32(20, 300);
  expect(imageDimensions(png)).toEqual({ width: 400, height: 300 });
});
