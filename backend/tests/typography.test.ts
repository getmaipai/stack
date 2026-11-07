import { expect, test, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assText, fitTitleFontSize, resolveFonts } from "@/media/typography";
import { normalizeProbe } from "@/media/probe";
import { creditsArgs, titleCardArgs, captionsArgs, type Clip } from "@/media/editOps";
import { spawnRunner } from "@/media/run";

describe("film typography", () => {
  test("ASS escaping preserves Unicode and escapes syntax/control text", () => {
    expect(assText("it's {fine} café\nnext\u0001")).toBe("it\u2019s \\{fine\\} café\\Nnext");
  });
  test("title sizing is monotonic and bounded", () => {
    const sizes = [4, 12, 38, 80].map((n) => fitTitleFontSize("x".repeat(n), 1280, 720));
    const bounded = (n: number) => sizes[n]!;
    expect(bounded(0)).toBeGreaterThanOrEqual(bounded(1)); expect(bounded(1)).toBeGreaterThanOrEqual(bounded(2)); expect(bounded(2)).toBeGreaterThanOrEqual(bounded(3));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(720 / 22); expect(Math.max(...sizes)).toBeLessThanOrEqual(720 / 10);
  });
});

const ffmpeg = process.env.STACK_MEDIA_FFMPEG, ffprobe = process.env.STACK_MEDIA_FFPROBE;
const real = ffmpeg && ffprobe && existsSync(ffmpeg) && existsSync(ffprobe) && resolveFonts() ? test : test.skip;
const mkClip = (width: number, height: number): Clip => ({ path: "lavfi", probe: normalizeProbe({ format: { format_name: "mp4", duration: "2" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", width, height, pix_fmt: "yuv420p", avg_frame_rate: "24/1" }] }, "lavfi", 0) });
async function render(args: string[]): Promise<void> { const result = await spawnRunner(args, { env: { STACK_MEDIA_NO_NICE: "1" } }); if (result.code !== 0) throw new Error(result.stderr); }
async function pixels(path: string, width: number, height: number, time = 0, scratch = tmpdir()): Promise<Uint8Array> {
  const raw = join(scratch, `pixels-${Math.random().toString(16).slice(2)}.rgba`);
  const result = await spawnRunner([ffmpeg!, "-v", "error", "-ss", String(time), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw], { env: { STACK_MEDIA_NO_NICE: "1" } });
  expect(result.code).toBe(0); const data = new Uint8Array(readFileSync(raw)); rmSync(raw, { force: true }); expect(data.length).toBe(width * height * 4); return data;
}
function brightRows(data: Uint8Array, width: number, height: number): number[] { const rows: number[] = []; for (let y = 0; y < height; y++) { let count = 0; for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; if (data[i]! > 170 && data[i + 1]! > 170 && data[i + 2]! > 170) count++; } if (count) rows.push(y); } return rows; }
real("real ffmpeg renders ASS title sizes, credits, and captions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stack-typography-")), fonts = resolveFonts()!;
  try {
    for (const [w, h] of [[1280, 720], [1080, 1920]] as const) {
      for (const title of ["A Long Cinematic Title That Has Thirty Eight Characters", "A Short Title", "The Lighthouse's Secret"]) {
        const script = join(dir, `title-${w}-${title.length}.ass`), out = join(dir, `title-${w}-${title.length}.mp4`), clip = mkClip(w, h);
        const args = titleCardArgs(ffmpeg!, clip, out, { op: "title_card", text: title, subtitle: "A FILM IN THREE PARTS", duration_s: 2, position: "center", background: "black", text_color: "white", place: "start" }, "", script);
        const graph = args[args.indexOf("-filter_complex") + 1]!;
        await render([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=24:d=2`, "-vf", `ass=${script}:fontsdir=${fonts.fontsdir}`, "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
        expect(readFileSync(script, "utf8")).toContain("PlayResX: " + w); expect(graph).toContain("ass=");
        const data = await pixels(out, w, h, 0.9, dir), rows = brightRows(data, w, h);
        if (w === 1280 && title.startsWith("A Long")) { const old = join(dir, "legacy.mp4"); await render([ffmpeg!, "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=24:d=2`, "-vf", "drawtext=text=Legacy:fontsize=h/9:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", old]); const oldPixels = await pixels(old, w, h, 0.9, dir); expect(Buffer.compare(Buffer.from(data), Buffer.from(oldPixels))).not.toBe(0); }
        expect(rows.length).toBeGreaterThan(0); expect(rows.some((y) => y > h * .25 && y < h * .65)).toBe(true);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (data[i]! > 220 && data[i + 1]! > 220 && data[i + 2]! > 220) expect(x).toBeGreaterThan(w * .05), expect(x).toBeLessThan(w * .95); }
        const ruleRow = Math.round(h * .48 + h / 10 * .8); expect(rows.some((y) => Math.abs(y - ruleRow) < h * .08)).toBe(true);
      }
    }
    const creditScript = join(dir, "credits.ass"), clip = mkClip(1280, 720);
    const creditsOut = join(dir, "credits.mp4"); const creditArgs = creditsArgs(ffmpeg!, clip, creditsOut, { op: "credits", lines: Array.from({ length: 6 }, (_, i) => ({ role: `Role ${i}`, name: `Name ${i}` })), duration_s: 12, speed: 60, background: "black", text_color: "white", title: "The Credits" }, "", creditScript);
    const creditRun = [...creditArgs]; creditRun[creditRun.indexOf("-filter_complex") + 1] = creditRun[creditRun.indexOf("-filter_complex") + 1]!.replaceAll("\\'", "'"); await render(creditRun);
    expect(readFileSync(creditScript, "utf8")).toContain("\\move(");
    const creditPixels = await pixels(creditsOut, 1280, 720, 6, dir), columns = new Set<number>(); for (let x = 0; x < 1280; x++) { for (let y = 0; y < 720; y++) { const p = (y * 1280 + x) * 4; if (creditPixels[p]! > 180) { columns.add(Math.floor(x / 5)); break; } } }
    const groups: number[][] = []; for (const x of [...columns].sort((a,b)=>a-b)) { const g = groups[groups.length-1]; if (g && x <= g[g.length-1]! + 2) g.push(x); else groups.push([x]); } expect(groups.filter((g)=>g.length>3).length).toBeGreaterThanOrEqual(2);
    const captionScript = join(dir, "captions.ass");
    const captionOut = join(dir, "caption.mp4"), captionArgs = captionsArgs(ffmpeg!, clip, captionOut, { op: "captions", position: "bottom", lines: [{ from_s: 0, to_s: 2, text: "A caption rendered at the bottom of the frame." }] }, "", captionScript); const captionRun = [...captionArgs]; captionRun[captionRun.indexOf("-vf") + 1] = captionRun[captionRun.indexOf("-vf") + 1]!.replaceAll("\\'", "'"); captionRun[captionRun.indexOf("-i") + 1] = "-f";
    // Use a generated lavfi picture as the input while retaining the production subtitle filter.
    captionRun.splice(captionRun.indexOf("-i"), 2, "-f", "lavfi", "-i", "color=c=black:s=1280x720:d=2"); await render(captionRun);
    expect(readFileSync(captionScript, "utf8")).toContain("Caption,");
    const captionPixels = await pixels(captionOut, 1280, 720, .7, dir), captionRows = brightRows(captionPixels, 1280, 720); expect(captionRows.length).toBeGreaterThan(0); expect(Math.min(...captionRows)).toBeGreaterThan(480);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000); // real ffmpeg renders; a busy machine (load 19 seen 2026-11-06) pushed it past bun's 5 s default
