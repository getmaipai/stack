// What the Helper knows about the Stack's own words, kept in one place: the glossary (roles, engines,
// models, tiers), the plain-words formatting every tool result goes through (GB, never bytes), the
// role words an admin actually types, and the step that reads a message before the model does.
// Nothing here reads the machine; the read tools (helperReads.ts) do that and use these helpers.
import { ROLE_IDS, ROLES, type RoleId } from "@/roles";
import { partLabel } from "@/lib/partDefs";

// --- plain numbers --------------------------------------------------------
/** 25062267288 becomes "25.1 GB". Decimal GB, one place after the point under 100, none above. */
export function gb(bytes: number): string {
  const value = bytes / 1e9;
  if (value < 0.05) return "under 0.1 GB";
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} GB`;
}

/** Every number under a key that names bytes becomes a "GB" string, so the model never reads or repeats raw bytes. */
export function plainJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === "number" && /(^|_)bytes$|Bytes$/.test(key)) out[key.replace(/_?[bB]ytes$/, "") + "_gb"] = gb(item);
      else out[key] = plainJson(item);
    }
    return out;
  }
  return value;
}

// --- glossary -------------------------------------------------------------
export interface GlossaryEntry { term: string; words: string[]; meaning: string }
export const GLOSSARY: GlossaryEntry[] = [
  { term: "role", words: ["role", "roles", "feature", "features", "mode"], meaning: "A job the Stack does for Home: Chat, Coding, Voice in (speech to text), Voice out (text to speech), Images, Video, Music, Embeddings and so on. Each role is on or off, has a priority, and is served by one engine running one model." },
  { term: "engine", words: ["engine", "engines", "runtime"], meaning: "The program that runs a model. One engine can serve several roles. It is not a model and not a tier. Examples: llama-server (runs GGUF models on any computer), Splash (a faster runner for chat and coding on Apple silicon), the speech programs." },
  { term: "model", words: ["model", "models"], meaning: "The big file of learned numbers an engine loads into memory to do a job, for example Qwen3.8 27B. A model sits in memory for as long as its engine runs, and most of an engine's memory is the model." },
  { term: "tier", words: ["tier", "tiers", "level", "levels"], meaning: "How big a model a feature may use: Reduced, Standard, Boost, Max. Reduced is a small fallback that frees memory. Standard is the everyday size. Boost is bigger and better. Max is the biggest that fits and may need other things unloaded. Tiers exist for chat, pictures, video, music and voice." },
  { term: "reduced", words: ["reduced"], meaning: "The smallest tier. Chat swaps to a small model so a Max picture, video or song job can fit." },
  { term: "standard", words: ["standard"], meaning: "The everyday tier. It keeps room free for the rest of the household." },
  { term: "boost", words: ["boost"], meaning: "The tier above Standard: a bigger, better model that uses more memory." },
  { term: "max", words: ["max"], meaning: "The top tier: the biggest model that fits this computer. It may need other things unloaded while it runs." },
  { term: "splash", words: ["splash"], meaning: "An engine, not a model and not a tier. It is a fast runner for chat and coding on a Mac with an M3 chip or newer, macOS 26.4 and 36 GB or more. Its memory is the model it holds plus a conversation cache that grows with long chats. The setting Chat memory headroom caps that cache." },
  { term: "llama-server", words: ["llama-server", "llama server", "llama.cpp", "llama"], meaning: "The engine that runs GGUF model files on every computer. It serves chat, coding when Splash is not used, and the Helper." },
  { term: "coding", words: ["coding", "code"], meaning: "A role for programming help. It has its own model that loads only while someone is coding and unloads after idle minutes. It is a role, not a tier." },
  { term: "priority", words: ["priority", "above", "below", "first", "order"], meaning: "When work is waiting for memory, a lower priority number is served first. Roles with equal priority go in arrival order." },
  { term: "profile", words: ["profile", "profiles", "p16", "p32", "p64", "p128"], meaning: "The memory class of the computer (16, 32, 64 or 128 GB). It decides which roles run at once and which tiers are possible. The recommended profile is the plan the Stack works out for this exact computer." },
  { term: "resident", words: ["resident", "jit", "on demand", "keep warm"], meaning: "A resident role stays loaded all the time. An on-demand role loads when asked and unloads after idle minutes, so it costs no memory while idle." },
  { term: "helper", words: ["helper"], meaning: "This chat assistant. It has its own small model and works even when chat is down. It never changes anything without a confirm click." },
];

export function lookupTerm(raw: string): GlossaryEntry | null {
  const t = raw.toLowerCase().trim();
  if (!t) return null;
  return GLOSSARY.find((g) => g.term === t || g.words.includes(t)) ?? GLOSSARY.find((g) => g.words.some((w) => t.includes(w))) ?? null;
}

/** The short version the system prompt carries every turn (the long entries are one `explain` call away). */
export const GLOSSARY_PROMPT = [
  "Words: A role is a job (Chat, Coding, Voice in, Voice out, Images, Video, Music). An engine is the program that runs a model (llama-server, Splash). A model is the big file the engine holds in memory.",
  "Tiers are sizes for a feature: Reduced, Standard, Boost, Max. Splash is an ENGINE, not a tier. Coding is a ROLE, not a tier.",
].join(" ");

// --- role words ----------------------------------------------------------
export const ROLE_WORDS: Record<string, RoleId | RoleId[]> = {
  chat: "chat", assistant: "chat", coding: "coding", code: "coding", programming: "coding",
  judge: "judge", router: "router", embed: "embed", embeddings: "embed", embedding: "embed", search: "embed", rerank: "rerank", "re-rank": "rerank",
  vision: "vision", stt: "stt", "voice in": "stt", "speech to text": "stt", listening: "stt", transcription: "stt", dictation: "stt",
  tts: "tts", "voice out": "tts", "text to speech": "tts", talking: "tts",
  speech: ["stt", "tts"], voice: ["stt", "tts"], audio: ["stt", "tts"],
  wakeword: "wakeword", "wake word": "wakeword",
  image: "image", images: "image", "image generation": "image", "picture generation": "image", "video generation": "video", "music generation": "music", "image maker": "image", pictures: "image", picture: "image", photos: "image", photo: "image",
  video: "video", videos: "video", movies: "video", clips: "video", music: "music", songs: "music", song: "music", helper: "helper",
};

export type RoleResolution = { ok: true; role: RoleId } | { ok: false; reason: string; options?: RoleId[] };
/** Turns what an admin typed (id, label or everyday word) into one role, or says which words it could mean. */
export function resolveRole(raw: unknown): RoleResolution {
  const word = String(raw ?? "").toLowerCase().trim().replace(/\s+(role|feature|engine|mode)$/, "");
  if (!word) return { ok: false, reason: "No feature was named." };
  if ((ROLE_IDS as readonly string[]).includes(word)) return { ok: true, role: word as RoleId };
  const byLabel = ROLE_IDS.find((id) => ROLES[id].label.toLowerCase() === word);
  if (byLabel) return { ok: true, role: byLabel };
  const hit = ROLE_WORDS[word];
  if (typeof hit === "string") return { ok: true, role: hit };
  if (Array.isArray(hit)) return { ok: false, reason: `"${word}" could mean ${hit.map((r) => `${ROLES[r].label} (${roleExplain(r)})`).join(" or ")}.`, options: hit };
  return { ok: false, reason: `"${word}" is not a feature name. The features are: ${ROLE_IDS.map((r) => ROLES[r].label).join(", ")}.` };
}
export function roleExplain(role: RoleId): string {
  return ({ stt: "speech to text", tts: "text to speech", chat: "the main assistant", coding: "programming help", image: "pictures", embed: "search and memory", judge: "checks answers", router: "picks the right feature", vision: "reads pictures", wakeword: "hears the wake word", rerank: "sorts search results", video: "video clips", music: "songs", helper: "this assistant" } as Record<RoleId, string>)[role];
}
export const roleLabel = (role: string): string => (ROLE_IDS as readonly string[]).includes(role) ? ROLES[role as RoleId].label : role;
/** A model id in the words an admin sees, falling back to the id. */
export const modelLabel = (id: string): string => partLabel(id);

// --- tiers by feature -----------------------------------------------------
export type TierName = "reduced" | "standard" | "boost" | "max";
export const TIER_NAMES: TierName[] = ["reduced", "standard", "boost", "max"];
export type TierCategoryName = "chat" | "pictures" | "video" | "music" | "voice" | "stems";
export function tierCategoryOf(role: RoleId): TierCategoryName | null {
  switch (role) {
    case "chat": case "judge": case "router": return "chat";
    case "image": return "pictures";
    case "video": return "video";
    case "music": return "music";
    case "tts": return "voice";
    default: return null;
  }
}

// --- reading a message before the model does -----------------------------
export interface Topic { role?: RoleId; tier?: TierName; engine?: string }
const ENGINE_WORDS = ["splash", "llama-server", "mlx-serve", "omlx"];
const TIER_RE = /\b(reduced|standard|boost|max)\b/i;

/** What the message names: a tier, an engine, a role. Plain matching, no model. */
export function termsIn(message: string): Topic {
  const topic: Topic = {};
  const tier = TIER_RE.exec(message)?.[1]?.toLowerCase();
  if (tier) topic.tier = tier as TierName;
  const lower = message.toLowerCase();
  topic.engine = ENGINE_WORDS.find((e) => lower.includes(e));
  const words = Object.keys(ROLE_WORDS).sort((a, b) => b.length - a.length);
  for (const w of words) {
    if (new RegExp(`\\b${w.replace(/[-]/g, "\\-")}\\b`).test(lower)) { const hit = ROLE_WORDS[w]!; if (typeof hit === "string") { topic.role = hit; break; } }
  }
  if (!topic.engine) delete topic.engine;
  return topic;
}

const FOLLOW_UP = /^\s*(and\s+|what about\s+|how about\s+|what of\s+|and what about\s+|same for\s+|ok(ay)?,?\s+(and\s+)?|then\s+)/i;
/** The hint line that goes in front of the model: which words are tier, engine or role names, and what a short follow-up leans on from the turn before. */
export function interpretationHint(message: string, previous: Topic | null): string {
  const now = termsIn(message);
  const parts: string[] = [];
  if (now.tier) parts.push(`"${now.tier}" is a TIER name`);
  if (now.engine) parts.push(`"${now.engine}" is an ENGINE name`);
  if (now.role) parts.push(`the feature named is ${roleLabel(now.role)} (${now.role})`);
  const short = message.trim().split(/\s+/).length <= 6;
  if (previous && (FOLLOW_UP.test(message) || short) && (now.tier || now.engine || now.role) && (previous.role || previous.tier)) {
    const carried = [!now.role && previous.role ? `feature ${previous.role}` : "", !now.tier && previous.tier ? `tier ${previous.tier}` : ""].filter(Boolean);
    if (carried.length > 0) parts.push(`this is a follow-up: it still means ${carried.join(" and ")} from the question before`);
  }
  return parts.length > 0 ? `Reading of the admin's message: ${parts.join("; ")}.` : "";
}

/** The topic a finished turn was about, from the tools the model called, kept so the next short question can lean on it. */
export function topicFromCalls(calls: Array<{ name: string; args: Record<string, unknown> }>, message: string): Topic {
  const topic: Topic = termsIn(message);
  for (const call of calls) {
    const role = call.args.role ? resolveRole(call.args.role) : null;
    if (role?.ok) topic.role = role.role;
    const tier = String(call.args.tier ?? "").toLowerCase();
    if ((TIER_NAMES as string[]).includes(tier)) topic.tier = tier as TierName;
  }
  return topic;
}
