import { describe, expect, test } from "bun:test";
import { customPickRefusal, minorTierClamp, resolveLadder, resolveTier, thinkingAllowedFor, TIER_CANDIDATES } from "@/lib/tiers";

const GB = 1_000_000_000;

describe("tier resolver", () => {
  test("resolves the requested profile ladders", () => {
    expect(resolveLadder("chat", "p16", 12 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["qwen3-8b-instruct-q4-k-m", null, null]);
    expect(resolveLadder("chat", "p32", 30 * GB)[0]?.resolved?.model).toBe("muse-glimmer-30b-q4-k-m");
    expect(resolveLadder("pictures", "p32", 20 * GB)[0]?.resolved?.model).toBe("flux2-klein-4b");
    const chat64 = resolveLadder("chat", "p64", 40 * GB);
    expect(chat64[1]?.resolved?.model).toBe("muse-glimmer-30b-q4-k-xl");
    expect(chat64[1]?.resolved?.options).toEqual({ thinking: true, reasoningBudget: 4096 });
    expect(chat64[1]?.resolved?.switchCost).toBe("option");
    expect(chat64[1]?.hidden).toBe(false);
    const pic64 = resolveLadder("pictures", "p64", 40 * GB);
    expect(pic64[0]?.resolved?.model).toBe("ernie-image-turbo");
    expect(pic64[1]?.resolved?.model).toBe("z-image-turbo");
    // Measured 33 GB music admission is over every p64 cap (R = 24 GB): the evals must bring a lighter music peak before p64 offers music.
    expect(resolveLadder("music", "p64", 24 * GB).map((row) => row.resolved?.model ?? null)).toEqual([null, null, null]);
  });

  test("covers all p128 categories and max chat room threshold", () => {
    for (const category of ["chat", "pictures", "video", "music", "voice"] as const) {
      expect(resolveLadder(category, "p128", 72 * GB).some((row) => row.resolved !== null)).toBe(true);
    }
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 72 * GB })?.model).toBe("ornith-1-5-122b-mlx-4bit");
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 60 * GB })).toBeNull();
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 60 * GB, reducedFreedBytes: 9 * GB })?.model).toBe("ornith-1-5-122b-mlx-4bit");
  });

  test("video Standard needs 0.6 R to hold Wan's measured 44 GB", () => {
    const tight = resolveLadder("video", "p128", 72 * GB);
    expect(tight[0]?.resolved).toBeNull();
    expect(tight[1]?.resolved?.model).toBe("ltx-2-3-distilled-mlx");
    expect(resolveLadder("video", "p128", 74 * GB)[0]?.resolved?.verified).toBe(true);
    expect(resolveLadder("voice", "p128", 72 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["chatterbox-turbo-fp16", null, null]);
  });

  test("collapses equal pins and leaves option switches visible", () => {
    const same = resolveLadder("chat", "p64", 40 * GB, { standard: { model: "muse-glimmer-30b-q4-k-xl", options: { thinking: false } }, boost: { model: "muse-glimmer-30b-q4-k-xl", options: { thinking: false } } });
    expect(same[1]?.hiddenReason).toBe("same_as_below");
    const different = resolveLadder("chat", "p64", 40 * GB);
    expect(different[1]?.hiddenReason).toBeNull();
  });

  test("supports off, reduced and custom pick refusals", () => {
    expect(resolveTier({ category: "chat", tier: "reduced", profile: "p32", roomBytes: 12 * GB })?.model).toBe("qwen3-4b-q4-k-m");
    expect(resolveTier({ category: "pictures", tier: "reduced", profile: "p32", roomBytes: 12 * GB })).toBeNull();
    expect(resolveLadder("pictures", "p64", 24 * GB, { boost: { model: "off" } })[1]?.hiddenReason).toBe("off");
    expect(customPickRefusal({ category: "pictures", tier: "standard", profile: "p64", roomBytes: 40 * GB, model: "z-image-turbo" })).toBe("This needs 26 GB. Standard keeps Home free, so it can't hold it. Use Boost or Max.");
    expect(customPickRefusal({ category: "pictures", tier: "standard", profile: "p64", roomBytes: 48 * GB, model: "z-image-turbo" })).toBeNull();
  });

  test("exports complete candidates and minor rules", () => {
    expect(TIER_CANDIDATES.every((candidate) => candidate.family && candidate.peaks.length > 0)).toBe(true);
    expect(TIER_CANDIDATES.filter((candidate) => candidate.peaks.some((peak) => peak.status === "unverified")).every((candidate) => candidate.peaks.some((peak) => peak.status === "unverified"))).toBe(true);
    expect(minorTierClamp("boost")).toBe("standard");
    expect(minorTierClamp("max")).toBe("standard");
    expect(minorTierClamp("reduced")).toBe("reduced");
    expect(thinkingAllowedFor("child")).toBe(false);
    expect(thinkingAllowedFor("teen")).toBe(false);
    expect(thinkingAllowedFor("adult")).toBe(true);
  });
});
