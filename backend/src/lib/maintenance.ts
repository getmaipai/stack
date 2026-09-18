import { execFileSync } from "node:child_process";
import { getActivityReader, hasRecentActivity, type ActivityReader } from "@/lib/activity";
import { getGovernorStatus } from "@/lib/governor";
import { fetchLibrary } from "@/lib/library";
import { residentChatModel, runSpeedTest } from "@/lib/speedTest";
import { pruneUnreferenced } from "@/lib/store/manifests";
import { runCheck } from "@/lib/checkMyStack";
import { stackSettingValues } from "@/settings/stackKeys";
import { check } from "@/updates/check";

export type MaintenanceJobKind = "update.check" | "engine.update" | "smoke.test" | "storage.sweep" | "benchmark" | "library.fetch" | "digest";
export const MAINTENANCE_JOB_KINDS: MaintenanceJobKind[] = ["update.check", "engine.update", "smoke.test", "storage.sweep", "benchmark", "library.fetch", "digest"];
export interface MaintenanceJob { kind: MaintenanceJobKind; run(signal: AbortSignal): Promise<void>; due?: () => boolean; }
export interface Clock { now(): Date; }
export interface BatteryReader { onBattery(): boolean; }
export interface MaintenanceResult { state: "ran" | "deferred" | "paused"; nextRunAt: string; ran: MaintenanceJobKind[]; reason?: string; }
export interface MaintenanceOptions { clock?: Clock; activity?: ActivityReader; battery?: BatteryReader; pressure?: () => "normal" | "warn" | "critical"; settings?: () => Record<string, string | number | boolean>; jobs?: MaintenanceJob[]; }

const systemClock: Clock = { now: () => new Date() };
export function getBatteryReader(): BatteryReader {
  return { onBattery: () => {
    if (process.platform !== "darwin") return false;
    try { return /Now drawing from ['"]Battery Power/.test(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 1_000 })); } catch { return false; }
  } };
}
function minutes(value: string): number { const match = /^(\d{2}):(\d{2})$/.exec(value); return match ? Number(match[1]) * 60 + Number(match[2]) : 120; }
export function withinMaintenanceWindow(now: Date, start: string, end: string): boolean { const at = now.getHours() * 60 + now.getMinutes(); const from = minutes(start); const to = minutes(end); return from === to ? false : from < to ? at >= from && at < to : at >= from || at < to; }
export function nextMaintenanceRun(now: Date, start: string): Date { const next = new Date(now); const at = now.getHours() * 60 + now.getMinutes(); if (at >= minutes(start)) next.setDate(next.getDate() + 1); next.setHours(Math.floor(minutes(start) / 60), minutes(start) % 60, 0, 0); return next; }

// These are the only maintenance jobs. Jobs which require a later feature
// deliberately remain out of the registry until that feature has an owner.
export function registeredMaintenanceJobs(): MaintenanceJob[] {
  return [
    { kind: "update.check", run: async () => { await Promise.all([check("app"), check("engines"), check("models")]); } },
    { kind: "smoke.test", run: async () => { await runCheck(); } },
    { kind: "storage.sweep", run: async () => { pruneUnreferenced(); } },
    { kind: "benchmark", due: () => residentChatModel() !== null, run: async () => { const model = residentChatModel(); if (model) await runSpeedTest(model); } },
    { kind: "library.fetch", run: async () => { await fetchLibrary(); } },
  ];
}

export class MaintenanceScheduler {
  private readonly options: Required<Pick<MaintenanceOptions, "clock" | "activity" | "battery" | "pressure" | "settings">> & Pick<MaintenanceOptions, "jobs">;
  constructor(options: MaintenanceOptions = {}) { this.options = { clock: options.clock ?? systemClock, activity: options.activity ?? getActivityReader(), battery: options.battery ?? getBatteryReader(), pressure: options.pressure ?? (() => getGovernorStatus().pressure), settings: options.settings ?? stackSettingValues, jobs: options.jobs ?? registeredMaintenanceJobs() }; }
  nextRunAt(): string { const values = this.options.settings(); return nextMaintenanceRun(this.options.clock.now(), String(values.maintenanceStart ?? "02:00")).toISOString(); }
  async run(force = false): Promise<MaintenanceResult> {
    const values = this.options.settings(); const now = this.options.clock.now(); const start = String(values.maintenanceStart ?? "02:00"); const end = String(values.maintenanceEnd ?? "05:00"); const nextRunAt = nextMaintenanceRun(now, start).toISOString();
    if (!force && !withinMaintenanceWindow(now, start, end)) return { state: "deferred", nextRunAt, ran: [], reason: "Outside the maintenance window." };
    if (this.options.battery.onBattery()) return { state: "deferred", nextRunAt, ran: [], reason: "On battery power." };
    if (this.options.pressure() !== "normal") return { state: "deferred", nextRunAt, ran: [], reason: "Memory pressure is not normal." };
    if (hasRecentActivity(this.options.activity)) return { state: "deferred", nextRunAt, ran: [], reason: "Someone is using this computer." };
    const ran: MaintenanceJobKind[] = [];
    for (const job of this.options.jobs ?? []) {
      if (job.due && !job.due()) continue;
      if (this.options.battery.onBattery() || this.options.pressure() !== "normal" || hasRecentActivity(this.options.activity)) return { state: "paused", nextRunAt, ran, reason: "Maintenance paused while this computer is in use." };
      const controller = new AbortController();
      const watch = setInterval(() => {
        if (this.options.battery.onBattery() || this.options.pressure() !== "normal" || hasRecentActivity(this.options.activity)) controller.abort();
      }, 1_000);
      try {
        await job.run(controller.signal);
        if (controller.signal.aborted) return { state: "paused", nextRunAt, ran, reason: "Maintenance paused while this computer is in use." };
        ran.push(job.kind);
      } finally { clearInterval(watch); }
    }
    return { state: "ran", nextRunAt, ran };
  }
}

let scheduler = new MaintenanceScheduler();
export function getMaintenanceScheduler(): MaintenanceScheduler { return scheduler; }
export function __setMaintenanceSchedulerForTests(value: MaintenanceScheduler): void { scheduler = value; }

export function startMaintenanceScheduler(intervalMs = 60_000): () => void {
  const timer = setInterval(() => { void scheduler.run().catch(() => {}); }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
