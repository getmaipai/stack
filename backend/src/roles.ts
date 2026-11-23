import { z } from "zod";

export const ROLE_IDS = [
  "chat", "coding", "judge", "router", "embed", "rerank", "vision",
  "stt", "tts", "wakeword", "image", "video", "music", "helper",
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
  cause: z.string().optional(),
});
export type RoleStateRecord = z.infer<typeof RoleStateRecordSchema>;

export interface RoleDefinition {
  label: string;
  wire: Wire;
  residency: Residency;
  memoryClass: "reserved" | "warm" | "burst";
  endpoints: string[];
  quality: Quality[];
  sharesModelWith?: RoleId;
  // True on the roles that share chat's model, move with Home mode coding,
  // and take the Reduced chat swap. Collected into MODE_FOLLOWER_ROLES.
  followsHomeMode?: true;
}

export const ROLES = {
  chat: {
    label: "Chat",
    wire: "chat",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
    followsHomeMode: true,
  },
  // CODE-STACK-01: its own model (Qwen3.8-27B, bound on p64 and p128),
  // loaded only while someone is coding and never chat's process. S2: the
  // first request starts its own llama-server process, a request in flight
  // holds a lease, it unloads after `stack.engines.coding.keep_warm_minutes`
  // idle, and an idle one yields to a picture, video or music job. Until
  // loaded the role reports "installed" once the model is on disk.
  coding: {
    label: "Coding",
    wire: "chat",
    residency: "jit",
    memoryClass: "warm",
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/messages/count_tokens", "/v1/responses"],
    quality: ["fast", "everyday", "best"],
  },
  judge: {
    label: "Judge",
    wire: "chat",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    sharesModelWith: "chat",
    followsHomeMode: true,
  },
  router: {
    label: "Router",
    wire: "chat",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/chat/completions"],
    quality: [],
    sharesModelWith: "chat",
    followsHomeMode: true,
  },
  embed: {
    label: "Embeddings",
    wire: "embeddings",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/embeddings"],
    quality: [],
  },
  rerank: {
    label: "Re-rank",
    wire: "rerank",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: [],
    quality: [],
  },
  // VISION-01b: its own model and process (a vision-language model with
  // its projector), loaded on a picture request and evicted when idle;
  // never chat's text-only process, which cannot read a picture.
  vision: {
    label: "Vision",
    wire: "chat",
    residency: "jit",
    memoryClass: "warm",
    endpoints: ["/v1/chat/completions"],
    quality: ["fast", "everyday", "best"],
  },
  stt: {
    label: "Voice in",
    wire: "transcription",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/audio/transcriptions", "/v1/audio/speaker-embedding", "/v1/audio/mouth-timings"],
    quality: [],
  },
  tts: {
    label: "Voice out",
    wire: "speech",
    residency: "resident",
    memoryClass: "reserved",
    endpoints: ["/v1/audio/speech"],
    quality: [],
  },
  wakeword: {
    label: "Wake word",
    wire: "speech",
    residency: "installed",
    memoryClass: "reserved",
    endpoints: [],
    quality: [],
  },
  image: {
    label: "Images",
    wire: "job",
    residency: "jit",
    memoryClass: "warm",
    endpoints: ["/v1/images/generations"],
    quality: ["fast", "everyday", "best"],
  },
  video: {
    label: "Video",
    wire: "job",
    residency: "jit",
    memoryClass: "burst",
    endpoints: ["/v1/videos/generations"],
    quality: ["fast", "everyday", "best"],
  },
  music: {
    label: "Music",
    wire: "job",
    residency: "jit",
    memoryClass: "burst",
    endpoints: ["/v1/audio/music"],
    quality: ["fast", "everyday", "best"],
  },
  // HELPER-01: the admin page's chat assistant. Its own small model and its
  // own process (never chat's), loaded on the first message and unloaded
  // after `stack.engines.helper.keep_warm_minutes` idle; not on /v1 and not
  // reachable by Home. It works while `chat` is down.
  helper: {
    label: "Helper",
    wire: "chat",
    residency: "jit",
    memoryClass: "warm",
    endpoints: [],
    quality: [],
  },
} satisfies Record<RoleId, RoleDefinition>;

// The roles that follow Home's mode: they share chat's model, move with
// coding mode, and take the Reduced chat swap. Order: chat, judge, router.
export const MODE_FOLLOWER_ROLES: RoleId[] = ROLE_IDS.filter((role) => (ROLES[role] as RoleDefinition).followsHomeMode);

/** DEV-CHECKOUT-01 (2026-11-12): every Stack job has one of three classes, defined here and nowhere else.
 *  essential:   small always-on helpers (chat, judge, router, picture reader, speech, search): always admitted on real free memory.
 *  interactive: a family member is waiting (coding, one picture): held back only when it truly does not fit.
 *  heavy:       video, music, big pictures, long jobs: admitted on real free memory; from a dev session it goes through the dev checkout (Home's lease broker).
 *  A request that needs HEAVY_JOB_BYTES or more is heavy whatever its role (see jobClassOf in lib/governor.ts). */
export type JobClass = "essential" | "interactive" | "heavy";
export const ROLE_JOB_CLASS: Record<RoleId, JobClass> = {
  chat: "essential", judge: "essential", router: "essential", embed: "essential", rerank: "essential", vision: "essential",
  stt: "essential", tts: "essential", wakeword: "essential", coding: "interactive", image: "interactive", video: "heavy", music: "heavy", helper: "essential",
};

export const RoleDefinitionSchema = z.object({
  label: z.string(),
  wire: WireSchema,
  residency: ResidencySchema,
  memoryClass: z.enum(["reserved", "warm", "burst"]),
  endpoints: z.array(z.string()),
  quality: z.array(QualitySchema),
  sharesModelWith: RoleIdSchema.optional(),
});

export const RoleRecordSchema = RoleDefinitionSchema.extend({
  id: RoleIdSchema,
  enabled: z.boolean().describe("False when the role is turned off (stack.roles.<role>.enabled). A turned-off role is not started or admitted; its state is offline with the reason."),
  priority: z.number().int().describe("Where the role stands when work waits for memory; lower is served first (stack.roles.<role>.priority)."),
  state: RoleStateRecordSchema,
  reason: z.string().nullable(),
  model: z.object({ id: z.string(), sizeBytes: z.number().int().nullable(), measuredFootprintBytes: z.number().int().nullable(), measuredContextLength: z.number().int().nullable(), estimated: z.boolean(), imageInput: z.boolean().optional() }).nullable().optional(),
});
