// STACK-CTX-400-01: a prompt longer than the context is a 400 that names the limit, never a 5xx, whichever engine said so.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { setMachineTier, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests } from "@/lib/modelStore";
import { contextOverflowError } from "@/lib/contextOverflow";

afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });
beforeEach(() => { setMachineTier(null); __resetHealthForTests(); clearModelsForTests(); });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const engineSays = (status: number, body: unknown) => setSupervisorFactoryForTests(async (role) => {
  const scripted = scriptedProcess(role);
  return scriptedProcess(role, { client: { ...scripted.client, request: async () => ({ status, body }) } });
});
const oversize = { model: "chat", messages: [{ role: "user", content: "word ".repeat(50_000) }] };

test("llama-server's own overflow answer (400, exceed_context_size_error) says how many tokens and what the limit is", async () => {
  engineSays(400, { error: { code: 400, type: "exceed_context_size_error", message: "the request exceeds the available context size, try increasing it", n_prompt_tokens: 50_001, n_ctx: 32_768 } });
  const response = await app.request("/v1/chat/completions", json(oversize));
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { type: string; message: string; n_ctx: number; n_prompt_tokens: number } };
  expect(body.error.type).toBe("context_length_exceeded");
  expect(body.error.message).toContain("50001");
  expect(body.error.message).toContain("32768");
  expect(body.error.n_ctx).toBe(32_768);
});

test("an engine that answers an overflow with a 5xx (MLX, Splash) is still a 400 with a plain message", async () => {
  engineSays(500, { error: { message: "Prompt is too long: 60000 tokens exceeds the context length of 40960" } });
  const response = await app.request("/v1/chat/completions", json(oversize));
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { type: string; message: string } };
  expect(body.error.type).toBe("context_length_exceeded");
  expect(body.error.message).toMatch(/too long|longer than/i);
});

test("an unrelated engine failure keeps its status", async () => {
  engineSays(400, { error: { message: "unknown field foo" } });
  expect((await app.request("/v1/chat/completions", json(oversize))).status).toBe(400);
  expect(contextOverflowError(500, { error: { message: "segfault" } })).toBeNull();
});

test("a streamed request that overflows is the same 400", async () => {
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    const stream = async () => new Response(JSON.stringify({ error: { code: 400, type: "exceed_context_size_error", message: "the request exceeds the available context size", n_prompt_tokens: 9000, n_ctx: 4096 } }), { status: 400, headers: { "content-type": "application/json" } });
    return scriptedProcess(role, { client: { ...scripted.client, stream } });
  });
  const response = await app.request("/v1/chat/completions", json({ ...oversize, stream: true }));
  expect(response.status).toBe(400);
  expect((await response.json() as { error: { message: string } }).error.message).toContain("4096");
});
