// The contract Home builds against, exercised through the app: the role
// routes and their failure shapes, the control routes, and the rule that
// nothing needs a key because nothing but loopback is listening.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { serveOptions } from "@/index";
import { __resetHealthForTests, raise } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { getProcess, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests, EngineUnavailableError } from "@/lib/supervisor";
import { __resetSettingsForTests } from "@/settings";

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the daemon binds loopback only", () => {
  expect(serveOptions().hostname).toBe("127.0.0.1");
});

test("a chat completion by role answers with the engine's reply and the identity headers", async () => {
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [{ role: "user", content: "hello" }] }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-maipai-engine")).toBe("stub");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-chat");
  expect(response.headers.get("x-maipai-revision")).toBe("scripted");
  expect((await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("Scripted Stack reply.");
});

test("streaming passes the SSE bytes through with the headers", async () => {
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [{ role: "user", content: "hello" }], stream: true }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-chat");
  expect(await response.text()).toContain("data: [DONE]");
});

test("embeddings by role answer on their own endpoint; a role on the wrong endpoint is a 400", async () => {
  const embed = await app.request("/v1/embeddings", json({ model: "embed", input: "OK" }));
  expect(embed.status).toBe(200);
  const wrong = await app.request("/v1/embeddings", json({ model: "chat", input: "OK" }));
  expect(wrong.status).toBe(400);
  expect((await wrong.json() as { roles: string[] }).roles).toContain("embed");
});

test("no engine is a 503 with the role, its state and the reason, never a 404, with none identity", async () => {
  setSupervisorFactoryForTests(async () => { throw new EngineUnavailableError("No verified and installed chat model is available."); });
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [] }));
  expect(response.status).toBe(503);
  expect(response.headers.get("x-maipai-engine")).toBe("none");
  expect(await response.json()).toMatchObject({ role: "chat", state: "offline", offline_reason: "No verified and installed chat model is available." });
  const image = await app.request("/v1/images/generations", json({ model: "image", prompt: "a cat" }));
  expect(image.status).toBe(503);
  expect(await image.json()).toMatchObject({ role: "image", state: "notInstalled" });
});

test("an unknown model is a 400 listing the roles; an unverified model is a 409 naming what is missing", async () => {
  const unknown = await app.request("/v1/chat/completions", json({ model: "nope", messages: [] }));
  expect(unknown.status).toBe(400);
  expect((await unknown.json() as { roles: string[] }).roles).toContain("chat");
  upsertModel({ id: "m-unverified", roles: ["chat"], source: "huggingface", provenance: {}, revision: "r" });
  const unverified = await app.request("/v1/chat/completions", json({ model: "m-unverified", messages: [] }));
  expect(unverified.status).toBe(409);
  expect(await unverified.json()).toMatchObject({ reason: "unverified", missing: ["sha256", "licence", "verifiedAt"] });
});

test("GET /v1/models lists the roles and the installed model ids", async () => {
  upsertModel({ id: "m-1", roles: ["chat"], source: "catalog", provenance: {}, revision: "r" });
  const body = await (await app.request("/v1/models")).json() as { data: Array<{ id: string }> };
  expect(body.data.map((entry) => entry.id)).toEqual(expect.arrayContaining(["chat", "embed", "m-1"]));
});

test("the health routes list problems as data and run a fix", async () => {
  raise({ code: "engine.crashed.chat", severity: "error", title: "The chat engine crashed", text: "exited", cause: "exit", fix: { label: "Restart engine", action: "restart_engine" } });
  const listed = await (await app.request("/stack/v1/health")).json() as { health: Array<{ code: string; fix?: { action: string } }> };
  expect(listed.health[0]).toMatchObject({ code: "engine.crashed.chat", fix: { action: "restart_engine" } });
  const fixed = await app.request("/stack/v1/health/engine.crashed.chat/fix", { method: "POST" });
  expect(await fixed.json()).toMatchObject({ ok: true });
  raise({ code: "memory-pressure-warn", severity: "warning", title: "Memory pressure is tight", text: "tight", cause: "kernel", fix: { label: "Free memory", action: "free_memory" } });
  expect(await (await app.request("/stack/v1/health/memory-pressure-warn/fix", { method: "POST" })).json()).toMatchObject({ ok: true });
  // Freeing memory unloads; it never leaves a role stopped.
  expect((await app.request("/v1/chat/completions", json({ model: "chat", messages: [] }))).status).toBe(200);
  expect((await (await app.request("/stack/v1/health")).json() as { health: unknown[] }).health).toEqual([]);
  expect((await app.request("/stack/v1/health/nope/resolve", { method: "POST" })).status).toBe(404);
});

test("the engine routes start, stop and restart the chat role", async () => {
  const engines = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ name: string; state: string }> };
  expect(engines.engines.map((engine) => engine.name)).toContain("llama-server");
  expect((await (await app.request("/stack/v1/engines/llama-server/start", { method: "POST" })).json())).toMatchObject({ ok: true });
  expect((await (await app.request("/stack/v1/engines/llama-server/start", { method: "POST" })).json())).toMatchObject({ ok: true, reason: "Already running." });
  expect((await (await app.request("/stack/v1/engines/llama-server/stop", { method: "POST" })).json())).toMatchObject({ ok: true });
  expect((await app.request("/stack/v1/engines/nope/start", { method: "POST" })).status).toBe(404);
});

test("the model routes refuse a pull without full provenance and list records with their state", async () => {
  const refused = await app.request("/stack/v1/models", json({ id: "m", role: "chat", url: "https://huggingface.co/x/resolve/r/m.gguf", sha256: "a".repeat(64), revision: "r" }));
  expect(refused.status).toBe(400);
  upsertModel({ id: "m-2", roles: ["chat"], source: "catalog", provenance: { package: "model:m-2" }, revision: "r", sha256: "a".repeat(64), licence: "MIT" });
  const listed = await (await app.request("/stack/v1/models")).json() as { models: Array<{ id: string; state: string; pinned: boolean }> };
  expect(listed.models[0]).toMatchObject({ id: "m-2", state: "notInstalled", pinned: false });
  const pinned = await app.request("/stack/v1/models/m-2/actions", json({ action: "pin" }));
  expect(await pinned.json()).toMatchObject({ ok: true });
  expect((await app.request("/stack/v1/models/nope/actions", json({ action: "load" }))).status).toBe(404);
});

test("hardware, budget, backup and the diagnostics bundle answer as data without a computer name", async () => {
  const hardware = await (await app.request("/stack/v1/hardware")).json() as { hardware: Record<string, unknown>; tiers: unknown[] };
  expect(hardware.hardware.computerName).toBeUndefined();
  expect(hardware.tiers).toHaveLength(4);
  const budget = await (await app.request("/stack/v1/hardware/budget")).json() as { capBytes: number; pressure: string };
  expect(budget.capBytes).toBeGreaterThan(0);
  const backup = await (await app.request("/stack/v1/backup")).json() as { data_dir: string; paths: Array<{ mode: string }> };
  expect(backup.paths.map((path) => path.mode)).toEqual(["include", "include", "exclude", "exclude"]);
  const bundle = await app.request("/stack/v1/diagnostics");
  expect(bundle.headers.get("content-type")).toBe("application/zip");
  expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(100);
});

test("an unknown path is a JSON 404 and there is no console to fall back to", async () => {
  for (const path of ["/", "/index.html", "/stack/v1/nope", "/stack/v1/operator/login", "/stack/v1/clients"]) {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  }
});

test("the generated document covers the contract table's surfaces", async () => {
  const document = await (await app.request("/api/openapi.json")).json() as { paths: Record<string, unknown> };
  for (const path of ["/v1/chat/completions", "/v1/embeddings", "/v1/models", "/stack/v1/roles", "/stack/v1/engines", "/stack/v1/models", "/stack/v1/jobs", "/stack/v1/health", "/stack/v1/check", "/stack/v1/updates", "/stack/v1/events", "/stack/v1/hardware", "/stack/v1/hardware/budget", "/stack/v1/settings", "/stack/v1/storage/sweep", "/stack/v1/privacy", "/stack/v1/backup", "/healthz"]) {
    expect(Object.keys(document.paths), `missing ${path}`).toContain(path);
  }
  await getProcess("chat");
});
