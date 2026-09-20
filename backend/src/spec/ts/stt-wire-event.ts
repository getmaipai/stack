// Hand-written Zod mirror of ../schemas/stt-wire-event.schema.json.
import { z } from "zod";

export const SttWireEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready") }).strict(),
  z.object({ t: z.literal("vad"), speaking: z.boolean(), rms: z.number().min(0) }).strict(),
  z.object({ t: z.literal("partial"), v: z.string() }).strict(),
  z.object({ t: z.literal("final"), v: z.string().min(1) }).strict(),
  z.object({ t: z.literal("no_speech") }).strict(),
  z.object({ t: z.literal("error"), v: z.string().min(1) }).strict(),
]);
export type SttWireEvent = z.infer<typeof SttWireEvent>;
