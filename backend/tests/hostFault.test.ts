// 2026-10-26: the Mac's Metal compiler stopped answering. Engines must not be
// launched into it, and self-heal must wait for the host instead of burning
// its retries and opening the circuit.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HOST_FAULT_VERDICT, METAL_COMPILER_SENTENCE, classifyCrash } from "@/lib/crashClassifier";
import { metalHostFault, setMetalProbeForTests } from "@/lib/hostProbe";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests, list as listHealth } from "@/lib/health";
import { __resetSelfHealForTests, __setSelfHealForTests, __settledForTests, onEngineCrash, selfHealSummary, type Clock } from "@/lib/selfHeal";
import { resetSupervisorForTests } from "@/lib/supervisor";

let t = 0;
let timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
const clock: Clock = { now: () => t, after(ms, run) { const timer = { at: t + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };

beforeEach(() => { t = 1_000_000; timers = []; __resetEventsForTests(); __resetHealthForTests(); resetSupervisorForTests(); __setSelfHealForTests({ clock }); });
afterEach(() => { __resetSelfHealForTests(); __setSelfHealForTests(null); setMetalProbeForTests(async () => null); });

test("the probe only asks about Metal engines", async () => {
  let asked = 0;
  setMetalProbeForTests(async () => { asked++; return METAL_COMPILER_SENTENCE; });
  expect(await metalHostFault("llama-server")).toBe(METAL_COMPILER_SENTENCE);
  expect(await metalHostFault("comfyui")).toBeNull();
  expect(asked).toBe(1);
});

test("a Metal compiler crash is a host fault, not an engine fault", () => {
  const verdict = classifyCrash({ exitCode: 1, signal: null, stderrTail: ["ggml_metal_library_compile_all: Unable to reach MTLCompilerService"] });
  expect(verdict).toBe(HOST_FAULT_VERDICT);
});

test("self-heal waits for a host fault without counting failures or opening the circuit", () => {
  for (let i = 0; i < 12; i++) {
    t += 60_000;
    onEngineCrash({ role: "chat", kind: "spawned", engine: "llama-server", modelId: null, exitCode: 1, signal: null, stderrTail: [], ranMs: 0, wasBusy: false, verdict: HOST_FAULT_VERDICT });
  }
  expect(selfHealSummary().stopped).toEqual([]);
  const item = listHealth().find((entry) => entry.code === "engine.crashed.chat");
  expect(item?.text).toContain("graphics compiler is not responding");
  expect(item?.text).toContain("tries again every");
  expect(timers.filter((timer) => !timer.cancelled).length).toBe(1);
});

test("GET /stack/v1/engines/gpu-health reports one compile: ok when it answers, the sentence when it does not", async () => {
  const { app } = await import("@/app");
  setMetalProbeForTests(async () => null);
  expect(await (await app.request("/stack/v1/engines/gpu-health")).json()).toEqual({ ok: true, reason: null });
  setMetalProbeForTests(async () => METAL_COMPILER_SENTENCE);
  expect(await (await app.request("/stack/v1/engines/gpu-health")).json()).toEqual({ ok: false, reason: METAL_COMPILER_SENTENCE });
});
