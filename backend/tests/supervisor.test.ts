import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { getProcess, getRoleStatus, lastRealRequestAt, loadTimeoutForModel, preferModel, probeReplyOk, probeRequest, processRoleFor, requestRole, restartRole, resetSupervisorForTests, scriptedProcess, selectedModel, setSupervisorFactoryForTests, setSupervisorTimeoutsForTests, stopRole, streamRole, unloadIdleRole, unloadRole, waitHealthy, EngineUnavailableError, type RoleProcess } from "@/lib/supervisor";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import type { RoleId } from "@/roles";

let started: RoleId[] = [];
beforeEach(() => {
  started = [];
  __resetEventsForTests(); __resetHealthForTests();
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role); });
});
afterEach(() => { setSupervisorFactoryForTests(null); setSupervisorTimeoutsForTests(null); resetSupervisorForTests(); });

test("the first request starts the role's process once, and ready is stamped from that real request", async () => {
  const [first, second] = await Promise.all([getProcess("chat"), getProcess("chat")]);
  expect(first).toBe(second);
  expect(started).toEqual(["chat"]);
  expect(getRoleStatus("chat")).toMatchObject({ state: "ready", kind: "url", identity: { model: "scripted-chat" } });
  expect(lastRealRequestAt("chat")).not.toBeNull();
  expect(eventsAfter(0).map((event) => event.id)).toEqual(expect.arrayContaining(["engine.state", "role.state"]));
});

test("roles that share chat's model run on chat's process", async () => {
  expect(processRoleFor("judge")).toBe("chat");
  await getProcess("coding");
  await getProcess("judge");
  expect(started).toEqual(["chat"]);
  expect(getRoleStatus("router").state).toBe("ready");
});

test("a request carries the identity headers and the reply of the engine", async () => {
  const reply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [{ role: "user", content: "hi" }] });
  expect(reply.status).toBe(200);
  expect(reply.headers).toEqual({ "x-maipai-engine": "stub", "x-maipai-model": "scripted-chat", "x-maipai-revision": "scripted" });
  expect((reply.body as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("Scripted Stack reply.");
  const embed = await requestRole("embed", "/v1/embeddings", { model: "embed", input: "OK" });
  expect(probeReplyOk("embed", embed)).toBe(true);
  expect(started).toEqual(["chat", "embed"]);
});

test("streaming passes the engine's bytes through and finishes the request when the stream ends", async () => {
  const stream = await streamRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(stream.status).toBe(200);
  const text = await new Response(stream.body).text();
  expect(text).toContain("data: [DONE]");
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("stop drains and marks the role stopped; restart starts a new generation", async () => {
  await getProcess("chat");
  await stopRole("chat");
  expect(getRoleStatus("chat")).toMatchObject({ state: "stopped" });
  await expect(getProcess("chat")).rejects.toBeInstanceOf(EngineUnavailableError);
  await restartRole("chat");
  await getProcess("chat");
  expect(started).toEqual(["chat", "chat"]);
});

test("a process that fails to start leaves the role offline with the reason", async () => {
  setSupervisorFactoryForTests(async () => { throw new EngineUnavailableError("No verified and installed chat model is available."); });
  await expect(getProcess("chat")).rejects.toThrow(/No verified/);
  expect(getRoleStatus("chat")).toMatchObject({ state: "offline", reason: "No verified and installed chat model is available." });
});

test("a living engine's 5xx is returned as is and does not retire the process", async () => {
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    scripted.client.request = async () => ({ status: 500, body: { error: "slot busy" } });
    return scripted;
  });
  const reply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(reply.status).toBe(500);
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("an engine that stops answering its health probe is retired and reported offline", async () => {
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    scripted.client.request = async () => { throw new EngineUnavailableError("connection refused"); };
    scripted.client.health = async () => false;
    return scripted;
  });
  await expect(requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] })).rejects.toBeInstanceOf(EngineUnavailableError);
  expect(getRoleStatus("chat").state).toBe("offline");
});

test("a cancelled request is a normal end, not a retirement", async () => {
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    scripted.client.request = async () => { throw new DOMException("Cancelled", "AbortError"); };
    return scripted;
  });
  const reply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(reply.status).toBe(499);
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("idle unload retires a quiet process after the declared minutes, sooner on battery", async () => {
  await getProcess("chat");
  const later = new Date(Date.now() + 20 * 60_000);
  expect(await unloadIdleRole("chat", { now: later, onBattery: false, idleMinutes: 30, batteryIdleMinutes: 10 })).toBe(false);
  expect(await unloadIdleRole("chat", { now: later, onBattery: true, idleMinutes: 30, batteryIdleMinutes: 10 })).toBe(true);
  expect(getRoleStatus("chat").state).toBe("installed");
  await getProcess("chat");
  expect(started).toEqual(["chat", "chat"]);
});

test("the post-load probe is the smallest real request for the wire", () => {
  expect(probeRequest("chat").path).toBe("/v1/chat/completions");
  expect(probeRequest("embed").path).toBe("/v1/embeddings");
  expect(probeReplyOk("chat", { status: 200, body: { choices: [{ message: { content: "", reasoning_content: "thinking" } }] } })).toBe(true);
  expect(probeReplyOk("chat", { status: 200, body: { choices: [{ message: { content: "" } }] } })).toBe(false);
  expect(probeReplyOk("embed", { status: 200, body: { data: [] } })).toBe(false);
});

test("the load timeout scales with model size between the floor and the ceiling", () => {
  setSupervisorTimeoutsForTests({ loadFloorMs: 1_000 });
  expect(loadTimeoutForModel(0)).toBe(1_000);
  expect(loadTimeoutForModel(3 * 1024 ** 3)).toBe(1_000 + 3 * 60_000);
  expect(loadTimeoutForModel(100 * 1024 ** 3)).toBe(20 * 60_000);
});

test("waitHealthy gives up when the process exits before it is healthy", async () => {
  const client: RoleProcess["client"] = { baseUrl: "x", request: async () => ({ status: 200, body: {} }), health: async () => false };
  await expect(waitHealthy(client, 200, () => false)).rejects.toThrow(/exited before/);
  await expect(waitHealthy(client, 50, () => true)).rejects.toThrow(/load timeout/);
});

test("the roles route derives state from the supervisor and never stores it", async () => {
  await getProcess("chat");
  const response = await app.request("/stack/v1/roles");
  const body = await response.json() as { roles: Array<{ id: string; state: { state: string; checkedAt?: string } }> };
  expect(body.roles.find((role) => role.id === "chat")!.state.state).toBe("ready");
  expect(body.roles.find((role) => role.id === "chat")!.state.checkedAt).toBeDefined();
  expect(body.roles.find((role) => role.id === "image")!.state.state).toBe("notInstalled");
});

test("after an engine goes offline mid-request, the next request starts a fresh process (regression: a stale start promise was reused)", async () => {
  let starts = 0;
  setSupervisorFactoryForTests(async (role) => {
    starts++;
    const scripted = scriptedProcess(role);
    if (starts === 1) { scripted.client.request = async () => { throw new EngineUnavailableError("connection refused"); }; scripted.client.health = async () => false; }
    return scripted;
  });
  await expect(requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] })).rejects.toBeInstanceOf(EngineUnavailableError);
  const reply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(reply.status).toBe(200);
  expect(starts).toBe(2);
});

test("unload is undone by the next request; stop stays stopped until a restart", async () => {
  await getProcess("chat");
  expect(await unloadRole("chat", "Unloaded to free memory.")).toBe(true);
  expect(getRoleStatus("chat").state).toBe("installed");
  await getProcess("chat");
  expect(started).toEqual(["chat", "chat"]);
  await stopRole("chat");
  await expect(getProcess("chat")).rejects.toThrow(/stopped/);
});

test("Home's load names the model: the preferred selectable model wins over the first one", () => {
  clearModelsForTests();
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened.gguf" };
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  upsertModel({ id: "chat-b", roles: ["chat"], ...verified });
  expect(selectedModel("chat")?.id).toBe("chat-a");
  preferModel("chat", "chat-b");
  expect(selectedModel("chat")?.id).toBe("chat-b");
  preferModel("chat", "missing");
  expect(selectedModel("chat")?.id).toBe("chat-a");
  clearModelsForTests();
});
