import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import rows from "../src/rows/featureRows.json";
import { CATEGORY_DEFS } from "../src/lib/choiceCategories";

test("CATEGORY_DEFS is the JSON rows", () => {
  expect<unknown>(CATEGORY_DEFS).toEqual(rows);
});

test("category ids in order", () => {
  expect(CATEGORY_DEFS.map((def) => def.id)).toEqual(["chat", "coding", "pictures", "video", "music", "voice", "stt", "embeddings", "vision", "wakeword", "stems"]);
});

test("coding follows chat at max", () => {
  const coding = CATEGORY_DEFS.find((def) => def.id === "coding");
  expect(coding?.follows?.max).toBe("chat");
});

test("chat max is a heavy process tier with two models", () => {
  const chat = CATEGORY_DEFS.find((def) => def.id === "chat");
  expect(chat?.heavyAt?.max?.length).toBe(2);
  expect(chat?.process).toBe(true);
});

test("source text holds no model ids", () => {
  const text = readFileSync(join(import.meta.dir, "../src/lib/choiceCategories.ts"), "utf8");
  expect(text.includes("qwen")).toBe(false);
  expect(text.includes("CODING_27B")).toBe(false);
});
