import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { PROFILE_TIERS, proposeProfile } from "@/profiles";
import { RoleIdSchema, PRIMARY_ROLE } from "@/roles";
import { getGovernorDecisions, getGovernorStatus } from "@/lib/governor";
import { tierRoomBytes } from "@/lib/governor";
import { currentMachineTier } from "@/lib/supervisor";
import { budgetSlots } from "@/lib/tiers";
import { budgetPercent } from "@/profiles";
import { PROFILE_IDS } from "@/lib/profileIds";

const CudaDeviceSchema = z.object({ index: z.number(), name: z.string(), vramBytes: z.number(), usedVramBytes: z.number().optional(), utilizationPct: z.number().optional() });
const HardwareInfoSchema = z.object({ platform: z.string(), arch: z.string(), totalRamGb: z.number(), cpuCount: z.number(), isAppleSilicon: z.boolean(), unifiedMemoryGb: z.number(), cudaDevices: z.array(CudaDeviceSchema), freeDiskBytes: z.number().nullable(), totalDiskBytes: z.number().nullable(), osVersion: z.string() });
const ProfileTierSchema = z.object({ id: z.enum(PROFILE_IDS), level: z.enum(["minimal", "moderate", "recommended"]), label: z.string(), minUnifiedGb: z.number(), minVramGb: z.number(), resident: z.array(RoleIdSchema), onDemand: z.array(RoleIdSchema), installedOnly: z.array(RoleIdSchema), notAvailable: z.array(RoleIdSchema), speedRange: z.object({ min: z.number(), max: z.number() }) });
const BudgetSchema = z.object({ totalMemoryBytes: z.number().int(), capBytes: z.number().int(), freeMemoryBytes: z.number().int(), availablePercent: z.number(), pressure: z.enum(["normal", "warn", "critical"]), memoryReadingDegraded: z.boolean(), tier: z.enum(PROFILE_IDS), margin_bytes: z.number().int(), reading_degraded: z.boolean(), profile: z.string().nullable().openapi({ description: "The active machine profile used by the Stack's tier governor." }), free_now_bytes: z.number().int().openapi({ description: "Memory free at this moment. Informational: the slots do not depend on it." }), room_bytes: z.number().int().openapi({ description: "The tier room: what this computer can ever hold for models, before anything is loaded." }), slots: z.array(z.object({ category: z.enum([PRIMARY_ROLE, "pictures", "video", "music", "voice", "stems"]), tier: z.enum(["reduced", "standard", "boost", "max"]), model: z.string().nullable(), peak_bytes: z.number().int().nullable(), basis: z.enum(["measured", "estimated"]).nullable(), verified: z.boolean(), resident_bytes: z.number().int().nullable(), fits_ever: z.boolean() })).openapi({ description: "One row per level of each category this computer has a model for, listed per level on this computer and never trimmed by memory free now. A level with no catalogued model has model and peak_bytes null. fits_ever says the peak is within that level's cap of the tier room; whether it fits now is decided by the governor at admission. verified is false for an estimate." }), loaded: z.array(z.object({ id: z.string(), kind: z.enum(["resident", "jit", "generator"]), peakBytes: z.number().int(), measured: z.boolean(), lastUsedAt: z.string(), idleTtlSeconds: z.number().int(), pinned: z.boolean(), pid: z.number().int().nullable() })), queue: z.array(z.object({ id: z.string(), position: z.number().int(), kind: z.enum(["resident", "jit", "generator"]) })) });

const hardwareRoute = createRoute({ method: "get", path: "/", tags: ["Hardware"], summary: "Hardware facts and the proposed profile", responses: { 200: { content: { "application/json": { schema: z.object({ hardware: HardwareInfoSchema, proposed: ProfileTierSchema.nullable(), budget_percent: z.number(), tiers: z.array(ProfileTierSchema) }) } }, description: "The probe's facts (no computer name), the applied AI budget and the tier this machine clears." } } });
const budgetRoute = createRoute({ method: "get", path: "/budget", tags: ["Hardware"], summary: "The memory governor's budget and loaded set", responses: { 200: { content: { "application/json": { schema: BudgetSchema } }, description: "Cap, free memory, pressure, loaded models and the queue. The slots list is per level on this computer (what each level needs, from the tier room); whether a level fits now is decided at admission." } } });
const decisionsRoute = createRoute({ method: "get", path: "/budget/decisions", tags: ["Hardware"], summary: "The governor's last 200 decisions", responses: { 200: { content: { "application/json": { schema: z.object({ decisions: z.array(z.object({ at: z.string(), decision: z.string(), reason: z.string(), model: z.string() })) }) } }, description: "Newest first." } } });

export const hardwareRoutes = apiRouter<AppEnv>();
hardwareRoutes.openapi(hardwareRoute, async (c) => {
  const { computerName: _computerName, freeDiskBytes, totalDiskBytes, ...hardware } = await detectHardware();
  return c.json({ hardware: { ...hardware, freeDiskBytes: freeDiskBytes ?? null, totalDiskBytes: totalDiskBytes ?? null }, proposed: proposeProfile({ ...hardware, freeDiskBytes, totalDiskBytes }), budget_percent: budgetPercent(), tiers: PROFILE_TIERS }, 200);
});
hardwareRoutes.openapi(budgetRoute, (c) => {
  const status = getGovernorStatus();
  const profile = currentMachineTier() ?? null;
  const room = tierRoomBytes();
  return c.json({ ...status, margin_bytes: status.marginBytes, reading_degraded: status.memoryReadingDegraded, profile, free_now_bytes: status.freeMemoryBytes, room_bytes: Math.round(room), slots: budgetSlots(profile, room) }, 200);
});
hardwareRoutes.openapi(decisionsRoute, (c) => c.json({ decisions: getGovernorDecisions() }, 200));
