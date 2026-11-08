import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runMix } from "./mix";
import { precheck } from "./jobs";
import { jobDir, releaseJobDir } from "./paths";

const configuredFfmpeg = process.env.STACK_MEDIA_FFMPEG ?? "ffmpeg";
const ffmpeg = spawnSync(configuredFfmpeg, ["-version"], { stdio: "ignore" }).status === 0;
if (!ffmpeg) console.info(`media.mix test skipped: ffmpeg is unavailable at ${configuredFfmpeg}`);
describe("media.mix", () => {
  (ffmpeg ? it : it.skip)("mixes offset tracks and ducks during the sidechain", async () => {
    // Job folders are the one place a test may read and write without Home declaring media roots.
    const dir = jobDir("mix-test-inputs");
    const a = join(dir, "a.wav"), b = join(dir, "b.wav");
    spawnSync(configuredFfmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", a]); spawnSync(configuredFfmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-c:a", "pcm_s16le", b]);
    try {
      const run = (id: string, duck: { under: number[]; by_db: number } | null, name: string) => runMix({ id, input: { tracks: [{ path: a, start_ms: 0 }, { path: b, start_ms: 500 }], output: { name }, duck } } as never, new AbortController().signal, () => {});
      const plain = await run("mix-plain", null, "plain.wav"); const ducked = await run("mix-duck", { under: [1], by_db: 8 }, "ducked.wav");
      expect(ducked.duration_s).toBeGreaterThan(1.4); expect(ducked.duration_s).toBeLessThan(1.7);
      const measure = (path: string) => { const result = spawnSync(configuredFfmpeg, ["-i", path, "-af", "atrim=start=0.6:duration=0.3,volumedetect", "-f", "null", "-"], { encoding: "utf8" }); const value = /mean_volume: ([\-\d.]+) dB/.exec(result.stderr)?.[1]; if (!value) throw new Error("ffmpeg could not measure the mixed audio level. Check the test output and try again."); return Number(value); };
      expect(measure(ducked.path)).toBeLessThan(measure(plain.path));
      const m4a = await runMix({ id: "mix-m4a", input: { tracks: [{ path: a, start_ms: 0, end_ms: 800, fade_out_ms: 200 }, { path: b, start_ms: 300 }], output: { name: "show.m4a" }, chapters: [{ start_ms: 0, title: "Hook" }, { start_ms: 600, title: "Weather" }] } } as never, new AbortController().signal, () => {});
      expect(m4a.path.endsWith("show.m4a")).toBe(true); expect(m4a.duration_s).toBeGreaterThan(1.1); expect(m4a.duration_s).toBeLessThan(1.5); expect(m4a.sha256).toHaveLength(64);
      const chapters = spawnSync(configuredFfmpeg, ["-i", m4a.path, "-f", "null", "-"], { encoding: "utf8" }).stderr; expect(chapters).toContain("Weather");
    } finally { for (const id of ["mix-test-inputs", "mix-plain", "mix-duck", "mix-m4a"]) releaseJobDir(id); }
  });
});

describe("media.mix admission", () => {
  it("checks a mix job's own fields, not a link to fetch", () => {
    expect(precheck("media.mix")({ tracks: [] })?.reason).toContain("tracks");
    expect(precheck("media.mix")({ tracks: [] })?.reason).not.toContain("url");
  });
});
