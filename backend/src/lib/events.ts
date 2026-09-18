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
  if (definition.id !== "job.progress" && definition.id !== "role.state") {
    const title = definition.template.replace(/\{(\w+)\}/g, (_match, key: string) => {
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
