// Hand-written Zod mirror of ../schemas/stack-event.schema.json: the ten
// event ids and what each `data` carries.
import { z } from "zod";

export const StackEventId = z.enum(["role.state", "engine.state", "pressure", "job.progress", "job.done", "model.installed", "update.available", "update.applied", "update.failed", "health.changed"]);
export type StackEventId = z.infer<typeof StackEventId>;

const RoleState = z.enum(["notInstalled", "installed", "loaded", "ready", "offline"]);
const dateTime = z.string().datetime({ offset: true });

export const StackEventData = {
  "role.state": z.object({ role: z.string(), state: RoleState, since: dateTime, reason: z.string().optional() }).passthrough(),
  "engine.state": z.object({ engine: z.string(), state: z.enum(["installed", "loading", "ready", "offline", "stopped"]), reason: z.string().optional() }).passthrough(),
  pressure: z.object({ pressure: z.enum(["normal", "warn", "critical"]), free_memory_bytes: z.number().int().min(0).optional(), floor_bytes: z.number().int().min(0).optional(), available_percent: z.number().min(0).max(100).optional(), reason: z.string().optional(), id: z.string().optional() }).passthrough(),
  "job.progress": z.object({ job: z.string(), kind: z.string(), state: z.enum(["queued", "running", "done", "failed", "cancelled"]), percent: z.number().int().min(0).max(100), completed_bytes: z.number().int().min(0), total_bytes: z.number().int().min(0), status: z.string(), position: z.number().int().min(1).nullable().optional() }).passthrough(),
  "job.done": z.object({ job: z.string(), kind: z.string(), ok: z.boolean(), reason: z.string().nullable().optional() }).passthrough(),
  "model.installed": z.object({ model: z.string(), path: z.string().nullable().optional(), removed: z.boolean().optional() }).passthrough(),
  "update.available": z.object({ kind: z.enum(["engine", "model"]), name: z.string(), installed: z.string().nullable().optional(), available: z.string() }).passthrough(),
  "update.applied": z.object({ kind: z.enum(["engine", "model"]), name: z.string(), tag: z.string() }).passthrough(),
  "update.failed": z.object({ kind: z.enum(["engine", "model"]), name: z.string().optional(), reason: z.string() }).passthrough(),
  "health.changed": z.object({ code: z.string(), severity: z.enum(["critical", "error", "warning"]), title: z.string(), open: z.boolean() }).passthrough(),
} as const;

const Envelope = z.object({ id: StackEventId, at: dateTime, seq: z.number().int().min(1), data: z.record(z.string(), z.unknown()) }).strict();

export const StackEvent = Envelope.superRefine((event, context) => {
  const result = StackEventData[event.id].safeParse(event.data);
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ ...issue, path: ["data", ...issue.path] });
});
export type StackEvent = z.infer<typeof Envelope>;
