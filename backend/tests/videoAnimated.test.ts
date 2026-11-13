import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { app } from "@/app";
import { animatedArgs } from "@/video/animated";

test("animatedArgs builds a two pass looping GIF and clamps options", () => {
  const args = animatedArgs("gif", { width: 900, fps: 2 });
  expect(args.join(" ")).toContain("fps=5,scale=720:-1:flags=lanczos");
  expect(args.join(" ")).toContain("split[a][b];[a]palettegen[p];[b][p]paletteuse");
  expect(args).toContain("-loop"); expect(args).toContain("0");
});

test("animatedArgs selects animated WebP and clamps upper bounds", () => {
  const args = animatedArgs("webp", { width: 100, fps: 99 });
  expect(args.join(" ")).toContain("fps=20,scale=160:-1:flags=lanczos");
  expect(args.join(" ")).toContain("libwebp_anim -loop 0 -q:v 60");
});

test("animated route validates format and requires a body", async () => {
  const bad = await app.request("/v1/videos/animated?format=mp4", { method: "POST", headers: { "content-type": "video/mp4" }, body: new Uint8Array([1]) });
  expect(bad.status).toBe(400);
  const missing = await app.request("/v1/videos/animated?format=gif", { method: "POST", headers: { "content-type": "video/mp4" } });
  expect(missing.status).toBe(400);
});

const FFMPEG = process.env.VIDEO_FFMPEG_TEST ?? "";
const CLIP = process.env.VIDEO_TEST_CLIP ?? "";
test.skipIf(!(FFMPEG && existsSync(FFMPEG) && CLIP && existsSync(CLIP)))("real GIF conversion returns an animation", async () => {
  process.env.VIDEO_FFMPEG = FFMPEG;
  try {
    const response = await app.request("/v1/videos/animated?format=gif&seconds=2", { method: "POST", headers: { "content-type": "video/mp4" }, body: readFileSync(CLIP) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await response.arrayBuffer()).slice(0, 6)).toEqual(new TextEncoder().encode("GIF89a"));
  } finally { delete process.env.VIDEO_FFMPEG; }
});
