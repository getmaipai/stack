// CODE-STACK-01 S3: the coding role's wires (Anthropic Messages and its token
// count, OpenAI Responses, chat completions), the role-scoped model list, the
// sampling rule and the thinking clamp. Every test uses a scripted engine that
// records what it was sent; no model and no llama-server runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { clampThinking, DROPPED_CLIENT_SAMPLING } from "@/lib/codingWire";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests } from "@/lib/governor";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { codingEngineStatus, EngineDoesNotFitError, EngineUnavailableError, requestRole, resetSupervisorForTests, scriptedProcess, setCodingEngineForTests, setMachineTier, setSupervisorFactoryForTests, streamRole } from "@/lib/supervisor";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";
import type { RoleId } from "@/roles";

const CODING_MODEL = "qwen3.8-27b-ud-q4-k-m";
const PIN_SAMPLING = { temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 0.0, source: "test card" };
const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened/coding.gguf" };
const encoder = new TextEncoder();

interface Seen { path: string; body: Record<string, unknown>; signal?: AbortSignal; streamed: boolean }
let started: RoleId[] = [];
let seen: Seen[] = [];
let streamCancelled = 0;
/** What the scripted coding engine answers: a JSON body per path, and the byte chunks it streams per path. */
let jsonFor: (path: string) => { status: number; body: unknown } = (path) => ({ status: 200, body: { engine_saw: path } });
let chunksFor: (path: string) => Uint8Array[] = () => [encoder.encode("data: [DONE]\n\n")];
let streamStatus = 200;
/** When set, a non-stream request waits for the client's abort instead of answering. */
let holdRequest = false;
/** When set, a stream sends its first chunk and then waits until it is cancelled or aborted. */
let holdStream = false;

function codingEngine(role: RoleId) {
  const base = scriptedProcess(role);
  if (role !== "coding") return base;
  return scriptedProcess(role, {
    modelId: CODING_MODEL,
    client: {
      ...base.client,
      async request(path, body, signal) {
        seen.push({ path, body, signal, streamed: false });
        if (holdRequest) await new Promise<void>((_, reject) => { signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); });
        return jsonFor(path);
      },
      async stream(path, body, signal) {
        seen.push({ path, body, signal, streamed: true });
        const chunks = chunksFor(path);
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of chunks) { controller.enqueue(chunk); if (holdStream) await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => resolve(), { once: true }); }); }
            if (!holdStream) controller.close();
          },
          cancel() { streamCancelled += 1; },
        });
        return new Response(stream, { status: streamStatus, headers: { "content-type": streamStatus === 200 ? "text/event-stream" : "application/json" } });
      },
    },
  });
}

beforeEach(() => {
  started = []; seen = []; streamCancelled = 0; holdRequest = false; holdStream = false; streamStatus = 200;
  jsonFor = (path) => ({ status: 200, body: { engine_saw: path } });
  chunksFor = () => [encoder.encode("data: [DONE]\n\n")];
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests();
  setMachineTier("p128");
  upsertModel({ id: CODING_MODEL, roles: ["coding"], ...verified, engineRequirements: { sampling: PIN_SAMPLING } });
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  setSupervisorFactoryForTests(async (role) => { started.push(role); return codingEngine(role); });
});
afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); __resetSettingsForTests(); });

const post = (path: string, body: unknown, init: { signal?: AbortSignal } = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });
const textOf = async (response: Response) => Buffer.from(await response.arrayBuffer());

const messagesBody = { model: "coding", max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: "Read main.ts" }] }], tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }] };
const responsesBody = { model: "coding", input: [{ role: "user", content: [{ type: "input_text", text: "Read main.ts" }] }], tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }] };
const chatBody = { model: "coding", messages: [{ role: "user", content: "Read main.ts" }] };

// The frames each real wire sends, with a thinking block, a tool call, usage and a finish reason, split into chunks that cut frames in half.
const anthropicFrames = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"coding","usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The file is small."}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"main.ts\\"}"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":31}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");
const responsesFrames = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Reading"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":9,"output_tokens":3}}}\n\n',
].join("");
const chatFrames = [
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Look first."}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"main.ts\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":20}}\n\n',
  "data: [DONE]\n\n",
].join("");
const cutInto = (text: string, size: number): Uint8Array[] => { const bytes = encoder.encode(text); const out: Uint8Array[] = []; for (let at = 0; at < bytes.length; at += size) out.push(bytes.slice(at, at + size)); return out; };

// ---- each wire, streaming and not ------------------------------------------------

const WIRES = [
  { path: "/v1/messages", body: messagesBody, frames: anthropicFrames, reply: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "" }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "main.ts" } }], stop_reason: "tool_use", usage: { input_tokens: 12, output_tokens: 31 } } },
  { path: "/v1/responses", body: responsesBody, frames: responsesFrames, reply: { id: "resp_1", object: "response", status: "completed", output: [{ type: "function_call", name: "read_file", arguments: "{\"path\":\"main.ts\"}" }], usage: { input_tokens: 9, output_tokens: 3 } } },
  { path: "/v1/chat/completions", body: chatBody, frames: chatFrames, reply: { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: null, reasoning_content: "Look first.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"main.ts\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 20 } } },
];

for (const wire of WIRES) {
  test(`${wire.path}: the engine's JSON reply comes back unchanged with the identity headers, and the first request starts the coding engine`, async () => {
    jsonFor = () => ({ status: 200, body: wire.reply });
    expect(started).toEqual([]);
    const response = await post(wire.path, wire.body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(wire.reply);
    expect(response.headers.get("x-maipai-model")).toBe("scripted-coding");
    expect(started).toEqual(["coding"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe(wire.path);
    expect(seen[0]!.streamed).toBe(false);
    // Tools, thinking-free bodies and content blocks reach the engine as sent.
    expect((seen[0]!.body as { tools?: unknown }).tools).toEqual((wire.body as { tools?: unknown }).tools);
    await post(wire.path, wire.body);
    expect(started).toEqual(["coding"]);
  });

  test(`${wire.path}: a stream is the engine's bytes, frame cuts and all`, async () => {
    chunksFor = () => cutInto(wire.frames, 37);
    const response = await post(wire.path, { ...wire.body, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("x-maipai-model")).toBe("scripted-coding");
    expect((await textOf(response)).equals(Buffer.from(wire.frames))).toBe(true);
    expect(seen[0]!.path).toBe(wire.path);
    expect(seen[0]!.streamed).toBe(true);
    expect(seen[0]!.body.stream).toBe(true);
    expect(codingEngineStatus().slots_busy).toBe(0);
  });
}

test("/v1/messages/count_tokens passes the engine's count through and changes nothing in the request", async () => {
  jsonFor = () => ({ status: 200, body: { input_tokens: 42 } });
  const body = { ...messagesBody, temperature: 0.2, thinking: { type: "enabled", budget_tokens: 99_999 } };
  const response = await post("/v1/messages/count_tokens", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ input_tokens: 42 });
  expect(seen[0]!.path).toBe("/v1/messages/count_tokens");
  expect(seen[0]!.body).toEqual(body);
});

test("an engine's own error status and body pass through on every wire, streamed or not", async () => {
  jsonFor = () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages: required" } } });
  const plain = await post("/v1/messages", messagesBody);
  expect(plain.status).toBe(400);
  expect((await plain.json() as { error: { message: string } }).error.message).toBe("messages: required");
  streamStatus = 400;
  chunksFor = () => [encoder.encode('{"error":{"message":"bad"}}')];
  const streamed = await post("/v1/responses", { ...responsesBody, stream: true });
  expect(streamed.status).toBe(400);
  expect(streamed.headers.get("content-type")).toContain("application/json");
  expect(await streamed.text()).toBe('{"error":{"message":"bad"}}');
});

// ---- which role answers ----------------------------------------------------------

test("the coding model id selects the coding role the way every role's model id does", async () => {
  const response = await post("/v1/messages", { ...messagesBody, model: CODING_MODEL });
  expect(response.status).toBe(200);
  expect(started).toEqual(["coding"]);
});

test("a role other than coding is told which role answers, and nothing starts", async () => {
  for (const path of ["/v1/messages", "/v1/messages/count_tokens", "/v1/responses"]) {
    const response = await post(path, { ...messagesBody, ...(path === "/v1/responses" ? { input: "hi" } : {}), model: "chat" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; roles: string[] };
    expect(body.error).toContain("Send model 'coding'");
    expect(body.roles).toEqual(["coding"]);
  }
  const unknown = await post("/v1/messages", { ...messagesBody, model: "nope" });
  expect(unknown.status).toBe(400);
  expect(started).toEqual([]);
});

// ---- cancellation ----------------------------------------------------------------

test("a client that aborts a non-streaming request cancels the engine's request: 499, the signal aborted, the lease released", async () => {
  holdRequest = true;
  const controller = new AbortController();
  const pending = post("/v1/messages", messagesBody, { signal: controller.signal });
  while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(codingEngineStatus().slots_busy).toBe(1);
  controller.abort();
  const response = await Promise.resolve(pending).catch((error: unknown) => error);
  if (response instanceof Response) expect(response.status).toBe(499);
  expect(seen[0]!.signal?.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(codingEngineStatus().slots_busy).toBe(0);
});

test("a client that drops a stream cancels the engine's stream and releases the lease", async () => {
  holdStream = true;
  chunksFor = () => cutInto(anthropicFrames, 200).slice(0, 1);
  const controller = new AbortController();
  const response = await post("/v1/messages", { ...messagesBody, stream: true }, { signal: controller.signal });
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(first.done).toBe(false);
  expect(codingEngineStatus().slots_busy).toBe(1);
  await reader.cancel();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(streamCancelled).toBe(1);
  expect(seen[0]!.signal?.aborted).toBe(true);
  expect(codingEngineStatus().slots_busy).toBe(0);
});

// ---- errors ----------------------------------------------------------------------

test("an engine that cannot start answers 503 with the reason in plain words, on every coding wire", async () => {
  setSupervisorFactoryForTests(async (role) => { if (role === "coding") throw new EngineUnavailableError("The coding engine could not be started: the model file is missing. Reinstall it in Settings."); return scriptedProcess(role); });
  for (const [path, body] of [["/v1/messages", messagesBody], ["/v1/messages/count_tokens", messagesBody], ["/v1/responses", responsesBody]] as const) {
    const response = await post(path, body);
    expect(response.status).toBe(503);
    const reply = await response.json() as { error: string; role: string; offline_reason: string };
    expect(reply.role).toBe("coding");
    expect(reply.offline_reason).toContain("Reinstall it in Settings");
  }
  const streamed = await post("/v1/messages", { ...messagesBody, stream: true });
  expect(streamed.status).toBe(503);
});

test("an engine that cannot fit answers 503 and names the memory and what to do", async () => {
  const message = "The coding model needs about 17.9 GB to load, and this computer has 6.1 GB free after keeping 4.0 GB back. Chat and the other always-on models stay loaded. Wait for the picture, video or song job to finish, or close a large app, then send the request again.";
  setSupervisorFactoryForTests(async (role) => { if (role === "coding") throw new EngineDoesNotFitError(message); return scriptedProcess(role); });
  const response = await post("/v1/responses", responsesBody);
  expect(response.status).toBe(503);
  expect((await response.json() as { offline_reason: string }).offline_reason).toBe(message);
});

test("a wire the coding engine does not serve is a 501 with a plain sentence, and the engine is never started to find out", async () => {
  setCodingEngineForTests("splash");
  for (const [path, body] of [["/v1/messages", messagesBody], ["/v1/messages/count_tokens", messagesBody], ["/v1/responses", { ...responsesBody, stream: true }]] as const) {
    const response = await post(path, body);
    expect(response.status).toBe(501);
    const reply = await response.json() as { error: string; role: string; wire: string };
    expect(reply.error).toContain("does not serve");
    expect(reply.error).toContain("/v1/chat/completions");
    expect(reply.role).toBe("coding");
  }
  expect(started).toEqual([]);
  expect(seen).toEqual([]);
  // Chat completions still work on that engine.
  setCodingEngineForTests(undefined);
});

test("an engine that answers 404 for a wire (a build without it) is a 501, streamed or not", async () => {
  jsonFor = () => ({ status: 404, body: { error: { message: "File Not Found", code: 404 } } });
  const plain = await post("/v1/responses", responsesBody);
  expect(plain.status).toBe(501);
  expect((await plain.json() as { error: string }).error).toContain("does not serve");
  streamStatus = 404;
  chunksFor = () => [encoder.encode('{"error":{"message":"File Not Found"}}')];
  const streamed = await post("/v1/messages", { ...messagesBody, stream: true });
  expect(streamed.status).toBe(501);
  expect(codingEngineStatus().slots_busy).toBe(0);
});

// ---- GET /v1/models --------------------------------------------------------------

test("GET /v1/models?role=coding lists only the coding role's served model with its window and thinking ceiling, and never starts the engine", async () => {
  const response = await app.request("/v1/models?role=coding");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "list", data: [{ id: CODING_MODEL, object: "model", created: 0, owned_by: "maipai-stack", role: "coding", context_length: 131_072, thinking_budget_ceiling: 2000 }] });
  updateSettings({ "stack.engines.coding.thinking_budget_ceiling": 800, "stack.engines.coding.context_length": 65_536 });
  // Both need a restart: until the coding engine next starts the value in effect is the one it was launched with.
  expect(((await (await app.request("/v1/models?role=coding")).json()) as { data: Array<{ thinking_budget_ceiling: number }> }).data[0]!.thinking_budget_ceiling).toBe(2000);
  applyPendingSettings();
  const changed = (await (await app.request("/v1/models?role=coding")).json() as { data: Array<{ context_length: number; thinking_budget_ceiling: number }> }).data[0]!;
  expect(changed.thinking_budget_ceiling).toBe(800);
  expect(changed.context_length).toBe(65_536);
  expect(started).toEqual([]);
});

test("GET /v1/models?role=coding is empty when no coding model is installed, and refuses other roles with a plain sentence", async () => {
  clearModelsForTests();
  expect(await (await app.request("/v1/models?role=coding")).json()).toEqual({ object: "list", data: [] });
  const other = await app.request("/v1/models?role=chat");
  expect(other.status).toBe(400);
  expect((await other.json() as { error: string }).error).toContain("Only the coding role");
});

test("GET /v1/models without a role is unchanged: every role id and every installed model id", async () => {
  const ids = (await (await app.request("/v1/models")).json() as { data: Array<{ id: string; role?: string }> }).data;
  expect(ids.map((entry) => entry.id)).toEqual(expect.arrayContaining(["chat", "coding", "embed", CODING_MODEL, "chat-a"]));
  expect(ids.every((entry) => entry.role === undefined)).toBe(true);
});

// ---- sampling ---------------------------------------------------------------------

const clientSampling = { temperature: 0.1, top_p: 0.5, top_k: 3, min_p: 0.2, presence_penalty: 1.9, frequency_penalty: 1.1, repeat_penalty: 1.3, typical_p: 0.4, mirostat: 2, mirostat_tau: 5, mirostat_eta: 0.1, repeat_last_n: 64 };

test("non-streaming and streaming coding requests on every generation path drop client sampling and carry the pin's four values", async () => {
  for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses"]) {
    seen = [];
    await requestRole("coding", path, { model: "coding", messages: [], seed: 7, stop: ["x"], ...clientSampling });
    await (await streamRole("coding", path, { model: "coding", messages: [], seed: 7, stop: ["x"], ...clientSampling })).body!.cancel();
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.body).toMatchObject({ temperature: 1.0, top_p: 0.95, top_k: 20, presence_penalty: 0.0, seed: 7, stop: ["x"] });
      for (const key of DROPPED_CLIENT_SAMPLING) if (!["temperature", "top_p", "top_k", "presence_penalty"].includes(key)) expect(call.body).not.toHaveProperty(key);
    }
  }
});

test("the token-count paths carry no sampling for the coding role", async () => {
  await requestRole("coding", "/v1/messages/count_tokens", { model: "coding", messages: [] });
  expect(seen[0]!.body).toEqual({ model: "coding", messages: [] });
});

test("the sampling rule of every other role is unchanged: the pin fills only what is missing, and only on chat completions when not streaming", async () => {
  const chatPin = { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, source: "test" };
  upsertModel({ id: "chat-pinned", roles: ["chat"], ...verified, sizeBytes: 1_000_000, engineRequirements: { sampling: chatPin } });
  const recorded: Seen[] = [];
  setSupervisorFactoryForTests(async (role) => {
    const base = scriptedProcess(role);
    return scriptedProcess(role, { modelId: "chat-pinned", client: { ...base.client, request: async (path, body) => { recorded.push({ path, body, streamed: false }); return { status: 200, body: {} }; }, stream: async (path, body) => { recorded.push({ path, body, streamed: true }); return new Response("data: [DONE]\n\n", { status: 200 }); } } });
  });
  await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [], temperature: 0.2 });
  await requestRole("chat", "/v1/anything-else", { model: "chat", messages: [], temperature: 0.2 });
  await (await streamRole("chat", "/v1/anything-else", { model: "chat", messages: [] })).body!.cancel();
  expect(recorded[0]!.body).toMatchObject({ temperature: 0.2, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
  expect(recorded[1]!.body).toEqual({ model: "chat", messages: [], temperature: 0.2 });
  expect(recorded[2]!.body).toMatchObject({ temperature: 0.7, top_p: 0.8 });
});

// ---- the thinking clamp -----------------------------------------------------------

const withThinking = (budget: unknown, extra: Record<string, unknown> = {}) => ({ ...messagesBody, thinking: { type: "enabled", budget_tokens: budget }, ...extra });

test("Anthropic thinking.budget_tokens above the ceiling is brought down to it; below it is kept", async () => {
  await post("/v1/messages", withThinking(10_000));
  await post("/v1/messages", withThinking(500));
  await (await post("/v1/messages", { ...withThinking(10_000), stream: true })).body!.cancel();
  expect((seen[0]!.body.thinking as { budget_tokens: number }).budget_tokens).toBe(2000);
  expect((seen[1]!.body.thinking as { budget_tokens: number }).budget_tokens).toBe(500);
  expect((seen[2]!.body.thinking as { budget_tokens: number }).budget_tokens).toBe(2000);
  expect((seen[0]!.body.thinking as { type: string }).type).toBe("enabled");
});

test("OpenAI-style thinking_budget_tokens is clamped the same way on chat completions and Responses; -1 (unrestricted) becomes the ceiling", async () => {
  for (const path of ["/v1/chat/completions", "/v1/responses"]) {
    const body = path === "/v1/responses" ? responsesBody : chatBody;
    seen = [];
    await post(path, { ...body, thinking_budget_tokens: 50_000 });
    await post(path, { ...body, thinking_budget_tokens: 300 });
    await post(path, { ...body, thinking_budget_tokens: -1 });
    await post(path, { ...body, thinking_budget_tokens: 0 });
    expect(seen.map((call) => call.body.thinking_budget_tokens)).toEqual([2000, 300, 2000, 0]);
  }
});

test("an absent budget stays absent: the Stack adds no budget, no thinking block and no enable_thinking", async () => {
  await post("/v1/messages", messagesBody);
  await post("/v1/chat/completions", chatBody);
  await post("/v1/responses", responsesBody);
  for (const call of seen) {
    expect(call.body).not.toHaveProperty("thinking");
    expect(call.body).not.toHaveProperty("thinking_budget_tokens");
    expect(call.body).not.toHaveProperty("chat_template_kwargs");
  }
});

test("thinking the caller turned off stays off, and a budget never turns it on", async () => {
  await post("/v1/messages", { ...messagesBody, thinking: { type: "disabled" } });
  await post("/v1/chat/completions", { ...chatBody, chat_template_kwargs: { enable_thinking: false }, thinking_budget_tokens: 9000 });
  expect(seen[0]!.body.thinking).toEqual({ type: "disabled" });
  expect(seen[1]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  expect(seen[1]!.body.thinking_budget_tokens).toBe(2000);
});

test("the ceiling is the setting in effect (the one the engine was launched with): lowering it lowers what a request gets, and 0 means no thinking", async () => {
  updateSettings({ "stack.engines.coding.thinking_budget_ceiling": 800 });
  applyPendingSettings();
  await post("/v1/messages", withThinking(2000));
  updateSettings({ "stack.engines.coding.thinking_budget_ceiling": 0 });
  applyPendingSettings();
  await post("/v1/chat/completions", { ...chatBody, thinking_budget_tokens: 100 });
  expect((seen[0]!.body.thinking as { budget_tokens: number }).budget_tokens).toBe(800);
  expect(seen[1]!.body.thinking_budget_tokens).toBe(0);
});

test("a budget that would reach the request's own output limit is lowered under it; the limit itself is never changed", async () => {
  await post("/v1/messages", { ...withThinking(5000), max_tokens: 1000 });
  expect(seen[0]!.body.max_tokens).toBe(1000);
  expect((seen[0]!.body.thinking as { budget_tokens: number }).budget_tokens).toBe(999);
  await post("/v1/chat/completions", { ...chatBody, thinking_budget_tokens: 1500, max_completion_tokens: 4000 });
  expect(seen[1]!.body.thinking_budget_tokens).toBe(1500);
});

test("a budget that is not a number is a 400 in plain words and never reaches the engine", async () => {
  const response = await post("/v1/messages", withThinking("lots"));
  expect(response.status).toBe(400);
  expect((await response.json() as { error: string }).error).toContain("thinking.budget_tokens must be a number of tokens");
  const chat = await post("/v1/chat/completions", { ...chatBody, thinking_budget_tokens: "lots" });
  expect(chat.status).toBe(400);
  expect(seen).toEqual([]);
});

test("clampThinking does not change its input and leaves every other field alone", () => {
  const input = { model: "coding", tools: [{ name: "t" }], thinking: { type: "enabled", budget_tokens: 9000 }, stream: true };
  const copy = structuredClone(input);
  const out = clampThinking(input, 2000);
  expect(input).toEqual(copy);
  expect(out).toEqual({ ...copy, thinking: { type: "enabled", budget_tokens: 2000 } });
});

// ---- the other roles ---------------------------------------------------------------

test("chat keeps its route: no clamp, no sampling change, the body reaches its engine as sent", async () => {
  const recorded: Seen[] = [];
  setSupervisorFactoryForTests(async (role) => {
    const base = scriptedProcess(role);
    return scriptedProcess(role, { client: { ...base.client, request: async (path, body) => { recorded.push({ path, body, streamed: false }); return { status: 200, body: {} }; } } });
  });
  const body = { model: "chat", messages: [{ role: "user", content: "hello" }], thinking_budget_tokens: 99_999, temperature: 0.3 };
  const response = await post("/v1/chat/completions", body);
  expect(response.status).toBe(200);
  expect(recorded[0]!.body).toEqual(body);
});
