import { z } from "zod";

export const ROLE_IDS = [
  "chat", "coding", "judge", "router", "embed", "rerank", "vision",
  "stt", "tts", "wakeword", "image", "video", "music",
] as const;
export type RoleId = typeof ROLE_IDS[number];

export const RoleIdSchema = z.enum(ROLE_IDS);
export const WireSchema = z.enum(["chat", "embeddings", "rerank", "transcription", "speech", "job"]);
export type Wire = z.infer<typeof WireSchema>;
export const ResidencySchema = z.enum(["resident", "jit", "installed"]);
export type Residency = z.infer<typeof ResidencySchema>;
export const QualitySchema = z.enum(["fast", "everyday", "best"]);
export type Quality = z.infer<typeof QualitySchema>;
export const RoleStateSchema = z.enum(["notInstalled", "installed", "loading", "ready", "busy", "stopped", "offline"]);
export type RoleState = z.infer<typeof RoleStateSchema>;

export interface RoleDefinition {
  wire: Wire;
  residency: Residency;
  endpoints: string[];
  quality: Quality[];
  description: string;
  sharesModelWith?: RoleId;
}

export const ROLES = {
  chat: {
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Talk with your local AI.",
  },
  coding: {
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Build and understand things with local AI.",
    sharesModelWith: "chat",
  },
  judge: {
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    description: "Check a local AI answer before it is used.",
    sharesModelWith: "chat",
  },
  router: {
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    description: "Choose the right local capability for a request.",
    sharesModelWith: "chat",
  },
  embed: {
    wire: "embeddings",
    residency: "resident",
    endpoints: ["/v1/embeddings"],
    quality: [],
    description: "Find related things in your local data.",
  },
  rerank: {
    wire: "rerank",
    residency: "resident",
    endpoints: [],
    quality: [],
    description: "Put the most useful local results first.",
  },
  vision: {
    wire: "chat",
    residency: "jit",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Understand an image on your computer.",
    sharesModelWith: "chat",
  },
  stt: {
    wire: "transcription",
    residency: "resident",
    endpoints: ["/v1/audio/transcriptions"],
    quality: [],
    description: "Turn your voice into words locally.",
  },
  tts: {
    wire: "speech",
    residency: "resident",
    endpoints: ["/v1/audio/speech"],
    quality: [],
    description: "Read words aloud on your computer.",
  },
  wakeword: {
    wire: "speech",
    residency: "installed",
    endpoints: [],
    quality: [],
    description: "Listen for a wake word in a body process.",
  },
  image: {
    wire: "job",
    residency: "jit",
    endpoints: ["/v1/images/generations"],
    quality: ["fast", "everyday", "best"],
    description: "Make an image on your computer.",
  },
  video: {
    wire: "job",
    residency: "jit",
    endpoints: [],
    quality: ["fast", "everyday", "best"],
    description: "Make a video on your computer.",
  },
  music: {
    wire: "job",
    residency: "jit",
    endpoints: [],
    quality: ["fast", "everyday", "best"],
    description: "Make music on your computer.",
  },
} satisfies Record<RoleId, RoleDefinition>;

export const RoleDefinitionSchema = z.object({
  wire: WireSchema,
  residency: ResidencySchema,
  endpoints: z.array(z.string()),
  quality: z.array(QualitySchema),
  description: z.string(),
  sharesModelWith: RoleIdSchema.optional(),
});

export const RoleRecordSchema = RoleDefinitionSchema.extend({
  id: RoleIdSchema,
  state: RoleStateSchema,
  reason: z.string().nullable(),
  model: z.object({ id: z.string(), sizeBytes: z.number().int().nullable(), measuredFootprintBytes: z.number().int().nullable(), measuredContextLength: z.number().int().nullable(), estimated: z.boolean() }).nullable().optional(),
});
