// STACK-87: ready and current claims are time-bound and identity-bound,
// and a readiness result goes stale the moment the Stack changes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { __resetReadinessForTests, latestCheck, roleCheck, runCheck } from "@/lib/readiness";
import { resolveRoleState } from "@/lib/router";
import { __resetStackGenerationForTests, bumpStackGeneration, stackGeneration } from "@/lib/stackGeneration";
import { getProcess, identityCheck, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetSettingsForTests, applyPendingSettings, updateSettings } from "@/settings";

beforeEach(() => { __resetHealthForTests(); __resetReadinessForTests(); __resetStackGenerationForTests(); __resetSettingsForTests(); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetReadinessForTests(); });

const verified = { source: "catalog" as const, provenance: {}, revision: "r1", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened/chat-a.gguf" };

test("a spawned process that reports a different model file than the selected one is loaded, never ready", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", pid: 4242, modelId: "chat-a", identity: { host: "local", build: "b10797", model: "chat-b.gguf", healthy: true } }));
  await getProcess("chat");
  expect(identityCheck("chat")).toMatchObject({ ok: false, expected: "chat-a.gguf", actual: "chat-b.gguf" });
  const state = resolveRoleState("chat");
  expect(state.state).toBe("loaded");
  expect(state.reason).toMatch(/reports chat-b.gguf/);
  const roles = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string }; identity: { ok: boolean } }> };
  expect(roles.roles.find((role) => role.id === "chat")).toMatchObject({ state: { state: "loaded" }, identity: { ok: false } });
});

test("a spawned process that reports the selected model's file is ready with checkedAt", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", pid: 4242, modelId: "chat-a", identity: { host: "local", build: "b10797", model: "chat-a.gguf", healthy: true } }));
  await getProcess("chat");
  expect(identityCheck("chat").ok).toBe(true);
  expect(resolveRoleState("chat")).toMatchObject({ state: "ready" });
  expect(resolveRoleState("chat").checkedAt).toBeDefined();
});

test("a url binding with an expected version is ready only when the server's build carries it", async () => {
  // expected_version takes effect at the next start, like every engine key.
  updateSettings({ "stack.engines.chat.expected_version": "b10900" });
  applyPendingSettings();
  await getProcess("chat");
  expect(identityCheck("chat")).toMatchObject({ ok: false, expected: "b10900", actual: "scripted" });
  expect(resolveRoleState("chat").state).toBe("loaded");
  updateSettings({ "stack.engines.chat.expected_version": "" });
  applyPendingSettings();
  expect(resolveRoleState("chat").state).toBe("ready");
});

test("not checked, passed, failed and skipped are four different things on the roles route", async () => {
  expect(roleCheck("chat").state).toBe("not checked");
  await runCheck({ roleIds: ["chat", "tts"], requestRole: async (role) => role === "chat" ? { status: 200 } : { status: 503, reason: "no tts engine" } });
  expect(roleCheck("chat")).toMatchObject({ state: "passed", stale: false });
  expect(roleCheck("tts")).toMatchObject({ state: "failed", reason: "no tts engine" });
  expect(roleCheck("embed").state).toBe("not checked");
  const skipped = await runCheck({ roleIds: ["tts"] });
  expect(skipped.results[0]!.skipped).toBe(true);
  expect(roleCheck("tts").state).toBe("skipped");
  const roles = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; check: { state: string } }> };
  expect(roles.roles.find((role) => role.id === "tts")!.check.state).toBe("skipped");
  expect(roles.roles.find((role) => role.id === "chat")!.check.state).toBe("not checked");
});

test("a readiness result goes stale when a model, an engine or a setting changes after it ran, and says why", async () => {
  await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  expect(latestCheck()).toMatchObject({ stale: false, staleReason: null });
  const before = stackGeneration();
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  expect(stackGeneration()).toBe(before);
  updateSettings({ "stack.runtime.idle_unload_minutes": 45 });
  expect(stackGeneration()).toBeGreaterThan(before);
  expect(latestCheck()).toMatchObject({ stale: true, staleReason: "settings changed: stack.runtime.idle_unload_minutes" });
  expect(roleCheck("chat")).toMatchObject({ state: "passed", stale: true });
  const latest = await (await app.request("/stack/v1/check/latest")).json() as { latest: { stale: boolean } };
  expect(latest.latest.stale).toBe(true);
  bumpStackGeneration("engine llama-server now b2");
  expect(latestCheck()?.staleReason).toBe("engine llama-server now b2");
  await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  expect(latestCheck()?.stale).toBe(false);
});

test("a stale last request degrades ready to loaded with a reason", async () => {
  const { requestRole } = await import("@/lib/supervisor");
  await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(resolveRoleState("chat").state).toBe("ready");
  const realNow = Date.now;
  Date.now = () => realNow() + 3_600_001;
  try { expect(resolveRoleState("chat")).toMatchObject({ state: "loaded", reason: "No request through the public route in the last hour." }); } finally { Date.now = realNow; }
});

test("a change during a run makes that run stale; a no-op save or a pending-only write does not", async () => {
  let landed = false;
  await runCheck({ roleIds: ["chat"], requestRole: async () => { if (!landed) { landed = true; updateSettings({ "stack.runtime.idle_unload_minutes": 50 }); } return { status: 200 }; } });
  expect(latestCheck()?.stale).toBe(true);
  await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  expect(latestCheck()?.stale).toBe(false);
  updateSettings({ "stack.runtime.idle_unload_minutes": 50 });
  expect(latestCheck()?.stale).toBe(false);
  updateSettings({ "stack.runtime.port": 8790 });
  expect(latestCheck()?.stale).toBe(false);
  applyPendingSettings();
  expect(latestCheck()).toMatchObject({ stale: true, staleReason: "1 pending setting(s) applied" });
});

test("loading or pinning a different model changes what runs and stales the last run", async () => {
  const { pinModel, preferModel } = await import("@/lib/supervisor");
  await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  preferModel("chat", "chat-b");
  expect(latestCheck()).toMatchObject({ stale: true, staleReason: "chat now prefers chat-b" });
  await runCheck({ roleIds: ["chat"], requestRole: async () => ({ status: 200 }) });
  pinModel("chat-b", true);
  expect(latestCheck()?.staleReason).toBe("model chat-b pinned");
  pinModel("chat-b", true);
  expect(latestCheck()?.staleReason).toBe("model chat-b pinned");
});

test("a spawned process whose model record was removed is no longer ready", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { kind: "spawned", pid: 4242, modelId: "chat-a", identity: { host: "local", build: "b10797", model: "chat-a.gguf", healthy: true } }));
  await getProcess("chat");
  expect(resolveRoleState("chat").state).toBe("ready");
  clearModelsForTests();
  expect(identityCheck("chat")).toMatchObject({ ok: false, reason: expect.stringContaining("no longer has") });
  expect(resolveRoleState("chat").state).toBe("loaded");
});

test("a bad value in one key leaves every other key in the same request unwritten", () => {
  expect(() => updateSettings({ "stack.runtime.idle_unload_minutes": 55, "stack.runtime.port": 70_000 })).toThrow();
  expect(latestCheck()).toBeNull();
  const { settingValues } = require("@/settings") as typeof import("@/settings");
  expect(settingValues()["stack.runtime.idle_unload_minutes"]).toBe(30);
});

test("an offline chat group is probed once per check run, not once per role that shares chat's process", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  let attempts = 0;
  setSupervisorFactoryForTests(async () => { attempts += 1; throw new Error("llama-server exited during load"); });
  await expect(getProcess("chat")).rejects.toThrow(/exited/);
  expect(resolveRoleState("chat").state).toBe("offline");
  expect(resolveRoleState("coding").state).toBe("offline");
  attempts = 0;
  const run = await runCheck();
  expect(run.ok).toBe(false);
  expect(run.results.map((result) => result.role)).toEqual(["chat"]);
  // One start attempt for the probe; the fit-together generator does not
  // try chat again after its probe failed.
  expect(attempts).toBe(1);
});

test("roles sharing a process whose owner failed to start in this run are skipped with the owner's reason, not started again", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  let attempts = 0;
  setSupervisorFactoryForTests(async () => { attempts += 1; throw new Error("llama-server exited during load"); });
  const run = await runCheck({ roleIds: ["coding", "chat", "judge", "router", "vision"] });
  expect(attempts).toBe(1);
  expect(run.ok).toBe(false);
  expect(run.results.map((result) => [result.role, result.ok, result.skipped ?? false])).toEqual([["chat", false, false], ["coding", false, true], ["judge", false, true], ["router", false, true], ["vision", false, true]]);
  expect(run.results[1]?.reason).toMatch(/runs on chat's process, which failed: llama-server exited during load/);
});
