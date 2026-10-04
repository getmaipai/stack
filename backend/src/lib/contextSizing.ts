// What context the engine really has (STACK-CTX-01). Pure: no engine, no
// store, no clock, so the arithmetic is testable without either.

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
