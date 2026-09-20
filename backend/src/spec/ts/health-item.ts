// Hand-written Zod mirror of ../schemas/health-item.schema.json.
import { z } from "zod";

export const HealthFixAction = z.enum(["restart_engine", "free_memory", "retry_download", "rollback_update", "reinstall_engine", "reinstall_model"]);
export type HealthFixAction = z.infer<typeof HealthFixAction>;

export const HealthItem = z.object({
  code: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  severity: z.enum(["critical", "error", "warning"]),
  title: z.string().min(1),
  text: z.string().min(1),
  since: z.string().datetime({ offset: true }),
  cause: z.string().min(1),
  fix: z.object({ label: z.string().min(1), action: HealthFixAction }).strict().optional(),
}).strict();
export type HealthItem = z.infer<typeof HealthItem>;
