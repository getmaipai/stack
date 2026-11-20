import { describe, expect, test } from "bun:test";
import { videoRecipe, videoRecipeAdapterReady } from "@/video/recipes";
import { loadPacks, packFor } from "@/packs/loader";
import { PACK_SOURCES } from "@/packs/index.generated";

const HD_FLOOR = 77_700_000_000;

describe("videoRecipe (VF-PROFILE-01): the chosen recipe is read from the pack", () => {
  test("H3 Standard is the preview recipe: 7 steps with its required turbo adapter; Boost is the quality recipe: 24 steps, no adapter", () => {
    const standard = videoRecipe("h3", "standard", "clip_text")!.recipe;
    expect(standard).toMatchObject({ profile: "preview", steps: 7, schedule: "h3-turbo-7", label: "Standard", adapter: { id: "minimax_h3_turbo_v4_step600_ema", required: true } });
    const boost = videoRecipe("h3", "boost", "clip_text")!.recipe;
    expect(boost).toMatchObject({ profile: "quality", steps: 24, label: "Boost" });
    expect(boost.adapter).toBeUndefined();
    expect(boost.finish!.map((step) => step.op)).toEqual(["model_upscale", "audio_lead_in"]);
  });
  test("the build follows the caller's choice: resident h3 or streaming h3stream", () => {
    expect(videoRecipe("h3", "standard", "clip_text", undefined, Number.MAX_SAFE_INTEGER, "h3")!.quality).toBe("h3");
    expect(videoRecipe("h3", "standard", "clip_text", undefined, Number.MAX_SAFE_INTEGER, "h3stream")!.quality).toBe("h3stream");
  });
  test("a level the table lacks gives null, never a guess", () => {
    expect(videoRecipe("h3", "max", "clip_text")).toBeNull();
    expect(videoRecipe("ltx25", "max", "clip_text")).toBeNull();
  });
  test("Max HD (1920x1088) is chosen only for film shots and enhance, and only when the memory floor is admitted; otherwise the plain Max recipe", () => {
    for (const operation of ["clip_film_shot", "enhance"] as const) {
      const hd = videoRecipe("ltx25max", "max", operation, undefined, HD_FLOOR)!.recipe;
      expect(hd.size).toEqual({ width: 1920, height: 1088 });
      expect(hd.finish).toEqual([
        { op: "crop", params: expect.objectContaining({ width: 1920, height: 1080 }) },
        { op: "unsharp", params: { luma_x: 5, luma_y: 5, amount: 0.4 } },
      ]);
      expect(videoRecipe("ltx25max", "max", operation, undefined, HD_FLOOR - 1)!.recipe.size).toBeUndefined();
    }
    expect(videoRecipe("ltx25max", "max", "clip_text", undefined, Number.MAX_SAFE_INTEGER)!.recipe.size).toBeUndefined();
    expect(videoRecipe("ltx25max", "max", "clip_start_picture", undefined, Number.MAX_SAFE_INTEGER)!.recipe.size).toBeUndefined();
  });
  test("the adapter check follows the recipe, never a file that happens to exist", () => {
    expect(videoRecipeAdapterReady("h3", "standard", "clip_text", undefined, Number.MAX_SAFE_INTEGER, "/m", () => false)).toBe(false);
    expect(videoRecipeAdapterReady("h3", "standard", "clip_text", undefined, Number.MAX_SAFE_INTEGER, "/m", (path) => path === "/m/loras/minimax_h3_turbo_v4_step600_ema.safetensors")).toBe(true);
    expect(videoRecipeAdapterReady("h3", "boost", "clip_text", undefined, Number.MAX_SAFE_INTEGER, "/m", () => false)).toBe(true);
  });
  test("every clip recipe carries a label and a plain description with no model names, pixel counts or memory words", () => {
    for (const engine of ["ltx25", "ltx25max", "h3"] as const) {
      for (const level of ["standard", "boost", "max"] as const) {
        const selected = videoRecipe(engine, level, "clip_text");
        if (!selected) continue;
        expect(selected.recipe.label, `${engine} ${level}`).toBeTruthy();
        expect(selected.recipe.description ?? "", `${engine} ${level}`).not.toMatch(/\bGB\b|\bRAM\b|memory|\d{3,}|MiniMax|LTX/i);
      }
    }
  });
});

describe("pack profile validation at load", () => {
  const source = PACK_SOURCES.find((item) => item.dir === packFor("minimax-h3")?.dir)!;
  const withProfiles = (profiles: unknown[]) => {
    const pack = structuredClone(source.pack) as { jobs: Array<{ job: string; profiles?: unknown[] }> };
    pack.jobs.find((job) => job.job === "clip")!.profiles = profiles;
    return [{ ...source, pack }] as unknown as typeof PACK_SOURCES;
  };
  const base = { level: "standard", profile: "preview", steps: 7, checkpoint: "c", schedule: "s", prompt_format: "p" };
  test("two recipes for one level and size are refused", () => {
    expect(() => loadPacks(withProfiles([base, base]))).toThrow(/two profiles/);
  });
  test("a required adapter without an id is refused", () => {
    expect(() => loadPacks(withProfiles([{ ...base, adapter: { id: " ", strength: 1, required: true } }]))).toThrow(/needs an id/);
  });
  test("an unknown finish operation is refused", () => {
    expect(() => loadPacks(withProfiles([{ ...base, finish: [{ op: "sparkle" }] }]))).toThrow(/invalid|unknown finish/);
  });
  test("a recipe for a level the job's limits lack is refused", () => {
    expect(() => loadPacks(withProfiles([{ ...base, level: "max" }]))).toThrow(/missing from limits/);
  });
});

describe("Max HD row (measured in the proof of concept, not yet re-measured by the Stack)", () => {
  test("the row is admitted at its own measured peak plus headroom and the 1024x576 row is unchanged", async () => {
    const { ltx25MaxPeakBytes, ltx25MaxRefusal, LTX25_MAX_MEASURED } = await import("@/video/ltx25");
    const { videoAdmission } = await import("@/video/jobs");
    expect(LTX25_MAX_MEASURED.map((row) => row.size)).toEqual(["1024x576", "1920x1088"]);
    expect(ltx25MaxPeakBytes(false, "1920x1088")).toBe(77_700_000_000);
    expect(ltx25MaxPeakBytes(false)).toBeLessThan(ltx25MaxPeakBytes(false, "1920x1088"));
    expect(videoAdmission({ quality: "ltx25max", size: "1920x1088", seconds: 5, mode: "text-to-video" }).requestedBytes).toBeGreaterThanOrEqual(77_700_000_000);
    expect(videoAdmission({ quality: "ltx25max", size: "1024x576", seconds: 5, mode: "text-to-video" }).requestedBytes).toBeLessThan(77_000_000_000);
    expect(ltx25MaxRefusal(1920, 1088, 121)).toBeNull();
    expect(ltx25MaxRefusal(1920, 1088, 145)).toContain("at most 5 seconds");
  });
});
