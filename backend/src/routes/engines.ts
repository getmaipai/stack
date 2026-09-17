import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { detectHardware } from "@/lib/hardware";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, selectEngineBinary } from "@/lib/engineCatalog";
import { engineDir } from "@/lib/engineInstall";

const EngineSchema = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.enum(["darwin", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  verified: z.boolean(),
  installed: z.boolean(),
  matchesThisMachine: z.boolean(),
});
const enginesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Engines"],
  summary: "Pinned engine builds",
  middleware: [requireClientOrOperator] as const,
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ engines: z.array(EngineSchema) }) } },
      description: "Pinned builds and their local installation state.",
    },
  },
});

export const enginesRoutes = apiRouter();
enginesRoutes.openapi(enginesRoute, async (c) => {
  const hardware = await detectHardware();
  const selected = selectEngineBinary(hardware)?.id;
  return c.json({ engines: ENGINE_BINARIES.map((pin) => ({
    id: pin.id,
    label: pin.label,
    platform: pin.platform,
    arch: pin.arch,
    verified: pin.verified,
    installed: existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER)),
    matchesThisMachine: pin.id === selected,
  })) }, 200);
});
