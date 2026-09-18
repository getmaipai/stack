import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { requireOperator } from "@/lib/operator";
import { detectHardware } from "@/lib/hardware";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, selectEngineBinary } from "@/lib/engineCatalog";
import { engineDir, engineIsBound, ensureEngine, removeEngine } from "@/lib/engineInstall";
import { currentEngine, swapEngine } from "@/updates/engines";
import { deriveEngineVersionState } from "@/lib/engineState";
import { readEngineConfig, updateEngineConfig } from "@/settings/engineKeys";
import { getChatBackend, getChatEngineStatus, restartChatEngine, stopChatEngine } from "@/lib/supervisor";
import { readEngineIdentity } from "@/lib/identity";
import { emit } from "@/lib/events";

const EngineSchema = z.object({
  id: z.string(),
  label: z.string(),
  platform: z.enum(["darwin", "win32"]),
  arch: z.enum(["arm64", "x64"]),
  verified: z.boolean(),
  installed: z.boolean(),
  matchesThisMachine: z.boolean(),
  running: z.string().nullable(),
  currentTag: z.string().nullable(),
  newestTag: z.string().nullable(),
  current: z.boolean(),
  notCurrent: z.boolean(),
  needsRestart: z.boolean(),
  state: z.enum(["current", "notCurrent"]),
  stateReason: z.enum(["newer installed", "newer available"]).nullable(),
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
  const status = getChatEngineStatus();
  return c.json({ engines: ENGINE_BINARIES.map((pin) => ({
    ...(() => {
      const marker = pin.id.indexOf("-b");
      const name = marker > 0 ? pin.id.slice(0, marker) : pin.id;
      const newestTag = marker > 0 ? pin.id.slice(marker + 1).split("-")[0] ?? null : null;
      const currentTag = currentEngine(name);
      const running = status.kind === "spawned" ? status.identity?.build ?? null : null;
      const needsRestart = readEngineConfig(name).some((setting) => setting.pending !== null);
      return deriveEngineVersionState({ running, currentTag, newestTag, needsRestart });
    })(),
    id: pin.id,
    label: pin.label,
    platform: pin.platform,
    arch: pin.arch,
    verified: pin.verified,
    installed: existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER)),
    matchesThisMachine: pin.id === selected,
  })) }, 200);
});

const nameParam = z.object({ name: z.string().openapi({ param: { name: "name", in: "path" } }) });
const tagBody = { body: { content: { "application/json": { schema: z.object({ tag: z.string() }) } } } };
const settingSchema = z.object({
  key: z.string(), type: z.enum(["number", "boolean", "text"]), default: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string(), help: z.string(), disclosure: z.enum(["basic", "advanced", "developer"]), needsRestart: z.boolean(),
  inEffect: z.union([z.string(), z.number(), z.boolean()]), pending: z.union([z.string(), z.number(), z.boolean()]).nullable(),
});
const configRoute = createRoute({
  method: "get", path: "/{name}/config", tags: ["Engines"], summary: "Read engine configuration", middleware: [requireOperator] as const,
  request: { params: nameParam },
  responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(settingSchema) }) } }, description: "Declared and effective engine settings." } },
});
enginesRoutes.openapi(configRoute, (c) => c.json({ settings: readEngineConfig(c.req.valid("param").name) }, 200));

const updateConfigRoute = createRoute({ method: "put", path: "/{name}/config", tags: ["Engines"], summary: "Update engine configuration", middleware: [requireOperator] as const, request: { params: nameParam, body: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ settings: z.array(z.unknown()) }) } }, description: "Pending engine configuration." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid engine configuration." } } });
enginesRoutes.openapi(updateConfigRoute, (c) => { try { const { name } = c.req.valid("param"); return c.json({ settings: updateEngineConfig(name, c.req.valid("json")) }, 200); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid engine configuration" }, 400); } });

const controlRoute = (action: "start" | "stop" | "restart" | "probe") => createRoute({ method: "post", path: `/{name}/${action}`, tags: ["Engines"], summary: `${action} engine`, middleware: [requireOperator] as const, request: { params: nameParam }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), healthy: z.boolean().optional() }) } }, description: "Engine control completed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Engine control failed." } } });
for (const action of ["start", "stop", "restart", "probe"] as const) enginesRoutes.openapi(controlRoute(action), async (c) => {
  const { name } = c.req.valid("param");
  if (action === "start") await getChatBackend();
  else if (action === "stop") await stopChatEngine();
  else if (action === "restart") await restartChatEngine();
  else {
    const host = process.env.STACK_MANAGED_ENGINE_URL ?? process.env.MAIPAI_LLAMA_SERVER_URL;
    if (!host) return c.json({ error: "No managed engine host is configured." }, 400);
    const identity = await readEngineIdentity(host);
    return c.json({ ok: true as const, healthy: identity.healthy ?? false }, 200);
  }
  return c.json({ ok: true as const }, 200);
});

const installRoute = createRoute({ method: "post", path: "/{name}/install", tags: ["Engines"], summary: "Install an engine build", middleware: [requireOperator] as const, request: { params: nameParam, ...tagBody }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Engine installed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Engine install failed." } } });
enginesRoutes.openapi(installRoute, async (c) => {
  const { name } = c.req.valid("param"); const { tag } = c.req.valid("json"); const pin = ENGINE_BINARIES.find((entry) => entry.id.startsWith(`${name}-${tag}-`));
  if (!pin) return c.json({ error: `No pinned build exists for ${name} ${tag}.` }, 400);
  await ensureEngine(pin, (completedBytes, totalBytes, label) => emit({ id: "job.progress", data: { job: "engine-install", engine: name, tag, completedBytes, totalBytes, label } }));
  return c.json({ ok: true as const }, 200);
});

const currentRoute = createRoute({ method: "post", path: "/{name}/current", tags: ["Engines"], summary: "Make an installed engine current", middleware: [requireOperator] as const, request: { params: nameParam, ...tagBody }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Engine made current." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Engine swap failed." } } });
enginesRoutes.openapi(currentRoute, async (c) => { const { name } = c.req.valid("param"); const { tag } = c.req.valid("json"); await swapEngine(name, tag, { drain: () => stopChatEngine(), postLoadCheck: async () => { await restartChatEngine(); return true; } }); return c.json({ ok: true as const }, 200); });

const removeEngineRoute = createRoute({
  method: "delete",
  path: "/{name}/builds/{tag}",
  tags: ["Engines"],
  summary: "Remove an engine tag",
  middleware: [requireOperator] as const,
  request: { params: z.object({ name: z.string().openapi({ param: { name: "name", in: "path" } }), tag: z.string().openapi({ param: { name: "tag", in: "path" } }) }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Engine removed." },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "The build is current or bound." },
    404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown engine tag." },
  },
});
enginesRoutes.openapi(removeEngineRoute, (c) => { const { name, tag } = c.req.valid("param"); if (currentEngine(name) === tag) return c.json({ error: "The current engine build cannot be removed." }, 400); if (engineIsBound(name, tag)) return c.json({ error: "This engine build is bound to an installed model." }, 400); if (!removeEngine(name, tag)) return c.json({ error: "Unknown engine tag" }, 404); return c.json({ ok: true as const }, 200); });
