// The voice wire shape (STACK-101a): the metadata Home's voice picker
// shows. Declared locally, not part of @maipai/spec - it was added after
// spec-v0.1.0 folded the Stack's other wire shapes in, and no spec tag
// carries it yet.
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
  /** The engine that renders this voice (`pocket-tts`, `chatterbox-turbo`); Home's StackVoice reads it. */
  engine: z.string().min(1).optional(),
  /** The tts capability flag (VOICE-STUDIO-01): the tags this voice's engine renders as sounds, written by
   * Home's composer into `reply.speech`. An engine with none gives an empty array. */
  tts: z.object({ engine: z.string().min(1), tags: z.array(z.string()) }).strict().optional(),
}).strict();
export type Voice = z.infer<typeof Voice>;
