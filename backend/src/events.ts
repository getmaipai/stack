import { z } from "zod";

export const EventLevelSchema = z.enum(["immediate", "time_sensitive", "passive"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;
export const EventIdSchema = z.enum(["role.state", "engine.state", "pressure", "job.progress", "job.done", "model.installed", "update.available", "update.applied", "update.failed", "repair", "health.changed", "detected.changed", "check.progress", "check.done", "run.state", "live", "digest.week"]);
export type EventId = z.infer<typeof EventIdSchema>;

export const EVENTS = {
  "role.state": { id: "role.state", level: "passive", audience: "operator", durable: false, template: "{role} is {state}." },
  "engine.state": { id: "engine.state", level: "time_sensitive", audience: "operator", durable: false, template: "The {engine} engine is {state}." },
  pressure: { id: "pressure", level: "immediate", audience: "operator", durable: false, template: "Memory pressure needs attention.", actions: ["free_memory"] },
  "job.progress": { id: "job.progress", level: "time_sensitive", audience: "operator", durable: false, template: "Download is {percent}% complete." },
  "job.done": { id: "job.done", level: "time_sensitive", audience: "operator", durable: false, template: "Download finished." },
  "model.installed": { id: "model.installed", level: "passive", audience: "operator", durable: true, template: "{model} is installed." },
  "update.available": { id: "update.available", level: "passive", audience: "operator", durable: true, template: "An update is available." },
  "update.applied": { id: "update.applied", level: "passive", audience: "operator", durable: true, template: "The update was applied." },
  "update.failed": { id: "update.failed", level: "immediate", audience: "operator", durable: true, template: "The update failed." },
  repair: { id: "repair", level: "passive", audience: "operator", durable: true, template: "{title}", actions: ["restart_engine", "reinstall_engine", "free_memory", "check_host"] },
  "health.changed": { id: "health.changed", level: "passive", audience: "operator", durable: true, template: "{title} is {severity}." },
  "detected.changed": { id: "detected.changed", level: "passive", audience: "operator", durable: false, template: "Local detection changed." },
  "check.progress": { id: "check.progress", level: "time_sensitive", audience: "operator", durable: false, template: "Check {role} is {state}." },
  "check.done": { id: "check.done", level: "passive", audience: "operator", durable: true, template: "Stack check finished." },
  "run.state": { id: "run.state", level: "passive", audience: "operator", durable: true, template: "Stack is {state}." },
  live: { id: "live", level: "time_sensitive", audience: "operator", durable: false, template: "Live sample taken." },
  "digest.week": { id: "digest.week", level: "passive", audience: "operator", durable: true, template: "{message}" },
} as const;

export const EventEnvelopeSchema = z.object({
  id: EventIdSchema,
  at: z.string(),
  data: z.record(z.string(), z.unknown()),
  seq: z.number().int().positive(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
