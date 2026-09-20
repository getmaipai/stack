import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { readResourceSeries, readSeries, type SeriesRange } from "@/lib/series";
import { showroom, showroomResourceSeries, showroomSeries } from "@/showroom/fixture";

const SampleSchema = z.object({ at: z.string(), ability: z.string().nullable().optional(), clientId: z.string().nullable().optional(), modelId: z.string().nullable().optional(), requests: z.number().int().optional(), tokensIn: z.number().int().optional(), tokensOut: z.number().int().optional(), jobs: z.number().int().optional(), totalBytes: z.number().int().optional(), freeBytes: z.number().int().optional(), availablePercent: z.number().int().optional(), pressure: z.string().optional(), loadedBytes: z.number().int().optional(), engine: z.string().nullable().optional(), firstTokenMs: z.number().int().nullable().optional(), tokensPerSecond: z.number().int().nullable().optional() });
const SeriesSchema = z.object({ range: z.enum(["hour", "day", "week"]), usage: z.array(SampleSchema), memory: z.array(SampleSchema), speed: z.array(SampleSchema) });
const seriesRoute = createRoute({ method: "get", path: "/", tags: ["Overview"], summary: "Usage, memory, and speed series", middleware: [requireClientOrOperator] as const, request: { query: z.object({ range: z.enum(["hour", "day", "week"]).default("day"), window: z.string().optional(), metric: z.enum(["usage", "memory", "speed"]).optional() }) }, responses: { 200: { content: { "application/json": { schema: SeriesSchema } }, description: "Local dashboard series for the selected range." } } });

export const seriesRoutes = apiRouter();
seriesRoutes.openapi(seriesRoute, (c) => {
  const range = c.req.valid("query").range;
  const data = showroom() ? showroomSeries(range) : readSeries(range);
  return c.json({ range, ...data } as never, 200);
});

const ResourceBucketSchema = z.object({ at: z.string(), percent: z.number().nullable(), usedBytes: z.number().nullable(), totalBytes: z.number().nullable() });
const ResourceGpuDeviceSchema = z.object({ index: z.number(), name: z.string(), utilization: z.number().nullable(), memoryUsedBytes: z.number().nullable(), memoryTotalBytes: z.number().nullable() });
const ResourceDriveDeviceSchema = z.object({ name: z.string(), usedBytes: z.number(), totalBytes: z.number() });
const ResourceSeriesSchema = z.object({
  range: z.enum(["hour", "day", "week", "month"]),
  cpu: z.array(ResourceBucketSchema),
  memory: z.array(ResourceBucketSchema),
  gpu: z.array(ResourceBucketSchema),
  storage: z.array(ResourceBucketSchema),
  devices: z.object({ gpus: z.array(ResourceGpuDeviceSchema), drives: z.array(ResourceDriveDeviceSchema) }),
});
const resourceSeriesRoute = createRoute({
  method: "get",
  path: "/resources",
  tags: ["Monitoring"],
  summary: "CPU, memory, GPU, and storage history",
  middleware: [requireClientOrOperator] as const,
  request: { query: z.object({ range: z.enum(["hour", "day", "week", "month"]).default("hour") }) },
  responses: { 200: { content: { "application/json": { schema: ResourceSeriesSchema } }, description: "Bucketed resource history, with nulls where no sample exists." } },
});
seriesRoutes.openapi(resourceSeriesRoute, (c) => {
  const range = c.req.valid("query").range as SeriesRange;
  const data = showroom() ? showroomResourceSeries(range) : readResourceSeries(range);
  return c.json({ range, ...data }, 200);
});
