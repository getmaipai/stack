import { describe, expect, test } from "bun:test";
import { selectVariant, type Variant } from "../src/lib/variantSelect";

const GB = 1024 ** 3;
const v = (id: string, engine: string, gb: number | null, quant?: string): Variant => ({ id, engine, sizeBytes: gb === null ? null : gb * GB, ...(quant ? { quant } : {}) });
const base = { roomBytes: 10 * GB, supportedEngines: ["llama", "mlx"], enginePreference: ["mlx", "llama"] };

describe("selectVariant", () => {
  test("chooses the largest variant that fits", () => {
    const out = selectVariant([v("a", "llama", 4), v("b", "llama", 8), v("c", "llama", 12)], base);
    expect(out.reason).toBe("fits");
    expect(out.chosen?.id).toBe("b");
  });

  test("a better engine beats a larger size among those that fit", () => {
    const out = selectVariant([v("big", "llama", 9), v("small", "mlx", 5)], base);
    expect(out.chosen?.id).toBe("small");
  });

  test("an engine missing from the preference list ranks last", () => {
    const out = selectVariant([v("x", "other", 6), v("y", "llama", 4)], { ...base, supportedEngines: ["llama", "other"] });
    expect(out.chosen?.id).toBe("y");
  });

  test("a pin wins outright, even over budget", () => {
    const out = selectVariant([v("a", "llama", 4), v("huge", "llama", 40)], { ...base, pin: "huge" });
    expect(out.reason).toBe("pinned");
    expect(out.chosen?.id).toBe("huge");
  });

  test("an unknown size never beats a known fit", () => {
    const out = selectVariant([v("known", "llama", 3), v("mystery", "mlx", null)], base);
    expect(out.chosen?.id).toBe("known");
    expect(out.ranked.find((r) => r.variant.id === "mystery")?.fit).toBe("unknown");
  });

  test("an unknown size is chosen only when nothing known fits", () => {
    const out = selectVariant([v("huge", "llama", 40), v("mystery", "llama", null)], base);
    expect(out.reason).toBe("unknown-size");
    expect(out.chosen?.id).toBe("mystery");
  });

  test("nothing fits when every variant is over", () => {
    const out = selectVariant([v("a", "llama", 30), v("b", "llama", 40)], base);
    expect(out.chosen).toBeNull();
    expect(out.reason).toBe("nothing-fits");
    expect(out.ranked.map((r) => r.fit)).toEqual(["over", "over"]);
  });

  test("no supported engine gives no choice", () => {
    const out = selectVariant([v("a", "cuda", 4)], base);
    expect(out.chosen).toBeNull();
    expect(out.reason).toBe("no-engine");
  });

  test("empty input gives no choice", () => {
    expect(selectVariant([], base).chosen).toBeNull();
  });

  test("ranked lists fits, then unknown, then over", () => {
    const out = selectVariant([v("over", "llama", 30), v("mystery", "llama", null), v("fit", "llama", 2)], base);
    expect(out.ranked.map((r) => r.variant.id)).toEqual(["fit", "mystery", "over"]);
  });

  test("equal size and engine break ties by id", () => {
    const out = selectVariant([v("b", "llama", 5), v("a", "llama", 5)], base);
    expect(out.chosen?.id).toBe("a");
  });

  test("the result is the same for shuffled input and the input is not changed", () => {
    const list = [v("a", "llama", 4), v("b", "mlx", 6), v("c", "llama", 9), v("d", "mlx", null), v("e", "llama", 50)];
    const copy = JSON.stringify(list);
    const one = selectVariant(list, base);
    const two = selectVariant([...list].reverse(), base);
    expect(JSON.stringify(list)).toBe(copy);
    expect(two.chosen?.id).toBe(one.chosen?.id);
    expect(two.ranked.map((r) => r.variant.id)).toEqual(one.ranked.map((r) => r.variant.id));
  });
});
