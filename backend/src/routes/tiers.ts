// TIER-HOME-04: the tier catalog as Home's slot dialogs need it (read only). The profile is this machine's proposed one and the room is the
// governor's tier room, so a candidate's "fits" is the same answer the resolver and the governor give. Max is sized from the Max room,
// the resident room plus what Reduced frees (TIER-ROOM-01), as the governor sizes a Max job at admission.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { reducedRoomBytes, tierRoomBytes } from "@/lib/governor";
import { tierCandidateLists, TIER_CANDIDATES, type TierCategory } from "@/lib/tiers";
import { applyVoiceEngine } from "@/lib/tierPick";
import { controlReducedChat } from "@/lib/reducedChatLease";

const Candidate = z.object({
  id: z.string(), label: z.string(), family: z.string(), peak_bytes: z.number(), verified: z.boolean(),
  fits: z.boolean().describe("Whether the candidate's peak is at or under this level's cap on this computer."),
  refusal: z.string().nullable().describe("The plain-words reason it cannot fill this level, or null when it fits."),
});
const Level = z.object({ tier: z.enum(["standard", "boost", "max"]), cap_bytes: z.number(), recommended: z.string().nullable(), candidates: z.array(Candidate) });
const candidatesRoute = createRoute({
  method: "get", path: "/candidates", tags: ["Tiers"], summary: "The models each level of a category may use on this computer (TIER-HOME-04)",
  description: "Every catalog candidate for the category on this computer's profile, under each of Standard, Boost and Max, with the family it belongs to, its peak memory, whether it fits that level's cap and the plain refusal when it does not. `profile` is null when this computer is too small for any profile.",
  request: { query: z.object({ category: z.enum(["chat", "pictures", "video", "music", "voice", "stems"]) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ category: z.string(), profile: z.enum(["p16", "p32", "p64", "p128"]).nullable(), room_bytes: z.number(), levels: z.array(Level) }) } }, description: "The candidates per level." } },
});

export const tiersRoutes = apiRouter<AppEnv>();
tiersRoutes.openapi(candidatesRoute, async (c) => {
  const { category } = c.req.valid("query");
  const { computerName: _name, ...hardware } = await detectHardware();
  const profile = proposeProfile(hardware as Parameters<typeof proposeProfile>[0])?.id ?? null;
  const roomBytes = tierRoomBytes();
  const levels = profile ? tierCandidateLists(category as TierCategory, profile, roomBytes, reducedRoomBytes()) : [];
  return c.json({
    category, profile, room_bytes: roomBytes,
    levels: levels.map((level) => ({ tier: level.tier, cap_bytes: level.capBytes, recommended: level.recommended, candidates: level.candidates.map((row) => ({ id: row.id, label: row.label, family: row.family, peak_bytes: row.peakBytes, verified: row.verified, fits: row.fits, refusal: row.refusal })) })),
  }, 200);
});

const Reduced = z.boolean().describe("Whether chat is on the smaller Reduced model right now.");
const reducedRoute = createRoute({
  method: "post", path: "/reduced", tags: ["Tiers"], summary: "Put chat in Reduced, or bring it back (TIER-REDUCED-ROUTE)",
  description: "`on: true` swaps chat, judge and router to the smaller model so a Max job fits; `on: false` returns them to the standard model. Idempotent: asking for the state chat is already in answers 200 with swap_ms 0. 202 means a chat turn is running and nothing changed; ask again after it. 409 or 503 carry a plain sentence, and chat is on its normal model after a failed entry. Repeat `{ on: true }` to renew: with no renewal for 30 minutes (STACK_REDUCED_CHAT_CAP_MS) the Stack leaves Reduced by itself.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ on: z.boolean() }) } } } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), swap_ms: z.number(), reduced: Reduced }) } }, description: "Chat is in the asked state." },
    202: { content: { "application/json": { schema: z.object({ ok: z.literal(false), waiting: z.literal(true), reduced: Reduced }) } }, description: "A chat turn is in flight; nothing changed." },
    409: { content: { "application/json": { schema: z.object({ ok: z.literal(false), reason: z.string(), reduced: Reduced }) } }, description: "The change cannot happen now (coding mode, a change already running, the smaller model missing)." },
    503: { content: { "application/json": { schema: z.object({ ok: z.literal(false), reason: z.string(), reduced: Reduced }) } }, description: "The swap failed and chat stayed on its previous model." },
  },
});
tiersRoutes.openapi(reducedRoute, async (c) => {
  const result = await controlReducedChat(c.req.valid("json").on);
  return c.json(result.body, result.status) as never;
});

// VOICE-VOXCPM2-01 / stack-owns-model-choices: the Stack applies a model pick itself. A voice pick sets the voice engine the row names, so a model
// listed above and chosen in Home's picker is the model that speaks after the voice engine restarts; a category whose rows name no engine stores nothing yet.
const choiceRoute = createRoute({
  method: "put", path: "/choice", tags: ["Tiers"], summary: "Pick a model for a level; the Stack applies it (stack-owns-model-choices)",
  description: "Validates that the model is a candidate of the category, then applies what the pick means to the Stack. For voice, the engine the candidate names is saved in `stack.voice.engine` and starts at the next voice engine restart. `applied` is false when the candidate names no engine to apply.",
  request: { body: { required: true, content: { "application/json": { schema: z.object({ category: z.enum(["chat", "pictures", "video", "music", "voice", "stems"]), tier: z.enum(["reduced", "standard", "boost", "max"]), model: z.string().min(1) }) } } } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), applied: z.boolean(), pending_restart: z.boolean() }) } }, description: "The pick is valid; `applied` says whether the Stack changed a setting for it." },
    404: { content: { "application/json": { schema: z.object({ error: z.string(), code: z.string() }) } }, description: "No such candidate in that category." },
  },
});
tiersRoutes.openapi(choiceRoute, async (c) => {
  const { category, tier, model } = c.req.valid("json");
  const candidate = TIER_CANDIDATES.find((item) => item.category === category && item.id === model);
  if (!candidate) return c.json({ error: `${model} is not a model this Stack offers for ${category}. Pick one from the list.`, code: "unknown_candidate" }, 404);
  // Only the Standard voice pick selects the speaking engine; Reduced is the memory fallback and Boost and Max do not exist for voice.
  if (category !== "voice" || tier !== "standard" || !candidate.engine) return c.json({ ok: true as const, applied: false, pending_restart: false }, 200);
  return c.json({ ok: true as const, ...applyVoiceEngine(candidate.engine) }, 200);
});
