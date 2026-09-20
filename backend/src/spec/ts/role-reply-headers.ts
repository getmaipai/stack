// Hand-written Zod mirror of ../schemas/role-reply-headers.schema.json.
import { z } from "zod";

export const RoleReplyHeaders = z.object({
  "x-maipai-engine": z.string().min(1),
  "x-maipai-model": z.string().min(1),
  "x-maipai-revision": z.string().min(1),
}).strict();
export type RoleReplyHeaders = z.infer<typeof RoleReplyHeaders>;
