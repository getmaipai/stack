import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { __setCompositeSwapRunnerForTests, analyzeClip, compositeSwap, compositeSwapArgs, compositeSwapEnv, compositeSwapRequirementsFileFor, referenceCrops } from "@/video/compositeSwap";

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

describe("composite swap: the media tools handoff and the other two worker modes (SWAP-01)", () => {
  const saved = { ffmpeg: process.env.STACK_MEDIA_FFMPEG, ffprobe: process.env.STACK_MEDIA_FFPROBE };
  afterEach(() => { for (const [key, value] of [["STACK_MEDIA_FFMPEG", saved.ffmpeg], ["STACK_MEDIA_FFPROBE", saved.ffprobe]] as const) value === undefined ? delete process.env[key] : process.env[key] = value; });
  test("the worker gets the Stack's ffmpeg and ffprobe under the names the whole Stack uses, and the older names too", () => {
    delete process.env.STACK_MEDIA_FFMPEG; delete process.env.STACK_MEDIA_FFPROBE;
    expect(compositeSwapEnv({ ffmpeg: "/tools/ffmpeg", ffprobe: "/tools/ffprobe" })).toMatchObject({ STACK_MEDIA_FFMPEG: "/tools/ffmpeg", STACK_MEDIA_FFPROBE: "/tools/ffprobe", COMPOSITE_SWAP_FFMPEG: "/tools/ffmpeg", COMPOSITE_SWAP_FFPROBE: "/tools/ffprobe" });
  });
  test("with no path from the caller, the path already in STACK_MEDIA_FFMPEG and STACK_MEDIA_FFPROBE is passed on; a caller's path wins", () => {
    process.env.STACK_MEDIA_FFMPEG = "/env/ffmpeg"; process.env.STACK_MEDIA_FFPROBE = "/env/ffprobe";
    expect(compositeSwapEnv()).toMatchObject({ STACK_MEDIA_FFMPEG: "/env/ffmpeg", STACK_MEDIA_FFPROBE: "/env/ffprobe" });
    expect(compositeSwapEnv({ ffmpeg: "/own/ffmpeg" })).toMatchObject({ STACK_MEDIA_FFMPEG: "/own/ffmpeg", STACK_MEDIA_FFPROBE: "/env/ffprobe" });
  });
  test("a run passes the resolved tools to the worker's environment", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath; let seen: Record<string, string> = {};
    __setCompositeSwapRunnerForTests(async (_command, env) => { seen = env; return { code: 0, stdout: JSON.stringify({ frames: 1 }), stderr: "" }; });
    await compositeSwap({ source: "/a.mp4", donor: "/b.mp4", out: "/c.mp4", ffmpeg: "/tools/ffmpeg", ffprobe: "/tools/ffprobe" });
    expect(seen.STACK_MEDIA_FFMPEG).toBe("/tools/ffmpeg"); expect(seen.STACK_MEDIA_FFPROBE).toBe("/tools/ffprobe");
    expect(seen.HOME).toContain("home");   // the managed environment: nothing lands in the person's account
  });
  test("the source's own frame rate is passed only when given", () => {
    process.env.COMPOSITE_SWAP_PYTHON = "/py";
    expect(compositeSwapArgs({ source: "/s", donor: "/d", out: "/o", fps: 29.97 }, "/w.py").slice(-2)).toEqual(["--fps", "29.97"]);
    expect(compositeSwapArgs({ source: "/s", donor: "/d", out: "/o" }, "/w.py")).not.toContain("--fps");
  });
  test("analysis asks for the caption box, the people and the framing per segment", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath; let command: string[] = [];
    const analysis = { caption_box: [1, 2, 3, 4], size: [1080, 1920], people_max: 1, many_people_share: 0, segments: [{ edge_contact: false }, { edge_contact: true }] };
    __setCompositeSwapRunnerForTests(async (c) => { command = c; return { code: 0, stdout: `${JSON.stringify(analysis)}\n`, stderr: "" }; });
    const result = await analyzeClip({ source: "/in.mp4", start: 1, seconds: 4, segments: [[1, 2], [3, 2]] });
    expect(result).toEqual({ ok: true, analysis } as never);
    expect(command.slice(2)).toEqual(["--mode", "analyze", "--source", "/in.mp4", "--start", "1", "--seconds", "4", "--segments", "1:2,3:2"]);
  });
  test("reference crops come back as paths, and a refusal keeps the worker's plain line and its code", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = process.execPath;
    __setCompositeSwapRunnerForTests(async () => ({ code: 0, stdout: JSON.stringify({ crops: ["/d/c1.png"] }), stderr: "" }));
    expect(await referenceCrops({ references: ["/a.png"], outDir: "/d" })).toEqual({ ok: true, crops: ["/d/c1.png"] });
    __setCompositeSwapRunnerForTests(async () => ({ code: 2, stdout: JSON.stringify({ error: "Reference picture 2 shows 2 people. Use a picture of one person, or crop the picture to one person first.", code: "many_people" }), stderr: "" }));
    expect(await referenceCrops({ references: ["/a.png", "/b.png"], outDir: "/d" })).toEqual({ ok: false, line: "Reference picture 2 shows 2 people. Use a picture of one person, or crop the picture to one person first.", code: "many_people" });
  });
  test("with no environment the line says to install it, for every worker mode", async () => {
    process.env.COMPOSITE_SWAP_PYTHON = "/does/not/exist/python";
    for (const result of [await analyzeClip({ source: "/s", start: 0, seconds: 1, segments: [] }), await referenceCrops({ references: [], outDir: "/d" })]) { expect(result.ok).toBe(false); if (!result.ok) { expect(result.line).toContain("not installed yet"); expect(result.code).toBe("environment_missing"); } }
  });
});

// The Python unit tests run in the composite environment when it exists (or in COMPOSITE_SWAP_PYTHON); otherwise they are skipped with a plain message.
const python = process.env.COMPOSITE_SWAP_PYTHON_TEST ?? process.env.COMPOSITE_SWAP_PYTHON_FOR_TESTS ?? "";
describe("composite swap Python unit tests", () => {
  test.skipIf(!python || !existsSync(python))("tests/composite_swap/test_composite.py passes (set COMPOSITE_SWAP_PYTHON_TEST to a python with numpy and OpenCV; skipped otherwise)", () => {
    const run = Bun.spawnSync([python, "-m", "unittest", "discover", "-s", join(import.meta.dir, "composite_swap"), "-p", "test_composite.py"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(new TextDecoder().decode(run.stderr)).toContain("OK");
    expect(run.exitCode).toBe(0);
  }, 180_000);
});
