// CODE-STACK-01 S5a / ENGINE-SPLASH-01: Splash 1.3.2's coding wire contract.
// The server is scripted; no model, network download or Splash binary is used.
import { afterEach, expect, test } from "bun:test";
import { ServedNameClient } from "@/lib/supervisor";
import { codingPauseBoundMs } from "@/lib/heavyGate";
import type { EngineClient } from "@/lib/supervisor";

const modelId = "qwen3.8-27b-ud-q4-k-m";
const encoder = new TextEncoder();
const requests: Array<{ path: string; model: unknown }> = [];
const client: EngineClient = {
  baseUrl: "http://fake-splash",
  async request(path, body) {
    requests.push({ path, model: body.model });
    if (body.model !== modelId) return { status: 404, body: { error: { message: "model not found" } } };
    if (path === "/v1/chat/completions") return { status: 200, body: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "Splash reply." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
    if (path === "/v1/messages") return { status: 200, body: { type: "message", content: [{ type: "text", text: "Splash reply." }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } } };
    if (path === "/v1/messages/count_tokens") return { status: 200, body: { input_tokens: 3 } };
    if (path === "/v1/responses") return { status: 200, body: { object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Splash reply." }] }], usage: { input_tokens: 3, output_tokens: 2 } } };
    return { status: 404, body: { error: "Not found." } };
  },
  async stream(path, body) {
    requests.push({ path, model: body.model });
    if (body.model !== modelId) return new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 });
    const data = path === "/v1/messages" ? 'event: message_start\ndata: {"type":"message_start","message":{"type":"message","content":[]}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n' : path === "/v1/responses" ? 'event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n' : 'data: {"choices":[{"delta":{"content":"Splash"}}]}\n\ndata: [DONE]\n\n';
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(data)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  },
  async health() { return true; },
};
const splash = new ServedNameClient(client, modelId);
const bodies = [
  ["/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hello" }] }, "chat"],
  ["/v1/messages", { model: "coding", max_tokens: 24, messages: [{ role: "user", content: "hello" }] }, "message"],
  ["/v1/messages/count_tokens", { model: "coding", messages: [{ role: "user", content: "hello" }] }, "count"],
  ["/v1/responses", { model: "coding", input: "hello" }, "response"],
] as const;
afterEach(() => { requests.length = 0; });

test("Splash answers each coding wire with the expected status and shape", async () => {
  for (const [path, body, kind] of bodies) {
    const result = await splash.request(path, body);
    expect(result.status).toBe(200);
    const payload = result.body as Record<string, unknown>;
    if (kind === "chat") expect(payload).toMatchObject({ object: "chat.completion", choices: [{ message: { content: "Splash reply." } }] });
    if (kind === "message") expect(payload).toMatchObject({ type: "message", content: [{ type: "text", text: "Splash reply." }] });
    if (kind === "count") expect(payload).toEqual({ input_tokens: 3 });
    if (kind === "response") expect(payload).toMatchObject({ object: "response", status: "completed" });
    expect(requests.at(-1)).toEqual({ path, model: modelId });
  }
  for (const [path, body] of bodies.filter((entry) => entry[2] !== "count")) {
    const streamed = await splash.stream(path, { ...body, stream: true });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("text/event-stream");
    expect(await streamed.text()).toContain(path === "/v1/messages" ? "message_stop" : path === "/v1/responses" ? "response.completed" : "[DONE]");
  }
});

test("an unknown model name would get Splash's 404; the served-name client maps it to the pinned model", async () => {
  expect((await client.request("/v1/chat/completions", { model: "unknown-model" })).status).toBe(404);
  expect(await splash.request("/v1/chat/completions", { model: "unknown-model" })).toMatchObject({ status: 200, body: { object: "chat.completion" } });
});

test("short pauses are allowed; a longer pause is clamped to Splash's 20 second liveness bound", () => {
  delete process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS;
  delete process.env.STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS;
  expect(codingPauseBoundMs("splash")).toBe(20_000);
  process.env.STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS = "10000";
  expect(codingPauseBoundMs("splash")).toBe(10_000);
  delete process.env.STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS;
});
