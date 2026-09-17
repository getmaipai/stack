import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { apiRouter } from "@/lib/openapi";
import { identityHeaders } from "@/lib/identity";
import { noEngineResponse, resolveRole, UnknownRoleError } from "@/lib/router";
import { ROLE_IDS } from "@/roles";

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
const inferenceResponses = {
  400: { content: { "application/json": { schema: UnknownModelSchema } }, description: "Unknown role or model." },
  503: { content: { "application/json": { schema: NoEngineSchema } }, description: "No engine is bound to the role." },
} as const;

function inferenceReply<T extends Context>(c: T, model: string) {
  try {
    const resolution = resolveRole(model);
    const result = noEngineResponse(resolution.role);
    return jsonReply(c, result.body, result.status, result.headers);
  } catch (error) {
    const message = error instanceof UnknownRoleError ? error.message : "Unknown role or model.";
    return jsonReply(c, { error: message, roles: ROLE_IDS }, 400, identityHeaders(null));
  }
}

function jsonReply<T extends Context>(c: T, body: unknown, status: 400 | 503, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return c.json(body as never, status as never);
}

const chatRoute = createRoute({ method: "post", path: "/chat/completions", tags: ["Inference"], request: { body: { content: { "application/json": { schema: ChatRequestSchema } } } }, responses: inferenceResponses });
const embeddingsRoute = createRoute({ method: "post", path: "/embeddings", tags: ["Inference"], request: { body: { content: { "application/json": { schema: EmbeddingsRequestSchema } } } }, responses: inferenceResponses });
const transcriptionsRoute = createRoute({ method: "post", path: "/audio/transcriptions", tags: ["Inference"], request: { body: { content: { "application/json": { schema: TranscriptionRequestSchema } } } }, responses: inferenceResponses });
const speechRoute = createRoute({ method: "post", path: "/audio/speech", tags: ["Inference"], request: { body: { content: { "application/json": { schema: SpeechRequestSchema } } } }, responses: inferenceResponses });
const imagesRoute = createRoute({ method: "post", path: "/images/generations", tags: ["Inference"], request: { body: { content: { "application/json": { schema: ImageRequestSchema } } } }, responses: inferenceResponses });

export const inferenceRoutes = apiRouter();
inferenceRoutes.openapi(chatRoute, (c) => inferenceReply(c, c.req.valid("json").model));
inferenceRoutes.openapi(embeddingsRoute, (c) => inferenceReply(c, c.req.valid("json").model));
inferenceRoutes.openapi(transcriptionsRoute, (c) => inferenceReply(c, c.req.valid("json").model));
inferenceRoutes.openapi(speechRoute, (c) => inferenceReply(c, c.req.valid("json").model));
inferenceRoutes.openapi(imagesRoute, (c) => inferenceReply(c, c.req.valid("json").model));
