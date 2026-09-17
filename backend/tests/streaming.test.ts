import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { app } from "@/app";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { issueClient } from "@/lib/clients";
import { setSupervisorFactoryForTests, type ChatBackend, getChatBackend, type EngineClient } from "@/lib/supervisor";

let streamKey = "";
function auth() {
  return { authorization: "Bearer " + streamKey, "content-type": "application/json" };
}

function backend(client: EngineClient, stop = async () => {}): ChatBackend {
  return {
    client,
    kind: "managed",
    identity: { host: "local", build: "stream-test", model: "chat.gguf", healthy: true },
    pid: null,
    stop,
    activeRequests: 0,
    retired: false,
  };
}

afterEach(() => setSupervisorFactoryForTests(null));
beforeAll(() => {
  db.delete(clients).where(eq(clients.name, "streaming-test")).run();
  streamKey = issueClient("streaming-test", ["chat", "embed"]);
});
afterAll(() => {
  setSupervisorFactoryForTests(null);
  db.delete(clients).where(eq(clients.name, "streaming-test")).run();
});

test("a streaming completion pipes ordered SSE chunks, identity, and usage", async () => {
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const chunks = [
        "data: " + JSON.stringify({ choices: [{ delta: { content: "one" } }] }) + "\n\n",
        "data: " + JSON.stringify({ choices: [{ delta: { content: " two" } }] }) + "\n\n",
        "data: " + JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2 } }) + "\n\n",
        "data: [DONE]\n\n",
      ];
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const client: EngineClient = {
    baseUrl: "http://127.0.0.1:" + upstream.port,
    complete: async () => ({ status: 200, body: {} }),
    stream: (body, signal) => fetch("http://127.0.0.1:" + upstream.port + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
    health: async () => true,
  };
  setSupervisorFactoryForTests(async () => backend(client));
  const rowBefore = db.select({ requests: clients.requests, tokensIn: clients.tokensIn, tokensOut: clients.tokensOut }).from(clients).where(eq(clients.name, "streaming-test")).get()!;

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "hello" }], stream: true }),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-maipai-engine")).toBe("local");
  expect(response.headers.get("x-maipai-model")).toBe("chat.gguf");
  expect(response.headers.get("x-maipai-revision")).toBe("stream-test");
  expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
  expect(text).toContain("data: [DONE]");
  const rowAfter = db.select({ requests: clients.requests, tokensIn: clients.tokensIn, tokensOut: clients.tokensOut }).from(clients).where(eq(clients.name, "streaming-test")).get()!;
  expect(rowAfter.requests).toBe(rowBefore.requests + 1);
  expect(rowAfter.tokensIn).toBe(rowBefore.tokensIn + 3);
  expect(rowAfter.tokensOut).toBe(rowBefore.tokensOut + 2);
  upstream.stop();
});

test("a client abort cancels the upstream stream and keeps the backend bound", async () => {
  let upstreamAborted = false;
  const encoder = new TextEncoder();
  const upstream = Bun.serve({
    port: 0,
    fetch(request) {
      request.signal.addEventListener("abort", () => { upstreamAborted = true; });
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let index = 0; index < 20; index++) {
            if (request.signal.aborted) {
              upstreamAborted = true;
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: String(index) } }] }) + "\n\n"));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  let stopCalls = 0;
  const client: EngineClient = {
    baseUrl: "http://127.0.0.1:" + upstream.port,
    complete: async () => ({ status: 200, body: {} }),
    stream: (body, signal) => fetch("http://127.0.0.1:" + upstream.port + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
    health: async () => true,
  };
  const bound = backend(client, async () => { stopCalls++; });
  setSupervisorFactoryForTests(async () => bound);
  const controller = new AbortController();
  const response = await app.fetch(new Request("http://stack.test/v1/chat/completions", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "chat", messages: [], stream: true }),
    signal: controller.signal,
  }));
  const reader = response.body!.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(upstreamAborted).toBe(true);
  expect(stopCalls).toBe(0);
  expect(await getChatBackend()).toBe(bound);
  upstream.stop();
});

test("a non-chat role still refuses streaming", async () => {
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "embed", messages: [], stream: true }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Streaming is not available yet", role: "embed" });
});
