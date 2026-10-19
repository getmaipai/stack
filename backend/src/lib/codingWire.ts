// CODE-STACK-01 S3: what the Stack does to a coding request, and nothing
// else. The Stack never translates a wire: the pinned llama-server serves
// Anthropic Messages, OpenAI Responses and chat completions itself and its
// bytes pass through. Three things change on the way in, each pure and each
// pinned by tests/codingWires.test.ts:
//   1. client sampling is dropped and the pin's sampling is set (design 3.6);
//   2. thinking budgets are clamped to stack.engines.coding.thinking_budget_ceiling;
//   3. a wire the engine does not serve is refused with a plain 501 before
//      the engine is started.

/** The three coding wires beside chat completions, by name. */
export type CodingWire = "messages" | "count_tokens" | "responses";

export const CODING_WIRE_PATHS: Record<CodingWire, string> = {
  messages: "/v1/messages",
  count_tokens: "/v1/messages/count_tokens",
  responses: "/v1/responses",
};

/** The paths a coding request that generates text goes to. Sampling and the
 * thinking budget apply here; the token-count paths carry neither. */
export const CODING_GENERATION_PATHS: readonly string[] = ["/v1/chat/completions", CODING_WIRE_PATHS.messages, CODING_WIRE_PATHS.responses];

/** Which wires each engine serves natively. llama-server b10797 serves all
 * three: its server library carries `/v1/messages`, `/v1/messages/count_tokens`
 * and `/v1/responses` (and `/v1/responses/input_tokens`), checked with
 * `strings` on libllama-server-impl.dylib (docs/dev.md, CODE-STACK-01 S3).
 * An engine not listed serves none of them. S5 adds the Splash row once its
 * wires pass the engine contract suite. */
export const ENGINE_CODING_WIRES: Record<string, Record<CodingWire, boolean>> = {
  "llama-server": { messages: true, count_tokens: true, responses: true },
};

export function engineServesWire(engine: string | null, wire: CodingWire): boolean {
  return engine !== null && ENGINE_CODING_WIRES[engine]?.[wire] === true;
}

/** The plain sentence for a wire the coding engine does not serve. */
export function wireNotServedMessage(wire: CodingWire, engine: string | null): string {
  const name = wire === "responses" ? "the OpenAI Responses API (/v1/responses)" : wire === "count_tokens" ? "Anthropic token counting (/v1/messages/count_tokens)" : "the Anthropic Messages API (/v1/messages)";
  return `The coding engine${engine ? ` (${engine})` : ""} on this computer does not serve ${name}. Use /v1/chat/completions instead, or ask an admin to update the coding engine.`;
}

/** Sampling fields a client may send that the coding role ignores: the four
 * the model card sets (temperature, top_p, top_k, presence_penalty) and the
 * other knobs that reshape the next-token distribution. `seed`, `stop`,
 * `logit_bias`, `max_tokens` and the output limits are not sampling and pass
 * through. A field the pin does not carry is dropped and the engine's own
 * default applies. */
export const DROPPED_CLIENT_SAMPLING = [
  "temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty",
  "repeat_penalty", "repeat_last_n", "typical_p", "mirostat", "mirostat_tau", "mirostat_eta",
] as const;

export function dropClientSampling(body: Record<string, unknown>): Record<string, unknown> {
  const kept = { ...body };
  for (const key of DROPPED_CLIENT_SAMPLING) delete kept[key];
  return kept;
}

/** A request the Stack refuses before the engine sees it; `message` says what to change. */
export class CodingRequestError extends Error {
  readonly status = 400 as const;
  constructor(message: string) { super(message); this.name = "CodingRequestError"; }
}

function clampOne(value: unknown, ceiling: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new CodingRequestError(`${field} must be a number of tokens. Send a whole number, or leave it out to use the household's limit of ${ceiling}.`);
  // -1 asks for unrestricted thinking: the ceiling is the most it gets.
  if (value < 0) return ceiling;
  return Math.min(Math.floor(value), ceiling);
}

/** Bounds every thinking budget in a coding request by the admin's ceiling.
 *
 * - `thinking_budget_tokens` (the engine's per-request field, also used by
 *   OpenAI-style clients) and Anthropic's `thinking.budget_tokens` become
 *   `min(requested, ceiling)`; -1 (unrestricted) becomes the ceiling.
 * - A request can never raise a budget, and the Stack never adds a budget,
 *   `thinking` block or `enable_thinking`: an absent budget stays absent (the
 *   engine's launch-level `--reasoning-budget`, set to the ceiling at start,
 *   applies) and `thinking.type: "disabled"` or `enable_thinking: false` stay
 *   exactly as sent, so a request cannot turn thinking on where the caller or
 *   Home turned it off. The Stack has no age signal; Home sends thinking off
 *   for a minor and the Stack honours that.
 * - A clamped budget that would reach the request's own output limit
 *   (`max_tokens` or `max_completion_tokens`, whichever is smaller) is lowered
 *   to one token under it, because Anthropic requires budget_tokens below
 *   max_tokens. The output limit itself is never raised or lowered.
 * Returns a new body; the input is not changed. */
export function clampThinking(body: Record<string, unknown>, ceiling: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  let budget: number | null = null;
  const note = (value: number) => { budget = budget === null ? value : Math.min(budget, value); };
  const bound = Math.max(0, Math.floor(ceiling));
  if (out.thinking_budget_tokens !== undefined) {
    const clamped = clampOne(out.thinking_budget_tokens, bound, "thinking_budget_tokens");
    out.thinking_budget_tokens = clamped;
    note(clamped);
  }
  if (out.thinking !== undefined && out.thinking !== null) {
    if (typeof out.thinking !== "object" || Array.isArray(out.thinking)) throw new CodingRequestError("thinking must be an object like {\"type\": \"enabled\", \"budget_tokens\": 1000}.");
    const thinking = { ...(out.thinking as Record<string, unknown>) };
    if (thinking.budget_tokens !== undefined) {
      const clamped = clampOne(thinking.budget_tokens, bound, "thinking.budget_tokens");
      thinking.budget_tokens = clamped;
      note(clamped);
    }
    out.thinking = thinking;
  }
  if (budget !== null) {
    const limits = [out.max_tokens, out.max_completion_tokens].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const limit = limits.length ? Math.min(...limits) : null;
    if (limit !== null && (budget as number) >= limit) {
      const lowered = Math.max(0, Math.floor(limit) - 1);
      if (typeof out.thinking_budget_tokens === "number") out.thinking_budget_tokens = Math.min(out.thinking_budget_tokens, lowered);
      const thinking = out.thinking as Record<string, unknown> | undefined;
      if (thinking && typeof thinking.budget_tokens === "number") thinking.budget_tokens = Math.min(thinking.budget_tokens, lowered);
    }
  }
  return out;
}
