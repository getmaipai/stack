// Hand-written Zod mirror of ../schemas/stack-setting.schema.json: a
// SettingsKey (home/spec) restricted to the Stack, plus the value half.
import { z } from "zod";

export const StackSetting = z.object({
  key: z.string().regex(/^stack(\.[a-z][a-z0-9_]*)+$/),
  scope: z.literal("device"),
  selector: z.enum(["number", "select", "text", "boolean"]),
  range: z.unknown().optional(),
  default: z.unknown(),
  label: z.string().min(1),
  help: z.string().optional(),
  section: z.object({ id: z.string().optional(), collapsed: z.boolean().optional(), order: z.number().int().optional() }).strict().optional(),
  level: z.enum(["basic", "advanced", "expert"]),
  secret: z.boolean().optional(),
  needs: z.array(z.string()).optional(),
  lives_in: z.literal("stack"),
  honoured_by: z.array(z.enum(["home", "bot"])).min(1),
  needs_restart: z.boolean(),
  in_effect: z.unknown(),
  pending: z.unknown(),
}).strict();
export type StackSetting = z.infer<typeof StackSetting>;
