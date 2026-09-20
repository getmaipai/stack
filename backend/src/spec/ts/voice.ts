// Hand-written Zod mirror of ../schemas/voice.schema.json.
import { z } from "zod";

export const Voice = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  language: z.string().min(1),
  country: z.string().min(1),
  gender: z.enum(["female", "male", "neutral", "unknown"]),
  source: z.enum(["preset", "community", "cloned"]),
  onDisk: z.boolean(),
  licence: z.string().nullable(),
  revision: z.string().min(1),
}).strict();
export type Voice = z.infer<typeof Voice>;
