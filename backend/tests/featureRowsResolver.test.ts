import { test, expect } from "bun:test";
import { CATEGORY_DEFS } from "../src/lib/choiceCategories";

test("only the chat row allows added models", () => {
  const added = CATEGORY_DEFS.filter((def) => def.addedModels === true);
  expect(added.map((def) => def.id)).toEqual(["chat"]);
});

test("chat mirrors its Standard pick through a model id setting", () => {
  const chat = CATEGORY_DEFS.find((def) => def.id === "chat");
  expect(chat?.legacySetting?.by).toBe("model");
  expect(chat?.legacySetting?.key).toBe("stack.engines.chat.model");
});

test("voice mirrors its Standard pick through an engine setting", () => {
  const voice = CATEGORY_DEFS.find((def) => def.id === "voice");
  expect(voice?.legacySetting?.by).toBe("engine");
});

test("no other row has a legacy setting", () => {
  const others = CATEGORY_DEFS.filter((def) => def.id !== "chat" && def.id !== "voice");
  expect(others.every((def) => def.legacySetting === undefined)).toBe(true);
});
