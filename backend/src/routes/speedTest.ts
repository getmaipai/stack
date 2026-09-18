import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { residentChatModel, runSpeedTest } from "@/lib/speedTest";
import { showroom, showroomSeries } from "@/showroom/fixture";

const SpeedResultSchema = z.object({
  at: z.string(),
  ability: z.string().nullable(),
  modelId: z.string().nullable(),
  engine: z.string().nullable(),
  firstTokenMs: z.number().int().nullable(),
  loadMs: z.number().int().nullable(),
  measuredFootprintBytes: z.number().int().nullable(),
  promptTps: z.number().int().nullable(),
  tokensPerSecond: z.number().int().nullable(),
  contextLength: z.number().int().nullable(),
});

const speedTestRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Overview"],
  summary: "Run the local chat speed test",
  middleware: [requireOperator] as const,
  responses: {
    200: { content: { "application/json": { schema: z.object({ result: SpeedResultSchema }) } }, description: "The recorded speed test result." },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "No resident chat model is available." },
  },
});

export const speedTestRoutes = apiRouter();
speedTestRoutes.openapi(speedTestRoute, async (c) => {
  if (showroom()) {
    const result = showroomSeries("day").speed.at(-1);
    return result ? c.json({ result: { ...result, loadMs: 1_420, measuredFootprintBytes: 21_600_000_000, promptTps: 112, contextLength: 8192 } } as never, 200) : c.json({ error: "No speed result is available." }, 400);
  }
  const model = residentChatModel();
  if (!model) return c.json({ error: "No installed resident chat model is available." }, 400);
  try {
    return c.json({ result: await runSpeedTest(model) } as never, 200);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "The speed test failed." }, 400);
  }
});
