import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { __setCompositeSwapRunnerForTests, compositeSwap, compositeSwapArgs, compositeSwapRequirementsFileFor } from "@/video/compositeSwap";

afterEach(() => { __setCompositeSwapRunnerForTests(null); delete process.env.COMPOSITE_SWAP_PYTHON; });

describe("composite swap caller (fake runner)", () => {
  const input = { source: "/in.mp4", donor: "/donor.mp4", out: "/out.mp4", start: 2.5, seconds: 2.3333, captionBox: [170, 1540, 740, 135] as [number, number, number, number], flowAlpha: 0.7 };
  test("builds the worker command line with every option", () => {
    process.env.COMPOSITE_SWAP_PYTHON = "/py";
    expect(compositeSwapArgs(input, "/w.py")).toEqual(["/py", "/w.py", "--source", "/in.mp4", "--donor", "/donor.mp4", "--out", "/out.mp4", "--start", "2.5", "--seconds", "2.3333", "--caption-box", "170,1540,740,135", "--flow-alpha", "0.7"]);
  });
  test("returns the worker's report on success", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath;
    const report = { frames: 56, size: [1080, 1920], mouth_flicker_original: 2.5, mouth_flicker_raw: 3, mouth_flicker_filtered: 1.5, flicker_ratio: 0.6, flicker_ok: true, residual_original_head_frames: [[3, 0.2]], outside_mask_pixels_changed: 0, recoloured_leftover_skin_pixels: 10 };
    __setCompositeSwapRunnerForTests(async () => ({ code: 0, stdout: `warm-up line\n${JSON.stringify(report)}\n`, stderr: "" }));
    const result = await compositeSwap(input); expect(result.ok).toBe(true); if (result.ok) expect(result.report).toEqual(report as never);
  });
  test("a failure gives the worker's plain line, or a generic one when the output is not readable", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath;
    __setCompositeSwapRunnerForTests(async () => ({ code: 2, stdout: JSON.stringify({ error: "The donor clip was not found. Check that the swap produced it, then try again." }), stderr: "" }));
    expect(await compositeSwap(input)).toEqual({ ok: false, line: "The donor clip was not found. Check that the swap produced it, then try again." });
    __setCompositeSwapRunnerForTests(async () => ({ code: 1, stdout: "Traceback (most recent call last)", stderr: "boom" }));
    const failed = await compositeSwap(input); expect(failed.ok).toBe(false); if (!failed.ok) { expect(failed.line).toContain("Try the swap again"); expect(failed.line).not.toContain("Traceback"); }
    __setCompositeSwapRunnerForTests(async () => { throw new Error("spawn failed"); });
    expect((await compositeSwap(input)).ok).toBe(false);
  });
  test("a missing environment says to install it", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = "/does/not/exist/python";
    const r = await compositeSwap(input); expect(r.ok).toBe(false); if (!r.ok) expect(r.line).toContain("not installed yet");
  });
  test("a cancelled run says so", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath; const controller = new AbortController();
    __setCompositeSwapRunnerForTests(async () => { controller.abort(); return { code: 1, stdout: "", stderr: "" }; });
    const r = await compositeSwap({ ...input, signal: controller.signal }); expect(r.ok).toBe(false); if (!r.ok) expect(r.line).toContain("cancelled");
  });
  test("the macOS Apple silicon requirements file is pinned with hashes", () => {
    const file = compositeSwapRequirementsFileFor("darwin", "arm64"); expect(file).not.toBeNull();
    expect(compositeSwapRequirementsFileFor("linux", "x64")).toBeNull();
  });
});

// The Python unit tests run in the composite environment when it exists (or in COMPOSITE_SWAP_PYTHON); otherwise they are skipped with a plain message.
const python = process.env.COMPOSITE_SWAP_PYTHON_TEST ?? process.env.COMPOSITE_SWAP_PYTHON_FOR_TESTS ?? "";
describe("composite swap Python unit tests", () => {
  test.skipIf(!python || !existsSync(python))("tests/composite_swap/test_composite.py passes (set COMPOSITE_SWAP_PYTHON_TEST to a python with numpy and OpenCV; skipped otherwise)", () => {
    const run = Bun.spawnSync([python, "-m", "unittest", "discover", "-s", join(import.meta.dir, "composite_swap"), "-p", "test_composite.py"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(new TextDecoder().decode(run.stderr)).toContain("OK");
    expect(run.exitCode).toBe(0);
  });
});
