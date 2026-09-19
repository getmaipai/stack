import { afterEach, beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { app } from "@/app";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { hashClientKey } from "@/lib/clients";
import { __resetOperatorThrottleForTests, setOperatorPassword } from "@/lib/operator";
import { dataDir } from "@/lib/paths";
import { setSupervisorFactoryForTests, type ChatBackend, type EngineClient } from "@/lib/supervisor";

let operatorCookie = "";

async function login(): Promise<string> {
  const response = await app.request("/stack/v1/operator/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "client-test-password" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function createClient(allowedRoles: string[] = ["chat"]): Promise<{ key: string; id: string }> {
  const response = await app.request("/stack/v1/clients", {
    method: "POST",
    headers: { cookie: operatorCookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "test client", allowedRoles }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { key: string; client: { id: string } };
  return { key: body.key, id: body.client.id };
}

beforeAll(async () => {
  db.delete(clients).where(ne(clients.name, "test-suite")).run();
  __resetOperatorThrottleForTests();
  await setOperatorPassword("client-test-password");
  operatorCookie = await login();
});

afterEach(() => {
  db.delete(clients).where(ne(clients.name, "test-suite")).run();
  setSupervisorFactoryForTests(null);
});

test("a raw key is returned once and never appears in metadata, the database, or logs", async () => {
  const created = await createClient(["chat", "embed"]);
  expect(created.key).toMatch(/^mps_[A-Za-z0-9_-]{43}$/);

  const listed = await app.request("/stack/v1/clients", { headers: { cookie: operatorCookie } });
  expect(listed.status).toBe(200);
  expect(JSON.stringify(await listed.json())).not.toContain(created.key);

  const row = db.select().from(clients).where(eq(clients.id, created.id)).get();
  expect(row).toBeDefined();
  expect(JSON.stringify(row)).not.toContain(created.key);
  expect(row?.keyHash).toBe(hashClientKey(created.key));

  const logsDir = join(dataDir, "logs");
  if (existsSync(logsDir)) {
    const logText = readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(logsDir, entry.name), "utf8"))
      .join("\n");
    expect(logText).not.toContain(created.key);
  }
});

test("a revoked key is refused on the next request", async () => {
  const created = await createClient();
  const before = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(before.status).toBe(503);

  const revoke = await app.request(`/stack/v1/clients/${created.id}`, { method: "DELETE", headers: { cookie: operatorCookie } });
  expect(revoke.status).toBe(200);
  const after = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(after.status).toBe(401);
  expect(after.headers.get("x-maipai-engine")).toBe("none");
});

test("a client scoped to embed cannot use chat", async () => {
  const created = await createClient(["embed"]);
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Client is not allowed to use this role.", role: "chat", allowedRoles: ["embed"] });
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  expect(response.headers.get("x-maipai-model")).toBe("none");
  expect(response.headers.get("x-maipai-revision")).toBe("none");
});

test("a successful scripted completion increments client counters", async () => {
  const created = await createClient();
  const client: EngineClient = {
    baseUrl: "http://scripted",
    complete: async () => ({ status: 200, body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }),
    health: async () => true,
  };
  const backend: ChatBackend = { client, kind: "spawned", identity: { host: "local", build: "test", model: "chat.gguf", healthy: true }, pid: null, port: null, stop: async () => {}, activeRequests: 0, retired: false };
  setSupervisorFactoryForTests(async () => backend);
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "chat", messages: [] }),
  });
  expect(response.status).toBe(200);
  const row = db.select().from(clients).where(and(eq(clients.id, created.id), eq(clients.requests, 1))).get();
  expect(row).toMatchObject({ requests: 1, tokensIn: 3, tokensOut: 2 });
});

test("roles, hardware, and engines accept an operator session", async () => {
  for (const path of ["/stack/v1/roles", "/stack/v1/hardware", "/stack/v1/engines"]) {
    const response = await app.request(path, { headers: { cookie: operatorCookie } });
    expect(response.status).toBe(200);
  }
});
