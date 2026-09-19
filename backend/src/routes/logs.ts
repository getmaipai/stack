import { createRoute, z } from "@hono/zod-openapi";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { dataDir } from "@/lib/paths";

const route = createRoute({ method: "get", path: "/{name}", tags: ["Logs"], middleware: [requireOperator] as const, request: { params: z.object({ name: z.string() }), query: z.object({ tail: z.coerce.number().int().positive().max(10_000).optional() }) }, responses: { 200: { content: { "text/plain": { schema: z.string() } }, description: "Tail of an operator log." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown log." } } });
export const logsRoutes = apiRouter();
logsRoutes.get("/", requireOperator, (c) => {
  const path = join(dataDir, "logs", "stack.log");
  if (!existsSync(path)) return c.json({ lines: [] });
  return c.json({ lines: readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-200) });
});
logsRoutes.openapi(route, (c) => {
  const name = c.req.valid("param").name;
  const path = join(dataDir, "logs", `${name}.log`);
  if (!existsSync(path)) return c.json({ error: "Unknown log" }, 404);
  const lines = readFileSync(path, "utf8").split("\n");
  const tail = c.req.valid("query").tail ?? 200;
  return new Response(lines.slice(-tail).join("\n"), { headers: { "content-type": "text/plain" } }) as never;
});
