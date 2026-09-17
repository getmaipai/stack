import { afterEach, expect, test } from "bun:test";
import { app } from "@/app";
import {
  completeChat,
  getChatBackend,
  reportChatEngineExited,
  resetSupervisorForTests,
  restartChatEngine,
  setSupervisorFactoryForTests,
  type ChatBackend,
  type EngineClient,
} from "@/lib/supervisor";
import { testClientHeaders } from "./authTest";

const originalUrl = process.env.STACK_MANAGED_ENGINE_URL;
const originalChatUrl = process.env.STACK_CHAT_ENGINE_URL;

afterEach(() => {
  if (originalUrl === undefined) delete process.env.STACK_MANAGED_ENGINE_URL;
  else process.env.STACK_MANAGED_ENGINE_URL = originalUrl;
  if (originalChatUrl === undefined) delete process.env.STACK_CHAT_ENGINE_URL;
  else process.env.STACK_CHAT_ENGINE_URL = originalChatUrl;
  setSupervisorFactoryForTests(null);
});

function backend(client: EngineClient, kind: "spawned" | "managed" | "url" = "spawned", stop = async () => {}): ChatBackend {
  return {
    client,
    kind,
    identity: { host: "local", build: "test-revision", model: "test.gguf", healthy: true },
    pid: null,
    stop,
    activeRequests: 0,
    retired: false,
  };
}

test("a managed engine completes chat with identity headers", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      if (path === "/props") return Response.json({ build_info: "managed-test", model_path: "/models/chat.gguf" });
      if (path === "/v1/chat/completions") return Response.json({ id: "cmpl-test", choices: [{ message: { role: "assistant", content: "hello" } }] });
      return new Response("not found", { status: 404 });
    },
  });
  process.env.STACK_MANAGED_ENGINE_URL = `http://127.0.0.1:${server.port}`;
  delete process.env.STACK_CHAT_ENGINE_URL;
  resetSupervisorForTests();

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...testClientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hi" }] }),
  });
  expect(response.status).toBe(200);
  expect((await response.json() as { choices: unknown[] }).choices).toHaveLength(1);
  expect(response.headers.get("x-maipai-engine")).toBe("local");
  expect(response.headers.get("x-maipai-model")).toBe("chat.gguf");
  expect(response.headers.get("x-maipai-revision")).toBe("managed-test");
  server.stop();
});

test("a vanished managed engine returns its offline reason", async () => {
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => { throw new Error("connection refused"); },
    health: async () => false,
  };
  setSupervisorFactoryForTests(async () => backend(client, "managed"));
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...testClientHeaders, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(response.status).toBe(503);
  expect((await response.json() as { offline_reason: string }).offline_reason).toContain("connection");
});

test("a failed spawned engine can be reported and restarted", async () => {
  let starts = 0;
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => ({ status: 200, body: { choices: [{ message: { content: "ok" } }] } }),
    health: async () => true,
  };
  setSupervisorFactoryForTests(async () => {
    starts++;
    return backend(client);
  });
  await completeChat("chat", { model: "chat", messages: [] });
  reportChatEngineExited("scripted crash");
  await completeChat("chat", { model: "chat", messages: [] });
  expect(starts).toBe(2);
});

test("restart drains an in-flight request and stale starts are discarded", async () => {
  let resolveCompletion!: (value: { status: number; body: unknown }) => void;
  let stopCalls = 0;
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: () => new Promise((resolve) => { resolveCompletion = resolve; }),
    health: async () => true,
  };
  setSupervisorFactoryForTests(async () => backend(client, "spawned", async () => { stopCalls++; }));
  const request = completeChat("chat", { model: "chat", messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restart = restartChatEngine();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stopCalls).toBe(0);
  resolveCompletion({ status: 200, body: { choices: [{ message: { content: "ok" } }] } });
  await request;
  await restart;
  expect(stopCalls).toBe(1);
});

test("a start from an old generation is stopped before the new one is installed", async () => {
  let releaseFirst!: (value: ChatBackend) => void;
  let starts = 0;
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => ({ status: 200, body: { choices: [{ message: { content: "ok" } }] } }),
    health: async () => true,
  };
  setSupervisorFactoryForTests(() => {
    starts++;
    if (starts === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    return Promise.resolve(backend(client));
  });
  const first = getChatBackend();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await restartChatEngine();
  releaseFirst(backend(client));
  await first;
  expect(starts).toBe(2);
});

test("a living engine's 500 is returned without retirement", async () => {
  let calls = 0;
  let stopCalls = 0;
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => ++calls === 1 ? { status: 500, body: { error: "busy" } } : { status: 200, body: { ok: true } },
    health: async () => true,
  };
  setSupervisorFactoryForTests(async () => backend(client, "managed", async () => { stopCalls++; }));
  expect((await completeChat("chat", {})).status).toBe(500);
  expect((await completeChat("chat", {})).status).toBe(200);
  expect(stopCalls).toBe(0);
});

test("an aborted completion is a cancellation and does not retire the engine", async () => {
  let stopCalls = 0;
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => { throw new DOMException("Cancelled", "AbortError"); },
    health: async () => false,
  };
  setSupervisorFactoryForTests(async () => backend(client, "managed", async () => { stopCalls++; }));
  const result = await completeChat("chat", {}, AbortSignal.abort());
  expect(result.status).toBe(499);
  expect(stopCalls).toBe(0);
});

test("waitHealthy accepts a delayed loading response within the tuned timeout", async () => {
  let calls = 0;
  const { waitHealthy, setSupervisorTimeoutsForTests } = await import("@/lib/supervisor");
  setSupervisorTimeoutsForTests({ loadFloorMs: 100 });
  try {
    await waitHealthy({ health: async () => ++calls > 1, baseUrl: "scripted", complete: async () => ({ status: 200, body: {} }) }, 300);
    expect(calls).toBeGreaterThan(1);
  } finally {
    setSupervisorTimeoutsForTests(null);
  }
});

test("post-load checks time out instead of hanging", async () => {
  const { postLoadCheck, setSupervisorTimeoutsForTests } = await import("@/lib/supervisor");
  setSupervisorTimeoutsForTests({ postLoadMs: 10 });
  try {
    await expect(postLoadCheck({ baseUrl: "scripted", health: async () => true, complete: () => new Promise(() => {}) }, null)).rejects.toThrow();
  } finally {
    setSupervisorTimeoutsForTests(null);
  }
});

test("post-load checks record the kernel footprint when a process is present", async () => {
  const { postLoadCheck } = await import("@/lib/supervisor");
  const check = await postLoadCheck({ baseUrl: "scripted", health: async () => true, complete: async () => ({ status: 200, body: { choices: [{ message: { content: "OK" } }] } }) }, process.pid);
  expect(check.replyOk).toBe(true);
  expect(check.actualBytes).toBeGreaterThan(1_048_576);
});

test("a free spawned port is selected before engine launch", async () => {
  const { findFreePort } = await import("@/lib/supervisor");
  const port = await findFreePort();
  expect(port).toBeGreaterThan(0);
});
