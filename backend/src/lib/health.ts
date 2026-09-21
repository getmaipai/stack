import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { health } from "@/db/schema";
import { emit } from "@/lib/events";
import { HealthItem as HealthItemSchema, type HealthFixAction } from "@maipai/spec/stack/ts/health-item.js";

export const HEALTH_SEVERITIES = ["critical", "error", "warning"] as const;
export type HealthSeverity = typeof HEALTH_SEVERITIES[number];
export interface HealthFix { label: string; action: HealthFixAction; }
export interface HealthItem { code: string; severity: HealthSeverity; title: string; text: string; since: string; cause: string; fix?: HealthFix; }
export type HealthInput = Omit<HealthItem, "since"> & { since?: string };

function parseFix(value: string | null): HealthFix | undefined { try { const parsed = value ? JSON.parse(value) as HealthFix : undefined; return parsed?.label && parsed.action ? parsed : undefined; } catch { return undefined; } }
function toItem(row: typeof health.$inferSelect): HealthItem { const fix = parseFix(row.fix); return { code: row.code, severity: row.severity as HealthSeverity, title: row.title, text: row.text, since: row.since, cause: row.cause, ...(fix ? { fix } : {}) }; }
function changed(code: string): void { const row = db.select({ code: health.code, severity: health.severity, title: health.title, resolvedAt: health.resolvedAt, ignoredAt: health.ignoredAt }).from(health).where(eq(health.code, code)).get(); emit({ id: "health.changed", data: { code, title: row?.title ?? code, severity: row?.severity ?? "warning", open: !!row && row.resolvedAt === null && row.ignoredAt === null } }); }

// A producer sometimes hands over an engine's own words, which can be
// empty; the spec requires a sentence in each of these, so a blank one
// gets the smallest honest fallback rather than a row that fails to parse.
function sentence(value: string | undefined, fallback: string): string { return value && value.trim() ? value : fallback; }

export function raise(input: HealthInput, now = new Date()): HealthItem {
  const item: HealthInput = { ...input, title: sentence(input.title, input.code), text: sentence(input.text, "The Stack noticed a problem."), cause: sentence(input.cause, "The cause was not reported.") };
  HealthItemSchema.parse({ ...item, since: now.toISOString() });
  const existing = db.select().from(health).where(eq(health.code, item.code)).get();
  const values = { code: item.code, severity: item.severity, title: item.title, text: item.text, since: existing?.since ?? item.since ?? now.toISOString(), cause: item.cause, fix: item.fix ? JSON.stringify(item.fix) : null, resolvedAt: null, ignoredAt: null };
  const didChange = !existing || existing.severity !== values.severity || existing.title !== values.title || existing.text !== values.text || existing.cause !== values.cause || existing.fix !== values.fix || existing.resolvedAt !== null || existing.ignoredAt !== null;
  if (existing) db.update(health).set(values).where(eq(health.code, item.code)).run(); else db.insert(health).values(values).run();
  if (didChange) changed(item.code); return { ...item, since: values.since };
}
export function resolve(code: string, now = new Date()): boolean { const row = db.select({ code: health.code }).from(health).where(and(eq(health.code, code), isNull(health.resolvedAt), isNull(health.ignoredAt))).get(); if (!row) return false; db.update(health).set({ resolvedAt: now.toISOString() }).where(eq(health.code, code)).run(); changed(code); return true; }
export function ignore(code: string, now = new Date()): boolean { const row = db.select({ code: health.code }).from(health).where(and(eq(health.code, code), isNull(health.resolvedAt), isNull(health.ignoredAt))).get(); if (!row) return false; db.update(health).set({ ignoredAt: now.toISOString() }).where(eq(health.code, code)).run(); changed(code); return true; }
export function list(): HealthItem[] { return db.select().from(health).where(and(isNull(health.resolvedAt), isNull(health.ignoredAt))).orderBy(desc(health.since)).all().map(toItem); }
export function __resetHealthForTests(): void { db.delete(health).run(); }
