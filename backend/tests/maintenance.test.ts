import { expect, test } from "bun:test";
import { MaintenanceScheduler, MAINTENANCE_JOB_KINDS, withinMaintenanceWindow } from "@/lib/maintenance";

const clock = (hour: number, minute = 0) => ({ now: () => new Date(2026, 8, 18, hour, minute) });
const quiet = { secondsSinceInput: () => 301 };
const normal = { onBattery: () => false };

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
