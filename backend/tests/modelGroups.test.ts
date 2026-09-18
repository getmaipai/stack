import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { createModelGroup, getModelUsage, listGroupRollups, performGroupAction, recordModelLoaded, recordModelUnloaded, recordModelUsage, removeModelGroup, setModelRuntimeForTests, updateModelGroup } from "@/lib/modelGroups";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { resetSupervisorForTests } from "@/lib/supervisor";
import { __resetOperatorForTests, __resetOperatorThrottleForTests } from "@/lib/operator";

const originalScripted = process.env.STACK_SCRIPTED_ENGINES;

function model(id: string, groupId: string | null, nickname = id) {
  return upsertModel({ id, nickname, groupId, roles: ["chat"], source: "catalog", provenance: { licence: "Apache-2.0" }, revision: "test", sha256: "a".repeat(64), sizeBytes: 100, licence: "Apache-2.0", verifiedAt: new Date().toISOString(), installedAt: new Date().toISOString() });
}

beforeEach(() => { clearModelsForTests(); resetSupervisorForTests(); __resetOperatorForTests(); __resetOperatorThrottleForTests(); });
afterEach(() => { clearModelsForTests(); resetSupervisorForTests(); __resetOperatorForTests(); __resetOperatorThrottleForTests(); if (originalScripted === undefined) delete process.env.STACK_SCRIPTED_ENGINES; else process.env.STACK_SCRIPTED_ENGINES = originalScripted; });

test("nested group rollups count each model once and removing a middle group reparents", () => {
  const root = createModelGroup("Root"); const middle = createModelGroup("Middle", root.id); const leaf = createModelGroup("Leaf", middle.id);
  model("nested-model", leaf.id);
  expect(listGroupRollups().find((group) => group.id === root.id)?.modelCount).toBe(1);
  expect(listGroupRollups().find((group) => group.id === middle.id)?.modelCount).toBe(1);
  expect(removeModelGroup(middle.id)).toBe(true);
  expect(listGroupRollups().find((group) => group.id === root.id)?.modelCount).toBe(1);
  expect(() => updateModelGroup(root.id, { parentId: leaf.id })).toThrow("own ancestor");
});

test("group actions reach every model and report one scripted refusal", async () => {
  const group = createModelGroup("Batch"); model("load-one", group.id); model("refuse-two", group.id);
  const result = await performGroupAction(group.id, "load");
  expect(result.results).toHaveLength(2);
  expect(result.results.find((entry) => entry.modelId === "load-one")?.ok).toBe(true);
  expect(result.results.find((entry) => entry.modelId === "refuse-two")?.ok).toBe(false);
});

test("status and worst health are part of the group rollup", () => {
  const group = createModelGroup("Health"); const loaded = model("loaded", group.id); const failed = model("failed", group.id);
  setModelRuntimeForTests(loaded.id, "loaded"); setModelRuntimeForTests(failed.id, "failed", "critical");
  const rollup = listGroupRollups().find((entry) => entry.id === group.id)!;
  expect(rollup.status.loaded).toBe(1); expect(rollup.status.failed).toBe(1); expect(rollup.worstHealth).toBe("critical");
});

test("usage records on the model and loaded seconds accumulate", () => {
  const group = createModelGroup("Usage"); const entry = model("usage-model", group.id);
  recordModelUsage(entry.id, { requests: 2, tokensIn: 10, tokensOut: 15 }); recordModelLoaded(entry.id, Date.now() - 2_100); recordModelUnloaded(entry.id);
  const usage = getModelUsage(entry.id); expect(usage.requests).toBe(2); expect(usage.tokensIn).toBe(10); expect(usage.tokensOut).toBe(15); expect(usage.secondsLoaded).toBeGreaterThanOrEqual(2);
});

test("a nickname is display-only while the model id remains accepted", async () => {
  process.env.STACK_SCRIPTED_ENGINES = "1";
  const entry = model("real-model", null, "Friendly name");
  const nicknameResponse = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "Friendly name", messages: [{ role: "user", content: "hi" }] }) });
  expect(nicknameResponse.status).toBe(400);
  const idResponse = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: entry.id, messages: [{ role: "user", content: "hi" }] }) });
  expect(idResponse.status).toBe(200); expect(getModelUsage(entry.id).requests).toBe(1);
});
