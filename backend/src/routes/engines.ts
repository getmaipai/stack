// Pinned engine builds and the actions behind Home's buttons. Version
// state is derived from the running build, the store's `current` link
// and the newest pin for this machine, never stored.
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, selectEngineBinary, type EngineBinaryPin } from "@/lib/engineCatalog";
import { engineDir, engineIsBound, ensureEngine, removeEngine } from "@/lib/engineInstall";
import { currentEngine, swapEngine } from "@/updates/engines";
import { deriveEngineVersionState } from "@/lib/engineState";
import { getProcess, getRoleStatus, restartRole, roleCanBeStartedByStack, stopRole, EngineUnavailableError } from "@/lib/supervisor";
import { readSettings } from "@/settings";
import { createJob, finishJob, jobSignal, updateJob } from "@/lib/jobs";
import { emit } from "@/lib/events";

const EngineSchema = z.object({
  id: z.string(), name: z.string(), label: z.string(), platform: z.string(), arch: z.string(), verified: z.boolean(),
  installed: z.boolean(), matchesThisMachine: z.boolean(), running: z.string().nullable(), currentTag: z.string().nullable(), newestTag: z.string().nullable(),
  current: z.boolean(), notCurrent: z.boolean(), needsRestart: z.boolean(), state: z.enum(["current", "notCurrent"]), stateReason: z.enum(["newer installed", "newer available"]).nullable(),
  directory: z.string(), roleState: z.string(), roleReason: z.string().nullable(),
});
const nameParam = z.object({ name: z.string().openapi({ param: { name: "name", in: "path" }, example: "llama-server" }) });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Engines"], summary: "Pinned engine builds and their state", responses: { 200: { content: { "application/json": { schema: z.object({ engines: z.array(EngineSchema) }) } }, description: "Every pin, its install state and derived version state." } } });
const installRoute = createRoute({ method: "post", path: "/{name}/install", tags: ["Engines"], summary: "Install a pinned build (progress on the event feed)", request: { params: nameParam, body: { content: { "application/json": { schema: z.object({ tag: z.string().optional() }) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: z.string(), engine: z.string() }) } }, description: "The download job." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No pin for that engine on this machine." } } });
const controlRoute = (action: "start" | "stop" | "restart") => createRoute({ method: "post", path: `/{name}/${action}`, tags: ["Engines"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} an engine`, request: { params: nameParam }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), reason: z.string().optional() }) } }, description: "The outcome." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown engine." } } });
const currentRoute = createRoute({ method: "put", path: "/{name}/current", tags: ["Engines"], summary: "Select an installed build (drain, swap, post-load check, rollback on failure)", request: { params: nameParam, body: { content: { "application/json": { schema: z.object({ tag: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), tag: z.string() }) } }, description: "The build is current." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is not installed or the swap failed and was rolled back." } } });
const removeRoute = createRoute({ method: "delete", path: "/{name}/builds/{tag}", tags: ["Engines"], summary: "Remove an installed build that is not current", request: { params: z.object({ name: z.string().openapi({ param: { name: "name", in: "path" } }), tag: z.string().openapi({ param: { name: "tag", in: "path" } }) }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The current build cannot be removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown build." } } });

function engineName(pin: EngineBinaryPin): string { const marker = pin.id.indexOf("-b"); return marker > 0 ? pin.id.slice(0, marker) : pin.id; }
function engineTag(pin: EngineBinaryPin): string { const marker = pin.id.indexOf("-b"); return marker > 0 ? pin.id.slice(marker + 1) : "legacy"; }

export const enginesRoutes = apiRouter<AppEnv>();
enginesRoutes.openapi(listRoute, async (c) => {
  const hardware = await detectHardware();
  const selected = selectEngineBinary(hardware);
  const needsRestart = readSettings().some((setting) => setting.key.startsWith("engines.llama-server.") && setting.pending !== null);
  const status = getRoleStatus("chat");
  return c.json({ engines: ENGINE_BINARIES.map((pin) => {
    const name = engineName(pin);
    const version = deriveEngineVersionState({ running: status.identity?.build ?? null, currentTag: currentEngine(name), newestTag: selected?.id === pin.id ? engineTag(pin) : null, needsRestart });
    return { id: pin.id, name, label: pin.label, platform: pin.platform, arch: pin.arch, verified: pin.verified, installed: existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER)), matchesThisMachine: selected?.id === pin.id, ...version, directory: engineDir(pin.id), roleState: status.state, roleReason: status.reason };
  }) }, 200);
});
enginesRoutes.openapi(installRoute, async (c) => {
  const { name } = c.req.valid("param");
  const hardware = await detectHardware();
  const pin = ENGINE_BINARIES.find((candidate) => engineName(candidate) === name && candidate.platform === hardware.platform && candidate.arch === hardware.arch && (!candidate.requiresNvidia || hardware.cudaDevices.length > 0));
  if (!pin) return c.json({ error: `No pinned ${name} build for this machine.` }, 404);
  const job = createJob({ kind: "engine.install", totalBytes: pin.archive.approxBytes, status: "downloading", input: { engine: pin.id } });
  void ensureEngine(pin, (completed, total) => { updateJob(job.id, { completedBytes: completed, totalBytes: total || pin.archive.approxBytes, status: "downloading" }); }, { signal: jobSignal(job.id) })
    .then(() => { finishJob(job.id, { ok: true, result: { engine: pin.id } }); emit({ id: "engine.state", data: { engine: name, state: "installed" } }); })
    .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
  return c.json({ job: job.id, engine: pin.id }, 202);
});
for (const action of ["start", "stop", "restart"] as const) enginesRoutes.openapi(controlRoute(action), async (c) => {
  const { name } = c.req.valid("param");
  if (!ENGINE_BINARIES.some((pin) => engineName(pin) === name)) return c.json({ error: "Unknown engine" }, 404);
  try {
    if (action === "stop") { await stopRole("chat"); return c.json({ ok: true }, 200); }
    if (action === "restart") { await restartRole("chat"); await getProcess("chat"); return c.json({ ok: true }, 200); }
    const status = getRoleStatus("chat");
    if (status.state === "ready" || status.state === "busy" || status.state === "loading") return c.json({ ok: true, reason: "Already running." }, 200);
    if (!roleCanBeStartedByStack("chat") && status.state !== "stopped") return c.json({ ok: false, reason: "The chat role is bound to a server the Stack does not start." }, 200);
    await restartRole("chat"); await getProcess("chat");
    return c.json({ ok: true }, 200);
  } catch (error) {
    return c.json({ ok: false, reason: error instanceof EngineUnavailableError ? error.reason : (error as Error).message }, 200);
  }
});
enginesRoutes.openapi(currentRoute, async (c) => {
  const { name } = c.req.valid("param"); const { tag } = c.req.valid("json");
  try {
    await swapEngine(name, tag, { drain: () => stopRole("chat", "Draining for an engine change."), postLoadCheck: async () => { await restartRole("chat"); await getProcess("chat"); return true; } });
    return c.json({ ok: true as const, tag }, 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
enginesRoutes.openapi(removeRoute, (c) => {
  const { name, tag } = c.req.valid("param");
  if (currentEngine(name) === tag) return c.json({ error: "The current engine build cannot be removed." }, 400);
  if (engineIsBound(name, tag) && currentEngine(name) === null) return c.json({ error: "A model still names this engine." }, 400);
  return removeEngine(name, tag) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown build" }, 404);
});
