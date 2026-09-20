// Hand-written Zod mirror of ../schemas/precious-state.schema.json.
import { z } from "zod";

export const PreciousState = z.object({
  data_dir: z.string().min(1),
  paths: z.array(z.object({
    path: z.string().min(1),
    mode: z.enum(["include", "exclude"]),
    what: z.string().min(1),
    why: z.string().min(1),
  }).strict()).min(1),
}).strict();
export type PreciousState = z.infer<typeof PreciousState>;
