import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { helperToolRegistry } from "@/lib/helperTools";

const helperRoute = createRoute({ method: "post", path: "/", tags: ["Helper"], summary: "Ask the local helper", middleware: [requireOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ question: z.string().min(1) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ answer: z.string(), source: z.enum(["health", "helper"]) }) } }, description: "A local helper answer." } } });

export const helperRoutes = apiRouter();
helperRoutes.openapi(helperRoute, (c) => {
  const question = c.req.valid("json").question.toLocaleLowerCase();
  const health = (helperToolRegistry().find((tool) => tool.name === "health")?.run() ?? []) as Array<{ code: string; title: string; text: string }>;
  if (question.includes("chat") && (question.includes("offline") || question.includes("why"))) {
    const item = health.find((entry) => entry.code.includes("engine") || entry.title.toLocaleLowerCase().includes("chat"));
    return c.json({ answer: item ? `${item.title}: ${item.text}` : "Chat is offline, and the health list has no active explanation.", source: "health" as const }, 200);
  }
  return c.json({ answer: "The helper is model-free by default and can answer from this Stack's health and documentation.", source: "helper" as const }, 200);
});
