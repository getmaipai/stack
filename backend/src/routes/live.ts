import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { getLastLiveSample } from "@/lib/live";
import { showroom, showroomLive } from "@/showroom/fixture";

const liveGpuSchema = z.object({
  name: z.string(),
  memoryUsedBytes: z.number().nullable(),
  memoryTotalBytes: z.number().nullable(),
  utilization: z.number().nullable(),
});

const liveProcessSchema = z.object({
  engine: z.string(),
  build: z.string(),
  model: z.string().nullable(),
  port: z.number().nullable(),
  memoryFootprintBytes: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  pid: z.number(),
  startedAt: z.string().nullable(),
});

const liveDriveSchema = z.object({
  name: z.string(),
  mount: z.string(),
  usedBytes: z.number(),
  totalBytes: z.number(),
  mounted: z.boolean(),
});

const liveClientSchema = z.object({
  name: z.string(),
  roles: z.array(z.string()),
  requestCount: z.number(),
  lastRequestAt: z.string(),
});

const liveSampleSchema = z.object({
  processes: z.array(liveProcessSchema),
  gpus: z.array(liveGpuSchema),
  cpu: z.object({ percent: z.number().nullable() }),
  drives: z.array(liveDriveSchema),
  clients: z.array(liveClientSchema),
  at: z.string(),
});

const liveRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Live"],
  summary: "Get the last live sample",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ live: liveSampleSchema }) } },
      description: "The last live sample of processes, GPUs, drives, and clients.",
    },
  },
});

export const liveRoutes = apiRouter();
liveRoutes.openapi(liveRoute, (c) => {
  if (showroom()) return c.json({ live: showroomLive } as never, 200);
  const sample = getLastLiveSample();
  if (!sample) {
    const empty = {
      processes: [],
      gpus: [],
      cpu: { percent: null },
      drives: [],
      clients: [],
      at: new Date().toISOString(),
    };
    return c.json({ live: empty }, 200);
  }
  return c.json({ live: sample }, 200);
});
