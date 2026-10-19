// CODE-STACK-01 S3b: the coding engine yields to chat through the isolation
// gate (ISOLATION-01). While an interactive request that is not coding's own
// is in flight, the coding process is stopped (SIGSTOP in production, a fake
// worker here) and it continues when chat is quiet, for at most 120 s per
// pause (here shortened through the gate's own environment knobs). Hermetic:
// a scripted engine and fake workers; the only real processes are `sleep`
// children in the safety test. No model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests } from "@/lib/governor";
import { codingPauseBoundMs, heavyGate, isolationRules, PausableProcess, setProtectedPidProvider, type PausableWorker } from "@/lib/heavyGate";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { codingEngineStatus, getProcess, requestRole, resetSupervisorForTests, scriptedProcess, setMachineTier, setSupervisorFactoryForTests, setSupervisorTimeoutsForTests, streamRole, unloadIdleRole, unloadJitForGovernor } from "@/lib/supervisor";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import type { RoleId } from "@/roles";

const CODING_MODEL = "qwen3.8-27b-ud-q4-k-m";
const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened/coding.gguf" };
const encoder = new TextEncoder();

/** A worker the gate can stop, recording every stop and continue. */
class FakeWorker implements PausableWorker {
  readonly pid = null;
  paused = false;
  pauses = 0;
  resumes = 0;
  pause(): boolean { if (this.paused) return false; this.paused = true; this.pauses++; return true; }
  resume(): boolean { if (!this.paused) return false; this.paused = false; this.resumes++; return true; }
}

let worker: FakeWorker;
let started: RoleId[] = [];
/** Requests the scripted coding engine holds until `answer()` is called. */
let waiting: Array<() => void> = [];
let hold = true;
let healthSawPaused: boolean[] = [];
let failNext: Error | null = null;
const answerAll = () => { for (const release of waiting.splice(0)) release(); };

function codingEngine(role: RoleId) {
  const base = scriptedProcess(role);
  if (role !== "coding") return base;
  return scriptedProcess(role, {
    modelId: CODING_MODEL,
    pausable: worker,
    client: {
      ...base.client,
      async health() { healthSawPaused.push(worker.paused); return true; },
      async request() {
        if (failNext) { const error = failNext; failNext = null; throw error; }
        if (hold) await new Promise<void>((resolve) => { waiting.push(resolve); });
        return { status: 200, body: { ok: true } };
      },
      async stream(_path, _body, signal) {
        let cancelled: () => void = () => {};
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("data: first\n\n"));
            await new Promise<void>((resolve) => { waiting.push(resolve); cancelled = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); });
            try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); } catch { /* cancelled */ }
          },
          cancel() { cancelled(); },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    },
  });
}

const until = async (condition: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await Bun.sleep(5); } return condition(); };
const chatBody = { model: "coding", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  worker = new FakeWorker(); started = []; waiting = []; hold = true; healthSawPaused = []; failNext = null;
  heavyGate.reset();
  process.env.STACK_ISOLATION_TAIL_MS = "40";
  process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS = "200";
  process.env.STACK_ISOLATION_FORCED_RUN_MS = "120";
  setProtectedPidProvider(() => []);
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); clearModelsForTests();
  setMachineTier("p128");
  upsertModel({ id: CODING_MODEL, roles: ["coding"], ...verified, sizeBytes: 1_000_000 });
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  setSupervisorFactoryForTests(async (role) => { started.push(role); return codingEngine(role); });
});
afterEach(() => {
  answerAll();
  heavyGate.reset();
  for (const key of ["STACK_ISOLATION", "STACK_ISOLATION_TAIL_MS", "STACK_ISOLATION_CODING_MAX_PAUSE_MS", "STACK_ISOLATION_FORCED_RUN_MS"]) delete process.env[key];
  setSupervisorTimeoutsForTests(null);
  setMachineTier(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetGovernorForTests(); __resetSettingsForTests();
});

const startRequest = async () => {
  const pending = requestRole("coding", "/v1/chat/completions", chatBody);
  expect(await until(() => waiting.length > 0)).toBe(true);
  return { pending };
};

test("a Splash coding pause is bounded at 20 s so its liveness probe does not restart the engine; llama-server keeps 120 s", () => {
  delete process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS; delete process.env.STACK_ISOLATION_CODING_SPLASH_MAX_PAUSE_MS;
  expect(codingPauseBoundMs("splash")).toBe(20_000);
  expect(codingPauseBoundMs("llama-server")).toBe(120_000);
  process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS = "5000";
  expect(codingPauseBoundMs("splash")).toBe(5_000);
  delete process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS;
});

test("the defaults: yield to chat on, a pause bounded at 120 s, 60 s of running before the next", () => {
  delete process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS; delete process.env.STACK_ISOLATION_FORCED_RUN_MS;
  expect(isolationRules.codingMaxPauseMs()).toBe(120_000);
  expect(isolationRules.forcedRunMs()).toBe(60_000);
});

test("a chat request stops the coding engine mid-answer, and it continues after chat and the tail; the answer completes normally", async () => {
  const pending = requestRole("coding", "/v1/chat/completions", chatBody);
  expect(await until(() => waiting.length > 0)).toBe(true);
  expect(worker.paused).toBe(false);
  const end = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  await Bun.sleep(100);
  expect(worker.paused).toBe(true); // chat still in flight
  end();
  expect(worker.paused).toBe(true); // inside the tail
  expect(await until(() => !worker.paused)).toBe(true);
  expect(worker.pauses).toBe(1); expect(worker.resumes).toBe(1);
  answerAll();
  expect((await pending).status).toBe(200);
  expect(codingEngineStatus().state).toBe("ready");
});

test("every interactive role but coding's own yields it: chat, vision, router, stt and tts", async () => {
  for (const role of ["chat", "vision", "router", "stt", "tts"]) {
    worker = new FakeWorker();
    heavyGate.reset();
    setSupervisorFactoryForTests(async (r) => { started.push(r); return codingEngine(r); });
    const pending = requestRole("coding", "/v1/chat/completions", chatBody);
    expect(await until(() => waiting.length > 0)).toBe(true);
    const end = heavyGate.begin(role);
    expect(worker.paused).toBe(true);
    end();
    expect(await until(() => !worker.paused)).toBe(true);
    answerAll();
    await pending;
  }
});

test("background roles never stop it: the judge, embeddings and rerank are not interactive", async () => {
  const { pending } = await startRequest();
  for (const role of ["judge", "embed", "rerank"]) heavyGate.begin(role)();
  await Bun.sleep(80);
  expect(worker.pauses).toBe(0);
  answerAll();
  await pending;
});

test("coding is unaffected when no chat runs, and a coding request never stops the coding engine", async () => {
  const { pending } = await startRequest();
  const end = heavyGate.begin("coding"); // what the coding routes do for every coding request
  await Bun.sleep(80);
  expect(worker.pauses).toBe(0);
  end();
  await Bun.sleep(80);
  answerAll();
  expect((await pending).status).toBe(200);
  expect(worker.pauses).toBe(0);
});

test("a coding request does not hold the engine stopped: chat's quiet moment is what counts, even with coding requests in flight", async () => {
  const { pending } = await startRequest();
  const codingRequest = heavyGate.begin("coding");
  const chat = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  chat();
  expect(await until(() => !worker.paused)).toBe(true); // coding's own request is still open
  codingRequest();
  answerAll();
  await pending;
});

test("overlapping chats keep it stopped until the last one ends, and a chat inside the tail does not flap it", async () => {
  process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS = "5000";
  const { pending } = await startRequest();
  const first = heavyGate.begin("chat");
  const second = heavyGate.begin("chat");
  first();
  await Bun.sleep(120);
  expect(worker.paused).toBe(true);
  second();
  await Bun.sleep(15);
  const third = heavyGate.begin("chat");
  await Bun.sleep(100);
  expect(worker.paused).toBe(true);
  expect(worker.pauses).toBe(1);
  third();
  expect(await until(() => !worker.paused)).toBe(true);
  answerAll();
  await pending;
});

test("a coding request that arrives while chat is busy starts stopped and continues at chat's quiet moment (the same rule as a music job)", async () => {
  const chat = heavyGate.begin("chat");
  const pending = requestRole("coding", "/v1/chat/completions", chatBody);
  expect(await until(() => waiting.length > 0)).toBe(true);
  expect(worker.paused).toBe(true);
  chat();
  expect(await until(() => !worker.paused)).toBe(true);
  answerAll();
  expect((await pending).status).toBe(200);
});

test("the pause is bounded: after the maximum it is continued by force, runs for a while, and is stopped again if chat is still busy", async () => {
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  expect(await until(() => !worker.paused, 1000)).toBe(true); // forced resume at 200 ms
  expect(heavyGate.status().forced_resumes).toBe(1);
  await Bun.sleep(60);
  expect(worker.paused).toBe(false); // inside the forced run
  expect(await until(() => worker.paused, 1000)).toBe(true); // chat is still in flight: stopped again
  expect(worker.pauses).toBe(2);
  chat();
  expect(await until(() => !worker.paused)).toBe(true);
  answerAll();
  await pending;
});

test("a long chat burst slows coding and never starves it: over a burst it runs a share of the time", async () => {
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  const startedAt = Date.now();
  let runningMs = 0;
  let last = startedAt;
  while (Date.now() - startedAt < 900) { await Bun.sleep(10); const now = Date.now(); if (!worker.paused) runningMs += now - last; last = now; }
  chat();
  expect(runningMs).toBeGreaterThan(150); // 120 ms of every 320 ms cycle
  expect(runningMs).toBeLessThan(600);
  answerAll();
  await pending;
});

test("with yield_to_chat off the engine is never stopped, and turning it off continues an engine chat has stopped", async () => {
  updateSettings({ "stack.engines.coding.yield_to_chat": false });
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  await Bun.sleep(60);
  expect(worker.pauses).toBe(0);
  chat();
  answerAll();
  await pending;
  // Now on, paused, then off again.
  updateSettings({ "stack.engines.coding.yield_to_chat": true });
  const { pending: second } = await startRequest();
  const busy = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  updateSettings({ "stack.engines.coding.yield_to_chat": false });
  expect(worker.paused).toBe(false);
  busy();
  answerAll();
  await second;
});

test("the setting is declared once: a boolean, on by default, live, in the coding section", async () => {
  const body = await (await app.request("/stack/v1/settings")).json() as { settings: Array<{ key: string; in_effect: unknown; selector: string; level: string; needs_restart: boolean; section: { id: string } }> };
  const row = body.settings.find((setting) => setting.key === "stack.engines.coding.yield_to_chat")!;
  expect(row).toMatchObject({ selector: "boolean", in_effect: true, needs_restart: false, level: "advanced", section: { id: "engines.coding" } });
});

test("paused time is not idle time: a stopped answer is never unloaded, and keep-warm counts from the end of the request", async () => {
  const process_ = await getProcess("coding");
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  const options = { onBattery: false, idleMinutes: 30, batteryIdleMinutes: 10, roleIdleMinutes: { coding: 15 }, now: new Date(Date.now() + 5 * 3_600_000) };
  expect(await unloadIdleRole("coding", options)).toBe(false);
  expect(await unloadJitForGovernor("coding")).toBe(false);
  expect(codingEngineStatus()).toMatchObject({ state: "busy", idle_seconds: null });
  await Bun.sleep(150);
  chat();
  expect(await until(() => !worker.paused)).toBe(true);
  answerAll();
  await pending;
  const endedAt = Date.now();
  // The clock restarted at the end: not unloaded a hair under the limit, unloaded at it.
  expect(await unloadIdleRole("coding", { ...options, now: new Date(endedAt + 15 * 60_000 - 3_000) })).toBe(false);
  expect(process_.activeRequests).toBe(0);
  expect(await unloadIdleRole("coding", { ...options, now: new Date(endedAt + 15 * 60_000 + 3_000) })).toBe(true);
});

test("a paused answer does not time out: the completion limit counts only the time the engine could run", async () => {
  setSupervisorTimeoutsForTests({ completionMs: 150 });
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  await Bun.sleep(100); // stopped
  expect(worker.paused).toBe(true);
  chat();
  // The forced-resume bound (200 ms) is not reached; the pause is ~140 ms with the tail, then the answer arrives.
  await until(() => !worker.paused);
  answerAll();
  expect((await pending).status).toBe(200);
});

test("without a pause the same limit still applies: a coding answer stuck for longer than the limit times out as a 504", async () => {
  setSupervisorTimeoutsForTests({ completionMs: 120 });
  const reply = await requestRole("coding", "/v1/chat/completions", chatBody);
  expect(reply.status).toBe(504);
  expect((reply.body as { error: string }).error).toContain("timed out");
  expect(worker.pauses).toBe(0);
});

test("a long answer stopped for most of its life survives a short limit", async () => {
  setSupervisorTimeoutsForTests({ completionMs: 120 });
  process.env.STACK_ISOLATION_CODING_MAX_PAUSE_MS = "5000";
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  await Bun.sleep(400); // far past the limit, all of it stopped
  expect(worker.paused).toBe(true);
  chat();
  await until(() => !worker.paused);
  answerAll();
  expect((await pending).status).toBe(200);
});

test("two coding requests at once share one lease: the engine continues only when both are done, and one finishing does not continue it", async () => {
  const a = requestRole("coding", "/v1/chat/completions", chatBody);
  const b = requestRole("coding", "/v1/chat/completions", chatBody);
  expect(await until(() => waiting.length === 2)).toBe(true);
  const chat = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  expect(worker.pauses).toBe(1);
  waiting.shift()!();
  await a;
  expect(worker.paused).toBe(true); // the other answer is still waiting
  waiting.shift()!();
  await b;
  expect(worker.paused).toBe(false); // no coding request in flight: nothing to hold stopped
  chat();
});

test("a stream stopped for chat finishes when it continues, and a cancel while stopped continues the engine at once", async () => {
  const reply = await streamRole("coding", "/v1/chat/completions", chatBody);
  const reader = reply.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  const chat = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  await reader.cancel();
  expect(worker.paused).toBe(false);
  expect(codingEngineStatus().slots_busy).toBe(0);
  chat();
  // And a stream that is allowed to finish does.
  const second = await streamRole("coding", "/v1/chat/completions", chatBody);
  const secondReader = second.body!.getReader();
  await secondReader.read();
  const again = heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  again();
  expect(await until(() => !worker.paused)).toBe(true);
  answerAll();
  let text = "";
  for (;;) { const next = await secondReader.read(); if (next.done) break; text += new TextDecoder().decode(next.value); }
  expect(text).toContain("[DONE]");
});

test("an engine error while stopped continues it before the health check, so a stopped engine is never taken for a dead one", async () => {
  hold = false;
  failNext = new Error("connection reset");
  const chat = heavyGate.begin("chat");
  const reply = await requestRole("coding", "/v1/chat/completions", chatBody);
  expect(reply.status).toBe(503);
  expect(healthSawPaused).toEqual([false]);
  expect(codingEngineStatus().state).not.toBe("offline");
  chat();
});

test("chat and the other roles are unchanged: no lease, no stop, the same answers, and an idle coding engine is never stopped", async () => {
  const chatReply = await requestRole("chat", "/v1/chat/completions", { model: "chat", messages: [] });
  expect(chatReply.status).toBe(200);
  await getProcess("coding");
  const end = heavyGate.begin("chat");
  expect(worker.pauses).toBe(0); // loaded but serving nothing: nothing to yield
  expect(heavyGate.status().paused_now).toBe(0);
  end();
});

test("with isolation off (STACK_ISOLATION=off) the engine is never stopped", async () => {
  process.env.STACK_ISOLATION = "off";
  const { pending } = await startRequest();
  const chat = heavyGate.begin("chat");
  await Bun.sleep(60);
  expect(worker.pauses).toBe(0);
  chat();
  answerAll();
  await pending;
});

test("stopping the Stack, or the gate being reset, continues a stopped engine", async () => {
  const { pending } = await startRequest();
  heavyGate.begin("chat");
  expect(worker.paused).toBe(true);
  heavyGate.resumeEverything("shutdown");
  expect(worker.paused).toBe(false);
  answerAll();
  await pending;
});

// ---- safety: only the coding engine's own handle may be an engine ----------------------

test("the gate still never stops an engine the supervisor runs, except through the coding engine's own handle", async () => {
  const child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const stateOf = () => Bun.spawnSync(["ps", "-o", "state=", "-p", String(child.pid)], { stdout: "pipe" }).stdout.toString().trim().slice(0, 1);
  try {
    setProtectedPidProvider(() => [child.pid]);
    const ordinary = new PausableProcess(child.pid, child.exited);
    expect(ordinary.pause()).toBe(false);
    expect(stateOf()).not.toBe("T");
    const engine = new PausableProcess(child.pid, child.exited, { engine: true });
    expect(engine.pause()).toBe(true);
    expect(await until(() => stateOf() === "T")).toBe(true);
    expect(engine.resume()).toBe(true);
    expect(await until(() => stateOf() !== "T")).toBe(true);
    // Never the Stack itself, even as an engine.
    expect(new PausableProcess(process.pid, undefined, { engine: true }).pause()).toBe(false);
  } finally {
    child.kill("SIGCONT"); child.kill("SIGKILL");
  }
});
