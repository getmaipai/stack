// STACK-STALL-WATCHDOG-01: an engine that is busy but has made no progress (no streamed token, no answer) for its role's limit is restarted
// and the request fails in plain words; a request that keeps progressing is left alone however long it runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests } from "@/lib/modelStore";
import { __setStallTuningForTests, requestRole, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests, streamRole, getProcess, EngineUnavailableError } from "@/lib/supervisor";
import { findStalled, stallLimitMs, beginStallWatch, __resetStallWatchForTests } from "@/lib/stallWatch";

beforeEach(() => { __resetHealthForTests(); clearModelsForTests(); __resetStallWatchForTests(); });
afterEach(() => { __setStallTuningForTests(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); clearModelsForTests(); __resetStallWatchForTests(); });

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the pure rule: stalled only when every watched request is past the limit; a touch resets it", () => {
  const key = {};
  const watch = beginStallWatch(key, 1_000);
  expect(findStalled(1_000 + 99, () => 100)).toEqual([]);
  expect(findStalled(1_000 + 101, () => 100)).toEqual([key]);
  watch.touch(1_150);
  expect(findStalled(1_150 + 99, () => 100)).toEqual([]);
  watch.end();
  expect(findStalled(9_999_999, () => 100)).toEqual([]);
  expect(findStalled(9_999_999, () => null)).toEqual([]);
});

test("every role that answers in one reply has a limit; chat's limit is minutes, never seconds", () => {
  expect(stallLimitMs("embed")).toBeGreaterThan(0);
  expect(stallLimitMs("chat")!).toBeGreaterThanOrEqual(120_000);
  expect(stallLimitMs("image")).toBeNull();
});

test("a streamed chat that sends one token and then goes silent is restarted, and the next request gets a fresh engine", async () => {
  let starts = 0;
  setSupervisorFactoryForTests(async (role) => {
    starts++;
    const scripted = scriptedProcess(role);
    const stream = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(enc.encode("data: {}\n\n")); /* then nothing, ever */ } }), { status: 200 });
    return scriptedProcess(role, { client: { ...scripted.client, stream } });
  });
  __setStallTuningForTests({ limitMs: 150, intervalMs: 20 });
  const first = await getProcess("chat");
  const reply = await streamRole("chat", "/v1/chat/completions", { model: "chat", messages: [{ role: "user", content: "hi" }] });
  const reader = reply.body!.getReader();
  await reader.read();
  const stuck = reader.read().then(() => "ended", () => "errored");
  expect(await Promise.race([stuck, sleep(2_000).then(() => "still waiting")])).toBe("errored");
  const second = await getProcess("chat");
  expect(second).not.toBe(first);
  expect(starts).toBe(2);
});

test("a stream that keeps sending tokens is left alone for far longer than the limit", async () => {
  let starts = 0;
  setSupervisorFactoryForTests(async (role) => {
    starts++;
    const scripted = scriptedProcess(role);
    const stream = async () => new Response(new ReadableStream({
      async start(controller) { for (let i = 0; i < 12; i++) { controller.enqueue(enc.encode(`data: ${i}\n\n`)); await sleep(40); } controller.close(); },
    }), { status: 200 });
    return scriptedProcess(role, { client: { ...scripted.client, stream } });
  });
  __setStallTuningForTests({ limitMs: 150, intervalMs: 20 });
  const reply = await streamRole("chat", "/v1/chat/completions", { model: "chat", messages: [{ role: "user", content: "hi" }] });
  const text = await new Response(reply.body!).text();
  expect(text.split("\n\n").filter(Boolean)).toHaveLength(12);
  expect(starts).toBe(1);
});

test("an embedding request that never answers is restarted and fails with a plain message", async () => {
  setSupervisorFactoryForTests(async (role) => {
    const scripted = scriptedProcess(role);
    return scriptedProcess(role, { client: { ...scripted.client, request: () => new Promise(() => {}) } });
  });
  __setStallTuningForTests({ limitMs: 150, intervalMs: 20 });
  const outcome = await requestRole("embed", "/v1/embeddings", { model: "embed", input: "x" }).then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(EngineUnavailableError);
  expect((outcome as EngineUnavailableError).reason).toMatch(/stopped answering.*restarted/i);
});
