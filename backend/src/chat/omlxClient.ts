// The Stack's client for an oMLX chat process. It speaks the Stack's
// chat wire (llama-server's shape, the one Home and the benches were
// written against) to an engine whose wire differs in six small ways, so
// nothing above the supervisor changes:
//
//  1. The engine has one loaded model and names it by folder; a request's
//     `model` (the role, `chat`) is rewritten to that name.
//  2. The record's pinned template variables (`reasoning_strength: low`)
//     are sent with every request, a request's own keys winning, the way
//     llama-server's `--chat-template-kwargs` launch flag merges them.
//  3. llama-server request fields the engine does not know (`cache_prompt`,
//     `id_slot`) are dropped.
//  4. The engine reports speed in its `usage` object; the final stream
//     chunk gains llama-server's `timings` object built from it, so the
//     tokens-per-second figure and the cache figure in turn stats are
//     unchanged.
//  5. The engine has no `/apply-template` or `/tokenize`; the Stack's
//     `/v1/tokenize` is answered by asking the engine for one token and
//     reading its own `usage.prompt_tokens`, which is exact (the engine's
//     template and tokenizer) and cheap (the prompt cache holds the prefix).
//  6. Every request carries the launch's bearer key.
//  7. The template tells the model to write `namespace.function` when a tool has a
//     namespace; the Home tools have none, and the 4-bit weights often echo the name
//     as `math.math` or `generate_image.generate_image`. A returned tool name that is
//     not an offered tool but whose dotted halves name one is rewritten to that tool
//     (ENGINE-MLX-02: 12 of 12 picture requests came back dotted before this).
import type { EngineClient } from "@/lib/supervisor";

/** The stand-in `/apply-template` returns: the request itself, tagged, for `/tokenize` to count. */
export const COUNT_TAG = "\u0000omlx-count\u0000";
const DROPPED_FIELDS = ["cache_prompt", "id_slot", "timings_per_token"] as const;

export interface OmlxClientOptions {
  baseUrl: string;
  apiKey: string;
  /** The folder name the engine reports for the model. */
  modelId: string;
  /** The record's pinned chat-template variables. */
  templateKwargs?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_eval_duration?: number;
  generation_duration?: number;
  prompt_tokens_per_second?: number;
  generation_tokens_per_second?: number;
}

/** The names of the tools a request offers. */
export function offeredToolNames(body: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(body.tools)) for (const tool of body.tools as Array<{ function?: { name?: unknown }; name?: unknown }>) {
    const name = tool?.function?.name ?? tool?.name;
    if (typeof name === "string") names.add(name);
  }
  return names;
}

/** `math.math` or `files.math` becomes `math` when `math` is offered and the dotted name is not. */
export function repairToolName(rawName: string, offered: Set<string>): string {
  // A template control token written after the name (`convert<|message|>`) is not part of it.
  const name = rawName.replace(/<\|[a-z_]+\|>.*$/s, "").trim();
  if (offered.size === 0 || offered.has(name) || !name.includes(".")) return offered.size > 0 && offered.has(name) ? name : (name === rawName ? rawName : name);
  const halves = name.split(".");
  const last = halves[halves.length - 1]!;
  if (offered.has(last)) return last;
  const first = halves[0]!;
  return offered.has(first) ? first : name;
}

/** Repairs the tool names in a chat completion body (non-streamed), in place. */
export function repairToolCalls(reply: unknown, offered: Set<string>): void {
  const choices = (reply as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string } }> } }> } | null)?.choices;
  if (!Array.isArray(choices) || offered.size === 0) return;
  for (const choice of choices) for (const call of choice.message?.tool_calls ?? []) if (call.function && typeof call.function.name === "string") call.function.name = repairToolName(call.function.name, offered);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** llama-server's `timings` object from the engine's usage, or null when the usage carries no speed. */
export function timingsFromUsage(usage: Usage | null | undefined): Record<string, number> | null {
  if (!usage || !finite(usage.generation_tokens_per_second) || !finite(usage.completion_tokens)) return null;
  const cached = finite(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details!.cached_tokens! : 0;
  const promptN = finite(usage.prompt_tokens) ? Math.max(0, usage.prompt_tokens - cached) : 0;
  return {
    cache_n: cached,
    prompt_n: promptN,
    prompt_ms: finite(usage.prompt_eval_duration) ? usage.prompt_eval_duration * 1000 : 0,
    prompt_per_second: finite(usage.prompt_tokens_per_second) ? usage.prompt_tokens_per_second : 0,
    predicted_n: usage.completion_tokens,
    predicted_ms: finite(usage.generation_duration) ? usage.generation_duration * 1000 : 0,
    predicted_per_second: usage.generation_tokens_per_second,
  };
}

/** Adds `timings` to the usage chunk of a server-sent-event stream; every other line passes through byte for byte. */
export function withTimingsStream(upstream: ReadableStream<Uint8Array>, offered: Set<string> = new Set()): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const rewrite = (line: string): string => {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trim();
    if (offered.size > 0 && payload.startsWith("{") && payload.includes("\"tool_calls\"")) {
      try {
        const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }> };
        let changed = false;
        for (const choice of chunk.choices ?? []) for (const call of choice.delta?.tool_calls ?? []) {
          const fn = call.function;
          if (fn && typeof fn.name === "string") { const fixed = repairToolName(fn.name, offered); if (fixed !== fn.name) { fn.name = fixed; changed = true; } }
        }
        if (changed) return `data: ${JSON.stringify(chunk)}`;
      } catch { /* not JSON: pass through */ }
    }
    if (!payload.startsWith("{") || !payload.includes("\"usage\"")) return line;
    try {
      const chunk = JSON.parse(payload) as { usage?: Usage; timings?: unknown };
      if (chunk.timings !== undefined) return line;
      const timings = timingsFromUsage(chunk.usage);
      return timings ? `data: ${JSON.stringify({ ...chunk, timings })}` : line;
    } catch { return line; }
  };
  return upstream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (lines.length > 0) controller.enqueue(encoder.encode(lines.map(rewrite).join("\n") + "\n"));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    },
  }));
}

export class OmlxEngineClient implements EngineClient {
  readonly baseUrl: string;
  private readonly options: OmlxClientOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OmlxClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string { return `${this.baseUrl}${path}`; }
  private headers(extra: Record<string, string> = {}): Record<string, string> { return { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}`, ...extra }; }

  /** The request body as the engine takes it. */
  wireBody(body: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...body, model: this.options.modelId };
    for (const key of DROPPED_FIELDS) delete out[key];
    const own = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" ? body.chat_template_kwargs as Record<string, unknown> : {};
    const merged = { ...(this.options.templateKwargs ?? {}), ...own };
    if (Object.keys(merged).length > 0) out.chat_template_kwargs = merged;
    return out;
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal, extra: Record<string, string> = {}): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), { method: "POST", headers: this.headers(extra), body: JSON.stringify(body), signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error(`Engine request failed: ${(error as Error).message}`);
    }
  }

  /** The prompt's token count from the engine's own template and tokenizer. */
  private async countPrompt(request: { messages?: unknown; tools?: unknown; chat_template_kwargs?: unknown; content?: unknown }, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const viaChat = request.messages !== undefined;
    const path = viaChat ? "/v1/chat/completions" : "/v1/completions";
    const payload: Record<string, unknown> = viaChat
      ? this.wireBody({ messages: request.messages, ...(request.tools !== undefined ? { tools: request.tools } : {}), ...(request.chat_template_kwargs !== undefined ? { chat_template_kwargs: request.chat_template_kwargs } : {}), max_tokens: 1, temperature: 0, stream: false })
      : { model: this.options.modelId, prompt: String(request.content ?? ""), max_tokens: 1, temperature: 0, stream: false };
    const response = await this.post(path, payload, signal);
    const reply = await response.json().catch(() => ({ error: `Engine returned HTTP ${response.status}.` })) as { usage?: { prompt_tokens?: number } };
    if (!response.ok) return { status: response.status, body: reply };
    const count = reply.usage?.prompt_tokens;
    if (!finite(count)) return { status: 502, body: { error: "The engine did not report a prompt token count." } };
    return { status: 200, body: { tokens: new Array<number>(count).fill(0) } };
  }

  async request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    if (path === "/apply-template") {
      const { messages, tools, chat_template_kwargs } = body as { messages?: unknown; tools?: unknown; chat_template_kwargs?: unknown };
      return { status: 200, body: { prompt: COUNT_TAG + JSON.stringify({ messages, tools, chat_template_kwargs }) } };
    }
    if (path === "/tokenize") {
      const content = typeof body.content === "string" ? body.content : "";
      if (content.startsWith(COUNT_TAG)) {
        try { return await this.countPrompt(JSON.parse(content.slice(COUNT_TAG.length)) as Record<string, unknown>, signal); }
        catch (error) { if (error instanceof SyntaxError) return { status: 400, body: { error: "The prompt to count was not understood." } }; throw error; }
      }
      return this.countPrompt({ content }, signal);
    }
    const chat = path === "/v1/chat/completions" || path === "/v1/completions";
    const response = await this.post(path, chat ? this.wireBody(body) : body, signal);
    const reply = await response.json().catch(() => ({ error: `Engine returned HTTP ${response.status}.` })) as Record<string, unknown>;
    if (chat && response.ok) repairToolCalls(reply, offeredToolNames(body));
    if (chat && response.ok && reply && typeof reply === "object" && reply.timings === undefined) {
      const timings = timingsFromUsage(reply.usage as Usage | undefined);
      if (timings) reply.timings = timings;
    }
    return { status: response.status, body: reply };
  }

  async stream(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const wire = { ...this.wireBody(body), stream: true, stream_options: { include_usage: true } };
    const response = await this.post(path, wire, signal, { accept: "text/event-stream" });
    if (!response.ok || !response.body) return response;
    return new Response(withTimingsStream(response.body, offeredToolNames(body)), { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  async raw(path: string, init: { method: string; body?: FormData | string | Uint8Array; headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), { method: init.method, headers: { authorization: `Bearer ${this.options.apiKey}`, ...(init.headers ?? {}) }, body: init.body as never, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new Error(`Engine request failed: ${(error as Error).message}`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.url("/health"), { headers: { authorization: `Bearer ${this.options.apiKey}` }, signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch { return false; }
  }
}
