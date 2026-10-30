import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { eq } from "drizzle-orm";
import { configureHomeMode, currentHomeMode, homeModeView, HomeModeError, initializeHomeMode, selfTest, switchHomeMode, type HomeModeRuntime } from "@/lib/homeMode";
import { applyHomeModeCodingDefaults, processRoleFor, requestRole, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorDecisions, setCodingModeActive, withdraw } from "@/lib/governor";
import { checkHomeModeOpenAIWire, homeModeStayingResidentBytes } from "@/lib/homeModeRuntime";
import { splashArgs } from "@/lib/engineArgs";

let available = true;
let pin = "splash-a/model-a/draft-a";
let order: string[];
let holdStart: (() => void) | null;
let runtime: HomeModeRuntime;

function fakeRuntime(): HomeModeRuntime {
  return {
    inspect: () => ({ available, reason: available ? null : "This computer cannot hold the large coding model and the voice and search parts together.", checks: { engine: true, pieces: true, hardware: true, memory: available, bench: true }, memory: { plan_bytes: 80, budget_bytes: available ? 100 : 70 } }),
    stopResidents: async () => { order.push("residents-stopped"); },
    startHeavy: async () => { order.push("heavy-started"); if (holdStart) await new Promise<void>((resolve) => { const release = holdStart!; holdStart = () => { release(); resolve(); }; }); },
    stopHeavy: async () => { order.push("heavy-stopped"); },
    startResidents: async () => { order.push("residents-started"); },
    checkHeavy: async () => { order.push("check"); },
    bind: (mode) => { order.push(`bind:${mode}`); },
    transition: () => { order.push("transition"); },
    persistMode: (mode) => { order.push(`persist:${mode}`); },
    pins: () => pin,
  };
}
function setup() {
  order = []; available = true; pin = "splash-a/model-a/draft-a"; holdStart = null;
  db.delete(meta).where(eq(meta.key, "coding.home_mode.self_test")).run();
  db.delete(meta).where(eq(meta.key, "coding.home_mode.failure")).run();
  runtime = fakeRuntime(); configureHomeMode(runtime); initializeHomeMode("normal");
}

beforeEach(setup);
afterEach(() => { db.delete(meta).where(eq(meta.key, "coding.home_mode.self_test")).run(); db.delete(meta).where(eq(meta.key, "coding.home_mode.failure")).run(); setSupervisorFactoryForTests(null); });

test("switches in the required process order and reverses it on return", async () => {
  await switchHomeMode("coding");
  expect(currentHomeMode()).toBe("coding");
  expect(processRoleFor("chat")).toBe("coding");
  expect(processRoleFor("judge")).toBe("coding");
  expect(processRoleFor("router")).toBe("coding");
  expect(order.slice(0, 5)).toEqual(["transition", "residents-stopped", "heavy-started", "check", "bind:coding"]);
  order = [];
  await switchHomeMode("normal");
  expect(currentHomeMode()).toBe("normal");
  expect(processRoleFor("chat")).toBe("chat");
  expect(order.slice(0, 4)).toEqual(["transition", "heavy-stopped", "residents-started", "bind:normal"]);
});

test("a start failure rolls residents back and reports normal mode", async () => {
  runtime.startHeavy = async () => { order.push("heavy-start-failed"); throw new Error("Splash did not start."); };
  await expect(switchHomeMode("coding")).rejects.toMatchObject({ name: "HomeModeError", reason: "Splash did not start." });
  expect(currentHomeMode()).toBe("normal");
  expect(homeModeView()).toMatchObject({ mode: "normal", state: "failed", reason: "Splash did not start." });
  initializeHomeMode("normal");
  expect(homeModeView()).toMatchObject({ state: "failed", reason: "Splash did not start." });
  expect(order.slice(0, 5)).toEqual(["transition", "residents-stopped", "heavy-start-failed", "heavy-stopped", "residents-started"]);
});

test("a failed post-load check stops heavy before it restarts residents", async () => {
  runtime.checkHeavy = async () => { order.push("check-failed"); throw new Error("Tool check failed."); };
  await expect(switchHomeMode("coding")).rejects.toMatchObject({ reason: "Tool check failed." });
  expect(order.slice(0, 7)).toEqual(["transition", "residents-stopped", "heavy-started", "check-failed", "heavy-stopped", "residents-started", "bind:normal"]);
});

test("refuses a concurrent switch and an unavailable mode with its plain reason", async () => {
  holdStart = () => {};
  const first = switchHomeMode("coding");
  await Promise.resolve(); await Promise.resolve();
  await expect(switchHomeMode("normal")).rejects.toBeInstanceOf(HomeModeError);
  holdStart(); await first;
  available = false;
  await switchHomeMode("normal");
  await expect(switchHomeMode("coding")).rejects.toMatchObject({ reason: "This computer cannot hold the large coding model and the voice and search parts together." });
});

test("self-test records pins across configuration and clears when a pin changes", async () => {
  const result = await selfTest();
  expect(result.accepted).toBe(true);
  expect(homeModeView().self_test.passed_at).toBeTruthy();
  configureHomeMode(fakeRuntime());
  expect(homeModeView().self_test.passed_at).toBeTruthy();
  pin = "splash-b/model-a/draft-a";
  expect(homeModeView().self_test).toEqual({ passed_at: null, stale: false });
});

test("GET returns the declared mode status shape", async () => {
  configureHomeMode(fakeRuntime());
  const response = await app.request("/stack/v1/coding/mode");
  expect(response.status).toBe(200);
  const value = await response.json() as Record<string, unknown>;
  expect(Object.keys(value).sort()).toEqual(["available", "checks", "memory", "mode", "reason", "self_test", "state", "target"]);
  expect(value).toEqual({ mode: "normal", target: "normal", state: "stable", reason: null, available: true, checks: { engine: true, pieces: true, hardware: true, memory: true, bench: true }, self_test: { passed_at: null, stale: false }, memory: { plan_bytes: 80, budget_bytes: 100 } });
});

test("coding requests get medium and the configured ceiling while chat requests keep their body", async () => {
  await switchHomeMode("coding");
  expect(applyHomeModeCodingDefaults("coding", { messages: [] })).toMatchObject({ reasoning_effort: "medium", thinking_budget_tokens: 2000 });
  expect(applyHomeModeCodingDefaults("chat", { messages: [], reasoning_effort: "none" })).toEqual({ messages: [], reasoning_effort: "none" });
  const forwarded: Array<Record<string, unknown>> = [];
  setSupervisorFactoryForTests(async (role) => scriptedProcess(role, { modelId: "ornith-1-5-122b-mlx-4bit", client: {
    baseUrl: "scripted://coding",
    request: async (_path, body) => { forwarded.push(body); return { status: 200, body: { choices: [{ message: { content: "ok" } }] } }; },
    health: async () => true,
  } }));
  await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [] });
  await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [], reasoning_effort: "none" });
  expect(forwarded[0]).toMatchObject({ reasoning_effort: "medium", thinking_budget_tokens: 2000 });
  expect(forwarded[1]).toMatchObject({ reasoning_effort: "none" });
  expect(forwarded[1]?.thinking_budget_tokens).toBeUndefined();
});

test("generator work waits in the governor with the coding_mode reason code", async () => {
  __resetGovernorForTests();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * 1_073_741_824, freeMemoryBytes: 24 * 1_073_741_824, tier: "p32" });
  setCodingModeActive(true);
  const result = await admit({ id: "generator-in-coding-mode", kind: "generator", requestedBytes: 1_073_741_824 });
  expect(result).toMatchObject({ queued: true });
  expect(getGovernorDecisions()[0]).toMatchObject({ decision: "Queued", reasonCode: "coding_mode" });
  setCodingModeActive(false);
  withdraw("generator-in-coding-mode");
});

test("the heavy-mode dry run counts only the embed, stt and tts processes that stay loaded", () => {
  expect(homeModeStayingResidentBytes([
    { id: "chat", peakBytes: 20 }, { id: "judge", peakBytes: 30 }, { id: "embed", peakBytes: 3 },
    { id: "stt", peakBytes: 5 }, { id: "tts", peakBytes: 7 },
  ])).toBe(15);
});

test("coding mode's Splash launch carries its default-effort, memory and decode-share caps", () => {
  const args = splashArgs({ model: "owner/model", revision: "a".repeat(40), port: 8777, servedModelName: "heavy", thinkingBudgetTokens: 2000, contextLength: 131072, defaultReasoningEffort: "none", maxMemory: "96G", decodeShare: 1.0 });
  expect(args).toContain("--default-reasoning-effort");
  expect(args[args.indexOf("--default-reasoning-effort") + 1]).toBe("none");
  expect(args.slice(args.indexOf("--max-memory"), args.indexOf("--max-memory") + 2)).toEqual(["--max-memory", "96G"]);
  expect(args.slice(args.indexOf("--decode-share"), args.indexOf("--decode-share") + 2)).toEqual(["--decode-share", "1.0"]);
});

test("the post-load check sends three real OpenAI chat requests and requires text, tool calls and thinking text", async () => {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  let call = 0;
  await checkHomeModeOpenAIWire({ request: async (path, body) => {
    sent.push({ path, body }); call++;
    if (call === 2) return { status: 200, body: { choices: [{ message: { tool_calls: [{ type: "function", function: { name: "home_mode_check", arguments: "{}" } }] } }] } };
    return { status: 200, body: { choices: [{ message: { content: "ready" } }] } };
  } });
  expect(sent).toHaveLength(3);
  expect(sent.every((item) => item.path === "/v1/chat/completions")).toBe(true);
  expect(sent[0]?.body.reasoning_effort).toBe("none");
  expect(sent[1]?.body.tools).toBeDefined();
  expect(sent[2]?.body).toMatchObject({ reasoning_effort: "low", thinking_budget_tokens: 128 });
});

test("coding yields to chat only in normal mode: in coding mode the coding process is the chat process", async () => {
  const { codingYieldsToChat } = await import("@/lib/supervisor");
  const { initializeHomeMode } = await import("@/lib/homeMode");
  initializeHomeMode("normal");
  expect(codingYieldsToChat({})).toBe(true);
  expect(codingYieldsToChat({ "stack.engines.coding.yield_to_chat": false })).toBe(false);
  initializeHomeMode("coding");
  expect(codingYieldsToChat({})).toBe(false);
  initializeHomeMode("normal");
});

test("leaving coding mode, chat resolves to its own model while the residents start", async () => {
  const { selectedModel } = await import("@/lib/supervisor");
  await switchHomeMode("coding");
  let during: string | undefined = "unset"; let processRole = "";
  runtime.startResidents = async () => { during = selectedModel("chat")?.id; processRole = processRoleFor("chat"); };
  await switchHomeMode("normal");
  expect(during).not.toBe("ornith-1-5-122b-mlx-4bit");
  expect(processRole).toBe("chat");
});

test("a heavy start waits out a resident engine that is still starting, then gives up at the limit", async () => {
  const { retryWhileResidentStarts } = await import("@/lib/homeModeRuntime");
  let calls = 0;
  const value = await retryWhileResidentStarts(async () => { calls++; if (calls < 3) throw new Error("The coding engine waits while a resident engine starts."); return "up"; }, 1_000, 1);
  expect(value).toBe("up"); expect(calls).toBe(3);
  await expect(retryWhileResidentStarts(async () => { throw new Error("The coding engine waits while a resident engine starts."); }, 20, 5)).rejects.toThrow("waits while");
  await expect(retryWhileResidentStarts(async () => { throw new Error("out of memory"); }, 1_000, 1)).rejects.toThrow("out of memory");
});

test("switching into coding mode while pictures are being made holds new ones, waits for the running ones, then switches", async () => {
  const { __setWaitTuningForTests, homeModeSwitching } = await import("@/lib/homeMode");
  __setWaitTuningForTests(5, 5_000);
  let busy = true;
  runtime.generating = () => busy;
  const done = switchHomeMode("coding");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(homeModeView().state).toBe("waiting");
  expect(homeModeSwitching()).toBe(false);
  expect(order).toEqual(["transition"]);
  busy = false;
  await done;
  expect(currentHomeMode()).toBe("coding");
  expect(order.slice(0, 3)).toEqual(["transition", "transition", "residents-stopped"]);
});

test("a switch that is waiting for generation can be cancelled by asking for normal", async () => {
  const { __setWaitTuningForTests } = await import("@/lib/homeMode");
  __setWaitTuningForTests(5, 5_000);
  runtime.generating = () => true;
  const done = switchHomeMode("coding");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await switchHomeMode("normal");
  await done;
  expect(currentHomeMode()).toBe("normal");
  expect(homeModeView().state).toBe("stable");
  expect(order).toContain("bind:normal");
  expect(order).not.toContain("residents-stopped");
});

test("a switch that waits too long gives up in plain words and stays in normal mode", async () => {
  const { __setWaitTuningForTests } = await import("@/lib/homeMode");
  __setWaitTuningForTests(5, 40);
  runtime.generating = () => true;
  await expect(switchHomeMode("coding")).rejects.toThrow("still being made");
  expect(currentHomeMode()).toBe("normal");
  expect(homeModeView().state).toBe("failed");
  expect(order).not.toContain("residents-stopped");
  __setWaitTuningForTests(2_000, 30 * 60_000);
});

test("while the large coding mode holds generators, a picture, video or song request is refused up front in plain words", async () => {
  const { registerJobRunner, submitJob, __resetJobsForTests, REFUSED_BY_MODE_TEXT } = await import("@/lib/jobs");
  __resetJobsForTests();
  registerJobRunner("held_test", async () => ({ ok: true }), { generator: { role: "image", memory: () => ({ requestedBytes: 1 }) } });
  setCodingModeActive(true);
  const refused = submitJob({ kind: "held_test", role: "image" });
  expect(refused).toMatchObject({ refused: true, code: "coding_mode", reason: REFUSED_BY_MODE_TEXT });
  expect(REFUSED_BY_MODE_TEXT).not.toMatch(/mode|coding/i);
  setCodingModeActive(false);
  expect("job" in submitJob({ kind: "held_test", role: "image" })).toBe(true);
  __resetJobsForTests();
});
