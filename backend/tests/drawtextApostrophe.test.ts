import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { drawTextEscape, filterEscape } from "@/media/editOps";

describe("title, credit and caption text with an apostrophe (found 2026-11-06: 'The Lighthouse's Secret' broke the title card)", () => {
  test("no straight apostrophe survives inside a single-quoted drawtext value", () => {
    for (const text of ["The Lighthouse's Secret", "it's", "'quoted'", "rock 'n' roll: 100% fun"]) {
      expect(drawTextEscape(text)).not.toContain("'");
      expect(filterEscape(text)).not.toContain("'");
    }
    expect(drawTextEscape("The Lighthouse's Secret")).toBe("The Lighthouse’s Secret");
  });
  test("other specials are still escaped", () => {
    expect(drawTextEscape("a:b")).toBe("a\\:b");
    expect(drawTextEscape("50%")).toBe("50\\%");
    expect(filterEscape("{x}")).toBe("\\{x\\}");
  });
  test("ffmpeg draws the text when the real binary is available", async () => {
    const ffmpeg = process.env.STACK_MEDIA_FFMPEG;
    if (!ffmpeg || !existsSync(ffmpeg)) return;
    const font = "/System/Library/Fonts/Supplemental/Arial.ttf";
    if (!existsSync(font)) return;
    const proc = Bun.spawn([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1", "-vf", `drawtext=fontfile='${drawTextEscape(font)}':text='${drawTextEscape("The Lighthouse's Secret")}':fontsize=h/9:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", "-f", "null", "-"], { stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });
});
