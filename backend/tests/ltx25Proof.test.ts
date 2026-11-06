import { describe, expect, test } from "bun:test";
import { ltx25GenProof, ltx25MaxGenProof } from "@/video/ltx25";

describe("the file that proves an LTX-2.5 environment was built", () => {
  test("is never mlx/__init__.py: mlx is a namespace package and has none, so the first clean install failed on it", () => {
    for (const proof of [ltx25GenProof(), ltx25MaxGenProof()]) {
      expect(proof.endsWith("/site-packages/mlx/__init__.py")).toBe(false);
      expect(proof.endsWith("/site-packages/mlx_lm/__init__.py")).toBe(true);
    }
  });
});
