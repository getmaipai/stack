// What context the engine really has, and what context it should be
// launched with (STACK-CTX-01). Pure: no engine, no store, no clock, so
// the arithmetic is testable without any of them.
import type { KvCacheType } from "@/lib/engineArgs";

/** llama.cpp's own ggml block sizes: q8_0 is 34 bytes per 32 elements,
 * q4_0 is 18 bytes per 32. */
export const KV_BYTES_PER_ELEMENT: Record<KvCacheType, number> = { f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 };
export const CONTEXT_STEP = 1024;
export const CONTEXT_MIN = 512;
/** Below this a chat window holds little more than one search answer and
 * Home's tool block: the role status says so. */
export const CONTEXT_REPORT_BELOW = 8192;
/** The context when the model's KV shape cannot be read. */
export const CONTEXT_UNKNOWN_SHAPE = 4096;
/** The most one tier asks for: 32768 on the tiers Home runs a household
 * on, more where a Studio-class machine has the memory. */
export const CONTEXT_CEILING = { p16: 32768, p32: 32768, p64: 65536, p128: 131072 } as const;
/** The file size to the process footprint multiplier admission uses for a
 * llama-server model that has no measurement yet (governor `engineMultipliers`). */
export const WEIGHTS_MULTIPLIER = 1.3;
/** What the roles beside chat (embed, tts, stt, wakeword) are given out of
 * the same budget: an estimate until each has a measured peak. */
export const CO_RESIDENT_BYTES = 3 * 1_073_741_824;

export interface KvShape { layers: number; kvHeads: number; headDim: number }

/** layers x KV heads x head dim x 2 (keys and values) x bytes per element. */
export function kvBytesPerToken(shape: KvShape, kvCacheType: KvCacheType): number {
  return Math.ceil(shape.layers * shape.kvHeads * shape.headDim * 2 * KV_BYTES_PER_ELEMENT[kvCacheType]);
}

export interface ContextSizingInput {
  tier: keyof typeof CONTEXT_CEILING;
  /** null when the model's KV shape could not be read. */
  shape: KvShape | null;
  kvCacheType: KvCacheType;
  modelFileBytes: number | null;
  /** A measured process footprint and the launch context it was taken at. */
  measuredFootprintBytes?: number | null;
  measuredContextLength?: number | null;
  /** The governor's model budget (its cap), working margin, and what the
   * roles that sit beside chat (embed, tts, stt, wakeword) are given. */
  capBytes: number;
  marginBytes: number;
  coResidentBytes: number;
  /** The context the model was trained for; 0 when unknown. */
  trainedContext: number;
  slots: number;
  /** The person's setting; 0 or absent means compute it. */
  declaredContext?: number;
}

export interface ContextSizing {
  contextLength: number;
  slots: number;
  contextPerSlot: number;
  kvBytesPerToken: number | null;
  /** The KV cache at the chosen context, the whole of `-c`. */
  kvBytes: number | null;
  weightsBytes: number | null;
  availableBytes: number | null;
  source: "computed" | "declared" | "unknown-shape";
  reason: string | null;
}

/** The launch context for the chat engine: the largest multiple of 1024
 * whose KV cache fits in what the governor's budget leaves after the
 * working margin, the roles beside chat and the weights, capped by the
 * tier's ceiling and the model's trained context. A declared context is
 * honoured only up to that. Never zero: below CONTEXT_MIN the engine would
 * not start, so it gets CONTEXT_MIN and the reason says it does not fit. */
export function sizeChatContext(input: ContextSizingInput): ContextSizing {
  const slots = Math.max(1, Math.floor(input.slots));
  const declared = input.declaredContext && input.declaredContext > 0 ? Math.floor(input.declaredContext) : 0;
  const done = (contextLength: number, rest: Partial<ContextSizing>): ContextSizing => ({
    contextLength, slots, contextPerSlot: Math.floor(contextLength / slots), kvBytesPerToken: null, kvBytes: null, weightsBytes: null, availableBytes: null, source: "computed", reason: null, ...rest,
  });
  if (!input.shape) {
    const contextLength = declared || CONTEXT_UNKNOWN_SHAPE;
    return done(contextLength, { source: "unknown-shape", reason: `The model's KV cache cost could not be read, so the chat engine launches with ${contextLength} tokens, not a computed fit.` });
  }
  const perToken = kvBytesPerToken(input.shape, input.kvCacheType);
  const measuredKv = (input.measuredContextLength ?? 0) * perToken;
  const weightsBytes = input.measuredFootprintBytes ? Math.max(0, input.measuredFootprintBytes - measuredKv) : Math.ceil((input.modelFileBytes ?? 0) * WEIGHTS_MULTIPLIER);
  const availableBytes = input.capBytes - input.marginBytes - input.coResidentBytes - weightsBytes;
  const fits = Math.floor(Math.max(0, availableBytes) / perToken / CONTEXT_STEP) * CONTEXT_STEP;
  const ceiling = Math.min(CONTEXT_CEILING[input.tier], input.trainedContext > 0 ? Math.floor(input.trainedContext / CONTEXT_STEP) * CONTEXT_STEP || input.trainedContext : Number.POSITIVE_INFINITY);
  const wanted = declared ? Math.min(declared, ceiling) : ceiling;
  const contextLength = Math.max(CONTEXT_MIN, Math.min(wanted, fits));
  const notes: string[] = [];
  if (declared && declared > contextLength) notes.push(`The declared context of ${declared} tokens does not fit this machine's memory budget, so the chat engine launches with ${contextLength}.`);
  if (contextLength < CONTEXT_REPORT_BELOW) notes.push(`The chat engine launches with a ${contextLength}-token context, below ${CONTEXT_REPORT_BELOW}: this machine's memory budget leaves room for little more after the model.`);
  return done(contextLength, { kvBytesPerToken: perToken, kvBytes: contextLength * perToken, weightsBytes, availableBytes, reason: notes.length ? notes.join(" ") : null, source: declared ? "declared" : "computed" });
}

/** What admission adds for the KV cache at the chosen context: nothing
 * where the peak already holds it (a dry run at this context, a measurement
 * taken at it), the difference where a measurement was taken at another,
 * all of it where the peak is the file size times a multiplier. */
export function kvHeadroomBytes(input: { kvPerToken: number | null; contextLength: number; measuredFootprintBytes: number | null; measuredContextLength: number | null; dryRunPeakBytes: number | null }): number {
  if (input.kvPerToken === null) return 0;
  if (input.measuredFootprintBytes) return Math.max(0, input.contextLength - (input.measuredContextLength ?? 0)) * input.kvPerToken;
  if (input.dryRunPeakBytes) return 0;
  return input.contextLength * input.kvPerToken;
}

export interface EngineContext { contextLength: number; slots: number; contextPerSlot: number }

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The context an engine reports on `/props` (llama-server:
 * `default_generation_settings.n_ctx` and `total_slots`). Builds differ on
 * whether `n_ctx` is the whole `-c` value or one slot's share of it, so the
 * launch value the Stack passed decides which it is: equal means the whole,
 * a product with the slot count means the share. Anything else is the
 * engine's word, taken as the whole. Null when `/props` has no usable
 * `n_ctx`, so the caller falls back to what it launched. */
export function engineContextFrom(props: unknown, launchContext: number): EngineContext | null {
  if (!props || typeof props !== "object") return null;
  const record = props as { default_generation_settings?: { n_ctx?: unknown }; total_slots?: unknown };
  const nCtx = positiveInt(record.default_generation_settings?.n_ctx);
  if (nCtx === null) return null;
  const slots = positiveInt(record.total_slots) ?? 1;
  if (nCtx * slots === launchContext && slots > 1) return { contextLength: launchContext, slots, contextPerSlot: nCtx };
  return { contextLength: nCtx, slots, contextPerSlot: Math.floor(nCtx / slots) };
}
