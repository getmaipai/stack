// The Stack's event catalogue: the ten ids Home's notification bridge
// maps (integrations.md, "The event feed"). Declared once here; the ring
// and the SSE writer are in lib/events.ts.
import { StackEvent, StackEventId } from "@maipai/spec/stack/ts/stack-event.js";

export const EventIdSchema = StackEventId;
export type EventId = StackEventId;
export const EventEnvelopeSchema = StackEvent;
export type EventEnvelope = StackEvent;
