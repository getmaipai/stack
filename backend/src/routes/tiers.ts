// TIER-HOME-04: the tier catalog as Home's slot dialogs need it (read only). The profile is this machine's proposed one and the room is the
// governor's tier room, so a candidate's "fits" is the same answer the resolver and the governor give.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { proposeProfile } from "@/profiles";
import { tierRoomBytes } from "@/lib/governor";
import { tierCandidateLists, type TierCategory } from "@/lib/tiers";
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
  const levels = profile ? tierCandidateLists(category as TierCategory, profile, roomBytes) : [];
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
