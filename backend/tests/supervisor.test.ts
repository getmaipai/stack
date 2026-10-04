import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { sizeChatLaunch, dryRunFootprint, fitTotalBytes, getProcess, getRoleStatus, lastRealRequestAt, loadTimeoutForModel, parseFitRows, preferModel, probeReplyOk, probeRequest, processRoleFor, requestRole, restartRole, resetSupervisorForTests, scriptedProcess, selectedModel, setSupervisorFactoryForTests, setSupervisorTimeoutsForTests, stopRole, streamRole, unloadIdleRole, unloadRole, waitHealthy, EngineUnavailableError, type RoleProcess } from "@/lib/supervisor";
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

test("llama-fit-params rows sum device and Host MiB, ignoring its diagnostic", () => {
  const samples = [
    ["MTL0 1743 448 304\nHost 315 0 24", 2834],
    ["MTL0 1743 3584 304\nHost 315 0 80", 6026],
    ["MTL0 2375 576 301\nHost 304 0 28", 3584],
    ["MTL0 2375 2304 306\nHost 304 0 52", 5341],
  ] as const;
  const diagnostic = "0.00.035.228 I llama_fit_params: printing estimated memory in MiB to stdout (device, model, context, compute) ...";
  for (const [rows, expectedMiB] of samples) expect(fitTotalBytes(parseFitRows(`${diagnostic}\n${rows}`)!)).toBe(expectedMiB * 1_048_576);
  expect(parseFitRows("")).toBeNull();
  expect(parseFitRows(diagnostic)).toBeNull();
});

test("dryRunFootprint reads the fake fit binary output and returns null on a failed empty run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-fit-test-"));
  const previous = process.env.STACK_FIT_BINARY;
  try {
    const binary = join(dir, "fit-ok");
    writeFileSync(binary, "#!/bin/sh\nprintf 'MTL0 1743 448 304\\nHost 315 0 24\\n'\n"); chmodSync(binary, 0o755);
    process.env.STACK_FIT_BINARY = binary;
    expect(await dryRunFootprint("/tmp/model.gguf", 4096)).toBe(2834 * 1_048_576);
    const empty = join(dir, "fit-empty");
    writeFileSync(empty, "#!/bin/sh\nexit 1\n"); chmodSync(empty, 0o755);
    process.env.STACK_FIT_BINARY = empty;
    expect(await dryRunFootprint("/tmp/model.gguf", 4096)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.STACK_FIT_BINARY; else process.env.STACK_FIT_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
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
  expect(reply.headers).toEqual({ "x-maipai-engine": "stub scripted", "x-maipai-model": "scripted-chat", "x-maipai-revision": "scripted" });
  expect((reply.body as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("Scripted Stack reply.");
  const embed = await requestRole("embed", "/v1/embeddings", { model: "embed", input: "OK" });
  expect(probeReplyOk("embed", embed)).toBe(true);
  expect(started).toEqual(["chat", "embed"]);
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { modelRevision: "90862c4b" }));
  expect((await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] })).headers["x-maipai-revision"]).toBe("90862c4b");
});

test("an explicit chat model starts and dispatches through its own model process; omission keeps the current process", async () => {
  const modelStarts: Array<string | undefined> = [];
  const dispatchedModels: Array<unknown> = [];
  setSupervisorFactoryForTests(async (role, modelId) => {
    modelStarts.push(modelId);
    const processRecord = scriptedProcess(role, {
      kind: "spawned",
      modelId: modelId ?? "default-chat-model",
      identity: { host: "stub", build: "scripted", model: modelId ?? "default-chat-model", healthy: true },
    });
    const request = processRecord.client.request!;
    processRecord.client.request = async (path, body, signal) => { dispatchedModels.push(body.model); return request(path, body, signal); };
    return processRecord;
  });

  const defaultReply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(defaultReply.headers["x-maipai-model"]).toBe("default-chat-model");

  const selectedReply = await requestRole("chat", "/v1/chat/completions", { model: "qwen-chat-fast", messages: [] });
  expect(selectedReply.headers["x-maipai-model"]).toBe("qwen-chat-fast");

  const nextDefault = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(nextDefault.headers["x-maipai-model"]).toBe("qwen-chat-fast");
  expect(modelStarts).toEqual([undefined, "qwen-chat-fast"]);
  expect(dispatchedModels).toEqual(["chat", "chat", "chat"]);
});

test("concurrent requests for different models keep the first generation alive", async () => {
  let releaseFirst!: () => void;
  const firstGeneration = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstHasStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
  const processes = new Map<string, RoleProcess>();
  const outcomes: string[] = [];
  setSupervisorFactoryForTests(async (role, modelId) => {
    const processRecord = scriptedProcess(role, {
      kind: "spawned",
      modelId: modelId ?? "default-chat-model",
      identity: { host: "stub", build: "scripted", model: modelId ?? "default-chat-model", healthy: true },
    });
    processRecord.client.request = async () => {
      if (modelId === "qwen-chat-first") {
        firstStarted();
        await firstGeneration;
      }
      outcomes.push(modelId ?? "default-chat-model");
      return { status: 200, body: { model: modelId, choices: [{ message: { content: `reply from ${modelId}` } }] } };
    };
    processes.set(modelId ?? "default-chat-model", processRecord);
    return processRecord;
  });

  const firstRequest = requestRole("chat", "/v1/chat/completions", { model: "qwen-chat-first", messages: [] });
  await firstHasStarted;
  const firstProcess = processes.get("qwen-chat-first")!;
  expect(firstProcess.activeRequests).toBe(1);

  const bothRequests = Promise.all([
    firstRequest,
    requestRole("chat", "/v1/chat/completions", { model: "qwen-chat-second", messages: [] }),
  ]);
  // Model switching must drain the first generation before retiring its
  // process, so the second request may finish only after we release it.
  await Promise.resolve();
  expect(firstProcess.activeRequests).toBe(1);
  releaseFirst();
  const [firstReply, secondReply] = await bothRequests;
  expect(secondReply.status).toBe(200);
  expect((secondReply.body as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("reply from qwen-chat-second");
  expect(firstReply.status).toBe(200);
  expect((firstReply.body as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content).toBe("reply from qwen-chat-first");
  expect(firstProcess.activeRequests).toBe(0);
  expect(firstProcess.retired).toBe(true);
  expect(outcomes).toHaveLength(2);
  expect(outcomes).toEqual(expect.arrayContaining(["qwen-chat-first", "qwen-chat-second"]));
});

test("streaming chat selects the explicit model process too", async () => {
  let selectedModel: string | undefined;
  let dispatchedModel: unknown;
  setSupervisorFactoryForTests(async (role, modelId) => {
    selectedModel = modelId;
    const processRecord = scriptedProcess(role, { kind: "spawned", modelId: modelId ?? null, identity: { host: "stub", build: "scripted", model: modelId ?? "default", healthy: true } });
    const stream = processRecord.client.stream!;
    processRecord.client.stream = async (path, body, signal) => { dispatchedModel = body.model; return stream(path, body, signal); };
    return processRecord;
  });
  const stream = await streamRole("chat", "/v1/chat/completions", { model: "qwen-chat-stream", messages: [] });
  expect(stream.headers["x-maipai-model"]).toBe("qwen-chat-stream");
  expect(await new Response(stream.body).text()).toContain("data: [DONE]");
  expect(selectedModel).toBe("qwen-chat-stream");
  expect(dispatchedModel).toBe("chat");
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

test("the roles route carries the running engine's context length, slots and context per slot, and null with a reason when nothing runs (STACK-CTX-01)", async () => {
  type View = { id: string; context: { context_length: number | null; slots: number | null; context_per_slot: number | null; reason: string | null } };
  const read = async () => ((await (await app.request("/stack/v1/roles")).json()) as { roles: View[] }).roles.find((role) => role.id === "chat")!;
  expect((await read()).context).toEqual({ context_length: null, slots: null, context_per_slot: null, reason: "No engine is running." });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { context: { contextLength: 32768, slots: 1, contextPerSlot: 32768 } }));
  await getProcess("chat");
  expect((await read()).context).toEqual({ context_length: 32768, slots: 1, context_per_slot: 32768, reason: null });
});

test("an unreadable GGUF is launched at the declared context with the reason, never a computed guess (STACK-CTX-01)", async () => {
  upsertModel({ id: "chat-unreadable", roles: ["chat"], source: "catalog", provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never/chat.gguf", sizeBytes: 4_920_000_000 });
  const sizing = await sizeChatLaunch(selectedModel("chat")!);
  expect(sizing).toMatchObject({ contextLength: 4096, slots: 1, kvBytes: null, source: "unknown-shape" });
  expect(sizing.reason).toContain("KV");
  clearModelsForTests();
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
