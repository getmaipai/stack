import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { apiRouter } from "@/lib/openapi";
import { recordUsage, requireClientOrOperator } from "@/lib/clients";
import { identityHeaders } from "@/lib/identity";
import { noEngineResponse, resolveRole, UnknownRoleError, UnverifiedModelError } from "@/lib/router";
import { ROLE_IDS } from "@/roles";
import { ROLES } from "@/roles";
import { completeChat, EngineUnavailableError, streamChat } from "@/lib/supervisor";

const MessageSchema = z.object({ role: z.string(), content: z.unknown() }).passthrough();
const ChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(MessageSchema),
  stream: z.boolean().optional(),
}).passthrough();
const EmbeddingsRequestSchema = z.object({ model: z.string(), input: z.union([z.string(), z.array(z.string())]) }).passthrough();
const TranscriptionRequestSchema = z.object({ model: z.string(), file: z.string().optional() }).passthrough();
const SpeechRequestSchema = z.object({ model: z.string(), input: z.string() }).passthrough();
const ImageRequestSchema = z.object({ model: z.string(), prompt: z.string() }).passthrough();

const UnknownModelSchema = z.object({ error: z.string(), roles: z.array(z.string()) });
const NoEngineSchema = z.object({
  error: z.string(),
  role: z.string(),
  state: z.string(),
  offline_reason: z.string(),
});
const RoleForbiddenSchema = z.object({ error: z.string(), role: z.string(), allowedRoles: z.array(z.string()) });
const StreamingUnavailableSchema = z.object({ error: z.literal("Streaming is not available yet"), role: z.string() });
const UnverifiedModelSchema = z.object({ error: z.string(), model: z.string(), reason: z.literal("unverified"), missing: z.array(z.string()) });
const inferenceResponses = {
  400: { content: { "application/json": { schema: z.union([UnknownModelSchema, StreamingUnavailableSchema]) } }, description: "Unknown role or unsupported streaming request." },
  401: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "A client key is required." },
  403: { content: { "application/json": { schema: RoleForbiddenSchema } }, description: "The client key is not scoped to this role." },
  409: { content: { "application/json": { schema: UnverifiedModelSchema } }, description: "The model provenance is incomplete." },
  503: { content: { "application/json": { schema: NoEngineSchema } }, description: "No engine is bound to the role." },
} as const;

async function inferenceReply<T extends Context>(c: T, model: string, body: Record<string, unknown>, chat = false) {
  try {
    const resolution = resolveRole(model);
    const client = c.var.client;
    if (client && !client.allowedRoles.includes(resolution.role)) {
      return jsonReply(c, { error: "Client is not allowed to use this role.", role: resolution.role, allowedRoles: client.allowedRoles }, 403, identityHeaders(null));
    }
    const definition = ROLES[resolution.role];
    const sharesChat = "sharesModelWith" in definition && definition.sharesModelWith === "chat";
    if (chat && body.stream === true) {
      if (definition.wire !== "chat") {
        return jsonReply(c, { error: "Streaming is not available yet", role: resolution.role }, 400, identityHeaders(null));
      }
      return await streamReply(c, model, body, client?.id ?? null) as never;
    }
    if (chat && (resolution.role === "chat" || sharesChat)) {
      const result = await completeChat(model, body);
      for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
      if (result.status >= 200 && result.status < 300) {
        const usage = (result.body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
        if (client) recordUsage(client.id, {
          requests: 1,
          tokensIn: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0,
          tokensOut: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0,
        });
      }
      return c.json(result.body as never, result.status as never);
    }
    const result = noEngineResponse(resolution.role);
    return jsonReply(c, result.body, result.status, result.headers);
  } catch (error) {
    if (error instanceof EngineUnavailableError) {
      const reason = error.reason;
      const result = noEngineResponse("chat");
      return jsonReply(c, { ...result.body, state: "offline", offline_reason: reason }, result.status, result.headers);
    }
    if (error instanceof UnverifiedModelError) {
      return jsonReply(c, { error: error.message, model: error.modelId, reason: "unverified", missing: error.missing }, 409, identityHeaders(null));
    }
    const message = error instanceof UnknownRoleError ? error.message : "Unknown role or model.";
    return jsonReply(c, { error: message, roles: ROLE_IDS }, 400, identityHeaders(null));
  }
}

async function streamReply<T extends Context>(c: T, model: string, body: Record<string, unknown>, clientId: string | null): Promise<Response> {
  const result = await streamChat(model, body, c.req.raw.signal);
  for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
  if (!result.body) {
    const payload = JSON.stringify({ error: result.status === 499 ? "Request cancelled" : "Streaming is unavailable" });
    return new Response(payload, {
      status: result.status,
      headers: { ...result.headers, "content-type": "application/json" },
    });
  }

  const decoder = new TextDecoder();
  let pending = "";
  let counted = false;
  let tokensIn = 0;
  let tokensOut = 0;
  const recordStreamUsage = (text: string) => {
    pending += text.replaceAll("\r\n", "\n");
    const events = pending.split("\n\n");
    pending = events.pop() ?? "";
    for (const event of events) {
      const data = event.split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        if (typeof parsed.usage?.prompt_tokens === "number") tokensIn = parsed.usage.prompt_tokens;
        if (typeof parsed.usage?.completion_tokens === "number") tokensOut = parsed.usage.completion_tokens;
      } catch {
        // The upstream stream is opaque to callers; an unparseable event
        // must still be passed through unchanged.
      }
    }
  };
  const tracked = result.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      recordStreamUsage(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      recordStreamUsage(decoder.decode());
      if (!counted) {
        counted = true;
        if (clientId) recordUsage(clientId, { requests: 1, tokensIn, tokensOut });
      }
    },
  }));
  return new Response(tracked, {
    status: result.status,
    headers: { ...result.headers, "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function jsonReply<T extends Context>(c: T, body: unknown, status: 400 | 403 | 409 | 503, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return c.json(body as never, status as never);
}

const clientMiddleware = [requireClientOrOperator];
const chatRoute = createRoute({ method: "post", path: "/chat/completions", tags: ["Inference"], middleware: clientMiddleware, request: { body: { content: { "application/json": { schema: ChatRequestSchema } } } }, responses: inferenceResponses });
const embeddingsRoute = createRoute({ method: "post", path: "/embeddings", tags: ["Inference"], middleware: clientMiddleware, request: { body: { content: { "application/json": { schema: EmbeddingsRequestSchema } } } }, responses: inferenceResponses });
const transcriptionsRoute = createRoute({ method: "post", path: "/audio/transcriptions", tags: ["Inference"], middleware: clientMiddleware, request: { body: { content: { "application/json": { schema: TranscriptionRequestSchema } } } }, responses: inferenceResponses });
const speechRoute = createRoute({ method: "post", path: "/audio/speech", tags: ["Inference"], middleware: clientMiddleware, request: { body: { content: { "application/json": { schema: SpeechRequestSchema } } } }, responses: inferenceResponses });
const imagesRoute = createRoute({ method: "post", path: "/images/generations", tags: ["Inference"], middleware: clientMiddleware, request: { body: { content: { "application/json": { schema: ImageRequestSchema } } } }, responses: inferenceResponses });

export const inferenceRoutes = apiRouter();
inferenceRoutes.openapi(chatRoute, (c) => inferenceReply(c, c.req.valid("json").model, c.req.valid("json"), true));
inferenceRoutes.openapi(embeddingsRoute, (c) => inferenceReply(c, c.req.valid("json").model, c.req.valid("json")));
inferenceRoutes.openapi(transcriptionsRoute, (c) => inferenceReply(c, c.req.valid("json").model, c.req.valid("json")));
inferenceRoutes.openapi(speechRoute, (c) => inferenceReply(c, c.req.valid("json").model, c.req.valid("json")));
inferenceRoutes.openapi(imagesRoute, (c) => inferenceReply(c, c.req.valid("json").model, c.req.valid("json")));
