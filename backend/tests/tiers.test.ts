import { describe, expect, test } from "bun:test";
import { STACK_IMAGE_ERNIE_ID, STACK_IMAGE_KLEIN_ID, STACK_IMAGE_ZIMAGE_ID, STACK_MUSIC_MODEL_ID, STACK_VIDEO_MODEL_ID } from "@/lib/modelCatalog";
import { budgetSlots, tierCandidateLists, tierCapBytes, customPickRefusal, minorTierClamp, resolveLadder, resolveTier, thinkingAllowedFor, TIER_CANDIDATES } from "@/lib/tiers";

const GB = 1_000_000_000;

describe("tier resolver", () => {
  test("reports resolved tier peaks for the budget route", () => {
    const slots = budgetSlots("p128", 72 * GB);
    for (const category of ["chat", "pictures", "video", "music"] as const) {
      const ladder = resolveLadder(category, "p128", 72 * GB);
      for (const { tier, resolved } of ladder) {
        if (!resolved) continue;
        expect(slots.find((row) => row.category === category && row.tier === tier)).toMatchObject({ peak_bytes: resolved.peakBytes, model: resolved.model, verified: resolved.verified });
      }
    }
    const reduced = resolveTier({ category: "chat", tier: "reduced", profile: "p128", roomBytes: 72 * GB });
    expect(slots.find((row) => row.category === "chat" && row.tier === "reduced")?.peak_bytes).toBe(reduced?.peakBytes);
    expect(slots.filter((row) => row.peak_bytes !== null).map(({ category, tier }) => `${category}:${tier}`)).toEqual(["chat:reduced", "chat:standard", "chat:boost", "chat:max", "pictures:standard", "pictures:boost", "pictures:max", "video:standard", "video:max", "music:standard", "voice:reduced", "voice:standard", "stems:standard"]);
    // p16 has the streaming MiniMax H3-Image as its Standard picture candidate (H3-IMAGE-STACK-01); nothing else but chat, voice and stems.
    expect(budgetSlots("p16", 12 * GB).filter((row) => row.peak_bytes !== null).every((row) => row.category === "chat" || row.category === "voice" || row.category === "stems" || (row.category === "pictures" && row.tier === "standard" && row.model === "minimax-h3-image"))).toBe(true);
    expect(budgetSlots("p16", 12 * GB).some((row) => row.category === "video" || row.category === "music")).toBe(false);
    expect(budgetSlots(null)).toEqual([]);
  });

  test("resolves the requested profile ladders", () => {
    expect(resolveLadder("chat", "p16", 12 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["qwen3-8b-instruct-q4-k-m", null, null]);
    expect(resolveLadder("chat", "p32", 30 * GB)[0]?.resolved?.model).toBe("qwen3-8b-instruct-q4-k-m");
    // Standard pictures on a 32 GB computer: MiniMax H3-Image streaming (2.5 GB) is recommended; FLUX.2 Klein stays a candidate and can be picked.
    expect(resolveLadder("pictures", "p32", 20 * GB)[0]?.resolved).toMatchObject({ model: "minimax-h3-image", peakBytes: 2_500_000_000, options: { ditMode: "stream" } });
    expect(resolveTier({ category: "pictures", tier: "standard", profile: "p32", roomBytes: 20 * GB, slot: { model: "flux2-klein-4b" } })?.model).toBe("flux2-klein-4b");
    const chat64 = resolveLadder("chat", "p64", 40 * GB);
    expect(chat64[0]?.resolved?.model).toBe("qwen3-8b-instruct-q4-k-m");
    expect(chat64[1]?.resolved?.model).toBe("qwen3.8-27b-ud-q4-k-m");
    expect(chat64[1]?.resolved?.options).toEqual({ thinking: true });
    expect(chat64[1]?.hidden).toBe(false);
    const pic64 = resolveLadder("pictures", "p64", 40 * GB);
    expect(pic64[0]?.resolved?.model).toBe("minimax-h3-image");
    // Boost picks the same MiniMax H3-Image as Standard, so the ladder collapses the rung (Z-Image stays a pickable Boost candidate).
    expect(pic64[1]?.resolved?.model).toBe("minimax-h3-image");
    expect(pic64[1]?.hiddenReason).toBe("same_as_below");
    // Measured 16.4 GB music peak: Standard needs 0.6 R, so R = 24 GB is still short and R = 28 GB holds it. Boost and Max music stay empty.
    expect(resolveLadder("music", "p64", 24 * GB).map((row) => row.resolved?.model ?? null)).toEqual([null, null, null]);
    expect(resolveLadder("music", "p64", 28 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["ace-step-1-5-turbo", null, null]);
  });

  test("covers all p128 categories and max chat room threshold", () => {
    for (const category of ["chat", "pictures", "video", "music", "voice"] as const) {
      expect(resolveLadder(category, "p128", 72 * GB).some((row) => row.resolved !== null)).toBe(true);
    }
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 72 * GB })?.model).toBe("ornith-1-5-122b-mlx-4bit");
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 60 * GB })).toBeNull();
    expect(resolveTier({ category: "chat", tier: "max", profile: "p128", roomBytes: 60 * GB, reducedFreedBytes: 9 * GB })?.model).toBe("ornith-1-5-122b-mlx-4bit");
  });

  test("video Standard needs 0.6 R to hold Wan's measured 25.4 GB and Max lists the LTX profile", () => {
    const tight = resolveLadder("video", "p128", 40 * GB);
    expect(tight[0]?.resolved).toBeNull();
    expect(tight[1]?.resolved).toBeNull();
    const roomy = resolveLadder("video", "p128", 72 * GB);
    expect(roomy.map((row) => row.resolved?.model ?? null)).toEqual(["fastwan2-2-ti2v-5b-mlx-bf16", null, "ltx-2-5-bf16-distilled-mlx-max"]);
    expect(roomy[0]?.resolved?.verified).toBe(true);
    expect(resolveTier({ category: "video", tier: "max", profile: "p128", roomBytes: 40 * GB, reducedFreedBytes: 22 * GB, slot: { model: "ltx-2-5-bf16-distilled-mlx-max", options: { input: "picture" } } })).toMatchObject({ peakBytes: 61_500_000_000 });
    expect(resolveLadder("voice", "p128", 72 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["chatterbox-turbo-fp16", null, null]);
  });

  test("evaluation slots: Nano Reduced voice on p64 and p128, Qwen-Image Max, htdemucs Standard stems, no draft model", () => {
    for (const profile of ["p64", "p128"] as const) expect(resolveTier({ category: "voice", tier: "reduced", profile, roomBytes: 24 * GB })?.model).toBe("chatterbox-nano");
    for (const profile of ["p16", "p32"] as const) expect(resolveTier({ category: "voice", tier: "reduced", profile, roomBytes: 12 * GB })?.model).toBe("pocket-tts-english");
    expect(resolveTier({ category: "pictures", tier: "max", profile: "p128", roomBytes: 72 * GB })).toMatchObject({ model: "qwen-image-2512-q8", verified: true, peakBytes: 37_400_000_000 });
    expect(resolveTier({ category: "pictures", tier: "max", profile: "p128", roomBytes: 36 * GB })).toBeNull();
    expect(resolveLadder("stems", "p16", 8 * GB).map((row) => row.resolved?.model ?? null)).toEqual(["htdemucs", null, null]);
    expect(resolveTier({ category: "music", tier: "max", profile: "p128", roomBytes: 72 * GB })).toBeNull();
    expect(TIER_CANDIDATES.some((candidate) => /draft|dflash|mtp/i.test(candidate.id))).toBe(false);
  });

  test("collapses equal pins and leaves option switches visible", () => {
    const same = resolveLadder("pictures", "p64", 40 * GB, { standard: { model: "minimax-h3-image" }, boost: { model: "minimax-h3-image" } });
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

  test("candidate ids match the catalog constants", () => {
    const ids = new Set(TIER_CANDIDATES.map((candidate) => candidate.id));
    for (const id of [STACK_IMAGE_ERNIE_ID, STACK_IMAGE_KLEIN_ID, STACK_IMAGE_ZIMAGE_ID, STACK_MUSIC_MODEL_ID, STACK_VIDEO_MODEL_ID]) expect(ids.has(id)).toBe(true);
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

describe("tier candidate lists for the slot dialog", () => {
  test("every candidate is listed under every level with its family, and a bigger one is refused in plain words", () => {
    const levels = tierCandidateLists("pictures", "p64", 40 * GB);
    expect(levels.map((level) => level.tier)).toEqual(["standard", "boost", "max"]);
    const standard = levels[0]!;
    expect(standard.candidates.map((row) => row.family)).toContain("z-image");
    const zimage = standard.candidates.find((row) => row.id === "z-image-turbo")!;
    expect(zimage.fits).toBe(false);
    expect(zimage.refusal).toBe("This needs 26 GB. Standard keeps Home free, so it can't hold it. Use Boost or Max.");
    expect(levels[1]!.candidates.find((row) => row.id === "z-image-turbo")).toMatchObject({ fits: true, refusal: null });
    expect(standard.recommended).toBe("minimax-h3-image");
    expect(standard.candidates.map((row) => row.id)).toEqual(expect.arrayContaining(["ernie-image-turbo", "flux2-klein-4b", "z-image-turbo", "minimax-h3-image"]));
    expect(levels[1]!.recommended).toBe("minimax-h3-image");
  });

  test("Reduced-only models are never offered as a pick, and a profile with no models lists nothing", () => {
    const ids = tierCandidateLists("chat", "p128", 72 * GB).flatMap((level) => level.candidates.map((row) => row.id));
    expect(ids).not.toContain("qwen3-4b-q4-k-m");
    expect(tierCandidateLists("music", "p16", 10 * GB).every((level) => level.candidates.length === 0)).toBe(true);
  });

  test("a model this computer can never hold says so", () => {
    const max = tierCandidateLists("video", "p128", 30 * GB)[2]!;
    expect(max.candidates.some((row) => row.id === "ltx-2-3-distilled-mlx")).toBe(false);
  });

  // TIER-ROOM-01: Max is sized from the Max room (the resident room plus what Reduced frees), Standard and Boost from the resident room.
  test("the Max cap counts what Reduced frees and the Standard and Boost caps do not", () => {
    const levels = tierCandidateLists("video", "p128", 41.5 * GB, 36 * GB);
    expect(levels.map((level) => level.capBytes)).toEqual([0.6 * 41.5 * GB, 0.85 * 41.5 * GB, 77.5 * GB]);
    expect(tierCapBytes("max", 41.5 * GB, 36 * GB)).toBe(77.5 * GB);
    expect(tierCapBytes("boost", 41.5 * GB, 36 * GB)).toBe(tierCapBytes("boost", 41.5 * GB));
    const ltx = levels[2]!.candidates.find((row) => row.id === "ltx-2-5-bf16-distilled-mlx-max")!;
    expect(ltx).toMatchObject({ peakBytes: 61_500_000_000, fits: true, refusal: null });
    expect(levels[2]!.recommended).toBe("ltx-2-5-bf16-distilled-mlx-max");
    const wan = levels[0]!.candidates.find((row) => row.id === "fastwan2-2-ti2v-5b-mlx-bf16")!;
    expect(wan).toMatchObject({ fits: false, refusal: "This needs 25 GB. Standard keeps Home free, so it can't hold it. Use Boost or Max." });
  });

  test("\"can never hold it\" is said only when the peak is above the Max room with Reduced counted", () => {
    const pick = { category: "video" as const, profile: "p128" as const, model: "ltx-2-5-bf16-distilled-mlx-max", options: { input: "picture" } };
    // 61.5 GB against a 40 GB room: never with 10 GB freed, Boost or Max with 25 GB freed, fits Max with 25 GB freed.
    expect(customPickRefusal({ ...pick, tier: "standard", roomBytes: 40 * GB, reducedFreedBytes: 10 * GB })).toBe("This needs 62 GB and this computer can never hold it.");
    expect(customPickRefusal({ ...pick, tier: "max", roomBytes: 40 * GB, reducedFreedBytes: 10 * GB })).toBe("This needs 62 GB and this computer can never hold it.");
    expect(customPickRefusal({ ...pick, tier: "standard", roomBytes: 40 * GB, reducedFreedBytes: 25 * GB })).toBe("This needs 62 GB. Standard keeps Home free, so it can't hold it. Use Boost or Max.");
    expect(customPickRefusal({ ...pick, tier: "boost", roomBytes: 40 * GB, reducedFreedBytes: 25 * GB })).toBe("This needs 62 GB. Boost keeps Home free, so it can't hold it. Use Max.");
    expect(customPickRefusal({ ...pick, tier: "max", roomBytes: 40 * GB, reducedFreedBytes: 25 * GB })).toBeNull();
    // The Reduced saving never changes a Standard or Boost refusal into a fit.
    expect(customPickRefusal({ ...pick, tier: "boost", roomBytes: 40 * GB, reducedFreedBytes: 100 * GB })).toBe("This needs 62 GB. Boost keeps Home free, so it can't hold it. Use Max.");
  });

  test("a vetting-only model is catalogued but never resolved or offered", () => {
    const vetting = TIER_CANDIDATES.filter((candidate) => candidate.vetting);
    expect(vetting.map((candidate) => candidate.id)).toEqual(["qwen3-6-35b-a3b-ud-q4-k-xl", "ltx-2-5-q8-distilled-mlx"]);
    const ladder = resolveLadder("chat", "p128", 72 * GB).map((row) => row.resolved?.model);
    expect(ladder).not.toContain("qwen3-6-35b-a3b-ud-q4-k-xl");
    const ids = tierCandidateLists("chat", "p128", 72 * GB).flatMap((level) => level.candidates.map((row) => row.id));
    expect(ids).not.toContain("qwen3-6-35b-a3b-ud-q4-k-xl");
    expect(resolveTier({ category: "chat", tier: "standard", profile: "p128", roomBytes: 72 * GB, slot: { model: "qwen3-6-35b-a3b-ud-q4-k-xl" } })).toBeNull();
  });
});
