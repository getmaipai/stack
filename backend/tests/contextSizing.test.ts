// STACK-CTX-01: the engine's own /props is what the role status reports
// as the context length, the slot count and the context per slot.
import { expect, test } from "bun:test";
import { engineContextFrom } from "@/lib/contextSizing";

test("the engine's /props is read: n_ctx and total_slots, cross-checked against the launch value", () => {
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 32768 }, total_slots: 1 }, 32768)).toEqual({ contextLength: 32768, slots: 1, contextPerSlot: 32768 });
  // n_ctx reported per slot: the launch value is the product.
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 8192 }, total_slots: 4 }, 32768)).toEqual({ contextLength: 32768, slots: 4, contextPerSlot: 8192 });
  // n_ctx reported as the whole launch value: the slots divide it.
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 32768 }, total_slots: 4 }, 32768)).toEqual({ contextLength: 32768, slots: 4, contextPerSlot: 8192 });
  expect(engineContextFrom({}, 32768)).toBeNull();
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 0 }, total_slots: 1 }, 32768)).toBeNull();
});
