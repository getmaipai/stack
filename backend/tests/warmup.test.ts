import { afterEach, beforeEach, expect, test } from "bun:test";
import { app } from "@/app";
import { __resetEventsForTests } from "@/lib/events";
import { __resetHealthForTests } from "@/lib/health";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { resetSupervisorForTests, scriptedProcess, setMachineTier, setSupervisorFactoryForTests, setSupervisorTimeoutsForTests, unloadIdleRole } from "@/lib/supervisor";
import { __resetWarmupForTests, planWarmSet, warmUp, warmedRoles, warmupStatus } from "@/lib/warmup";
import type { RoleId } from "@/roles";

const GB = 1_073_741_824;

test("planWarmSet keeps the roles that fit in order and leaves the rest on-demand", () => {
  const plan = planWarmSet([{ role: "chat", bytes: 20 * GB }, { role: "embed", bytes: 1 * GB }, { role: "judge", bytes: 6 * GB }], 28 * GB, 4 * GB);
  expect(plan.warm).toEqual(["chat", "embed"]);
  expect(plan.skipped.map((row) => row.role)).toEqual(["judge"]);
  expect(plan.skipped[0]!.reason).toContain("loads when first used");
});

test("planWarmSet never warms a model that does not fit even alone, and counts what is already resident", () => {
  expect(planWarmSet([{ role: "chat", bytes: 20 * GB }], 16 * GB, 4 * GB).warm).toEqual([]);
  expect(planWarmSet([{ role: "chat", bytes: 10 * GB }], 28 * GB, 4 * GB, 15 * GB).warm).toEqual([]);
});

let started: RoleId[] = [];
beforeEach(() => {
  started = []; __resetEventsForTests(); __resetHealthForTests(); __resetWarmupForTests(); clearModelsForTests();
  setSupervisorFactoryForTests(async (role) => { started.push(role); return scriptedProcess(role); });
});
afterEach(() => { setMachineTier(null); setSupervisorFactoryForTests(null); setSupervisorTimeoutsForTests(null); resetSupervisorForTests(); __resetWarmupForTests(); clearModelsForTests(); });

test("with no model installed a warm-up loads nothing and says ready", async () => {
  const result = await warmUp("test");
  expect(started).toEqual([]);
  expect(result).toMatchObject({ state: "ready", trigger: "test", roles: [] });
});

test("the warm-up route answers 202 and the state route reports it", async () => {
  const post = await app.request("/stack/v1/warmup", { method: "POST" });
  expect(post.status).toBe(202);
  const get = await app.request("/stack/v1/warmup");
  expect(get.status).toBe(200);
  expect(["idle", "warming", "ready"]).toContain(((await get.json()) as { state: string }).state);
});

test("idle unload spares a kept role while plugged in and takes it on battery", async () => {
  const { getProcess } = await import("@/lib/supervisor");
  await getProcess("chat");
  const idle = { now: new Date(Date.now() + 3 * 3_600_000), idleMinutes: 30, batteryIdleMinutes: 10 };
  expect(await unloadIdleRole("chat", { ...idle, onBattery: false, keep: ["chat"] })).toBe(false);
  expect(await unloadIdleRole("chat", { ...idle, onBattery: true, keep: ["chat"] })).toBe(true);
  expect(warmupStatus().state).toBe("idle");
  expect(warmedRoles()).toEqual([]);
});

test("a warm-up loads each installed role in order, primes it, and the idle unload then spares it", async () => {
  const verified = { source: "catalog" as const, provenance: {}, revision: "r", sha256: "a".repeat(64), licence: "MIT", verifiedAt: new Date().toISOString(), modelPath: "/tmp/never-opened.gguf", sizeBytes: 1_000_000 };
  upsertModel({ id: "chat-a", roles: ["chat"], ...verified });
  upsertModel({ id: "embed-a", roles: ["embed"], ...verified });
  const result = await warmUp("test");
  expect(started).toEqual(["chat", "embed"]);
  expect(result.roles.map((row) => [row.role, row.state])).toEqual([["chat", "warm"], ["embed", "warm"]]);
  expect(warmedRoles().sort()).toEqual(["chat", "embed"]);
});
