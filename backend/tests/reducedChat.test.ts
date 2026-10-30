import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetEventsForTests, eventsAfter } from "@/lib/events";
import { enterReducedChat, reducedVoiceAllowed, leaveReducedChat, resetSupervisorForTests, scriptedProcess, selectedModel, setMachineTier, setSupervisorFactoryForTests, setSupervisorTimeoutsForTests, requestRole } from "@/lib/supervisor";
import { getReducedChatState } from "@/lib/reducedChat";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";

const lightId = "qwen3-4b-q4-k-m";
const standardId = "muse-glimmer-30b-q4-k-xl";
function installModel(id: string, roles: Array<"chat" | "judge" | "router">): void {
  upsertModel({ id, roles, source: "catalog", provenance: { repo: "test/repo" }, revision: "rev", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: `/models/${id}.gguf`, engineRequirements: { engine: "llama-server" } });
}

beforeEach(() => {
  __resetEventsForTests();
  clearModelsForTests();
  setMachineTier("p64");
  installModel(standardId, ["chat"]);
  installModel(lightId, ["judge"]);
  setSupervisorFactoryForTests(async (role, modelId) => scriptedProcess(role, { kind: "spawned", modelId: modelId ?? (role === "judge" ? lightId : standardId), identity: { host: "stub", build: "scripted", model: modelId ?? standardId, healthy: true } }));
  setSupervisorTimeoutsForTests({ loadFloorMs: 1, postLoadMs: 50, completionMs: 50 });
});
afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); setSupervisorTimeoutsForTests(null); resetSupervisorForTests(); clearModelsForTests(); });

test("entry waits for active chat and swaps the selected model after the turn", async () => {
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const reply = new Promise<void>((resolve) => { release = resolve; });
  setSupervisorFactoryForTests(async (role, modelId) => {
    const proc = scriptedProcess(role, { kind: "spawned", modelId: modelId ?? standardId, identity: { host: "stub", build: "scripted", model: modelId ?? standardId, healthy: true } });
    const request = proc.client.request!;
    proc.client.request = async (...args) => { if (modelId !== lightId) { started(); await reply; } return request(...args); };
    return proc;
  });
  const turn = requestRole("chat", "/v1/chat/completions", { messages: [] });
  await didStart;
  expect(await enterReducedChat()).toEqual({ ok: false, waiting: true });
  expect(getReducedChatState()).toBe("off");
  release();
  expect((await turn).status).toBe(200);
  expect((await enterReducedChat()).ok).toBe(true);
  expect(selectedModel("chat")?.id).toBe(lightId);
  expect(selectedModel("judge")?.id).toBe(lightId);
  expect(selectedModel("router")?.id).toBe(lightId);
  expect(getReducedChatState()).toBe("reduced");
});

test("leave returns to standard selection and reports state causes", async () => {
  expect((await enterReducedChat()).ok).toBe(true);
  expect((await leaveReducedChat()).ok).toBe(true);
  expect(getReducedChatState()).toBe("off");
  expect(selectedModel("chat")?.id).toBe(standardId);
  const causes = eventsAfter(0).filter((event) => event.id === "role.state").map((event) => (event.data as { cause?: string }).cause).filter(Boolean);
  expect(causes).toContain("mode_change");
  expect(causes).toContain("tier_reduced");
});

test("the public voice allowance remains false", () => {
  expect(reducedVoiceAllowed()).toBe(false);
});

test("a light model that fails to start rolls back to the standard model", async () => {
  setSupervisorFactoryForTests(async (role, modelId) => {
    if (modelId === lightId) throw new Error("the smaller model would not start");
    return scriptedProcess(role, { kind: "spawned", modelId: modelId ?? standardId, identity: { host: "stub", build: "scripted", model: modelId ?? standardId, healthy: true } });
  });
  const result = await enterReducedChat();
  expect(result).toEqual({ ok: false, reason: "Chat could not switch to the smaller model, so it stayed on the standard one." });
  expect(getReducedChatState()).toBe("off");
  expect(selectedModel("chat")?.id).toBe(standardId);
  expect((await requestRole("chat", "/v1/chat/completions", { messages: [] })).status).toBe(200);
});

test("the smaller model missing refuses in plain words and changes nothing", async () => {
  clearModelsForTests();
  installModel(standardId, ["chat"]);
  const result = await enterReducedChat();
  expect(result).toEqual({ ok: false, reason: "The smaller chat model is not installed and selectable." });
  expect(getReducedChatState()).toBe("off");
});
