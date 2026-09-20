// Pinned engine builds and the actions behind Home's buttons. Version
// state is derived from the running build, the store's `current` link
// and the newest pin for this machine, never stored.
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { ENGINE_BINARIES, ENGINE_READY_MARKER, engineRole, MANAGED_RUNTIMES, selectEngineBinary } from "@/lib/engineCatalog";
import { ensurePocketTtsEnvironment, pocketTtsInstalled, pocketTtsRoot, POCKET_TTS_NAME } from "@/speech/pocketTts";
import { comfyuiInstalled, comfyuiRoot, COMFYUI_NAME, ensureComfyuiEnvironment } from "@/generators/comfyui";
import { engineDir, engineIsBound, ensureEngine, removeEngine } from "@/lib/engineInstall";
import { readEngineManifest } from "@/lib/store/manifests";
import { currentEngine, stagingPin, swapEngine } from "@/updates/engines";
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
// With no body, the pin for this machine is installed and activated.
// With tag, url, sha256 and size, that archive is staged beside the
// current build under the tag and not activated: the first half of an
// update, or a rollback target; PUT /{name}/current does the swap.
const StageSchema = z.object({ tag: z.string().regex(/^b[0-9]+(-[0-9a-z-]+)?$/), url: z.string().url(), sha256: z.string().length(64), size: z.number().int().nonnegative() });
const installRoute = createRoute({ method: "post", path: "/{name}/install", tags: ["Engines"], summary: "Install this machine's pinned build, or stage a build by url and checksum (progress on the event feed)", request: { params: nameParam, body: { content: { "application/json": { schema: z.union([z.object({}).strict(), StageSchema]) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: z.string(), engine: z.string(), staged: z.boolean() }) } }, description: "The download job." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No pin for that engine on this machine." }, 409: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is already installed with a different checksum." } } });
const controlRoute = (action: "start" | "stop" | "restart") => createRoute({ method: "post", path: `/{name}/${action}`, tags: ["Engines"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} an engine`, request: { params: nameParam }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), reason: z.string().optional() }) } }, description: "The outcome." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown engine." } } });
const currentRoute = createRoute({ method: "put", path: "/{name}/current", tags: ["Engines"], summary: "Select an installed build (drain, swap, post-load check, rollback on failure)", request: { params: nameParam, body: { content: { "application/json": { schema: z.object({ tag: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), tag: z.string() }) } }, description: "The build is current." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is not installed or the swap failed and was rolled back." } } });
const removeRoute = createRoute({ method: "delete", path: "/{name}/builds/{tag}", tags: ["Engines"], summary: "Remove an installed build that is not current", request: { params: z.object({ name: z.string().openapi({ param: { name: "name", in: "path" } }), tag: z.string().openapi({ param: { name: "tag", in: "path" } }) }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The current build cannot be removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown build." } } });


export const enginesRoutes = apiRouter<AppEnv>();
/** The environment build in flight per engine, so two installs never
 * race on one venv and one engine's build never answers for another. */
const environmentJobs = new Map<string, string>();
enginesRoutes.openapi(listRoute, async (c) => {
  const hardware = await detectHardware();
  const needsRestart = readSettings().some((setting) => setting.key.startsWith("stack.engines.llama_server.") && setting.pending !== null);
  const pins = ENGINE_BINARIES.map((pin) => {
    // Each engine name has its own pin for this machine and its own role.
    const selected = selectEngineBinary(hardware, pin.name);
    const status = getRoleStatus(engineRole(pin.name));
    // A tool pin (uv) never runs as the role's engine; only a server
    // build's running identity is compared with its tag.
    const running = pin.tool && pin.tool !== "llama-server" ? null : status.identity?.build ?? null;
    const version = deriveEngineVersionState({ running, currentTag: currentEngine(pin.name), newestTag: selected?.id === pin.id ? pin.tag : null, needsRestart: pin.name === "llama-server" && needsRestart });
    return { id: pin.id, name: pin.name, label: pin.label, platform: pin.platform, arch: pin.arch, verified: pin.verified, installed: existsSync(join(engineDir(pin), ENGINE_READY_MARKER)), matchesThisMachine: selected?.id === pin.id, ...version, directory: engineDir(pin), roleState: status.state, roleReason: status.reason };
  });
  // The managed runtimes the Stack assembles (Pocket TTS): one row each,
  // on every platform, installed when the environment is built.
  const managed = MANAGED_RUNTIMES.map((runtime) => {
    const status = getRoleStatus(engineRole(runtime.name));
    const installed = runtime.name === POCKET_TTS_NAME ? pocketTtsInstalled() : runtime.name === COMFYUI_NAME ? comfyuiInstalled() : false;
    const version = deriveEngineVersionState({ running: status.identity?.build ?? null, currentTag: installed ? runtime.version : null, newestTag: runtime.version, needsRestart: false });
    return { id: `${runtime.name}-${runtime.version}`, name: runtime.name, label: `${runtime.name} ${runtime.version}, an environment the Stack assembles through uv`, platform: process.platform, arch: process.arch, verified: true, installed, matchesThisMachine: true, ...version, directory: runtime.name === POCKET_TTS_NAME ? pocketTtsRoot() : runtime.name === COMFYUI_NAME ? comfyuiRoot() : "", roleState: status.state, roleReason: status.reason };
  });
  return c.json({ engines: [...pins, ...managed] }, 200);
});
enginesRoutes.openapi(installRoute, async (c) => {
  const { name } = c.req.valid("param");
  const body = c.req.valid("json");
  const staged = "tag" in body;
  if (name === POCKET_TTS_NAME) {
    // Not a download but a build: uv (a pinned build, fetched first if
    // missing), a managed Python, the hashed requirements synced. One
    // build at a time: a second request joins the job in flight.
    const inFlight = environmentJobs.get(POCKET_TTS_NAME);
    if (inFlight) return c.json({ job: inFlight, engine: POCKET_TTS_NAME, staged: false }, 202);
    const job = createJob({ kind: "engine.install", totalBytes: 0, status: "downloading", input: { engine: `${POCKET_TTS_NAME}-env` } });
    // The status is the phase (uv, python, packages): uv reports no byte
    // counts the job could show.
    environmentJobs.set(POCKET_TTS_NAME, job.id);
    void ensurePocketTtsEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) })
      .then(() => { finishJob(job.id, { ok: true, result: { engine: POCKET_TTS_NAME } }); emit({ id: "engine.state", data: { engine: POCKET_TTS_NAME, state: "installed" } }); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(POCKET_TTS_NAME); });
    return c.json({ job: job.id, engine: POCKET_TTS_NAME, staged: false }, 202);
  }
  if (!ENGINE_BINARIES.some((candidate) => candidate.name === name)) return c.json({ error: `Unknown engine ${name}.` }, 404);
  if (name === COMFYUI_NAME && !staged) {
    // The source archive (a pinned engine build, checksummed), then the
    // environment on top of it, one job; a second request joins it.
    const inFlight = environmentJobs.get(COMFYUI_NAME);
    if (inFlight) return c.json({ job: inFlight, engine: COMFYUI_NAME, staged: false }, 202);
    const hardware = await detectHardware();
    const pin = selectEngineBinary(hardware, COMFYUI_NAME);
    if (!pin) return c.json({ error: `No pinned ${name} build for this machine.` }, 404);
    const job = createJob({ kind: "engine.install", totalBytes: pin.archive.approxBytes, status: "downloading", input: { engine: pin.id } });
    environmentJobs.set(COMFYUI_NAME, job.id);
    void ensureEngine(pin, (completed, total) => { updateJob(job.id, { completedBytes: completed, totalBytes: total || pin.archive.approxBytes, status: "downloading" }); }, { signal: jobSignal(job.id), activate: true })
      .then(() => ensureComfyuiEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) }))
      .then(() => { finishJob(job.id, { ok: true, result: { engine: COMFYUI_NAME } }); emit({ id: "engine.state", data: { engine: COMFYUI_NAME, state: "installed" } }); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(COMFYUI_NAME); });
    return c.json({ job: job.id, engine: pin.id, staged: false }, 202);
  }
  const hardware = await detectHardware();
  const pin = staged
    ? stagingPin(name, body.tag, { url: body.url, sha256: body.sha256, size: body.size })
    : ENGINE_BINARIES.find((candidate) => candidate.name === name && candidate.platform === hardware.platform && candidate.arch === hardware.arch && (!candidate.requiresNvidia || hardware.cudaDevices.length > 0));
  if (!pin) return c.json({ error: `No pinned ${name} build for this machine.` }, 404);
  if (staged) {
    // A tag already on disk is what its manifest says it is; a request
    // naming the same tag with a different checksum is refused rather
    // than answered with a build the caller did not name.
    const existing = readEngineManifest(name, body.tag);
    if (existing && existing.sha256.toLowerCase() !== body.sha256.toLowerCase()) return c.json({ error: `Tag ${body.tag} is already installed with a different checksum.` }, 409);
  }
  const job = createJob({ kind: staged ? "engine.stage" : "engine.install", totalBytes: pin.archive.approxBytes, status: "downloading", input: { engine: pin.id } });
  void ensureEngine(pin, (completed, total) => { updateJob(job.id, { completedBytes: completed, totalBytes: total || pin.archive.approxBytes, status: "downloading" }); }, { signal: jobSignal(job.id), activate: !staged })
    .then(() => { finishJob(job.id, { ok: true, result: { engine: pin.id } }); if (!staged) emit({ id: "engine.state", data: { engine: name, state: "installed" } }); })
    .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
  return c.json({ job: job.id, engine: pin.id, staged }, 202);
});
for (const action of ["start", "stop", "restart"] as const) enginesRoutes.openapi(controlRoute(action), async (c) => {
  const { name } = c.req.valid("param");
  if (!ENGINE_BINARIES.some((pin) => pin.name === name) && !MANAGED_RUNTIMES.some((runtime) => runtime.name === name)) return c.json({ error: "Unknown engine" }, 404);
  const role = engineRole(name);
  try {
    if (action === "stop") { await stopRole(role); return c.json({ ok: true }, 200); }
    if (action === "restart") { await restartRole(role); await getProcess(role); return c.json({ ok: true }, 200); }
    const status = getRoleStatus(role);
    if (status.state === "ready" || status.state === "busy" || status.state === "loading") return c.json({ ok: true, reason: "Already running." }, 200);
    if (!roleCanBeStartedByStack(role) && status.state !== "stopped") return c.json({ ok: false, reason: `The ${role} role is bound to a server the Stack does not start.` }, 200);
    await restartRole(role); await getProcess(role);
    return c.json({ ok: true }, 200);
  } catch (error) {
    return c.json({ ok: false, reason: error instanceof EngineUnavailableError ? error.reason : (error as Error).message }, 200);
  }
});
enginesRoutes.openapi(currentRoute, async (c) => {
  const { name } = c.req.valid("param"); const { tag } = c.req.valid("json");
  try {
    const role = engineRole(name);
    await swapEngine(name, tag, { drain: () => stopRole(role, "Draining for an engine change."), postLoadCheck: async () => { await restartRole(role); await getProcess(role); return true; } });
    return c.json({ ok: true as const, tag }, 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
enginesRoutes.openapi(removeRoute, (c) => {
  const { name, tag } = c.req.valid("param");
  if (currentEngine(name) === tag) return c.json({ error: "The current engine build cannot be removed." }, 400);
  if (engineIsBound(name, tag) && currentEngine(name) === null) return c.json({ error: "A model still names this engine." }, 400);
  return removeEngine(name, tag) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown build" }, 404);
});
