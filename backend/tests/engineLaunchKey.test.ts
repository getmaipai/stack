// ISOLATION-04: the llama-server children are started with a key of their own; every request the Stack sends them carries it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { OpenAIEngineClient } from "@/lib/supervisor";
import { readEngineIdentity } from "@/lib/identity";

const KEY = `launch-${crypto.randomUUID()}`;
let server: ReturnType<typeof Bun.serve>;
let url = "";
beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ status: "ok" });
      if (request.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: "Invalid API Key" }, { status: 401 });
      if (path === "/props") return Response.json({ build_info: "b1", model_path: "/m/x.gguf" });
      return Response.json({ ok: true });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test("a client built with the launch key is accepted on request, stream, raw and health", async () => {
  const client = new OpenAIEngineClient(url, "/health", KEY);
  expect((await client.request("/v1/embeddings", { input: "x" })).status).toBe(200);
  expect((await client.stream("/v1/chat/completions", {})).status).toBe(200);
  expect((await client.raw("/v1/models", { method: "GET" })).status).toBe(200);
  expect(await client.health()).toBe(true);
});

test("without the key the engine refuses, which is what a web page that found the port gets", async () => {
  const client = new OpenAIEngineClient(url);
  expect((await client.request("/v1/embeddings", { input: "x" })).status).toBe(401);
});

test("the identity read sends the key (llama-server answers /props only with it)", async () => {
  expect((await readEngineIdentity(url, 3000, "/health", KEY)).build).toBe("b1");
  expect((await readEngineIdentity(url)).build).toBeNull();
});
