// The Stack's event catalogue: the ten ids Home's notification bridge
// maps (integrations.md, "The event feed"). Declared once here; the ring
// and the SSE writer are in lib/events.ts.
import { z } from "zod";

export const EventIdSchema = z.enum([
  "role.state", "engine.state", "pressure", "job.progress", "job.done",
  "model.installed", "update.available", "update.applied", "update.failed", "health.changed",
]);
export type EventId = z.infer<typeof EventIdSchema>;

export const EventEnvelopeSchema = z.object({
  id: EventIdSchema,
  at: z.string(),
  seq: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
