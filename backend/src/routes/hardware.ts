import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { PROFILE_TIERS, proposeProfile } from "@/profiles";
import { RoleIdSchema } from "@/roles";
import { getGovernorDecisions, getGovernorStatus } from "@/lib/governor";

const CudaDeviceSchema = z.object({ index: z.number(), name: z.string(), vramBytes: z.number(), usedVramBytes: z.number().optional(), utilizationPct: z.number().optional() });
const HardwareInfoSchema = z.object({ platform: z.string(), arch: z.string(), totalRamGb: z.number(), cpuCount: z.number(), isAppleSilicon: z.boolean(), unifiedMemoryGb: z.number(), cudaDevices: z.array(CudaDeviceSchema), freeDiskBytes: z.number().nullable(), totalDiskBytes: z.number().nullable(), osVersion: z.string() });
const ProfileTierSchema = z.object({ id: z.enum(["p16", "p32", "p64", "p128"]), label: z.string(), minUnifiedGb: z.number(), minVramGb: z.number(), resident: z.array(RoleIdSchema), onDemand: z.array(RoleIdSchema), installedOnly: z.array(RoleIdSchema), notAvailable: z.array(RoleIdSchema), speedRange: z.object({ min: z.number(), max: z.number() }) });
const BudgetSchema = z.object({ totalMemoryBytes: z.number().int(), capBytes: z.number().int(), freeMemoryBytes: z.number().int(), availablePercent: z.number(), pressure: z.enum(["normal", "warn", "critical"]), memoryReadingDegraded: z.boolean(), tier: z.enum(["p16", "p32", "p64", "p128"]), margin_bytes: z.number().int(), reading_degraded: z.boolean(), loaded: z.array(z.object({ id: z.string(), kind: z.enum(["resident", "jit", "generator"]), peakBytes: z.number().int(), measured: z.boolean(), lastUsedAt: z.string(), idleTtlSeconds: z.number().int(), pinned: z.boolean(), pid: z.number().int().nullable() })), queue: z.array(z.object({ id: z.string(), position: z.number().int(), kind: z.enum(["resident", "jit", "generator"]) })) });

const hardwareRoute = createRoute({ method: "get", path: "/", tags: ["Hardware"], summary: "Hardware facts and the proposed profile", responses: { 200: { content: { "application/json": { schema: z.object({ hardware: HardwareInfoSchema, proposed: ProfileTierSchema.nullable(), tiers: z.array(ProfileTierSchema) }) } }, description: "The probe's facts (no computer name) and the tier this machine clears." } } });
const budgetRoute = createRoute({ method: "get", path: "/budget", tags: ["Hardware"], summary: "The memory governor's budget and loaded set", responses: { 200: { content: { "application/json": { schema: BudgetSchema } }, description: "Cap, free memory, pressure, loaded models and the queue." } } });
const decisionsRoute = createRoute({ method: "get", path: "/budget/decisions", tags: ["Hardware"], summary: "The governor's last 200 decisions", responses: { 200: { content: { "application/json": { schema: z.object({ decisions: z.array(z.object({ at: z.string(), decision: z.string(), reason: z.string(), model: z.string() })) }) } }, description: "Newest first." } } });

export const hardwareRoutes = apiRouter<AppEnv>();
hardwareRoutes.openapi(hardwareRoute, async (c) => {
  const { computerName: _computerName, freeDiskBytes, totalDiskBytes, ...hardware } = await detectHardware();
  return c.json({ hardware: { ...hardware, freeDiskBytes: freeDiskBytes ?? null, totalDiskBytes: totalDiskBytes ?? null }, proposed: proposeProfile({ ...hardware, freeDiskBytes, totalDiskBytes }), tiers: PROFILE_TIERS }, 200);
});
hardwareRoutes.openapi(budgetRoute, (c) => {
  const status = getGovernorStatus();
  return c.json({ ...status, margin_bytes: status.marginBytes, reading_degraded: status.memoryReadingDegraded }, 200);
});
hardwareRoutes.openapi(decisionsRoute, (c) => c.json({ decisions: getGovernorDecisions() }, 200));
