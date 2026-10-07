// The contract Home builds against, exercised through the app: the role
// routes and their failure shapes, the control routes, and the rule that
// nothing needs a key because nothing but loopback is listening.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { app } from "@/app";
import { serveOptions } from "@/daemon";
import { __resetHealthForTests, raise } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { getProcess, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests, EngineUnavailableError } from "@/lib/supervisor";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __setMemoryReaderForTests } from "@/lib/memory";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { __resetSettingsForTests } from "@/settings";
import { dataDir } from "@/lib/paths";

const GB = 1_073_741_824;

beforeEach(() => { __resetHealthForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); __resetGovernorForTests(); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the daemon binds loopback only", () => {
  expect(serveOptions().hostname).toBe("127.0.0.1");
});

test("a chat completion by role answers with the engine's reply and the identity headers", async () => {
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [{ role: "user", content: "hello" }] }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-maipai-engine")).toBe("stub scripted");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-chat");
  expect(response.headers.get("x-maipai-revision")).toBe("scripted");
  expect((await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("Scripted Stack reply.");
});

test("a canary request and reply leave no text in the isolated Stack data folder", async () => {
  const canary = "sec11-request-text-canary-7b2c61";
  const replyCanary = "sec11-completion-text-canary-38a4de";
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    return scriptedProcess(role, { client: { ...scripted.client, request: async () => ({ status: 200, body: { id: "canary-completion", choices: [{ index: 0, message: { role: "assistant", content: replyCanary }, finish_reason: "stop" }] } }) } });
  });
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [{ role: "user", content: canary }] }));
  expect(response.status).toBe(200);
  expect((await response.text())).toContain(replyCanary);
  const pending = [dataDir];
  const contents: string[] = [];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else contents.push(fs.readFileSync(path, "utf8"));
    }
  }
  expect(contents.join("\n")).not.toContain(canary);
  expect(contents.join("\n")).not.toContain(replyCanary);
});

test("streaming passes the SSE bytes through with the headers", async () => {
  const response = await app.request("/v1/chat/completions", json({ model: "chat", messages: [{ role: "user", content: "hello" }], stream: true }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("x-maipai-model")).toBe("scripted-chat");
  expect(await response.text()).toContain("data: [DONE]");
});

test("a token count by role renders the messages with the engine's own template, then counts them with the engine's tokenizer", async () => {
  const counted = await app.request("/v1/tokenize", json({ model: "chat", messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "hello there" }] }));
  expect(counted.status).toBe(200);
  expect(counted.headers.get("x-maipai-model")).toBe("scripted-chat");
  // The scripted engine's template wraps each message in two marker tokens
  // and its tokenizer counts whitespace-separated pieces: 2 + 2 words, 2 + 2.
  expect(await counted.json()).toEqual({ count: 8 });
  // The tools block renders into the prompt, so it is counted (a review):
  // the scripted template adds two markers and one piece per tool.
  const withTools = await app.request("/v1/tokenize", json({ model: "chat", messages: [{ role: "user", content: "hello there" }], tools: [{ type: "function", function: { name: "web_search" } }] }));
  expect(await withTools.json()).toEqual({ count: 7 });
  const raw = await app.request("/v1/tokenize", json({ model: "chat", content: "one two three" }));
  expect(await raw.json()).toEqual({ count: 3 });
  const both = await app.request("/v1/tokenize", json({ model: "chat" }));
  expect(both.status).toBe(400);
  const wrong = await app.request("/v1/tokenize", json({ model: "embed", content: "x" }));
  expect(wrong.status).toBe(400);
});

test("a token count from an engine that cannot count is a 501 with the reason, and no engine is the usual 503", async () => {
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { client: { ...scriptedProcess(role).client, request: async () => ({ status: 404, body: { error: "Not found" } }) } }));
  const refused = await app.request("/v1/tokenize", json({ model: "chat", content: "hello" }));
  expect(refused.status).toBe(501);
  expect(await refused.json()).toMatchObject({ error: "This chat engine does not report token counts.", role: "chat" });
  setSupervisorFactoryForTests(async () => { throw new EngineUnavailableError("No verified and installed chat model is available."); });
  const offline = await app.request("/v1/tokenize", json({ model: "chat", content: "hello" }));
  expect(offline.status).toBe(503);
  expect(await offline.json()).toMatchObject({ role: "chat", state: "offline" });
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

test("the current build cannot be removed; a rollback to a tag that is not installed is refused; a staged build needs a full pin", async () => {
  const { mkdirSync, rmSync } = await import("node:fs");
  const { engineTagRoot } = await import("@/lib/store/layout");
  const { swapEngine } = await import("@/updates/engines");
  const root = engineTagRoot("llama-server", "b1").replace(/\/b1$/, "");
  try {
    mkdirSync(engineTagRoot("llama-server", "b1"), { recursive: true });
    const { writeFileSync } = await import("node:fs"); const { join } = await import("node:path");
    writeFileSync(join(engineTagRoot("llama-server", "b1"), ".engine-ready"), "now");
    await swapEngine("llama-server", "b1");
    expect((await app.request("/stack/v1/engines/llama-server/builds/b1", { method: "DELETE" })).status).toBe(400);
    expect((await app.request("/stack/v1/updates/engines/llama-server/rollback", json({ tag: "b9" }))).status).toBe(400);
    expect((await app.request("/stack/v1/engines/llama-server/install", json({ tag: "b2", url: "https://github.com/x/y.tar.gz" }))).status).toBe(400);
    // A tag already on disk with another checksum is never re-described.
    const { writeEngineManifest } = await import("@/lib/store/manifests");
    writeEngineManifest({ kind: "engine", name: "llama-server", tag: "b1", assetUrl: "https://github.com/x/b1.tar.gz", sizeBytes: 1, sha256: "a".repeat(64), extractedAt: new Date().toISOString(), blobs: [] });
    expect((await app.request("/stack/v1/engines/llama-server/install", json({ tag: "b1", url: "https://github.com/x/b1.tar.gz", sha256: "b".repeat(64), size: 1 }))).status).toBe(409);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("importing a multi-chunk local GGUF streams its hash and registers its lm-studio source", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "maipai-stack-route-import-"));
  const modelPath = join(root, "local-chat.gguf");
  const contents = Buffer.alloc(16 * 1024 * 1024 * 2 + 123, 0x5a);
  writeFileSync(modelPath, contents);
  const expectedDigest = createHash("sha256").update(contents).digest("hex");
  contents.fill(0);
  const wholeFileRead = spyOn(fs, "readFileSync");
  try {
    const response = await app.request("/stack/v1/models/import", json({
      id: "local-gguf-route-import",
      path: modelPath,
      roles: ["chat"],
      licence: "Apache-2.0",
      revision: "local-test-revision",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "local-gguf-route-import",
      roles: ["chat"],
      state: "installed",
      source: "lm-studio",
      revision: "local-test-revision",
      sha256: expectedDigest,
      modelPath: expect.any(String),
    });
    expect(wholeFileRead.mock.calls.some(([path]) => String(path) === modelPath)).toBe(false);
  } finally {
    wholeFileRead.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardware, budget, backup and the diagnostics bundle answer as data without a computer name", async () => {
  const hardware = await (await app.request("/stack/v1/hardware")).json() as { hardware: Record<string, unknown>; tiers: unknown[] };
  expect(hardware.hardware.computerName).toBeUndefined();
  expect(hardware.tiers).toHaveLength(4);
  const budget = await (await app.request("/stack/v1/hardware/budget")).json() as { capBytes: number; pressure: string; tier: string; margin_bytes: number; reading_degraded: boolean };
  expect(budget.capBytes).toBeGreaterThan(0);
  expect(budget.tier).toBe("p16");
  expect(budget.margin_bytes).toBe(4 * GB);
  expect(budget.reading_degraded).toBe(false);
  const backup = await (await app.request("/stack/v1/backup")).json() as { data_dir: string; paths: Array<{ mode: string }> };
  expect(backup.paths.map((path) => path.mode)).toEqual(["include", "include", "exclude", "exclude"]);
  const bundle = await app.request("/stack/v1/diagnostics");
  expect(bundle.headers.get("content-type")).toBe("application/zip");
  expect((await bundle.arrayBuffer()).byteLength).toBeGreaterThan(100);
});

test("the budget route reports the active tier, its margin and a degraded reading", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 30 * GB, tier: "p128" });
  const p128 = await (await app.request("/stack/v1/hardware/budget")).json() as { tier: string; margin_bytes: number; reading_degraded: boolean };
  expect(p128.tier).toBe("p128");
  expect(p128.margin_bytes).toBe(20 * GB);
  expect(p128.reading_degraded).toBe(false);
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 16 * GB, freeMemoryBytes: 4 * GB, tier: "p16" });
  const reader = scriptedMemoryReader([
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { probeError: "The kernel's ledger was unreachable." },
    { totalBytes: 16 * GB, freeBytes: 4 * GB, availablePercent: 25, pressure: "normal", degraded: false },
  ]);
  __setMemoryReaderForTests(reader);
  const startGovernor = (await import("@/lib/governor")).startGovernor;
  const stop = startGovernor({ pid: 1, pollMs: 1, memoryReader: reader });
  try {
    const degraded = await (await app.request("/stack/v1/hardware/budget")).json() as { tier: string; margin_bytes: number; reading_degraded: boolean };
    expect(degraded.reading_degraded).toBe(true);
    expect(degraded.tier).toBe("p16");
    expect(degraded.margin_bytes).toBe(4 * GB);
  } finally {
    stop();
    __setMemoryReaderForTests(scriptedMemoryReader([]));
    __resetGovernorForTests();
  }
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
  for (const path of ["/v1/chat/completions", "/v1/tokenize", "/v1/embeddings", "/v1/models", "/stack/v1/roles", "/stack/v1/engines", "/stack/v1/models", "/stack/v1/jobs", "/stack/v1/health", "/stack/v1/check", "/stack/v1/updates", "/stack/v1/events", "/stack/v1/hardware", "/stack/v1/hardware/budget", "/stack/v1/settings", "/stack/v1/storage/sweep", "/stack/v1/privacy", "/stack/v1/backup", "/healthz"]) {
    expect(Object.keys(document.paths), `missing ${path}`).toContain(path);
  }
  await getProcess("chat");
});
