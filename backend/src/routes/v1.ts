// The role routes: OpenAI-shaped, `model` is a role id or an installed
// model id, every reply carries the identity headers. A known role with
// no ready engine is a 503 with the reason, never a 404.
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { identityHeaders } from "@/lib/identity";
import { noEngineResponse, resolveRole, UnknownRoleError, UnverifiedModelError } from "@/lib/router";
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";
import { clampThinking, CODING_WIRE_PATHS, CodingRequestError, engineServesWire, refuseUnsupportedResponsesFields, wireNotServedMessage, type CodingWire } from "@/lib/codingWire";
import { codingEngineName, codingLaunchSettings, codingServedModel, EngineUnavailableError, getRoleStatus, requestRole, restartRole, roleHasEngine, roleIsBound, speakRole, speechForm, streamRole, ttsEngineInEffect } from "@/lib/supervisor";
import { listModels, ProvenanceIncompleteError } from "@/lib/modelStore";
import { DownloadVerificationError } from "@/lib/download";
import { POCKET_TTS_GATED_REPO } from "@/speech/pocketTts";
import { prepareChatterboxVoice, voiceSettingsRefusal } from "@/speech/chatterboxClones";
import { ensureCloningWeights, prepareVoice, voiceNeedsCloning, VoiceRefusedError } from "@/speech/voices";
import { hasJobRunner, submitJob, waitForJob } from "@/lib/jobs";
import { endWithStream, heavyGate } from "@/lib/heavyGate";
import { editImages, generateImages, ImageGenerationBodySchema, type ImageGenerationBody } from "@/routes/imageGenerations";
import { imageEngineActive } from "@/images/imageEngine";
import { IMAGE_TOOLS_OPERATIONS, stashInput, takeResult } from "@/imagetools/imageTools";
import type { ImageEditResult } from "@/imagetools/jobs";
import { RoleRequest } from "@maipai/spec/stack/ts/role-request.js";
import { RoleReplyHeaders } from "@maipai/spec/stack/ts/role-reply-headers.js";
import { TokenCountRequest, TokenCountResponse } from "@maipai/spec/stack/ts/token-count.js";

const MessageSchema = z.object({ role: z.string(), content: z.unknown() }).passthrough();
const ChatRequestSchema = RoleRequest.extend({ messages: z.array(MessageSchema) });
const EmbeddingsRequestSchema = RoleRequest.extend({ input: z.union([z.string(), z.array(z.string())]) });
// The transcription form is spec/voice's (multipart `file`, a 16-bit
// PCM WAV); `model` and `timeout_ms` ride as text fields and `model`
// is optional because this path serves one role.
const TranscriptionFormSchema = z.object({
  file: z.custom<File>((value) => value instanceof File, "A WAV file in the `file` field.").openapi({ type: "string", format: "binary" }),
  model: z.string().min(1).optional().openapi({ example: "stt" }),
  timeout_ms: z.coerce.number().int().positive().optional(),
});
const TranscriptionResponseSchema = z.object({ text: z.string() });
// The speech form is spec/voice's (`text`, an optional `voice_url`
// naming a preset or a voice URL); `model` and `timeout_ms` ride as
// text fields and `model` is optional because this path serves one role.
const SpeechFormSchema = z.object({
  text: z.string().min(1),
  voice_url: z.string().min(1).optional(),
  /** VOICES-02: the voice's own sampling temperature (0.1 to 2.0) and pitch offset in semitones (-12 to 12); the Chatterbox engine only. */
  temperature: z.coerce.number().optional(),
  pitch_semitones: z.coerce.number().optional(),
  model: z.string().min(1).optional().openapi({ example: "tts" }),
  timeout_ms: z.coerce.number().int().positive().optional(),
});
// The picture request: the role request with every field the picture generator takes (IMGGEN-STACK-02); `model` is optional (`image` is the role).
const ImageRequestSchema = ImageGenerationBodySchema;
// STACK-TOKENIZE-01: the engine's own token count, for Home's chat window
// (Home rule 2: Home never estimates what the engine can count). Either
// `messages`, rendered with the engine's own chat template first, or a
// raw `content` string; exactly one.
// The shapes are the spec's (TokenCountRequest, TokenCountResponse), never
// a second copy here.
const TokenizeRequestSchema = TokenCountRequest;
const TokenizeResponseSchema = TokenCountResponse;
const CannotCountSchema = z.object({ error: z.string(), role: z.string() });

const UnknownModelSchema = z.object({ error: z.string(), roles: z.array(z.string()) });
const NoEngineSchema = z.object({ error: z.string(), role: z.string(), state: z.string(), offline_reason: z.string() });
const UnverifiedModelSchema = z.object({ error: z.string(), model: z.string(), reason: z.literal("unverified"), missing: z.array(z.string()) });
/** A voice the Stack will not hand to the engine: not pinnable (400), or
 * cloning it needs is unavailable (409); `error` says what to do. */
const VoiceRefusedSchema = z.object({ error: z.string(), reason: z.enum(["voice-cloning-unavailable", "voice-not-pinnable"]) });
const ModelsResponseSchema = z.object({ object: z.literal("list"), data: z.array(z.object({
  id: z.string(), object: z.literal("model"), created: z.number(), owned_by: z.literal("maipai-stack"),
  role: z.string().optional().openapi({ description: "With ?role=coding: the role the model serves." }),
  context_length: z.number().int().optional().openapi({ description: "With ?role=coding: the window in tokens (the running engine's, or the one the next start asks for)." }),
  thinking_budget_ceiling: z.number().int().optional().openapi({ description: "With ?role=coding: the most thinking tokens one answer gets (stack.engines.coding.thinking_budget_ceiling); a request's own budget is clamped to it." }),
})) });
const ModelsQuerySchema = z.object({ role: z.string().optional().openapi({ description: "Only `coding`: list just that role's served model, with its context length and thinking ceiling. Left out, the list is every role id and installed model id." }) });
// The coding wires (CODE-STACK-01 S3): the request is the wire's own shape, passed to the engine as sent except for the sampling and thinking rules in lib/codingWire.ts.
const MessagesRequestSchema = z.object({ model: z.string().min(1), messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()), max_tokens: z.number().int().positive().optional(), stream: z.boolean().optional(), thinking: z.unknown().optional(), timeout_ms: z.number().int().min(1).optional() }).passthrough();
const CountTokensRequestSchema = z.object({ model: z.string().min(1), messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()) }).passthrough();
const ResponsesRequestSchema = z.object({ model: z.string().min(1), input: z.union([z.string(), z.array(z.unknown())]), stream: z.boolean().optional(), timeout_ms: z.number().int().min(1).optional() }).passthrough();
const WireNotServedSchema = z.object({ error: z.string(), role: z.string(), wire: z.string() });
const CodingRequestRefusedSchema = z.object({ error: z.string() }).passthrough();

const inferenceResponses = {
  200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "The engine's OpenAI-shaped reply, with x-maipai-engine, x-maipai-model and x-maipai-revision headers." },
  400: { content: { "application/json": { schema: UnknownModelSchema } }, description: "Unknown role or model id; the body lists the declared roles." },
  409: { content: { "application/json": { schema: UnverifiedModelSchema } }, description: "The named model's provenance is incomplete." },
  503: { content: { "application/json": { schema: NoEngineSchema } }, description: "No engine is ready for the role; offline_reason says why." },
} as const;

type Wire = "chat" | "embeddings" | "transcription" | "speech" | "job";
const DEFAULT_RENDER_WAIT_MS = 120_000;
const WIRE_PATHS: Record<Exclude<Wire, "job">, string> = { chat: "/v1/chat/completions", embeddings: "/v1/embeddings", transcription: "/v1/audio/transcriptions", speech: "/v1/audio/speech" };

function jsonReply<T extends Context>(c: T, body: unknown, status: number, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(RoleReplyHeaders.parse(headers))) c.header(name, value);
  return c.json(body as never, status as never);
}

async function reply<T extends Context>(c: T, wire: Wire, body: Record<string, unknown>) {
  const modelField = String(body.model);
  try {
    const resolution = resolveRole(modelField);
    const role: RoleId = resolution.role;
    const definition = ROLES[role];
    if (definition.wire !== wire && !(wire === "chat" && definition.wire === "chat")) {
      return jsonReply(c, { error: `Role '${role}' does not answer on this endpoint.`, roles: ROLE_IDS.filter((id) => ROLES[id].wire === wire) }, 400, identityHeaders(null));
    }
    if (wire === "job") {
      // The job API with a wait: the render is submitted, the reply waits
      // for it up to timeout_ms (two minutes when unsaid) and answers in
      // OpenAI's image shape; past the deadline the job goes on and the
      // reply carries its id, 202, for Home to fetch by id.
      if (!hasJobRunner(role) || !roleIsBound(role) || !roleHasEngine(role)) { const result = noEngineResponse(role, !roleHasEngine(role) ? `No ${role} engine is installed on this machine.` : undefined); return jsonReply(c, result.body, result.status, result.headers); }
      const submitted = submitJob({ kind: role, role, input: body });
      if ("refused" in submitted) return jsonReply(c, { ...noEngineResponse(role, submitted.reason).body }, 503, identityHeaders(null));
      const timeoutMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : DEFAULT_RENDER_WAIT_MS;
      const settled = await waitForJob(submitted.job.id, timeoutMs);
      const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
      if (!settled || settled.state === "queued" || settled.state === "running") return jsonReply(c, { created, job: submitted.job.id, data: [] }, 202, identityHeaders(null));
      // A render that failed inside the generator is the generator's
      // error (500 with the reason), never the no-engine 503 a client
      // would back off from; a cancelled one is 499.
      if (settled.state !== "done") return jsonReply(c, { error: settled.reason ?? `The render was ${settled.state}.`, job: settled.id, role, state: settled.state }, settled.state === "cancelled" ? 499 : 500, identityHeaders(null));
      const images = (settled.result as { images?: Array<Record<string, unknown>> } | null)?.images ?? [];
      return jsonReply(c, { created, job: settled.id, data: images }, 200, identityHeaders(null));
    }
    // CODE-STACK-01 S3: the coding role's thinking budget never exceeds the admin's ceiling, on this wire as on the Anthropic and Responses ones.
    if (role === "coding" && wire === "chat") body = clampThinking(body, codingLaunchSettings().thinkingBudgetTokens);
    // ISOLATION-01: a chat or transcription request is interactive for as long as it is in flight; a running heavy job is paused meanwhile.
    const interactive = wire === "chat" || wire === "transcription";
    if (wire === "chat" && body.stream === true) {
      const end = heavyGate.begin(role);
      let result: Awaited<ReturnType<typeof streamRole>>;
      try { result = await streamRole(role, WIRE_PATHS.chat, body, c.req.raw.signal); } catch (error) { end(); throw error; }
      for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
      if (!result.body) { end(); return new Response(JSON.stringify({ error: result.status === 499 ? "Request cancelled" : "Streaming is unavailable" }), { status: result.status, headers: { ...result.headers, "content-type": "application/json" } }); }
      return new Response(endWithStream(result.body, end), { status: result.status, headers: { ...result.headers, "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    const end = interactive ? heavyGate.begin(role) : () => {};
    try {
      const result = await requestRole(role, WIRE_PATHS[wire], body, c.req.raw.signal);
      return jsonReply(c, result.body, result.status, result.headers);
    } finally { end(); }
  } catch (error) {
    if (error instanceof CodingRequestError) return jsonReply(c, { error: error.message }, 400, identityHeaders(null));
    if (error instanceof EngineUnavailableError) {
      const role = (() => { try { return resolveRole(modelField).role; } catch { return "chat" as RoleId; } })();
      const result = noEngineResponse(role, error.reason);
      return jsonReply(c, result.body, result.status, result.headers);
    }
    if (error instanceof UnverifiedModelError) return jsonReply(c, { error: error.message, model: error.modelId, reason: "unverified", missing: error.missing }, 409, identityHeaders(null));
    const message = error instanceof UnknownRoleError ? error.message : "Unknown role or model.";
    return jsonReply(c, { error: message, roles: ROLE_IDS }, 400, identityHeaders(null));
  }
}

/** STACK-TOKENIZE-01: llama-server's own /apply-template and /tokenize,
 * passed through on a chat-wire role with the same resolution, identity
 * headers and engine checks as a completion. An engine without those
 * routes (404) is a 501 that says so; the Stack never estimates. */
async function tokenizeReply<T extends Context>(c: T, body: TokenCountRequest) {
  const modelField = String(body.model);
  try {
    const role = resolveRole(modelField).role;
    if (ROLES[role].wire !== "chat") return jsonReply(c, { error: `Role '${role}' does not count tokens.`, roles: ROLE_IDS.filter((id) => ROLES[id].wire === "chat") }, 400, identityHeaders(null));
    if ((body.messages === undefined) === (body.content === undefined)) return jsonReply(c, { error: "Send exactly one of `messages` or `content`.", roles: ROLE_IDS.filter((id) => ROLES[id].wire === "chat") }, 400, identityHeaders(null));
    const cannotCount = (headers: Record<string, string>) => jsonReply(c, { error: `This ${role} engine does not report token counts.`, role }, 501, headers);
    let content = body.content;
    if (body.messages !== undefined) {
      // The tools block and template switches render into the real prompt,
      // so they are counted too (a review); image parts are not (below).
      const rendered = await requestRole(role, "/apply-template", { model: body.model, messages: body.messages, add_generation_prompt: false, ...(body.tools !== undefined ? { tools: body.tools } : {}), ...(body.chat_template_kwargs !== undefined ? { chat_template_kwargs: body.chat_template_kwargs } : {}), ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}) }, c.req.raw.signal);
      if (rendered.status === 404) return cannotCount(rendered.headers);
      const prompt = (rendered.body as { prompt?: unknown } | null)?.prompt;
      if (rendered.status < 200 || rendered.status >= 300 || typeof prompt !== "string") return jsonReply(c, rendered.body, rendered.status >= 400 ? rendered.status : 502, rendered.headers);
      content = prompt;
    }
    const counted = await requestRole(role, "/tokenize", { model: body.model, content, add_special: true, ...(body.timeout_ms !== undefined ? { timeout_ms: body.timeout_ms } : {}) }, c.req.raw.signal);
    if (counted.status === 404) return cannotCount(counted.headers);
    const tokens = (counted.body as { tokens?: unknown } | null)?.tokens;
    if (counted.status < 200 || counted.status >= 300 || !Array.isArray(tokens)) return jsonReply(c, counted.body, counted.status >= 400 ? counted.status : 502, counted.headers);
    return jsonReply(c, { count: tokens.length }, 200, counted.headers);
  } catch (error) {
    if (error instanceof EngineUnavailableError) {
      const role = (() => { try { return resolveRole(modelField).role; } catch { return "chat" as RoleId; } })();
      const result = noEngineResponse(role, error.reason);
      return jsonReply(c, result.body, result.status, result.headers);
    }
    if (error instanceof UnverifiedModelError) return jsonReply(c, { error: error.message, model: error.modelId, reason: "unverified", missing: error.missing }, 409, identityHeaders(null));
    return jsonReply(c, { error: error instanceof UnknownRoleError ? error.message : "Unknown role or model.", roles: ROLE_IDS }, 400, identityHeaders(null));
  }
}

/** The coding wires: `model` must resolve to the coding role (a role id or its installed model id, as for every role), the engine must serve the wire, and the engine's bytes come back as they are. The thinking ceiling is applied here; sampling is dropped and set in the supervisor so a direct caller of requestRole/streamRole gets the same. */
async function codingWireReply<T extends Context>(c: T, wire: CodingWire, body: Record<string, unknown>) {
  const modelField = String(body.model);
  try {
    const role = resolveRole(modelField).role;
    if (role !== "coding") return jsonReply(c, { error: `Role '${role}' does not answer on this endpoint. Send model 'coding'.`, roles: ["coding"] }, 400, identityHeaders(null));
    const engine = codingEngineName();
    if (!engineServesWire(engine, wire)) return jsonReply(c, { error: wireNotServedMessage(wire, engine), role, wire }, 501, identityHeaders(null));
    const path = CODING_WIRE_PATHS[wire];
    if (wire === "responses") refuseUnsupportedResponsesFields(body);
    const sent = wire === "count_tokens" ? body : clampThinking(body, codingLaunchSettings().thinkingBudgetTokens);
    const notServed = (headers: Record<string, string>) => jsonReply(c, { error: wireNotServedMessage(wire, engine), role, wire }, 501, headers);
    if (wire !== "count_tokens" && body.stream === true) {
      const end = heavyGate.begin(role);
      let result: Awaited<ReturnType<typeof streamRole>>;
      try { result = await streamRole(role, path, sent, c.req.raw.signal); } catch (error) { end(); throw error; }
      for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
      if (result.status === 404) { end(); await result.body?.cancel().catch(() => {}); return notServed(result.headers); }
      if (!result.body) { end(); return new Response(JSON.stringify({ error: result.status === 499 ? "Request cancelled" : "The coding engine did not answer. Send the request again." }), { status: result.status, headers: { ...result.headers, "content-type": "application/json" } }); }
      return new Response(endWithStream(result.body, end), { status: result.status, headers: { ...result.headers, "content-type": result.contentType ?? "text/event-stream", "cache-control": "no-cache" } });
    }
    const end = heavyGate.begin(role);
    try {
      const result = await requestRole(role, path, sent, c.req.raw.signal);
      if (result.status === 404) return notServed(result.headers);
      return jsonReply(c, result.body, result.status, result.headers);
    } finally { end(); }
  } catch (error) {
    if (error instanceof CodingRequestError) return jsonReply(c, { error: error.message }, 400, identityHeaders(null));
    if (error instanceof EngineUnavailableError) { const result = noEngineResponse("coding", error.reason); return jsonReply(c, result.body, result.status, result.headers); }
    if (error instanceof UnverifiedModelError) return jsonReply(c, { error: error.message, model: error.modelId, reason: "unverified", missing: error.missing }, 409, identityHeaders(null));
    return jsonReply(c, { error: error instanceof UnknownRoleError ? error.message : "Unknown role or model.", roles: ROLE_IDS }, 400, identityHeaders(null));
  }
}

const modelsRoute = createRoute({ method: "get", path: "/models", tags: ["Roles"], summary: "Role ids and installed model ids, or one role's served model", request: { query: ModelsQuerySchema }, responses: { 200: { content: { "application/json": { schema: ModelsResponseSchema } }, description: "OpenAI's model-list shape. With `?role=coding`, the coding role's one served model (empty when none is installed) with `context_length` and `thinking_budget_ceiling`." }, 400: { content: { "application/json": { schema: CodingRequestRefusedSchema } }, description: "A role other than coding was named; only coding has a scoped list." } } });
const codingWireResponses = {
  ...inferenceResponses,
  200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) }, "text/event-stream": { schema: z.string() } }, description: "The engine's own reply, byte for byte: JSON, or its server-sent events when `stream` is true, with the identity headers. Abort the request to cancel." },
  400: { content: { "application/json": { schema: z.union([UnknownModelSchema, CodingRequestRefusedSchema]) } }, description: "Unknown role or model id, a role other than coding, a thinking budget that is not a number, chat_template_kwargs that is not an object, or (Responses) a previous_response_id: send the whole conversation with every request." },
  501: { content: { "application/json": { schema: WireNotServedSchema } }, description: "The engine bound to the coding role does not serve this wire; `error` says what to use instead. The engine is not started to find out." },
} as const;
const messagesRoute = createRoute({ method: "post", path: "/messages", tags: ["Roles"], summary: "Anthropic Messages for the coding role (the engine's native wire)", request: { body: { content: { "application/json": { schema: MessagesRequestSchema } } } }, responses: codingWireResponses });
const countTokensRoute = createRoute({ method: "post", path: "/messages/count_tokens", tags: ["Roles"], summary: "Anthropic token count for the coding role (the engine's native wire)", request: { body: { content: { "application/json": { schema: CountTokensRequestSchema } } } }, responses: codingWireResponses });
const responsesRoute = createRoute({ method: "post", path: "/responses", tags: ["Roles"], summary: "OpenAI Responses for the coding role (the engine's native wire)", request: { body: { content: { "application/json": { schema: ResponsesRequestSchema } } } }, responses: codingWireResponses });
const chatRoute = createRoute({ method: "post", path: "/chat/completions", tags: ["Roles"], summary: "Chat completions by role", request: { body: { content: { "application/json": { schema: ChatRequestSchema } } } }, responses: inferenceResponses });
const tokenizeRoute = createRoute({ method: "post", path: "/tokenize", tags: ["Roles"], summary: "Token count by role, from the engine's own template and tokenizer", request: { body: { content: { "application/json": { schema: TokenizeRequestSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: TokenizeResponseSchema } }, description: "The engine's token count: `messages` (with `tools` and `chat_template_kwargs` when sent) rendered with its chat template, no generation prompt, or `content` as given, with the identity headers. Image parts count as the template's media marker only, not the image's own tokens." }, 501: { content: { "application/json": { schema: CannotCountSchema } }, description: "The engine bound to the role has no token-count route." } } });
const embeddingsRoute = createRoute({ method: "post", path: "/embeddings", tags: ["Roles"], summary: "Embeddings by role", request: { body: { content: { "application/json": { schema: EmbeddingsRequestSchema } } } }, responses: inferenceResponses });
const transcriptionsRoute = createRoute({ method: "post", path: "/audio/transcriptions", tags: ["Roles"], summary: "Speech to text (one WAV file, spec/voice's transcribe form)", request: { body: { content: { "multipart/form-data": { schema: TranscriptionFormSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: TranscriptionResponseSchema } }, description: "SttTranscribeResponse: the transcript, empty when the file holds no speech, with the identity headers." } } });
const speechRoute = createRoute({ method: "post", path: "/audio/speech", tags: ["Roles"], summary: "Text to speech (spec/voice's form, the WAV streamed as it is generated)", request: { body: { content: { "multipart/form-data": { schema: SpeechFormSchema } } } }, responses: { ...inferenceResponses, 400: { content: { "application/json": { schema: z.union([UnknownModelSchema, VoiceRefusedSchema]) } }, description: "Unknown role or model id, or a voice the Stack cannot pin and verify (reason voice-not-pinnable)." }, 409: { content: { "application/json": { schema: z.union([UnverifiedModelSchema, VoiceRefusedSchema]) } }, description: "The named model's provenance is incomplete, or the voice needs voice cloning that is off or has no token (reason voice-cloning-unavailable)." }, 200: { content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } }, description: "TtsSynthesizeResult: a chunked audio/wav body whose header carries the format and a placeholder data size, with the identity headers. Abort the request to cancel." } } });
const ImageResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(z.record(z.string(), z.unknown())) });
const RenderFailedSchema = z.object({ error: z.string(), job: z.string(), role: z.string(), state: z.enum(["failed", "cancelled"]) });
const imagesRoute = createRoute({ method: "post", path: "/images/generations", tags: ["Roles"], summary: "Image generation (the job API with a wait)", request: { body: { content: { "application/json": { schema: ImageRequestSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: ImageResponseSchema } }, description: "OpenAI's image shape with the job id: `data` holds one `{ b64_json }` per image once the render finished within timeout_ms." }, 202: { content: { "application/json": { schema: ImageResponseSchema } }, description: "The render is still running past timeout_ms; fetch it by `job` on /stack/v1/jobs/{id}." }, 499: { content: { "application/json": { schema: RenderFailedSchema } }, description: "The render was cancelled." }, 500: { content: { "application/json": { schema: RenderFailedSchema } }, description: "The generator failed the render; the reason is the generator's own, not an outage." } } });

export const v1Routes = apiRouter<AppEnv>();
v1Routes.openapi(modelsRoute, (c) => {
  const { role } = c.req.valid("query");
  if (role === undefined) return c.json({ object: "list" as const, data: [...new Set([...ROLE_IDS, ...listModels().map((model) => model.id)])].map((id) => ({ id, object: "model" as const, created: 0, owned_by: "maipai-stack" as const })) }, 200) as never;
  if (role !== "coding") return jsonReply(c, { error: `Only the coding role has a scoped model list; '${role}' is not supported. Leave out ?role to list every role and model.` }, 400, identityHeaders(null)) as never;
  const served = codingServedModel();
  return c.json({ object: "list" as const, data: served ? [{ id: served.id, object: "model" as const, created: 0, owned_by: "maipai-stack" as const, role: "coding", context_length: served.context_length, thinking_budget_ceiling: served.thinking_budget_ceiling }] : [] }, 200) as never;
});
v1Routes.openapi(messagesRoute, (c) => codingWireReply(c, "messages", c.req.valid("json")) as never);
v1Routes.openapi(countTokensRoute, (c) => codingWireReply(c, "count_tokens", c.req.valid("json")) as never);
v1Routes.openapi(responsesRoute, (c) => codingWireReply(c, "responses", c.req.valid("json")) as never);
v1Routes.openapi(chatRoute, (c) => reply(c, "chat", c.req.valid("json")) as never);
v1Routes.openapi(tokenizeRoute, (c) => tokenizeReply(c, c.req.valid("json")) as never);
v1Routes.openapi(embeddingsRoute, (c) => reply(c, "embeddings", c.req.valid("json")) as never);
v1Routes.openapi(transcriptionsRoute, async (c) => {
  const form = c.req.valid("form");
  const audio_base64 = Buffer.from(await form.file.arrayBuffer()).toString("base64");
  return reply(c, "transcription", { model: form.model ?? "stt", timeout_ms: form.timeout_ms, audio_base64 }) as never;
});
v1Routes.openapi(speechRoute, async (c) => {
  const form = c.req.valid("form");
  const modelField = form.model ?? "tts";
  try {
    const resolution = resolveRole(modelField);
    if (ROLES[resolution.role].wire !== "speech") return jsonReply(c, { error: `Role '${resolution.role}' does not answer on this endpoint.`, roles: ROLE_IDS.filter((id) => ROLES[id].wire === "speech") }, 400, identityHeaders(null));
    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (form.timeout_ms) setTimeout(() => controller.abort(), form.timeout_ms);
    // The voice the engine will read is on disk before the ask (fetched
    // by the Stack once, then served offline); a voice that needs the
    // cloning weights waits for them and for an engine that loaded them.
    // Only Pocket TTS names its voices by preset or path; the MLX engine
    // speaks its one built-in voice, so a voice Home saved from Pocket's
    // list (or none) is not an error there (VOICE-STUDIO-01). A clip
    // address on the household's network is the one voice it takes
    // besides, with the voice's own temperature and pitch (VOICES-02).
    const pocket = ttsEngineInEffect() === "pocket";
    const refusal = voiceSettingsRefusal(form.temperature, form.pitch_semitones);
    if (refusal) return jsonReply(c, { error: refusal, reason: "voice-setting-out-of-range" }, 400, identityHeaders(null));
    const voice = pocket ? await prepareVoice(form.voice_url, { signal: controller.signal }) : await prepareChatterboxVoice(form.voice_url, { signal: controller.signal });
    if (pocket && voiceNeedsCloning(voice)) await ensureCloningLoaded(resolution.role, controller.signal);
    // ISOLATION-01: speech is interactive from the ask until the last audio is sent (a heavy job is paused meanwhile).
    const end = heavyGate.begin(resolution.role);
    let spoken: Awaited<ReturnType<typeof speakRole>>;
    try { spoken = await speakRole(resolution.role, speechForm(form.text, voice, pocket || !voice ? {} : { temperature: form.temperature, pitch_semitones: form.pitch_semitones }), controller.signal); } catch (error) { end(); throw error; }
    for (const [name, value] of Object.entries(spoken.headers)) c.header(name, value);
    if (!spoken.body) { end(); return new Response(JSON.stringify({ error: spoken.status === 499 ? "Request cancelled" : spoken.status === 504 ? "The engine timed out." : "The engine did not answer." }), { status: spoken.status, headers: { ...spoken.headers, "content-type": "application/json" } }); }
    return new Response(endWithStream(spoken.body, end), { status: spoken.status, headers: { ...spoken.headers, "content-type": spoken.contentType ?? "audio/wav", "cache-control": "no-cache" } });
  } catch (error) {
    if (error instanceof EngineUnavailableError) { const result = noEngineResponse("tts", error.reason); return jsonReply(c, result.body, result.status, result.headers); }
    if (error instanceof UnverifiedModelError) return jsonReply(c, { error: error.message, model: error.modelId, reason: "unverified", missing: error.missing }, 409, identityHeaders(null));
    if (error instanceof VoiceRefusedError) return jsonReply(c, { error: error.message, reason: error.reason }, error.status, identityHeaders(null));
    if (error instanceof DownloadVerificationError || error instanceof ProvenanceIncompleteError) return jsonReply(c, { error: `The voice could not be fetched: ${error.message}`, reason: "voice-not-pinnable" }, 400, identityHeaders(null));
    return jsonReply(c, { error: error instanceof UnknownRoleError ? error.message : "Unknown role or model.", roles: ROLE_IDS }, 400, identityHeaders(null));
  }
});
/** The cloning weights on disk and loaded: fetched now if they can be
 * (a token, cloning on), and the engine restarted when it is running
 * on the ungated twin, so the voice is encoded through the right
 * weights rather than answered 500 by the engine. */
async function ensureCloningLoaded(role: RoleId, signal: AbortSignal): Promise<void> {
  let fetched: boolean;
  try {
    fetched = await ensureCloningWeights({ signal });
  } catch (error) {
    if (error instanceof DownloadVerificationError || error instanceof ProvenanceIncompleteError) throw new VoiceRefusedError(`The voice-cloning weights could not be fetched: ${error.message}`, 409, "voice-cloning-unavailable");
    throw error;
  }
  if (!fetched) throw new VoiceRefusedError("This voice needs the voice-cloning weights, which Hugging Face keeps behind a token; set stack.engines.tts.hf_token, turn on stack.engines.tts.voice_cloning and restart the voice engine.", 409, "voice-cloning-unavailable");
  const status = getRoleStatus(role);
  if (status.state === "ready" || status.state === "busy") {
    if (status.identity?.model !== POCKET_TTS_GATED_REPO) await restartRole(role);
  }
}
// When the picture generator's weights are installed the mflux path answers (images/imageEngine.ts); otherwise the supervised ComfyUI does.
v1Routes.openapi(imagesRoute, (c) => {
  const body = c.req.valid("json") as ImageGenerationBody;
  const model = body.model ?? "image";
  if (imageEngineActive() && (model === "image" || model === "flux2-klein-4b" || model === "z-image-turbo")) return generateImages(c, body) as never;
  return reply(c, "job", { ...body, model }) as never;
});

// IMAGETOOLS-01: edits on a picture the person already has (additive). The
// job API with a wait, like /images/generations; the picture and mask ride
// as files in the form, never in the job record.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const ImageEditFormSchema = z.object({
  image: z.custom<File>((value) => value instanceof File, "The picture in the `image` field.").openapi({ type: "string", format: "binary" }),
  mask: z.custom<File>((value) => value instanceof File, "The mask in the `mask` field.").openapi({ type: "string", format: "binary" }).optional(),
  operation: z.enum([...IMAGE_TOOLS_OPERATIONS, "edit", "edit_masked"]).openapi({ description: "remove_background (a transparent PNG), erase (needs `mask`: white is removed), upscale (`scale` 2 or 4), resize (`width` and/or `height`, or `factor`); edit (change the picture as the `instruction` says) and edit_masked (the same, but only the painted `mask` or the `region` can change: the rest is the original, bit for bit, beyond a feathered edge) answer like /v1/images/generations: data[] has `url` and `b64_json`, and the files are under /v1/images/generations/{job}/0.png." }),
  instruction: z.string().optional().openapi({ description: "edit and edit_masked: what to change, in words (`prompt` is accepted too)." }),
  prompt: z.string().optional(),
  region: z.string().optional().openapi({ description: "edit_masked: x,y,width,height as fractions of the picture, like 0.4,0.5,0.2,0.2; the area to change when no mask is sent." }),
  feather: z.coerce.number().min(0).max(64).optional().openapi({ description: "edit_masked: pixels of soft edge on the mask (default 12). 0 changes exactly the mask." }),
  people: z.string().max(80).optional().openapi({ description: "erase_people: the people to remove, numbers from a find_people answer joined by commas (\"1,3\"), or \"all\". find_people answers with `people` (numbered boxes as fractions of the picture) and a copy of the picture with the boxes drawn and numbered." }),
  seed: z.coerce.number().int().min(0).optional(),
  steps: z.coerce.number().int().min(1).max(30).optional(),
  scale: z.coerce.number().int().optional(),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  factor: z.coerce.number().positive().optional(),
  engine: z.enum(["auto", "vision", "isnet"]).optional().openapi({ description: "remove_background only: auto uses Apple's on-device finder when this Mac has it, else the ONNX model." }),
  timeout_ms: z.coerce.number().int().positive().optional(),
  image_source: z.enum(["generated", "uploaded", "household_photo"]).optional().openapi({ description: "edit and edit_masked: where the picture came from, as Home knows it (required): `generated` (this Stack made it; its hash is checked), `household_photo` (a photo of a consenting household adult; needs `consent_proof`) or `uploaded` (a photo Home checked shows no person)." }),
  consent_proof: z.string().max(4096).optional().openapi({ description: "With `image_source: household_photo`: Home's signed proof, bound to this exact picture, valid for at most 30 minutes. Each proof is accepted once." }),
  reference: z.custom<File>((value) => value instanceof File, "A reference picture.").openapi({ type: "string", format: "binary", description: "edit and edit_masked: a picture the edit draws on, like a person to add to the scene (\"add the woman from the second picture\"). Up to two (`reference`, `reference2`). Declare where each came from with `reference_source` and, for a household photo, `reference_proof`." }).optional(),
  reference_source: z.enum(["generated", "uploaded", "household_photo"]).optional(),
  reference_proof: z.string().max(4096).optional(),
  reference2: z.custom<File>((value) => value instanceof File, "A second reference picture.").openapi({ type: "string", format: "binary" }).optional(),
  reference2_source: z.enum(["generated", "uploaded", "household_photo"]).optional(),
  reference2_proof: z.string().max(4096).optional(),
  audience: z.enum(["all-ages", "adult"]).optional().openapi({ description: "edit and edit_masked: who the picture is for. A household photo is accepted only with `adult`." }),
});
const ImageEditResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(z.record(z.string(), z.unknown())) });
const ImageEditErrorSchema = z.object({ error: z.string(), code: z.string().optional(), job: z.string().optional() });
const imageEditsRoute = createRoute({ method: "post", path: "/images/edits", tags: ["Roles"], summary: "Image edits: remove background, erase, upscale, resize (the job API with a wait)", request: { body: { content: { "multipart/form-data": { schema: ImageEditFormSchema } } } }, responses: {
  200: { content: { "application/json": { schema: ImageEditResponseSchema } }, description: "`data` holds one `{ b64_json, width, height, content_type, operation, engine, model, ms }`: a PNG with no metadata." },
  202: { content: { "application/json": { schema: ImageEditResponseSchema } }, description: "Still running past timeout_ms; fetch the PNG from GET /v1/images/edits/{job} when /stack/v1/jobs/{job} says done." },
  400: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "The form is incomplete." },
  413: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "The picture is bigger than the tool takes; `error` says the limit." },
  422: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "The request cannot be done (an empty mask, no subject found, a bad scale); `error` says what to change." },
  500: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "The tool failed on this picture." },
  503: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "The tools or a model file are not installed, or there is no free memory; `error` says what to do." },
} });
const imageEditResultRoute = createRoute({ method: "get", path: "/images/edits/{job}", tags: ["Roles"], summary: "The PNG a finished edit produced (kept in memory for a few minutes)", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "image/png": { schema: z.string().openapi({ format: "binary" }) } }, description: "The edited picture." }, 404: { content: { "application/json": { schema: ImageEditErrorSchema } }, description: "No such result (it expired or was never made)." } } });

v1Routes.openapi(imageEditsRoute, async (c) => {
  const form = c.req.valid("form");
  if (form.operation === "edit" || form.operation === "edit_masked") {
    if (form.image.size === 0 || form.image.size > MAX_UPLOAD_BYTES) return jsonReply(c, { error: `The picture must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, code: "too_large" }, 413, identityHeaders(null)) as never;
    if (form.mask && form.mask.size > MAX_UPLOAD_BYTES) return jsonReply(c, { error: "The mask is too big.", code: "too_large" }, 413, identityHeaders(null)) as never;
    return editImages(c, { image: form.image, mask: form.mask, operation: form.operation, instruction: form.instruction, prompt: form.prompt, region: form.region, feather: form.feather, seed: form.seed, steps: form.steps, timeout_ms: form.timeout_ms, image_source: form.image_source, consent_proof: form.consent_proof, audience: form.audience, references: [...(form.reference ? [{ file: form.reference, source: form.reference_source, proof: form.reference_proof }] : []), ...(form.reference2 ? [{ file: form.reference2, source: form.reference2_source, proof: form.reference2_proof }] : [])] }) as never;
  }
  if (form.image.size === 0 || form.image.size > MAX_UPLOAD_BYTES) return jsonReply(c, { error: `The picture must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`, code: "too_large" }, 413, identityHeaders(null)) as never;
  if (form.mask && form.mask.size > MAX_UPLOAD_BYTES) return jsonReply(c, { error: "The mask is too big.", code: "too_large" }, 413, identityHeaders(null)) as never;
  if (!hasJobRunner("image_edit")) return jsonReply(c, { error: "The image tools are not available on this machine.", code: "unsupported" }, 503, identityHeaders(null)) as never;
  const token = crypto.randomUUID();
  const params: Record<string, unknown> = { ...(form.scale !== undefined ? { scale: form.scale } : {}), ...(form.width !== undefined ? { width: form.width } : {}), ...(form.height !== undefined ? { height: form.height } : {}), ...(form.factor !== undefined ? { factor: form.factor } : {}), ...(form.engine ? { engine: form.engine } : {}), ...(form.people ? { people: form.people === "all" ? "all" : form.people.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0) } : {}) };
  stashInput(token, { operation: form.operation as typeof IMAGE_TOOLS_OPERATIONS[number], image: new Uint8Array(await form.image.arrayBuffer()), ...(form.mask ? { mask: new Uint8Array(await form.mask.arrayBuffer()) } : {}), params });
  const submitted = submitJob({ kind: "image_edit", role: "image", input: { operation: form.operation, params, token } });
  if ("refused" in submitted) return jsonReply(c, { error: submitted.reason, code: "unsupported" }, 503, identityHeaders(null)) as never;
  const timeoutMs = typeof form.timeout_ms === "number" ? form.timeout_ms : DEFAULT_RENDER_WAIT_MS;
  const settled = await waitForJob(submitted.job.id, timeoutMs);
  const created = Math.floor(new Date(submitted.job.createdAt).getTime() / 1000);
  if (!settled || settled.state === "queued" || settled.state === "running") return jsonReply(c, { created, job: submitted.job.id, data: [] }, 202, identityHeaders(null)) as never;
  if (settled.state === "cancelled") return jsonReply(c, { error: "The edit was cancelled.", code: "cancelled", job: settled.id }, 499, identityHeaders(null)) as never;
  if (settled.state !== "done") return jsonReply(c, { error: settled.reason ?? "The edit failed.", code: "failed", job: settled.id }, 500, identityHeaders(null)) as never;
  const outcome = settled.result as ImageEditResult | null;
  if (outcome?.rejected) return jsonReply(c, { error: outcome.rejected.message, code: outcome.rejected.code, job: settled.id }, outcome.rejected.status, identityHeaders(null)) as never;
  const kept = takeResult(settled.id);
  if (!kept) return jsonReply(c, { error: "The result is no longer held; run the edit again.", code: "expired", job: settled.id }, 500, identityHeaders(null)) as never;
  return jsonReply(c, { created, job: settled.id, data: [{ b64_json: Buffer.from(kept.png).toString("base64"), width: kept.width, height: kept.height, content_type: "image/png", operation: kept.operation, engine: kept.engine, model: kept.model, ms: kept.ms, ...(kept.people ? { people: kept.people } : {}) }] }, 200, identityHeaders(null)) as never;
});
v1Routes.openapi(imageEditResultRoute, (c) => {
  const kept = takeResult(c.req.valid("param").job);
  if (!kept) return jsonReply(c, { error: "No such result: it expired after a few minutes or was never made. Run the edit again.", code: "expired" }, 404, identityHeaders(null)) as never;
  return new Response(kept.png, { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store" } }) as never;
});
