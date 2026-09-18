import { z } from "zod";

export const EventLevelSchema = z.enum(["immediate", "time_sensitive", "passive"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;
export const EventIdSchema = z.enum(["role.state", "engine.state", "pressure", "job.progress", "job.done", "model.installed", "update.available", "update.applied", "update.failed", "repair", "health.changed", "detected.changed"]);
export type EventId = z.infer<typeof EventIdSchema>;

export const EVENTS = {
  "role.state": { id: "role.state", level: "passive", audience: "operator", template: "{role} is {state}." },
  "engine.state": { id: "engine.state", level: "time_sensitive", audience: "operator", template: "The {engine} engine is {state}.", actions: ["restart_engine"] },
  pressure: { id: "pressure", level: "immediate", audience: "operator", template: "Memory pressure needs attention.", actions: ["free_memory"] },
  "job.progress": { id: "job.progress", level: "time_sensitive", audience: "operator", template: "Job {job} is {percent}% complete." },
  "job.done": { id: "job.done", level: "time_sensitive", audience: "operator", template: "Job {job} finished." },
  "model.installed": { id: "model.installed", level: "passive", audience: "operator", template: "Model {model} is installed." },
  "update.available": { id: "update.available", level: "passive", audience: "operator", template: "An update is available." },
  "update.applied": { id: "update.applied", level: "passive", audience: "operator", template: "An update was applied." },
  "update.failed": { id: "update.failed", level: "immediate", audience: "operator", template: "An update failed." },
  repair: { id: "repair", level: "passive", audience: "operator", template: "Repair needed: {title}.", actions: ["restart_engine", "reinstall_engine", "free_memory", "check_host"] },
  "health.changed": { id: "health.changed", level: "passive", audience: "operator", template: "Health item {code} changed." },
  "detected.changed": { id: "detected.changed", level: "passive", audience: "operator", template: "Local detection changed." },
} as const;

export const EventEnvelopeSchema = z.object({
  id: EventIdSchema,
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
  seq: z.number().int().positive(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
