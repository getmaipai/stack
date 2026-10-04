// STACK-CTX-01: the chat engine's launch context is computed from the
// machine tier and the model's KV cache cost, never a constant, and the
// engine's own /props is what the role status reports.
import { expect, test } from "bun:test";
import { CONTEXT_REPORT_BELOW, engineContextFrom, kvBytesPerToken, kvHeadroomBytes, sizeChatContext, type KvShape } from "@/lib/contextSizing";

const GiB = 1_073_741_824;
// Llama-3.1-8B-Instruct Q4_K_M: 32 layers, 8 KV heads, head dim 128, trained at 131072.
const llama8b: KvShape = { layers: 32, kvHeads: 8, headDim: 128 };
const q4km = 4_920_000_000;
const machine24 = { tier: "p16" as const, capBytes: 16 * GiB, marginBytes: 4 * GiB, coResidentBytes: 3 * GiB };

test("KV cost per token is layers x kv heads x head dim x 2 x bytes per element", () => {
  expect(kvBytesPerToken(llama8b, "f16")).toBe(32 * 8 * 128 * 2 * 2);
  expect(kvBytesPerToken(llama8b, "q8_0")).toBe(32 * 8 * 128 * 2 * 1.0625);
  expect(kvBytesPerToken(llama8b, "q4_0")).toBe(32 * 8 * 128 * 2 * 0.5625);
});

test("a 24 GB machine with an 8B Q4_K_M model gets 32768 tokens at q8_0, one slot", () => {
  const sizing = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1 });
  expect(sizing.contextLength).toBe(32768);
  expect(sizing.slots).toBe(1);
  expect(sizing.contextPerSlot).toBe(32768);
  expect(sizing.kvBytes).toBe(32768 * 69632);
  expect(sizing.reason).toBeNull();
  expect(sizing.contextLength % 1024).toBe(0);
});

test("the context is as large as fits: f16 costs more per token, so it gets fewer, rounded down", () => {
  const sizing = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "f16", modelFileBytes: q4km, trainedContext: 131072, slots: 1 });
  const available = 16 * GiB - 4 * GiB - 3 * GiB - Math.ceil(q4km * 1.3);
  expect(sizing.contextLength).toBe(Math.floor(available / 131072 / 1024) * 1024);
  expect(sizing.contextLength).toBeGreaterThanOrEqual(16384);
  expect(sizing.contextLength).toBeLessThan(32768);
});

test("a Studio-class machine gets a larger context than the 24 GB tier", () => {
  const studio = sizeChatContext({ tier: "p128", capBytes: 120 * GiB, marginBytes: 20 * GiB, coResidentBytes: 3 * GiB, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1 });
  expect(studio.contextLength).toBe(131072);
  expect(studio.contextLength).toBeGreaterThan(32768);
});

test("the context never exceeds what the model was trained for", () => {
  const sizing = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 8192, slots: 1 });
  expect(sizing.contextLength).toBe(8192);
});

test("a measured footprint replaces the file-size multiplier, minus the KV it already holds", () => {
  const kv = kvBytesPerToken(llama8b, "q8_0");
  const measured = 5 * GiB + 4096 * kv;
  const sizing = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1, measuredFootprintBytes: measured, measuredContextLength: 4096 });
  expect(sizing.weightsBytes).toBe(5 * GiB);
});

test("slots divide the one launch context", () => {
  const sizing = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 2 });
  expect(sizing.slots).toBe(2);
  expect(sizing.contextPerSlot).toBe(sizing.contextLength / 2);
});

test("below 8192 the launch still happens at what fits and the reason says so", () => {
  const sizing = sizeChatContext({ tier: "p16", capBytes: 8 * GiB, marginBytes: 4 * GiB, coResidentBytes: 1 * GiB, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1 });
  expect(sizing.contextLength).toBeLessThan(CONTEXT_REPORT_BELOW);
  expect(sizing.contextLength).toBeGreaterThanOrEqual(512);
  expect(sizing.reason).toContain(String(sizing.contextLength));
  expect(sizing.reason).toContain("8192");
});

test("a declared context is honoured only up to what fits", () => {
  const small = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1, declaredContext: 8192 });
  expect(small.contextLength).toBe(8192);
  const huge = sizeChatContext({ ...machine24, shape: llama8b, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 131072, slots: 1, declaredContext: 262144 });
  expect(huge.contextLength).toBe(32768);
  expect(huge.reason).toContain("262144");
});

test("a model whose KV shape is unknown keeps the declared context, or 4096, and says why", () => {
  const unknown = sizeChatContext({ ...machine24, shape: null, kvCacheType: "q8_0", modelFileBytes: q4km, trainedContext: 0, slots: 1 });
  expect(unknown.contextLength).toBe(4096);
  expect(unknown.kvBytes).toBeNull();
  expect(unknown.reason).toContain("KV");
});

test("admission adds the KV for the chosen context only where the peak does not already hold it", () => {
  const kv = kvBytesPerToken(llama8b, "q8_0");
  expect(kvHeadroomBytes({ kvPerToken: kv, contextLength: 32768, measuredFootprintBytes: null, measuredContextLength: null, dryRunPeakBytes: null })).toBe(32768 * kv);
  expect(kvHeadroomBytes({ kvPerToken: kv, contextLength: 32768, measuredFootprintBytes: 6 * GiB, measuredContextLength: 4096, dryRunPeakBytes: null })).toBe((32768 - 4096) * kv);
  expect(kvHeadroomBytes({ kvPerToken: kv, contextLength: 32768, measuredFootprintBytes: 8 * GiB, measuredContextLength: 32768, dryRunPeakBytes: null })).toBe(0);
  expect(kvHeadroomBytes({ kvPerToken: kv, contextLength: 32768, measuredFootprintBytes: null, measuredContextLength: null, dryRunPeakBytes: 7 * GiB })).toBe(0);
  expect(kvHeadroomBytes({ kvPerToken: null, contextLength: 32768, measuredFootprintBytes: null, measuredContextLength: null, dryRunPeakBytes: null })).toBe(0);
});

test("the engine's /props is read: n_ctx and total_slots, cross-checked against the launch value", () => {
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 32768 }, total_slots: 1 }, 32768)).toEqual({ contextLength: 32768, slots: 1, contextPerSlot: 32768 });
  // n_ctx reported per slot: the launch value is the product.
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 8192 }, total_slots: 4 }, 32768)).toEqual({ contextLength: 32768, slots: 4, contextPerSlot: 8192 });
  // n_ctx reported as the whole launch value: the slots divide it.
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 32768 }, total_slots: 4 }, 32768)).toEqual({ contextLength: 32768, slots: 4, contextPerSlot: 8192 });
  expect(engineContextFrom({}, 32768)).toBeNull();
  expect(engineContextFrom({ default_generation_settings: { n_ctx: 0 }, total_slots: 1 }, 32768)).toBeNull();
});
