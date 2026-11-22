import { expect, test } from "bun:test";
import { pinnedCodingWindow } from "@/lib/supervisor";
import type { ModelRecord } from "@/lib/modelStore";

const pinned = { engineRequirements: { launch: { contextLength: 32_768 } } } as unknown as ModelRecord;
const plain = { engineRequirements: {} } as unknown as ModelRecord;

test("a pinned coding window stays at the pin until Max chat window asks for a larger one", () => {
  expect(pinnedCodingWindow(pinned, {})).toBe(32_768);
  expect(pinnedCodingWindow(pinned, { "stack.engines.coding.max_chat_context_length": 32_768 })).toBe(32_768);
  expect(pinnedCodingWindow(pinned, { "stack.engines.coding.max_chat_context_length": 65_536 })).toBe(65_536);
  expect(pinnedCodingWindow(pinned, { "stack.engines.coding.max_chat_context_length": 8_192 })).toBe(32_768);
});

test("a model with no pinned window follows the coding setting, not this one", () => {
  expect(pinnedCodingWindow(plain, { "stack.engines.coding.max_chat_context_length": 65_536 })).toBeNull();
});
