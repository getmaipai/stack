import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { health } from "@/db/schema";
import { emit } from "@/lib/events";

export const HEALTH_SEVERITIES = ["critical", "error", "warning"] as const;
export type HealthSeverity = typeof HEALTH_SEVERITIES[number];
export interface HealthFix { label: string; action: string; }
export interface HealthItem { code: string; severity: HealthSeverity; title: string; text: string; since: string; cause: string; fix?: HealthFix; learnMore?: string; }
export type HealthInput = Omit<HealthItem, "since"> & { since?: string };

function parseFix(value: string | null): HealthFix | undefined { try { const parsed = value ? JSON.parse(value) as HealthFix : undefined; return parsed?.label && parsed.action ? parsed : undefined; } catch { return undefined; } }
function toItem(row: typeof health.$inferSelect): HealthItem { const fix = parseFix(row.fix); return { code: row.code, severity: row.severity as HealthSeverity, title: row.title, text: row.text, since: row.since, cause: row.cause, ...(fix ? { fix } : {}), ...(row.learnMore ? { learnMore: row.learnMore } : {}) }; }
function changed(code: string): void { const row = db.select({ code: health.code, severity: health.severity, title: health.title }).from(health).where(eq(health.code, code)).get(); emit({ id: "health.changed", data: { code, title: row?.title ?? code, severity: row?.severity ?? "warning" } }); }

export function raise(item: HealthInput, now = new Date()): HealthItem {
  const existing = db.select().from(health).where(eq(health.code, item.code)).get();
  const values = { code: item.code, severity: item.severity, title: item.title, text: item.text, since: existing?.since ?? item.since ?? now.toISOString(), cause: item.cause, fix: item.fix ? JSON.stringify(item.fix) : null, learnMore: item.learnMore ?? null, resolvedAt: null, ignoredAt: null };
  const didChange = !existing || existing.severity !== values.severity || existing.title !== values.title || existing.text !== values.text || existing.cause !== values.cause || existing.fix !== values.fix || existing.learnMore !== values.learnMore || existing.resolvedAt !== null || existing.ignoredAt !== null;
  if (existing) db.update(health).set(values).where(eq(health.code, item.code)).run(); else db.insert(health).values(values).run();
  if (didChange) changed(item.code); return { ...item, since: values.since };
}
export function resolve(code: string, now = new Date()): boolean { const row = db.select({ code: health.code }).from(health).where(and(eq(health.code, code), isNull(health.resolvedAt), isNull(health.ignoredAt))).get(); if (!row) return false; db.update(health).set({ resolvedAt: now.toISOString() }).where(eq(health.code, code)).run(); changed(code); return true; }
export function ignore(code: string, now = new Date()): boolean { const row = db.select({ code: health.code }).from(health).where(and(eq(health.code, code), isNull(health.resolvedAt), isNull(health.ignoredAt))).get(); if (!row) return false; db.update(health).set({ ignoredAt: now.toISOString() }).where(eq(health.code, code)).run(); changed(code); return true; }
export function list(): HealthItem[] { return db.select().from(health).where(and(isNull(health.resolvedAt), isNull(health.ignoredAt))).orderBy(desc(health.since)).all().map(toItem); }
export function __resetHealthForTests(): void { db.delete(health).run(); }
