import { describe, expect, test } from "bun:test";
import { groupShards, parseGgufFilename } from "../src/lib/ggufFilename";

describe("parseGgufFilename", () => {
  test("reads the quant from a plain file name", () => {
    expect(parseGgufFilename("Qwen3-8B-Q4_K_M.gguf")).toEqual({ base: "Qwen3-8B-Q4_K_M", quant: "Q4_K_M", shardIndex: null, shardTotal: null, isProjector: false });
  });

  test("matches the longest known quant token", () => {
    expect(parseGgufFilename("model-Q5_K_M.gguf").quant).toBe("Q5_K_M");
    expect(parseGgufFilename("model-IQ4_XS.gguf").quant).toBe("IQ4_XS");
    expect(parseGgufFilename("model-UD-Q4_K_XL.gguf").quant).toBe("UD-Q4_K_XL");
    expect(parseGgufFilename("model-MXFP4.gguf").quant).toBe("MXFP4");
  });

  test("is case-insensitive and returns the token uppercased", () => {
    expect(parseGgufFilename("model-q8_0.gguf").quant).toBe("Q8_0");
  });

  test("returns null when no quant is in the name", () => {
    expect(parseGgufFilename("model.gguf").quant).toBeNull();
  });

  test("reads shard numbers and strips the shard suffix from the base", () => {
    expect(parseGgufFilename("big-Q4_K_M-00002-of-00003.gguf")).toEqual({ base: "big-Q4_K_M", quant: "Q4_K_M", shardIndex: 2, shardTotal: 3, isProjector: false });
  });

  test("flags a projector file", () => {
    expect(parseGgufFilename("mmproj-F16.gguf").isProjector).toBe(true);
    expect(parseGgufFilename("Model-MMPROJ-bf16.gguf").isProjector).toBe(true);
    expect(parseGgufFilename("Model-Q4_K_M.gguf").isProjector).toBe(false);
  });
});

describe("groupShards", () => {
  test("groups the shards of one model and marks a missing shard incomplete", () => {
    const groups = groupShards(["big-Q4_K_M-00001-of-00003.gguf", "big-Q4_K_M-00003-of-00003.gguf"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.complete).toBe(false);
    expect(groups[0]!.files).toEqual(["big-Q4_K_M-00001-of-00003.gguf", "big-Q4_K_M-00003-of-00003.gguf"]);
    const full = groupShards(["big-Q4_K_M-00002-of-00003.gguf", "big-Q4_K_M-00001-of-00003.gguf", "big-Q4_K_M-00003-of-00003.gguf"]);
    expect(full[0]!.complete).toBe(true);
    expect(full[0]!.files).toEqual(["big-Q4_K_M-00001-of-00003.gguf", "big-Q4_K_M-00002-of-00003.gguf", "big-Q4_K_M-00003-of-00003.gguf"]);
  });

  test("a single file is complete", () => {
    const groups = groupShards(["a-Q8_0.gguf"]);
    expect(groups).toEqual([{ base: "a-Q8_0", quant: "Q8_0", files: ["a-Q8_0.gguf"], complete: true, projector: null }]);
  });

  test("attaches the best projector to every group and keeps projectors out of the groups", () => {
    const groups = groupShards(["m-Q4_K_M.gguf", "m-Q8_0.gguf", "mmproj-Q8_0.gguf", "mmproj-F16.gguf", "mmproj-BF16.gguf"]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.projector === "mmproj-F16.gguf")).toBe(true);
    expect(groups.flatMap((g) => g.files).some((f) => f.includes("mmproj"))).toBe(false);
  });

  test("prefers BF16, then Q8_0, then any other projector", () => {
    expect(groupShards(["m-Q4_K_M.gguf", "mmproj-Q8_0.gguf", "mmproj-BF16.gguf"])[0]!.projector).toBe("mmproj-BF16.gguf");
    expect(groupShards(["m-Q4_K_M.gguf", "mmproj-Q8_0.gguf", "mmproj-Q4_0.gguf"])[0]!.projector).toBe("mmproj-Q8_0.gguf");
    expect(groupShards(["m-Q4_K_M.gguf", "mmproj-Q4_0.gguf"])[0]!.projector).toBe("mmproj-Q4_0.gguf");
  });

  test("ignores names that are not gguf files and sorts groups by base then quant", () => {
    const groups = groupShards(["README.md", "b-Q8_0.gguf", "a-Q8_0.gguf", "config.json"]);
    expect(groups.map((g) => g.base)).toEqual(["a-Q8_0", "b-Q8_0"]);
  });

  test("returns an empty list for empty input", () => {
    expect(groupShards([])).toEqual([]);
  });
});
