// STACK-CTX-400-01: a prompt longer than the context window is the caller's to shorten, so it is a 400 with a plain message that names the limit, never a 5xx a client would retry or blame the engine for.
// llama-server answers it already (400, type exceed_context_size_error, n_prompt_tokens, n_ctx); the MLX and Splash engines word it their own ways, sometimes under a 5xx, so the Stack recognises both.

export interface ContextOverflowBody { error: { code: 400; type: "context_length_exceeded"; message: string; n_prompt_tokens?: number; n_ctx?: number } }

const OVERFLOW_TEXT = /exceed(?:s|ed)? (?:the )?(?:available )?context|context (?:length|size|window)[^.]*(?:exceed|too (?:long|large|small))|prompt is too long|input is too long|maximum context length|too many tokens/i;

function numberAt(source: unknown, key: string): number | undefined {
  const value = source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The 400 body for an engine reply that says the prompt did not fit, or null for any other reply. */
export function contextOverflowError(status: number, body: unknown): ContextOverflowBody | null {
  if (status < 400) return null;
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  const message = typeof error === "string" ? error : error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  const type = error && typeof error === "object" ? (error as { type?: unknown }).type : undefined;
  if (type !== "exceed_context_size_error" && !OVERFLOW_TEXT.test(message)) return null;
  const sent = numberAt(error, "n_prompt_tokens") ?? numberAt(body, "n_prompt_tokens");
  const limit = numberAt(error, "n_ctx") ?? numberAt(body, "n_ctx") ?? Number(/(?:context (?:length|size|window)(?: of)?|limit(?: of)?)\D{0,6}(\d{3,})/i.exec(message)?.[1] ?? NaN);
  const knownLimit = Number.isFinite(limit) ? limit : undefined;
  const text = sent !== undefined && knownLimit !== undefined
    ? `This request is too long: ${sent} tokens were sent and the context window holds ${knownLimit}. Shorten the conversation or the message and try again.`
    : knownLimit !== undefined
      ? `This request is longer than the context window, which holds ${knownLimit} tokens. Shorten the conversation or the message and try again.`
      : "This request is longer than the context window. Shorten the conversation or the message and try again.";
  return { error: { code: 400, type: "context_length_exceeded", message: text, ...(sent !== undefined ? { n_prompt_tokens: sent } : {}), ...(knownLimit !== undefined ? { n_ctx: knownLimit } : {}) } };
}
