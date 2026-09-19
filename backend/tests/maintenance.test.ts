import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, readlinkSync } from "node:fs";
import { MaintenanceScheduler, MAINTENANCE_JOB_KINDS, registeredMaintenanceJobs, withinMaintenanceWindow } from "@/lib/maintenance";
import { check, setUpdatesEnabled } from "@/updates/check";
import { resetEngineUpdateRunnerForTests, setEngineUpdateRunnerForTests, swapEngine } from "@/updates/engines";
import { engineCurrentPath, engineTagRoot } from "@/lib/store/layout";
import { __resetEventsForTests, listNotifications } from "@/lib/events";
import { __resetStackSettingsForTests } from "@/settings/stackKeys";
import { db } from "@/db";
import { usageSamples } from "@/db/schema";
import { recordUsageSample } from "@/lib/series";
import { getChatBackend, resetSupervisorForTests, setSupervisorFactoryForTests, type ChatBackend } from "@/lib/supervisor";

const clock = (hour: number, minute = 0) => ({ now: () => new Date(2026, 8, 18, hour, minute) });
const quiet = { secondsSinceInput: () => 301 };
const normal = { onBattery: () => false };

afterEach(() => { setUpdatesEnabled(false); resetEngineUpdateRunnerForTests(); __resetEventsForTests(); __resetStackSettingsForTests(); resetSupervisorForTests(); setSupervisorFactoryForTests(null); db.delete(usageSamples).run(); rmSync(engineTagRoot("llama-server", "b10797").split(`/llama-server/`)[0] + "/llama-server", { recursive: true, force: true }); });

test("maintenance runs registered jobs in order inside its window and defers outside", async () => {
  const ran: string[] = [];
  const jobs = ["update.check", "engine.update", "smoke.test", "storage.sweep", "benchmark", "library.fetch", "digest"] as const;
  const scheduler = new MaintenanceScheduler({ clock: clock(2, 30), activity: quiet, battery: normal, pressure: () => "normal", settings: () => ({ maintenanceStart: "02:00", maintenanceEnd: "05:00" }), jobs: jobs.map((kind) => ({ kind, run: async () => { ran.push(kind); } })) });
  expect((await scheduler.run()).state).toBe("ran");
  expect(ran).toEqual([...jobs]);
  const outside = new MaintenanceScheduler({ clock: clock(12), activity: quiet, battery: normal, pressure: () => "normal", settings: () => ({ maintenanceStart: "02:00", maintenanceEnd: "05:00" }) });
  const result = await outside.run(); expect(result.state).toBe("deferred"); expect(new Date(result.nextRunAt).getHours()).toBe(2);
});

test("maintenance pauses before a later job when activity arrives, and never starts on battery", async () => {
  let reads = 0; const ran: string[] = [];
  const activity = { secondsSinceInput: () => ++reads < 3 ? 301 : 1 };
  const scheduler = new MaintenanceScheduler({ clock: clock(2), activity, battery: normal, pressure: () => "normal", settings: () => ({}), jobs: (["update.check", "engine.update"] as const).map((kind) => ({ kind, run: async () => { ran.push(kind); } })) });
  expect((await scheduler.run()).state).toBe("paused"); expect(ran).toEqual(["update.check"]);
  const battery = new MaintenanceScheduler({ clock: clock(2), activity: quiet, battery: { onBattery: () => true }, pressure: () => "normal", settings: () => ({}), jobs: [{ kind: "update.check", run: async () => { ran.push("bad"); } }] });
  expect((await battery.run()).reason).toBe("On battery power.");
});

test("maintenance window supports an overnight range", () => {
  expect(withinMaintenanceWindow(new Date(2026, 8, 18, 23), "22:00", "03:00")).toBe(true);
  expect(withinMaintenanceWindow(new Date(2026, 8, 18, 12), "22:00", "03:00")).toBe(false);
});

test("maintenance declares every scheduled kind in its fixed order", () => {
  expect(MAINTENANCE_JOB_KINDS).toEqual(["update.check", "engine.update", "smoke.test", "storage.sweep", "benchmark", "library.fetch", "digest"]);
});

test("the local scheduler warms chat ten minutes before the learned hour", async () => {
  for (const day of [1, 5, 12]) recordUsageSample({ at: new Date(2026, 8, day, 19).toISOString(), ability: "chat", clientId: null, modelId: "chat", requests: 1, tokensIn: 0, tokensOut: 0, jobs: 0 });
  let loads = 0;
  const backend: ChatBackend = { client: { baseUrl: "http://test", complete: async () => ({ status: 200, body: {} }), health: async () => true }, kind: "spawned", identity: { host: "local", build: "test", model: "chat", healthy: true }, pid: null, activeRequests: 0, retired: false, stop: async () => {} };
  setSupervisorFactoryForTests(async () => { loads++; return backend; });
  const scheduler = new MaintenanceScheduler({ clock: clock(18, 50), activity: quiet, battery: normal, pressure: () => "normal", settings: () => ({ chatWarmupEnabled: true, idleUnloadMinutes: 30, idleUnloadOnBatteryMinutes: 10 }) });
  await scheduler.tick();
  expect(loads).toBe(1);
  await getChatBackend(); expect(loads).toBe(1);
});

async function stageAvailableEngine(): Promise<void> {
  setUpdatesEnabled(true);
  await check("engines", async () => new Response(JSON.stringify({ version: "b10820", notes: "engine", pub_date: "2026-09-18", platforms: { default: { url: "https://example.test/engine.tar.gz", sha256: "a".repeat(64), size: 12, signature: "sig" } } })));
  mkdirSync(engineTagRoot("llama-server", "b10797"), { recursive: true });
  await swapEngine("llama-server", "b10797");
}

test("automatic engine update failure rolls back and leaves the exact durable notice", async () => {
  await stageAvailableEngine();
  setEngineUpdateRunnerForTests(async () => { throw new Error("post-swap check failed"); });
  await registeredMaintenanceJobs(() => ({ autoUpdateEngines: true })).find((job) => job.kind === "engine.update")!.run(new AbortController().signal);
  expect(readlinkSync(engineCurrentPath("llama-server"))).toBe("b10797");
  expect((listNotifications() as Array<{ title: string }>).find((item) => item.title.includes("update was undone"))?.title).toBe("The chat engine update was undone: the check failed. You are still on b10797.");
});

test("automatic engine update success notifies, while the switch off runs nothing", async () => {
  await stageAvailableEngine();
  let calls = 0;
  setEngineUpdateRunnerForTests(async (_name, tag) => { calls++; mkdirSync(engineTagRoot("llama-server", tag), { recursive: true }); await swapEngine("llama-server", tag); });
  await registeredMaintenanceJobs(() => ({ autoUpdateEngines: false })).find((job) => job.kind === "engine.update")!.run(new AbortController().signal);
  expect(calls).toBe(0);
  await registeredMaintenanceJobs(() => ({ autoUpdateEngines: true })).find((job) => job.kind === "engine.update")!.run(new AbortController().signal);
  expect(calls).toBe(1);
  expect((listNotifications() as Array<{ title: string }>).find((item) => item.title.includes("moved to build"))?.title).toBe("The chat engine moved to build b10820 overnight.");
});
