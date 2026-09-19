import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { health } from "@/db/schema";
import { list as listHealth, raise, resolve } from "@/lib/health";
import { restartChatEngine, stopChatEngine } from "@/lib/supervisor";

export const REPAIR_ACTIONS = ["restart_engine", "reinstall_engine", "reinstall_model", "free_memory", "check_host"] as const;
export type RepairAction = typeof REPAIR_ACTIONS[number];
function repairCode(title: string): string { return `repair.${title.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}`; }

export function raiseRepair(title: string, detail: string, action: RepairAction, now = new Date()): string {
  const code = repairCode(title);
  const recent = db.select({ since: health.since }).from(health).where(and(eq(health.code, code), isNull(health.resolvedAt), gt(health.since, new Date(now.getTime() - 10 * 60_000).toISOString()))).get();
  raise({ code, severity: recent ? "critical" : "warning", title, text: detail, cause: detail, fix: { label: "Fix", action } }, now);
  return code;
}
export function resolveRepair(id: string): boolean { return resolve(id); }
export async function repairHealth(code: string): Promise<{ ok: boolean; result: string }> {
  const item = listHealth().find((candidate) => candidate.code === code);
  if (!item?.fix) return { ok: false, result: "This health item has no repair action." };
  if (item.fix.action === "restart_engine") { await restartChatEngine(); resolve(code); return { ok: true, result: "The chat engine was restarted." }; }
  if (item.fix.action === "free_memory") { await stopChatEngine(); resolve(code); return { ok: true, result: "The chat engine was stopped to free memory." }; }
  if (item.fix.action === "check_host") return { ok: false, result: "Check this computer's connection, then run the Stack check again." };
  return { ok: false, result: "This repair needs the matching engine or model installer." };
}
export function listRepairs(): unknown[] { return listHealth().filter((item) => item.fix).map((item) => ({ id: item.code, title: item.title, detail: item.text, action: item.fix!.action, level: item.severity === "critical" ? "immediate" : "passive", openedAt: item.since, resolvedAt: null })); }
export function __resetRepairsForTests(): void { db.delete(health).run(); }
