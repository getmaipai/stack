import { and, desc, eq, isNull, gt } from "drizzle-orm";
import { db } from "@/db";
import { repairs } from "@/db/schema";
import { emit } from "@/lib/events";

export const REPAIR_ACTIONS = ["restart_engine", "reinstall_engine", "free_memory", "check_host"] as const;
export type RepairAction = typeof REPAIR_ACTIONS[number];

export function raiseRepair(title: string, detail: string, action: RepairAction, now = new Date()): string {
  const recent = db.select().from(repairs).where(and(isNull(repairs.resolvedAt), gt(repairs.openedAt, new Date(now.getTime() - 10 * 60_000).toISOString()))).orderBy(desc(repairs.openedAt)).get();
  const level = recent ? "immediate" : "passive";
  const id = recent?.id ?? `repair-${crypto.randomUUID()}`;
  if (recent) db.update(repairs).set({ level, detail, action }).where(eq(repairs.id, id)).run();
  else db.insert(repairs).values({ id, title, detail, action, level, openedAt: now.toISOString(), resolvedAt: null }).run();
  emit({ id: "repair", data: { id, title, detail, action, level } });
  return id;
}

export function resolveRepair(id: string): boolean {
  const row = db.select({ id: repairs.id }).from(repairs).where(and(eq(repairs.id, id), isNull(repairs.resolvedAt))).get();
  if (!row) return false;
  db.update(repairs).set({ resolvedAt: new Date().toISOString() }).where(eq(repairs.id, id)).run();
  return true;
}

export function listRepairs(): unknown[] { return db.select().from(repairs).orderBy(desc(repairs.openedAt)).all(); }

export function __resetRepairsForTests(): void { db.delete(repairs).run(); }
