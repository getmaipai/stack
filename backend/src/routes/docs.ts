import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { updatesEnabled } from "@/updates/check";

const docsRoute = createRoute({ method: "get", path: "/search", tags: ["Docs"], summary: "Search the Stack user docs", middleware: [requireClientOrOperator] as const, request: { query: z.object({ q: z.string().default("") }) }, responses: { 200: { content: { "application/json": { schema: z.object({ enabled: z.boolean(), results: z.array(z.object({ title: z.string(), url: z.string(), excerpt: z.string() })) }) } }, description: "Search results from the local or remote docs index." } } });

export const docsRoutes = apiRouter();
docsRoutes.openapi(docsRoute, async (c) => {
  const query = c.req.valid("query").q.trim();
  if (!updatesEnabled() || !query) return c.json({ enabled: false, results: [] }, 200);
  const response = await fetch("https://getmaipai.github.io/stack/pagefind/pagefind-entry.json", { headers: { "if-none-match": "", "user-agent": "maipai-stack/0.1.0" } }).catch(() => null);
  if (!response?.ok) return c.json({ enabled: true, results: [] }, 200);
  return c.json({ enabled: true, results: [] }, 200);
});
