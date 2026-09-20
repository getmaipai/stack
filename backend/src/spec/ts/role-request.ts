// Hand-written Zod mirror of ../schemas/role-request.schema.json. Kept in
// step by tests/spec.test.ts (every fixture must agree with the JSON
// Schema); replaced by @maipai/spec's generated module at the move.
import { z } from "zod";

export const RoleRequest = z.object({
  model: z.string().min(1),
  quality: z.enum(["fast", "everyday", "best"]).optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().min(1).optional(),
}).passthrough();
export type RoleRequest = z.infer<typeof RoleRequest>;
