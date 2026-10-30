// MEM-SPACE-06: what this computer can ever run at each level, per category, for the Performance page and the setup wizard. The same
// answer the resolver and the governor give: `fits_ever` is the governor's fitsEverForTier for the level's pick, `cap_bytes` the level's cap.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { fitsEverForTier, getGovernorStatus, tierRoomBytes } from "@/lib/governor";
import { currentMachineTier } from "@/lib/supervisor";
import { reducedFreedBytes, resolveTier, tierCapBytes, TIER_CANDIDATES, type ProfileId, type TierCategory } from "@/lib/tiers";

const CATEGORIES = [["chat", "chat"], ["image", "pictures"], ["video", "video"], ["music", "music"], ["voice", "voice"]] as const satisfies ReadonlyArray<readonly [string, TierCategory]>;
const LEVELS = ["standard", "boost", "max"] as const;
const Row = z.object({
  category: z.enum(["chat", "image", "video", "music", "voice"]), tier: z.enum(LEVELS),
  fits_ever: z.boolean().describe("Whether the level's pick could ever be admitted on this computer, with everything else idle."),
  needs_bytes: z.number().nullable().describe("The pick's peak memory, or the smallest catalogued peak for the level when nothing fits; null when the level has no model."),
  cap_bytes: z.number().describe("The most memory this level may hold on this computer."),
  model: z.string().nullable().describe("The model the level would use, or null when none fits or the level has no model."),
});
const route = createRoute({
  method: "get", path: "/", tags: ["Capabilities"], summary: "What each category can run at each level on this computer (MEM-SPACE-06)",
  description: "One row per category and level (Standard, Boost, Max). `machine_class` is this computer's profile, or `unknown` when it is too small for any profile, in which case no row fits.",
  responses: { 200: { content: { "application/json": { schema: z.object({ machine_class: z.string(), total_bytes: z.number(), rows: z.array(Row) }) } }, description: "The capability rows." } },
});

export const capabilitiesRoutes = apiRouter<AppEnv>();
capabilitiesRoutes.openapi(route, (c) => {
  const profile = (currentMachineTier() ?? null) as ProfileId | null;
  const room = tierRoomBytes();
  // Max may use the memory Reduced chat and voice free, the same figure the governor is given for a Max job.
  const freed = profile ? reducedFreedBytes(profile, room) : 0;
  const rows = CATEGORIES.flatMap(([category, tierCategory]) => LEVELS.map((tier) => {
    const reducedFreed = tier === "max" ? freed : 0;
    const cap_bytes = Math.round(tierCapBytes(tier, room, reducedFreed));
    const resolved = profile ? resolveTier({ category: tierCategory, tier, profile, roomBytes: room, reducedFreedBytes: reducedFreed }) : null;
    const smallest = profile ? TIER_CANDIDATES.filter((item) => item.category === tierCategory && item.profiles.includes(profile) && item.tiers.includes(tier)).flatMap((item) => item.peaks.map((peak) => peak.peakBytes)).sort((a, b) => a - b)[0] ?? null : null;
    const needs_bytes = resolved?.peakBytes ?? smallest;
    const fits_ever = needs_bytes !== null && fitsEverForTier({ id: `capability-${category}-${tier}`, kind: "generator", requestedBytes: needs_bytes, tier }, { reducedFreedBytes: reducedFreed }).fits;
    return { category, tier, fits_ever: resolved ? fits_ever : false, needs_bytes, cap_bytes, model: resolved?.model ?? null };
  }));
  return c.json({ machine_class: profile ?? "unknown", total_bytes: getGovernorStatus().totalMemoryBytes, rows }, 200);
});
