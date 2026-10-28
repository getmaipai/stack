// CODE-STACK-01 S2: the coding engine is its own llama-server process,
// started by the first coding request, held by a lease while a request
// runs, unloaded after its own keep-warm minutes, and admitted by the
// governor as a `jit` item that yields to a generator job and never
// evicts a resident. Every test uses the scripted engine; no model runs.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { codingServerArgs, llamaServerArgs } from "@/lib/engineArgs";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorDecisions, getGovernorStatus, startGovernor, type GovernorHandle } from "@/lib/governor";
import { scriptedMemoryReader } from "@/lib/memory/scripted";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { runCheck } from "@/lib/readiness";
import { resolveRoleState } from "@/lib/router";
import { codingCannotFitReason, codingContextFor, codingEngineStatus, codingKeepWarmSeconds, codingLaunchSettings, codingMemoryMessage, EngineDoesNotFitError, getProcess, getRoleStatus, requestRole, resetSupervisorForTests, scriptedProcess, setMachineTier, setSupervisorFactoryForTests, SPAWNABLE_ROLES, unloadIdleRole, unloadIdleRoles, unloadJitForGovernor } from "@/lib/supervisor";
import { __resetWarmupForTests, warmedRoles, warmUp } from "@/lib/warmup";
import { __resetSettingsForTests, updateSettings } from "@/settings";
import type { RoleId } from "@/roles";

const GB = 1_073_741_824;
const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "Apache-2.0", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened/coding.gguf", sizeBytes: 16 * GB };

let started: RoleId[] = [];
beforeEach(() => {
  started = [];
  __resetEventsForTests(); __resetHealthForTests(); __resetGovernorForTests(); __resetSettingsForTests(); __resetWarmupForTests(); clearModelsForTests();
  setMachineTier("p128");
  upsertModel({ id: "qwen3.8-27b-ud-q4-k-m", roles: ["coding"], ...verified });
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified, sizeBytes: 1_000_000 });
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role); });
});
afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); resetSupervisorForTests(); __resetWarmupForTests(); clearModelsForTests(); __resetGovernorForTests(); __resetSettingsForTests(); });

// ---- the launch ---------------------------------------------------------------

test("the coding launch is exactly this argument list (flags checked against llama-server b10797 --help)", () => {
  expect(codingServerArgs({ modelPath: "/m/q.gguf", port: 8801, contextLength: 131_072, slots: 2, thinkingBudgetTokens: 2000, alias: "qwen3.8-27b-ud-q4-k-m" })).toEqual([
    "--model", "/m/q.gguf",
    "--alias", "qwen3.8-27b-ud-q4-k-m",
    "--port", "8801",
    "--host", "127.0.0.1",
    "-c", "131072",
    "-fa", "on",
    "-ngl", "all",
    "--reasoning", "on",
    "--reasoning-budget", "2000",
    "-ub", "1024",
    "--no-webui",
    "--metrics",
    "--jinja",
    "--parallel", "2",
    "--kv-unified",
    "-ctk", "q8_0", "-ctv", "q8_0",
    "--offline",
  ]);
});

test("the coding launch keeps thinking on under a budget, q8_0 on every platform, loopback only and offline", () => {
  const args = codingServerArgs({ modelPath: "/m/q.gguf", port: 1, contextLength: 32_768, slots: 1, thinkingBudgetTokens: 0, alias: "qwen3.8-27b-ud-q4-k-m" });
  expect(args).not.toContain("off");
  expect(args.slice(args.indexOf("--reasoning"), args.indexOf("--reasoning") + 4)).toEqual(["--reasoning", "on", "--reasoning-budget", "0"]);
  expect(args.slice(args.indexOf("--host"), args.indexOf("--host") + 2)).toEqual(["--host", "127.0.0.1"]);
  expect(args).toContain("--offline");
  expect(args.join(" ")).toContain("-ctk q8_0 -ctv q8_0");
  // The chat launch's cache-reuse is not asked for: its KV shifting is unmeasured on this model.
  expect(args).not.toContain("--cache-reuse");
});

test("the chat launch is unchanged by the coding launch: reasoning off, no budget, no offline flag", () => {
  const args = llamaServerArgs({ modelPath: "/m/chat.gguf", port: 8800, config: { slots: 1, threads: 0, cacheRamMb: 0, flashAttention: true }, contextLength: 4096, kvCacheType: "q8_0" });
  expect(args).toEqual(["--model", "/m/chat.gguf", "--port", "8800", "--host", "127.0.0.1", "-c", "4096", "-fa", "on", "-ngl", "all", "--reasoning", "off", "-ub", "1024", "--no-webui", "--metrics", "--jinja", "--cache-reuse", "256", "--parallel", "1", "--cache-ram", "1024", "--checkpoint-min-step", "0", "--ctx-checkpoints", "8", "-ctk", "q8_0", "-ctv", "q8_0"]);
});

test("slots follow the tier unless the setting names a number; the budget and window come from the settings", () => {
  expect(codingLaunchSettings()).toEqual({ slots: 2, thinkingBudgetTokens: 2000, keepWarmMinutes: 15, contextLength: 131_072 });
  setMachineTier("p64");
  expect(codingLaunchSettings().slots).toBe(1);
  expect(codingLaunchSettings({ "stack.engines.coding.slots": 3, "stack.engines.coding.thinking_budget_ceiling": 500, "stack.engines.coding.context_length": 65_536 })).toMatchObject({ slots: 3, thinkingBudgetTokens: 500, contextLength: 65_536 });
});

test("the coding settings are declared once, with the Stack's defaults, and read through the settings route", async () => {
  const body = await (await app.request("/stack/v1/settings")).json() as { sections: Array<{ id: string }>; settings: Array<{ key: string; in_effect: unknown; level: string; needs_restart: boolean; section: { id: string } }> };
  expect(body.sections.some((section) => section.id === "engines.coding")).toBe(true);
  const row = (key: string) => body.settings.find((setting) => setting.key === key)!;
  expect(row("stack.engines.coding.keep_warm_minutes")).toMatchObject({ in_effect: 15, level: "advanced", needs_restart: false, section: { id: "engines.coding" } });
  expect(row("stack.engines.coding.thinking_budget_ceiling")).toMatchObject({ in_effect: 2000, level: "advanced" });
  expect(row("stack.engines.coding.slots")).toMatchObject({ in_effect: 0 });
});

test("coding is a role the supervisor can start", () => {
  expect(SPAWNABLE_ROLES).toContain("coding");
});

// ---- on demand, the lease, the keep-warm unload -------------------------------

test("coding starts on the first request and not before; a second request reuses it", async () => {
  expect(started).toEqual([]);
  expect(resolveRoleState("coding").state).toBe("installed");
  expect(started).toEqual([]);
  const first = await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "hi" }] });
  expect(first.status).toBe(200);
  expect(started).toEqual(["coding"]);
  const second = await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [{ role: "user", content: "again" }] });
  expect(second.status).toBe(200);
  expect(started).toEqual(["coding"]);
  expect(getRoleStatus("coding").state).toBe("ready");
  // It is its own process: chat was never started for it.
  expect(started).not.toContain("chat");
});

test("keep-warm: unloaded exactly after the setting's minutes without a request, not before, and a request after restarts it", async () => {
  await getProcess("coding");
  await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [] });
  const last = Date.now();
  const minutes = { onBattery: false, idleMinutes: 30, batteryIdleMinutes: 10, roleIdleMinutes: { coding: 15 } };
  // 30 minutes is the runtime-wide limit; coding uses its own 15.
  expect(await unloadIdleRole("coding", { ...minutes, now: new Date(last + 15 * 60_000 - 2_000) })).toBe(false);
  expect(getRoleStatus("coding").state).toBe("ready");
  expect(await unloadIdleRole("coding", { ...minutes, now: new Date(last + 15 * 60_000 + 2_000) })).toBe(true);
  expect(getRoleStatus("coding").state).toBe("installed");
  // A request after the unload cold-starts it again.
  await requestRole("coding", "/v1/chat/completions", { model: "coding", messages: [] });
  expect(started).toEqual(["coding", "coding"]);
});

test("keep-warm longer than the runtime-wide limit is honoured: coding is not unloaded at 30 minutes when the setting says 60", async () => {
  // A resident start unloads a loaded jit role first (rule 4), so chat starts before coding.
  await getProcess("chat");
  await getProcess("coding");
  const last = Date.now();
  const options = { onBattery: false, idleMinutes: 30, batteryIdleMinutes: 10, roleIdleMinutes: { coding: 60 }, now: new Date(last + 45 * 60_000) };
  expect((await unloadIdleRoles(options)).sort()).toEqual(["chat"]);
  expect(getRoleStatus("coding").state).toBe("ready");
  // On battery the coding limit is still its own, not the 10-minute battery limit.
  expect(await unloadIdleRole("coding", { ...options, onBattery: true, now: new Date(last + 30 * 60_000) })).toBe(false);
});

test("a request in flight is a lease: it is never unloaded by the idle tick or by the governor, and its end restarts the clock", async () => {
  const process = await getProcess("coding");
  process.activeRequests++;
  const options = { onBattery: false, idleMinutes: 30, batteryIdleMinutes: 10, roleIdleMinutes: { coding: 15 }, now: new Date(Date.now() + 5 * 3_600_000) };
  expect(await unloadIdleRole("coding", options)).toBe(false);
  expect(await unloadJitForGovernor("coding")).toBe(false);
  expect(getRoleStatus("coding").state).not.toBe("installed");
  expect(codingEngineStatus()).toMatchObject({ state: "busy", slots_busy: 1, idle_seconds: null });
  process.activeRequests--;
  expect(codingEngineStatus()).toMatchObject({ state: "ready", slots_busy: 0 });
  expect(await unloadJitForGovernor("coding")).toBe(true);
  expect(getRoleStatus("coding").state).toBe("installed");
});

test("the keep-warm arithmetic: the governor holds the setting in seconds and evicts at exactly that limit", async () => {
  expect(codingKeepWarmSeconds()).toBe(900);
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  await admit({ id: "coding", kind: "jit", requestedBytes: 20 * GB, measuredPeakBytes: 20 * GB, yieldsToGenerators: true });
  const item = getGovernorStatus().loaded.find((entry) => entry.id === "coding")!;
  // Not the governor-wide 600 s.
  expect(item.idleTtlSeconds).toBe(900);
  const reader = scriptedMemoryReader([{ totalBytes: 128 * GB, freeBytes: 100 * GB, availablePercent: 78, pressure: "normal", degraded: false }]);
  const last = new Date(item.lastUsedAt).getTime();
  const asked: string[] = [];
  const run = async (now: number) => {
    const stop = startGovernor({ pid: -1, pollMs: 1000, now: () => now, memoryReader: reader, unload: async (id) => { asked.push(id); return false; } });
    await new Promise((resolve) => setTimeout(resolve, 15));
    stop();
  };
  await run(last + 899_000);
  expect(asked).toEqual([]);
  await run(last + 900_000);
  expect(asked).toEqual(["coding"]);
});

test("changing the keep-warm setting moves the limit of the loaded engine at once", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
  await admit({ id: "coding", kind: "jit", requestedBytes: 20 * GB, measuredPeakBytes: 20 * GB });
  updateSettings({ "stack.engines.coding.keep_warm_minutes": 5 });
  expect(getGovernorStatus().loaded.find((entry) => entry.id === "coding")!.idleTtlSeconds).toBe(300);
  expect(() => updateSettings({ "stack.engines.coding.keep_warm_minutes": 0 })).toThrow();
});

// ---- the governor: yielding, waiting, residents --------------------------------

/** A 48 GB machine on the p16 margin: chat (8 GB) and an idle coding engine (20 GB) are loaded, and a 15 GB generator job waits. Memory reads 10 GB free until the coding engine is gone, then 30 GB. */
async function crowdedMachine() {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 48 * GB, freeMemoryBytes: 40 * GB, tier: "p16" });
  expect("id" in await admit({ id: "chat", kind: "resident", requestedBytes: 8 * GB, measuredPeakBytes: 8 * GB })).toBe(true);
  expect("id" in await admit({ id: "coding", kind: "jit", requestedBytes: 20 * GB, measuredPeakBytes: 20 * GB, yieldsToGenerators: true })).toBe(true);
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 10 * GB });
  let codingGone = false;
  const reader = { read: () => ({ totalBytes: 48 * GB, freeBytes: (codingGone ? 30 : 10) * GB, availablePercent: 20, pressure: "normal" as const, degraded: false }), processMemoryBytes: () => null };
  const job = await admit({ id: "image-job", kind: "generator", requestedBytes: 15 * GB, measuredPeakBytes: 15 * GB });
  expect(job).toMatchObject({ queued: true });
  return { reader, job: job as { queued: true; admitted: Promise<GovernorHandle | { refused: true; reason: string }> }, gone: () => { codingGone = true; } };
}

test("an idle coding engine is evicted to admit a generator job, and chat is never touched", async () => {
  await getProcess("chat");
  await getProcess("coding");
  const { reader, job, gone } = await crowdedMachine();
  const asked: string[] = [];
  const stop = startGovernor({ pid: -1, pollMs: 2, memoryReader: reader, unload: async (id) => { asked.push(id); const done = await unloadJitForGovernor(id); if (done) gone(); return done; } });
  try {
    const admitted = await Promise.race([job.admitted, new Promise((resolve) => setTimeout(() => resolve("timed out"), 1500))]);
    expect(admitted).toMatchObject({ id: "image-job", kind: "generator" });
  } finally { stop(); }
  expect(asked).toEqual(["coding"]);
  expect(getRoleStatus("coding").state).toBe("installed");
  expect(getRoleStatus("chat").state).toBe("ready");
  expect(getGovernorStatus().loaded.map((entry) => entry.id).sort()).toEqual(["chat", "image-job"]);
});

test("a busy coding engine makes the generator job wait, and the job goes in once the request ends", async () => {
  const codingProcess = await getProcess("coding");
  codingProcess.activeRequests++;
  const { reader, job, gone } = await crowdedMachine();
  const stop = startGovernor({ pid: -1, pollMs: 2, memoryReader: reader, unload: async (id) => { const done = await unloadJitForGovernor(id); if (done) gone(); return done; } });
  try {
    const early = await Promise.race([job.admitted, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 150))]);
    expect(early).toBe("still waiting");
    expect(getRoleStatus("coding").state).not.toBe("installed");
    expect(getGovernorStatus().queue.map((entry) => entry.id)).toEqual(["image-job"]);
    codingProcess.activeRequests--;
    const admitted = await Promise.race([job.admitted, new Promise((resolve) => setTimeout(() => resolve("timed out"), 1500))]);
    expect(admitted).toMatchObject({ id: "image-job" });
    expect(getRoleStatus("coding").state).toBe("installed");
  } finally { stop(); }
});

test("a generator job that coding's memory would not help is not made to evict it, and residents are never asked to go", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 48 * GB, freeMemoryBytes: 40 * GB, tier: "p16" });
  await admit({ id: "chat", kind: "resident", requestedBytes: 30 * GB, measuredPeakBytes: 30 * GB });
  await admit({ id: "coding", kind: "jit", requestedBytes: 5 * GB, measuredPeakBytes: 5 * GB, yieldsToGenerators: true });
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 10 * GB });
  // 40 GB for the job cannot fit even with coding gone (chat holds 30 of the 40 GB budget).
  const job = await admit({ id: "video-job", kind: "generator", requestedBytes: 40 * GB, measuredPeakBytes: 40 * GB });
  expect(job).toMatchObject({ refused: true, reason: expect.stringContaining("This request needs about 40.0 GB of memory") });
  const asked: string[] = [];
  const reader = { read: () => ({ totalBytes: 48 * GB, freeBytes: 10 * GB, availablePercent: 20, pressure: "normal" as const, degraded: false }), processMemoryBytes: () => null };
  const stop = startGovernor({ pid: -1, pollMs: 2, memoryReader: reader, unload: async (id) => { asked.push(id); return false; } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  stop();
  expect(asked).toEqual([]);
  expect(getGovernorStatus().loaded.map((entry) => entry.id).sort()).toEqual(["chat", "coding"]);
});

test("coding admission never evicts a resident: with no room it is queued and chat stays", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 48 * GB, freeMemoryBytes: 20 * GB, tier: "p16" });
  await admit({ id: "chat", kind: "resident", requestedBytes: 8 * GB, measuredPeakBytes: 8 * GB });
  await admit({ id: "embed", kind: "resident", requestedBytes: 2 * GB, measuredPeakBytes: 2 * GB });
  __setGovernorTuningForTestsOnly({ freeMemoryBytes: 14 * GB });
  const answer = await admit({ id: "coding", kind: "jit", requestedBytes: 20 * GB, measuredPeakBytes: 20 * GB, yieldsToGenerators: true });
  expect(answer).toMatchObject({ queued: true });
  expect(getGovernorStatus().loaded.map((entry) => entry.id).sort()).toEqual(["chat", "embed"]);
  expect(getGovernorDecisions().some((decision) => decision.decision === "Unloaded")).toBe(false);
});

// ---- refusal, status, readiness -------------------------------------------------

test("a coding start the governor cannot admit says what went wrong and what to do, and leaves chat loaded", async () => {
  const message = codingMemoryMessage({ peakBytes: 24.3 * GB, freeBytes: 18.1 * GB, budgetBytes: 100 * GB, marginBytes: 20 * GB });
  setSupervisorFactoryForTests(async (role) => { started.push(role); if (role === "coding") throw new EngineDoesNotFitError(message); return scriptedProcess(role); });
  const chat = await getProcess("chat");
  expect(message).toBe("The coding model needs about 24.3 GB to load, and this computer has 18.1 GB free after keeping 20.0 GB back. Chat and the other always-on models stay loaded. Wait for the picture, video or song job to finish, or close a large app, then send the request again.");
  expect(message).not.toContain("—");
  await expect(getProcess("coding")).rejects.toThrow(/Chat and the other always-on models stay loaded/);
  // The engine is not broken: it is installed, with the reason on the role.
  expect(getRoleStatus("coding").state).toBe("installed");
  expect(resolveRoleState("coding")).toMatchObject({ state: "installed", reason: message });
  expect(codingCannotFitReason()).toBe(message);
  expect(codingEngineStatus()).toMatchObject({ state: "installed", cannot_fit_reason: message });
  expect(await getProcess("chat")).toBe(chat);
  expect(getRoleStatus("chat").state).toBe("ready");
});

test("a model larger than the model budget is reported on the role before any request, and a refused start is not retried by self-heal", async () => {
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 24 * GB, freeMemoryBytes: 20 * GB });
  expect(codingCannotFitReason()).toContain("Memory for models");
  expect(resolveRoleState("coding").state).toBe("installed");
  const { offlineRolesWithoutProcess } = await import("@/lib/supervisor");
  expect(offlineRolesWithoutProcess()).not.toContain("coding");
});

test("the role list reports coding honestly and never starts it; the readiness check never starts it either", async () => {
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string }; coding?: { state: string; keep_warm_minutes: number; idle_seconds: number | null; slots: number | null; slots_busy: number; cannot_fit_reason: string | null; engine: string; engine_requested: string; engine_reason: string | null } }> };
  const coding = body.roles.find((role) => role.id === "coding")!;
  expect(coding.state.state).toBe("installed");
  // The engine fields (S5a): llama-server here, because no hardware facts were given and Splash is not installed; nothing is amiss, so no reason.
  expect(coding.coding).toEqual({ state: "installed", keep_warm_minutes: 15, idle_seconds: null, slots: 2, slots_busy: 0, cannot_fit_reason: null, engine: "llama-server", engine_requested: "auto", engine_reason: null });
  expect(body.roles.filter((role) => role.id !== "coding").every((role) => role.coding === undefined)).toBe(true);
  const run = await runCheck();
  expect(started.includes("coding")).toBe(false);
  expect(run.results.some((result) => result.role === "coding")).toBe(false);
  const explicit = await runCheck({ roleIds: ["coding"] });
  expect(explicit.results).toEqual([expect.objectContaining({ role: "coding", skipped: true })]);
  expect(started.includes("coding")).toBe(false);
});

test("not installed: no model on disk reports notInstalled", async () => {
  clearModelsForTests();
  expect(codingEngineStatus().state).toBe("notInstalled");
  expect(resolveRoleState("coding").state).toBe("notInstalled");
});

test("while it starts the status says loading, then ready with its idle seconds", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setSupervisorFactoryForTests(async (role) => { started.push(role); await gate; return scriptedProcess(role); });
  const pending = getProcess("coding");
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(codingEngineStatus().state).toBe("loading");
  expect(resolveRoleState("coding").state).toBe("loaded");
  release();
  await pending;
  const status = codingEngineStatus();
  expect(status.state).toBe("ready");
  expect(status.idle_seconds).toBeGreaterThanOrEqual(0);
});

test("a warm-up never warms coding, and warmedRoles() excludes it", async () => {
  await warmUp("test");
  expect(started).toEqual(["chat"]);
  expect(warmedRoles()).not.toContain("coding");
});

// ---- CODE-STACK-01 S3b: four smaller real-run fixes ---------------------------------

test("the role list fills the coding row's context fields from the running engine: one shared window, slots from the setting", async () => {
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role, role === "coding" ? { contextLength: 131_072, slots: 2, contextScope: "total across slots" } : {}); });
  const before = await (await app.request("/stack/v1/roles")).json() as { roles: Array<Record<string, unknown>> };
  const unloaded = before.roles.find((role) => role.id === "coding")!;
  expect(unloaded).toMatchObject({ context_length: null, context_per_slot: null, context_total: null, slots: null, context_scope: null });
  await getProcess("coding");
  const body = await (await app.request("/stack/v1/roles")).json() as { roles: Array<Record<string, unknown>> };
  expect(body.roles.find((role) => role.id === "coding")).toMatchObject({ context_length: 131_072, context_per_slot: 131_072, context_total: 131_072, slots: 2, context_scope: "total across slots" });
  // Chat's row keeps its own rule (per slot times slots) and the other roles carry no context fields.
  expect(body.roles.find((role) => role.id === "embed")!.context_length).toBeUndefined();
});

test("the dry run sizes a model file with no .gguf extension, because the pin's path decides, not its name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-fit-ext-"));
  const previous = process.env.STACK_FIT_BINARY;
  try {
    const calls = join(dir, "calls.txt");
    const binary = join(dir, "fit");
    writeFileSync(binary, `#!/bin/sh\necho "$@" >> ${calls}\nprintf 'MTL0 14674 4501 748\\nHost 682 0 296\\n'\n`); chmodSync(binary, 0o755);
    process.env.STACK_FIT_BINARY = binary;
    __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 100 * GB, tier: "p128" });
    const named = await codingContextFor({ ...verified, id: "a", roles: ["coding"], modelPath: "/store/blobs/9f3c2a" } as never, 131_072);
    expect(named.dryRunPeakBytes).toBe((14674 + 4501 + 748 + 682 + 296) * 1_048_576);
    expect(named.contextLength).toBe(131_072);
    const ran = await Bun.file(calls).text();
    expect(ran).toContain("--model /store/blobs/9f3c2a --ctx-size 131072");
  } finally {
    if (previous === undefined) delete process.env.STACK_FIT_BINARY; else process.env.STACK_FIT_BINARY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
