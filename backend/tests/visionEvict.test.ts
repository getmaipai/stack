// VISION-EVICT-01: a resident start never evicts a busy or needed just-in-time role for nothing. Found 2026-11-20 on a scratch Stack with
// the vision model installed and no chat or embed model: every retry of the missing resident unloaded the vision engine in the middle of a
// picture check, so the age check failed closed over and over. Scripted engines only; no model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests } from "@/lib/governor";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { __setJitYieldBoundForTests, EngineUnavailableError, getProcess, getRoleStatus, requestRole, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests, roleHasProcess } from "@/lib/supervisor";
import { __resetSettingsForTests } from "@/settings";
import type { RoleId } from "@/roles";

const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened/model.gguf" };
let started: RoleId[] = [];
beforeEach(() => {
  started = [];
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests();
  upsertModel({ id: "vision-a", roles: ["vision"], ...verified, sizeBytes: 1_000_000 });
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role); }, { checksModels: true });
});
afterEach(() => { __setJitYieldBoundForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); __resetSettingsForTests(); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("vision busy and no chat model installed: a chat start is refused as not installed and the vision engine is left alone", async () => {
  const vision = await getProcess("vision");
  vision.activeRequests++;
  await expect(getProcess("chat")).rejects.toBeInstanceOf(EngineUnavailableError);
  await expect(requestRole("embed", "/v1/embeddings", { model: "embed", input: "hi" })).rejects.toBeInstanceOf(EngineUnavailableError);
  expect(vision.retired).toBe(false);
  expect(roleHasProcess("vision")).toBe(true);
  expect(getRoleStatus("vision").state).not.toBe("installed");
  expect(started).toEqual(["vision"]);
});

test("a role with no model never starts anything, whoever asks and however often (a timer, a canary, a retry loop)", async () => {
  const vision = await getProcess("vision");
  for (let i = 0; i < 5; i++) { await expect(getProcess("embed")).rejects.toBeInstanceOf(EngineUnavailableError); await expect(getProcess("chat")).rejects.toBeInstanceOf(EngineUnavailableError); }
  expect(vision.retired).toBe(false);
  expect(started).toEqual(["vision"]);
});

test("vision busy and a chat model installed: chat waits for the request, vision takes no new request meanwhile, then vision is unloaded and chat starts", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  __setJitYieldBoundForTests(2_000);
  const vision = await getProcess("vision");
  vision.activeRequests++;
  const chat = getProcess("chat");
  await sleep(100);
  expect(vision.retired).toBe(false);                                   // still serving: not evicted
  expect(started).toEqual(["vision"]);                                  // chat has not started yet
  await expect(getProcess("vision")).rejects.toBeInstanceOf(EngineUnavailableError); // no new request is admitted meanwhile
  vision.activeRequests--;
  await chat;
  expect(started).toEqual(["vision", "chat"]);
  expect(getRoleStatus("vision").state).toBe("installed");              // unloaded once its request ended
});

test("vision busy for longer than the bound: chat proceeds after the bound and vision is unloaded (chat first)", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  __setJitYieldBoundForTests(150);
  const vision = await getProcess("vision");
  vision.activeRequests++;
  const t0 = Date.now();
  const chat = getProcess("chat");
  await sleep(40);
  expect(started).toEqual(["vision"]);
  // The retire of a busy engine waits for its request in production; here the request is released a moment after the bound passes.
  setTimeout(() => { vision.activeRequests--; }, 220);
  await chat;
  expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  expect(started).toEqual(["vision", "chat"]);
  expect(getRoleStatus("vision").state).toBe("installed");
});

test("vision idle and a chat model installed: unloaded at once, as before", async () => {
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  __setJitYieldBoundForTests(5_000);
  await getProcess("vision");
  const t0 = Date.now();
  await getProcess("chat");
  expect(Date.now() - t0).toBeLessThan(1_000);
  expect(started).toEqual(["vision", "chat"]);
  expect(getRoleStatus("vision").state).toBe("installed");
});

test("a canary asking for a restart of a role with no installed model is refused as not installed: no crash is recorded, nothing is unloaded", async () => {
  const { requestEngineRestart, selfHealSummary } = await import("@/lib/selfHeal");
  const vision = await getProcess("vision");
  const before = JSON.stringify(selfHealSummary());
  const answer = await requestEngineRestart("chat", "chat role not ready at a health check");
  expect(answer.accepted).toBe(false);
  expect(answer.why).toContain("No verified and installed chat model");
  expect(JSON.stringify(selfHealSummary())).toBe(before);
  expect(vision.retired).toBe(false);
});
