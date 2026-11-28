import { describe, expect, test } from "bun:test";
import { roomFromGovernor, recommendText } from "@/lib/variantRecommend";
import type { HfVariant } from "@/lib/hf";

const variant = (overrides: Partial<HfVariant> = {}): HfVariant => ({
  id: "model@Q4_K_M", engine: "llama.cpp", sizeBytes: 4_000, quant: "Q4_K_M",
  files: ["model-Q4_K_M.gguf"], projector: null, complete: true, ...overrides,
});

describe("variant recommendations", () => {
  test("computes governor room by subtracting margin and loaded peaks, clamped at zero", () => {
    expect(roomFromGovernor({ capBytes: 10_000, marginBytes: 2_000, loaded: [{ peakBytes: 1_000 }, { peakBytes: 3_000 }] })).toBe(4_000);
    expect(roomFromGovernor({ capBytes: 5_000, marginBytes: 4_000, loaded: [{ peakBytes: 2_000 }] })).toBe(0);
  });

  test("names a variant that fits", () => {
    expect(recommendText([variant()], 4_000)).toBe("Best fit for this machine right now: model-Q4_K_M.gguf.");
  });

  test("describes an unpublished size as uncertain", () => {
    expect(recommendText([variant({ sizeBytes: null })], 1)).toBe("model-Q4_K_M.gguf may fit, its size is not published.");
  });

  test("returns null when all known sizes are over room", () => {
    expect(recommendText([variant()], 3_999)).toBeNull();
  });

  test("skips incomplete shard sets", () => {
    expect(recommendText([variant({ complete: false, sizeBytes: null }), variant({ id: "large", sizeBytes: 5_000, files: ["large.gguf"] })], 4_000)).toBeNull();
  });
});
