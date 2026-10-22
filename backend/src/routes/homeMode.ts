import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { homeModeView, selfTest, switchHomeMode } from "@/lib/homeMode";

const Checks = z.object({ engine: z.boolean(), pieces: z.boolean(), hardware: z.boolean(), memory: z.boolean(), bench: z.boolean() });
const View = z.object({
  mode: z.enum(["normal", "coding"]), target: z.enum(["normal", "coding"]), state: z.enum(["stable", "waiting", "switching", "failed"]),
  reason: z.string().nullable(), available: z.boolean(), checks: Checks,
  self_test: z.object({ passed_at: z.string().nullable(), stale: z.boolean() }),
  memory: z.object({ plan_bytes: z.number(), budget_bytes: z.number() }),
});
const getRoute = createRoute({
  method: "get", path: "/coding/mode", tags: ["Coding"], summary: "Home's current mode switch status",
  responses: { 200: { content: { "application/json": { schema: View } }, description: "Mode, transition, availability checks, self-test and memory plan." } },
});
const changeRoute = createRoute({
  method: "post", path: "/coding/mode", tags: ["Coding"], summary: "Change Home mode",
  request: { body: { content: { "application/json": { schema: z.object({ mode: z.enum(["normal", "coding"]) }).strict() } } } },
  responses: {
    202: { content: { "application/json": { schema: z.object({ accepted: z.literal(true) }) } }, description: "The mode transaction has started." },
    400: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "The mode is invalid." },
    409: { content: { "application/json": { schema: z.object({ reason: z.string() }) } }, description: "A switch is active or the requested mode is unavailable." },
  },
});
const selfTestRoute = createRoute({
  method: "post", path: "/coding/mode/self-test", tags: ["Coding"], summary: "Run the Home mode self-test",
  responses: { 202: { content: { "application/json": { schema: z.object({ accepted: z.literal(true) }) } }, description: "The self-test has started." } },
});

export const homeModeRoutes = apiRouter<AppEnv>();
homeModeRoutes.openapi(getRoute, (c) => c.json(homeModeView(), 200));
homeModeRoutes.openapi(changeRoute, (c) => {
  const { mode } = c.req.valid("json");
  const view = homeModeView();
  if (view.state === "switching" || (view.state === "waiting" && mode !== "normal")) return c.json({ reason: "A Home mode change is already running." }, 409);
  if (mode === view.mode && view.state !== "waiting") return c.json({ reason: `Home is already in ${mode} mode.` }, 409);
  if (mode === "coding" && !view.available) return c.json({ reason: view.reason ?? "The large coding mode is not available on this computer." }, 409);
  void switchHomeMode(mode).catch(() => {});
  return c.json({ accepted: true as const }, 202);
});
homeModeRoutes.openapi(selfTestRoute, (c) => { void selfTest(); return c.json({ accepted: true as const }, 202); });
