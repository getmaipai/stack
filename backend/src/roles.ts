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
// The five truthful states a role can be in, declared once here and reused
// everywhere else (the /stack/v1/roles handler, the check runner, and the
// supervisor all reference these). `ready` is the only one with a time
// stamp of its own: it is only claimed while the last real request or
// post-load check succeeded within the last hour. Every state carries
// `since`, the moment it was first observed.
export const RoleStateEnum = z.enum(["notInstalled", "installed", "loaded", "ready", "offline"]);
export type RoleState = z.infer<typeof RoleStateEnum>;

// The oldest a `ready` claim can be and still hold. Older than this, a role
// has only been loaded (or worse) and stops claiming readiness.
export const READY_TTL_MS = 3_600_000;

// The stamped record served on /stack/v1/roles and computed by the check
// runner. `reason` is only present on `offline`; `checkedAt` is only present
// on `ready`.
export const RoleStateRecordSchema = z.object({
  state: RoleStateEnum,
  since: z.string(),
  checkedAt: z.string().optional(),
  reason: z.string().nullable().optional(),
});
export type RoleStateRecord = z.infer<typeof RoleStateRecordSchema>;

export interface RoleDefinition {
  label: string;
  wire: Wire;
  residency: Residency;
  endpoints: string[];
  quality: Quality[];
  description: string;
  sharesModelWith?: RoleId;
}

export const ROLES = {
  chat: {
    label: "Chat",
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Talk with your local AI.",
  },
  coding: {
    label: "Coding",
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Build and understand things with local AI.",
    sharesModelWith: "chat",
  },
  judge: {
    label: "Judge",
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    description: "Check a local AI answer before it is used.",
    sharesModelWith: "chat",
  },
  router: {
    label: "Router",
    wire: "chat",
    residency: "resident",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    description: "Choose the right local capability for a request.",
    sharesModelWith: "chat",
  },
  embed: {
    label: "Embeddings",
    wire: "embeddings",
    residency: "resident",
    endpoints: ["/v1/embeddings"],
    quality: [],
    description: "Find related things in your local data.",
  },
  rerank: {
    label: "Re-rank",
    wire: "rerank",
    residency: "resident",
    endpoints: [],
    quality: [],
    description: "Put the most useful local results first.",
  },
  vision: {
    label: "Vision",
    wire: "chat",
    residency: "jit",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    description: "Understand an image on your computer.",
    sharesModelWith: "chat",
  },
  stt: {
    label: "Voice in",
    wire: "transcription",
    residency: "resident",
    endpoints: ["/v1/audio/transcriptions"],
    quality: [],
    description: "Turn your voice into words locally.",
  },
  tts: {
    label: "Voice out",
    wire: "speech",
    residency: "resident",
    endpoints: ["/v1/audio/speech"],
    quality: [],
    description: "Read words aloud on your computer.",
  },
  wakeword: {
    label: "Wake word",
    wire: "speech",
    residency: "installed",
    endpoints: [],
    quality: [],
    description: "Listen for a wake word in a body process.",
  },
  image: {
    label: "Images",
    wire: "job",
    residency: "jit",
    endpoints: ["/v1/images/generations"],
    quality: ["fast", "everyday", "best"],
    description: "Make an image on your computer.",
  },
  video: {
    label: "Video",
    wire: "job",
    residency: "jit",
    endpoints: [],
    quality: ["fast", "everyday", "best"],
    description: "Make a video on your computer.",
  },
  music: {
    label: "Music",
    wire: "job",
    residency: "jit",
    endpoints: [],
    quality: ["fast", "everyday", "best"],
    description: "Make music on your computer.",
  },
} satisfies Record<RoleId, RoleDefinition>;

export const RoleDefinitionSchema = z.object({
  label: z.string(),
  wire: WireSchema,
  residency: ResidencySchema,
  endpoints: z.array(z.string()),
  quality: z.array(QualitySchema),
  description: z.string(),
  sharesModelWith: RoleIdSchema.optional(),
});

export const RoleRecordSchema = RoleDefinitionSchema.extend({
  id: RoleIdSchema,
  state: RoleStateRecordSchema,
  reason: z.string().nullable(),
  model: z.object({ id: z.string(), sizeBytes: z.number().int().nullable(), measuredFootprintBytes: z.number().int().nullable(), measuredContextLength: z.number().int().nullable(), estimated: z.boolean() }).nullable().optional(),
});
