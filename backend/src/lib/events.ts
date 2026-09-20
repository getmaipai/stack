import { desc, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { EVENTS, EventEnvelopeSchema, type EventEnvelope, type EventId, type EventLevel } from "@/events";

const RING_SIZE = 500;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ring: EventEnvelope[] = [];
let nextSeq = 1;

export function emit(event: { id: EventId; data: Record<string, unknown> }): EventEnvelope {
  const envelope = EventEnvelopeSchema.parse({ id: event.id, data: event.data, at: new Date().toISOString(), seq: nextSeq++ });
  ring.push(envelope);
  if (ring.length > RING_SIZE) ring.shift();
  const definition = EVENTS[event.id];
  // job.progress and role.state are excluded as too frequent to be a
  // "notification" (they fire repeatedly during one download or role
  // change); "live" is the same shape of problem, worse, since it fires
  // every 5s indefinitely from live.ts's sampler rather than during one
  // finite operation, and would otherwise flood this table forever.
  if (definition.id !== "job.progress" && definition.id !== "role.state" && definition.id !== "live") {
    const title = typeof event.data.message === "string" && (event.id === "update.applied" || event.id === "update.failed") ? event.data.message : definition.template.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = event.data[key];
      return value === undefined ? `{${key}}` : String(value);
    });
    db.insert(notifications).values({
      id: `notification-${crypto.randomUUID()}`,
      eventId: envelope.id,
      level: definition.level,
      title,
      data: JSON.stringify(envelope.data),
      at: envelope.at,
      readAt: null,
      dismissedAt: null,
    }).run();
    const severity = typeof event.data.severity === "string" ? event.data.severity : undefined;
    if (definition.level === "immediate" || (event.id === "health.changed" && (severity === "error" || severity === "critical"))) {
      void import("@/lib/channels").then(({ notifyAlertChannels }) => notifyAlertChannels(title));
    }
  }
  return envelope;
}

export function eventsAfter(lastEventId: number): EventEnvelope[] {
  return ring.filter((event) => event.seq > lastEventId);
}

export function listNotifications(durableOnly = false): unknown[] {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  db.delete(notifications).where(lt(notifications.at, cutoff)).run();
  const rows = db.select().from(notifications).where(isNull(notifications.dismissedAt)).orderBy(desc(notifications.at)).all();
  return durableOnly ? rows.filter((row) => EVENTS[row.eventId as EventId]?.durable === true) : rows;
}

// UI-08's activity log: a filtered read of the same durable event log the
// notification bell uses, not a second table. Model installs, engine
// starts/stops, available updates, finished checks, and health items
// raised or cleared, oldest-dismissed-and-read state notwithstanding
// (activity is history, not an actionable inbox, so dismissing or
// reading a notification must not erase it from here).
export const ACTIVITY_EVENT_IDS = new Set<EventId>(["model.installed", "engine.state", "update.available", "check.done", "health.changed"]);
const ACTIVITY_LIMIT = 200;

export function listActivity(): unknown[] {
  const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  db.delete(notifications).where(lt(notifications.at, cutoff)).run();
  return db.select().from(notifications).orderBy(desc(notifications.at)).all()
    .filter((row) => ACTIVITY_EVENT_IDS.has(row.eventId as EventId))
    .slice(0, ACTIVITY_LIMIT);
}

export function markRead(id: string): boolean {
  const row = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return false;
  db.update(notifications).set({ readAt: new Date().toISOString() }).where(eq(notifications.id, id)).run();
  return true;
}

export function dismiss(id: string): boolean {
  const row = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return false;
  db.update(notifications).set({ dismissedAt: new Date().toISOString() }).where(eq(notifications.id, id)).run();
  return true;
}

export function clearAll(): void {
  db.delete(notifications).run();
}

export function __resetEventsForTests(): void {
  ring.length = 0;
  nextSeq = 1;
  db.delete(notifications).run();
}
