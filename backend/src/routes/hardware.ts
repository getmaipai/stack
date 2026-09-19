import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { detectHardware } from "@/lib/hardware";
import { PROFILE_TIERS, proposeProfile, type ProfileTier, type RoleId } from "@/profiles";
import { showroom, showroomHardware, showroomProfile } from "@/showroom/fixture";
import { getLastLiveSample } from "@/lib/live";

const RoleIdSchema = z.enum(["chat", "coding", "judge", "router", "embed", "rerank", "vision", "stt", "tts", "wakeword", "image", "video", "music"]);
const CudaDeviceSchema = z.object({
  index: z.number(),
  name: z.string(),
  vramBytes: z.number(),
  usedVramBytes: z.number().optional(),
  utilizationPct: z.number().optional(),
});
const HardwareInfoSchema = z.object({
  computerName: z.string(),
  platform: z.string(),
  arch: z.string(),
  totalRamGb: z.number(),
  cpuCount: z.number(),
  isAppleSilicon: z.boolean(),
  unifiedMemoryGb: z.number(),
  cudaDevices: z.array(CudaDeviceSchema),
  freeDiskBytes: z.number(),
  totalDiskBytes: z.number(),
  osVersion: z.string(),
  drives: z.array(z.object({ name: z.string(), mount: z.string(), usedBytes: z.number(), totalBytes: z.number(), mounted: z.boolean() })),
});
const ProfileTierSchema = z.object({
  id: z.enum(["p16", "p32", "p64", "p128"]),
  label: z.string(),
  minUnifiedGb: z.number(),
  minVramGb: z.number(),
  resident: z.array(RoleIdSchema),
  onDemand: z.array(RoleIdSchema),
  installedOnly: z.array(RoleIdSchema),
  notAvailable: z.array(RoleIdSchema),
  speedRange: z.object({ min: z.number(), max: z.number() }),
});

const hardwareRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Hardware"],
  summary: "Hardware facts and the proposed profile",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            hardware: HardwareInfoSchema,
            proposed: ProfileTierSchema.nullable(),
            tiers: z.array(ProfileTierSchema),
          }),
        },
      },
      description: "The detected hardware and profile choices.",
    },
  },
});

export const hardwareRoutes = apiRouter();
hardwareRoutes.openapi(hardwareRoute, async (c) => {
  if (showroom()) return c.json({ hardware: showroomHardware, proposed: showroomProfile, tiers: PROFILE_TIERS } as never, 200);
  const hardware = await detectHardware();
  const sample = getLastLiveSample();
  const drives = sample?.drives ?? [];
  return c.json({ hardware: { ...hardware, computerName: hardware.computerName ?? "This computer", totalDiskBytes: hardware.totalDiskBytes ?? 0, drives }, proposed: proposeProfile(hardware), tiers: PROFILE_TIERS }, 200);
});

export type { ProfileTier, RoleId };
