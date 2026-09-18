import { expect, test } from "bun:test";
import { displayName } from "@/lib/names";

test("displayName turns model files and revisions into short names", () => {
  expect(displayName("qwen3-1.7b-q8-0.gguf")).toBe("Qwen3 1.7B");
  expect(displayName("b10797-832fd6f17")).toBe("b10797");
});
