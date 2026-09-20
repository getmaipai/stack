// Hand-written Zod mirror of ../schemas/stack-job.schema.json.
import { z } from "zod";

export const StackJobState = z.enum(["queued", "running", "done", "failed", "cancelled"]);
export type StackJobState = z.infer<typeof StackJobState>;

export const StackJob = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  role: z.string().nullable(),
  state: StackJobState,
  percent: z.number().int().min(0).max(100),
  completedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  status: z.string(),
  position: z.number().int().min(1).nullable(),
  input: z.record(z.string(), z.unknown()).nullable(),
  result: z.unknown().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type StackJob = z.infer<typeof StackJob>;
