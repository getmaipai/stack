import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { readNetworkSignal } from "@/lib/network";

const networkSignalSchema = z.object({
  interface: z.string().nullable(),
  linkMbps: z.number().nullable(),
  gatewayMs: z.number().nullable(),
  measuredAt: z.string(),
});

const networkRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Monitoring"],
  summary: "Get the network signal to the default gateway",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: { "application/json": { schema: networkSignalSchema } },
      description: "The default interface, its link speed, and the round trip to the gateway.",
    },
  },
});

export const networkRoutes = apiRouter();
networkRoutes.openapi(networkRoute, async (c) => {
  const signal = await readNetworkSignal();
  return c.json(signal, 200);
});
