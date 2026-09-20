// A counter in `meta` that every change to what the Stack runs bumps: a
// model installed or removed, an engine swapped or installed, a setting
// changed or applied. The readiness check records the generation it ran
// at, so a result from before such a change reads as stale rather than
// as a current claim (STACK-87). Imports only the database, so every
// producer can call it without a cycle.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";

const KEY = "stack.generation";
const REASON_KEY = "stack.generation.reason";

export function stackGeneration(): number {
  return Number(db.select({ value: meta.value }).from(meta).where(eq(meta.key, KEY)).get()?.value ?? 0);
}

export function bumpStackGeneration(reason: string): number {
  const next = stackGeneration() + 1;
  db.insert(meta).values({ key: KEY, value: String(next) }).onConflictDoUpdate({ target: meta.key, set: { value: String(next) } }).run();
  db.insert(meta).values({ key: REASON_KEY, value: reason }).onConflictDoUpdate({ target: meta.key, set: { value: reason } }).run();
  return next;
}

export function lastStackChange(): string | null {
  return db.select({ value: meta.value }).from(meta).where(eq(meta.key, REASON_KEY)).get()?.value ?? null;
}

export function __resetStackGenerationForTests(): void {
  db.delete(meta).where(eq(meta.key, KEY)).run();
  db.delete(meta).where(eq(meta.key, REASON_KEY)).run();
}
