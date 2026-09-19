import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import { issueClient } from "@/lib/clients";
import { PROFILE_TIERS } from "@/profiles";
import { setSupervisorFactoryForTests, type ChatBackend, type EngineClient } from "@/lib/supervisor";

afterEach(() => setSupervisorFactoryForTests(null));

test("GET /v1/models lists role ids for a client key", async () => {
  const key = issueClient("inference-model-list", ["chat"]);
  const response = await app.request("/v1/models", { headers: { authorization: `Bearer ${key}` } });
  expect(response.status).toBe(200);
  const body = await response.json() as { object: string; data: Array<{ id: string; object: string }> };
  expect(body.object).toBe("list");
  expect(body.data.map((entry) => entry.id)).toEqual(expect.arrayContaining(["chat", "coding"]));
});

test("coding preserves tool fields and identity headers through the chat binding", async () => {
  const key = issueClient("inference-coding", ["chat", "coding", "embed"]);
  let received: Record<string, unknown> | null = null;
  const client: EngineClient = { baseUrl: "http://scripted", complete: async (body) => { received = body; return { status: 200, body: { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] } }] } }; }, health: async () => true };
  const backend: ChatBackend = { client, kind: "managed", identity: { host: "local", build: "contract", model: "chat.gguf", healthy: true }, pid: null, stop: async () => {}, activeRequests: 0, retired: false };
  setSupervisorFactoryForTests(async () => backend);
  const response = await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "coding", messages: [], tools: [{ type: "function", function: { name: "read" } }], tool_choice: "auto", response_format: { type: "json_object" } }) });
  expect(response.status).toBe(200);
  expect(received).toMatchObject({ model: "coding", tools: [{ type: "function" }], tool_choice: "auto", response_format: { type: "json_object" } });
  expect((await response.json() as { choices: Array<{ message: { tool_calls: unknown[] } }> }).choices[0]?.message.tool_calls).toHaveLength(1);
  expect(response.headers.get("x-maipai-model")).toBe("chat.gguf");
});

test("coding shares chat on p32 and a chat-only key is refused", async () => {
  const p32 = PROFILE_TIERS.find((tier) => tier.id === "p32")!;
  expect(p32.resident).toContain("coding");
  expect(p32.notAvailable).not.toContain("coding");
  const key = issueClient("inference-chat-only", ["chat"]);
  const response = await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: "coding", messages: [] }) });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ role: "coding", allowedRoles: ["chat"] });
});
