// One typed feed. `emit` appends to a bounded ring (replay by sequence
// for a reconnecting subscriber) and fans out to live subscribers; the
// SSE response stays open until the caller goes away. Nothing here is
// persisted: progress is live only, and durable history is Home's.
import { EventEnvelopeSchema, type EventEnvelope, type EventId } from "@/events";

const RING_SIZE = 500;
const KEEPALIVE_MS = 15_000;
const ring: EventEnvelope[] = [];
const subscribers = new Set<(event: EventEnvelope) => void>();
let nextSeq = 1;

export function emit(event: { id: EventId; data: Record<string, unknown> }): EventEnvelope {
  const envelope = EventEnvelopeSchema.parse({ id: event.id, data: event.data, at: new Date().toISOString(), seq: nextSeq++ });
  ring.push(envelope);
  if (ring.length > RING_SIZE) ring.shift();
  for (const subscriber of subscribers) {
    try { subscriber(envelope); } catch { /* a failing subscriber never blocks the producer */ }
  }
  return envelope;
}

export function eventsAfter(lastSeq: number): EventEnvelope[] {
  return ring.filter((event) => event.seq > lastSeq);
}

export function subscribe(listener: (event: EventEnvelope) => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

function frame(event: EventEnvelope): string {
  return `id: ${event.seq}\nevent: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The `/stack/v1/events` body: replay from `Last-Event-Id`, then live
 * events, with a comment line every 15 s so an idle connection is not
 * closed by a proxy or a client timeout. */
export function sseResponse(request: { lastEventId: number; signal?: AbortSignal }): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (text: string) => { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } };
      for (const event of eventsAfter(request.lastEventId)) push(frame(event));
      unsubscribe = subscribe((event) => push(frame(event)));
      keepalive = setInterval(() => push(": keepalive\n\n"), KEEPALIVE_MS);
      (keepalive as unknown as { unref?: () => void }).unref?.();
      const close = () => {
        unsubscribe?.(); unsubscribe = null;
        if (keepalive) clearInterval(keepalive); keepalive = null;
        try { controller.close(); } catch { /* already closed */ }
      };
      if (request.signal?.aborted) close(); else request.signal?.addEventListener("abort", close, { once: true });
    },
    cancel() {
      unsubscribe?.(); unsubscribe = null;
      if (keepalive) clearInterval(keepalive); keepalive = null;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export function __resetEventsForTests(): void {
  ring.length = 0;
  subscribers.clear();
  nextSeq = 1;
}
