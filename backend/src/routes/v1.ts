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
import { EngineUnavailableError, getRoleStatus, requestRole, restartRole, roleHasEngine, roleIsBound, speakRole, speechForm, streamRole } from "@/lib/supervisor";
import { listModels, ProvenanceIncompleteError } from "@/lib/modelStore";
import { DownloadVerificationError } from "@/lib/download";
import { POCKET_TTS_GATED_REPO } from "@/speech/pocketTts";
import { ensureCloningWeights, prepareVoice, voiceNeedsCloning, VoiceRefusedError } from "@/speech/voices";
import { hasJobRunner, submitJob, waitForJob } from "@/lib/jobs";
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
  model: z.string().min(1).optional().openapi({ example: "tts" }),
  timeout_ms: z.coerce.number().int().positive().optional(),
});
const ImageRequestSchema = RoleRequest.extend({ prompt: z.string() });
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
const ModelsResponseSchema = z.object({ object: z.literal("list"), data: z.array(z.object({ id: z.string(), object: z.literal("model"), created: z.number(), owned_by: z.literal("maipai-stack") })) });

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
    if (wire === "chat" && body.stream === true) {
      const result = await streamRole(role, WIRE_PATHS.chat, body, c.req.raw.signal);
      for (const [name, value] of Object.entries(result.headers)) c.header(name, value);
      if (!result.body) return new Response(JSON.stringify({ error: result.status === 499 ? "Request cancelled" : "Streaming is unavailable" }), { status: result.status, headers: { ...result.headers, "content-type": "application/json" } });
      return new Response(result.body, { status: result.status, headers: { ...result.headers, "content-type": "text/event-stream", "cache-control": "no-cache" } });
    }
    const result = await requestRole(role, WIRE_PATHS[wire], body, c.req.raw.signal);
    return jsonReply(c, result.body, result.status, result.headers);
  } catch (error) {
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

const modelsRoute = createRoute({ method: "get", path: "/models", tags: ["Roles"], summary: "Role ids and installed model ids", responses: { 200: { content: { "application/json": { schema: ModelsResponseSchema } }, description: "OpenAI's model-list shape." } } });
const chatRoute = createRoute({ method: "post", path: "/chat/completions", tags: ["Roles"], summary: "Chat completions by role", request: { body: { content: { "application/json": { schema: ChatRequestSchema } } } }, responses: inferenceResponses });
const tokenizeRoute = createRoute({ method: "post", path: "/tokenize", tags: ["Roles"], summary: "Token count by role, from the engine's own template and tokenizer", request: { body: { content: { "application/json": { schema: TokenizeRequestSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: TokenizeResponseSchema } }, description: "The engine's token count: `messages` (with `tools` and `chat_template_kwargs` when sent) rendered with its chat template, no generation prompt, or `content` as given, with the identity headers. Image parts count as the template's media marker only, not the image's own tokens." }, 501: { content: { "application/json": { schema: CannotCountSchema } }, description: "The engine bound to the role has no token-count route." } } });
const embeddingsRoute = createRoute({ method: "post", path: "/embeddings", tags: ["Roles"], summary: "Embeddings by role", request: { body: { content: { "application/json": { schema: EmbeddingsRequestSchema } } } }, responses: inferenceResponses });
const transcriptionsRoute = createRoute({ method: "post", path: "/audio/transcriptions", tags: ["Roles"], summary: "Speech to text (one WAV file, spec/voice's transcribe form)", request: { body: { content: { "multipart/form-data": { schema: TranscriptionFormSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: TranscriptionResponseSchema } }, description: "SttTranscribeResponse: the transcript, empty when the file holds no speech, with the identity headers." } } });
const speechRoute = createRoute({ method: "post", path: "/audio/speech", tags: ["Roles"], summary: "Text to speech (spec/voice's form, the WAV streamed as it is generated)", request: { body: { content: { "multipart/form-data": { schema: SpeechFormSchema } } } }, responses: { ...inferenceResponses, 400: { content: { "application/json": { schema: z.union([UnknownModelSchema, VoiceRefusedSchema]) } }, description: "Unknown role or model id, or a voice the Stack cannot pin and verify (reason voice-not-pinnable)." }, 409: { content: { "application/json": { schema: z.union([UnverifiedModelSchema, VoiceRefusedSchema]) } }, description: "The named model's provenance is incomplete, or the voice needs voice cloning that is off or has no token (reason voice-cloning-unavailable)." }, 200: { content: { "audio/wav": { schema: z.string().openapi({ format: "binary" }) } }, description: "TtsSynthesizeResult: a chunked audio/wav body whose header carries the format and a placeholder data size, with the identity headers. Abort the request to cancel." } } });
const ImageResponseSchema = z.object({ created: z.number().int(), job: z.string(), data: z.array(z.record(z.string(), z.unknown())) });
const RenderFailedSchema = z.object({ error: z.string(), job: z.string(), role: z.string(), state: z.enum(["failed", "cancelled"]) });
const imagesRoute = createRoute({ method: "post", path: "/images/generations", tags: ["Roles"], summary: "Image generation (the job API with a wait)", request: { body: { content: { "application/json": { schema: ImageRequestSchema } } } }, responses: { ...inferenceResponses, 200: { content: { "application/json": { schema: ImageResponseSchema } }, description: "OpenAI's image shape with the job id: `data` holds one `{ b64_json }` per image once the render finished within timeout_ms." }, 202: { content: { "application/json": { schema: ImageResponseSchema } }, description: "The render is still running past timeout_ms; fetch it by `job` on /stack/v1/jobs/{id}." }, 499: { content: { "application/json": { schema: RenderFailedSchema } }, description: "The render was cancelled." }, 500: { content: { "application/json": { schema: RenderFailedSchema } }, description: "The generator failed the render; the reason is the generator's own, not an outage." } } });

export const v1Routes = apiRouter<AppEnv>();
v1Routes.openapi(modelsRoute, (c) => c.json({ object: "list" as const, data: [...new Set([...ROLE_IDS, ...listModels().map((model) => model.id)])].map((id) => ({ id, object: "model" as const, created: 0, owned_by: "maipai-stack" as const })) }, 200));
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
    const voice = await prepareVoice(form.voice_url, { signal: controller.signal });
    if (voiceNeedsCloning(voice)) await ensureCloningLoaded(resolution.role, controller.signal);
    const spoken = await speakRole(resolution.role, speechForm(form.text, voice), controller.signal);
    for (const [name, value] of Object.entries(spoken.headers)) c.header(name, value);
    if (!spoken.body) return new Response(JSON.stringify({ error: spoken.status === 499 ? "Request cancelled" : spoken.status === 504 ? "The engine timed out." : "The engine did not answer." }), { status: spoken.status, headers: { ...spoken.headers, "content-type": "application/json" } });
    return new Response(spoken.body, { status: spoken.status, headers: { ...spoken.headers, "content-type": spoken.contentType ?? "audio/wav", "cache-control": "no-cache" } });
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
v1Routes.openapi(imagesRoute, (c) => reply(c, "job", c.req.valid("json")) as never);
