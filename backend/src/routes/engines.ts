// Pinned engine builds and the actions behind Home's buttons. Version
// state is derived from the running build, the store's `current` link
// and the newest pin for this machine, never stored.
import { createRoute, z } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { detectHardware } from "@/lib/hardware";
import { CHAT_ENGINES, ENGINE_BINARIES, ENGINE_READY_MARKER, engineRole, MANAGED_RUNTIMES, selectEngineBinary, type ChatEngine } from "@/lib/engineCatalog";
import { ensurePocketTtsEnvironment, pocketTtsInstalled, pocketTtsRoot, POCKET_TTS_NAME } from "@/speech/pocketTts";
import { ensureMlxAudioEnvironment, mlxAudioInstalled, mlxAudioRoot, MLX_AUDIO_NAME } from "@/speech/mlxAudio";
import { ensureOmlxEnvironment, omlxInstalled, omlxRoot, OMLX_NAME } from "@/chat/omlx";
import { comfyuiInstalled, comfyuiRoot, COMFYUI_NAME, ensureComfyuiEnvironment } from "@/generators/comfyui";
import { ensureImageGenEnvironment, IMAGE_GEN_NAME, imageGen, imageGenEnvironmentReady } from "@/images/imageEngine";
import { ensureVideoGenEnvironment, videoGen, videoGenEnvironmentReady, videoGenRoot, VIDEO_GEN_NAME } from "@/video/videoGen";
import { ensureMusicGenEnvironment, musicGen, musicGenEnvironmentReady, musicGenRoot, MUSIC_GEN_NAME } from "@/music/musicGen";
import { engineRemovalRefusal } from "@/lib/engineRemoval";
import { engineDir, engineIsBound, ensureEngine, removeEngine } from "@/lib/engineInstall";
import { readEngineManifest } from "@/lib/store/manifests";
import { currentEngine, stagingPin, swapEngine } from "@/updates/engines";
import { deriveEngineVersionState } from "@/lib/engineState";
import { chatEngine, getProcess, getRoleStatus, restartForNewChatEngine, restartRole, roleCanBeStartedByStack, runningEngine, stopRole, EngineUnavailableError } from "@/lib/supervisor";
import { readSettings } from "@/settings";
import { createJob, finishJob, getJob, jobSignal, updateJob } from "@/lib/jobs";
import { emit } from "@/lib/events";
import { requestEngineRestart, selfHealSummary } from "@/lib/selfHeal";
import { metalHostFault } from "@/lib/hostProbe";
import { ROLE_IDS } from "@/roles";
import { EngineIndexEntrySchema } from "@/updates/catalog";

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
const StageSchema = z.object({ tag: EngineIndexEntrySchema.shape.tag, url: z.string().url(), sha256: z.string().length(64), size: z.number().int().nonnegative() });
const installRoute = createRoute({ method: "post", path: "/{name}/install", tags: ["Engines"], summary: "Install this machine's pinned build, or stage a build by url and checksum (progress on the event feed)", request: { params: nameParam, body: { content: { "application/json": { schema: z.union([z.object({}).strict(), StageSchema]) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: z.string(), engine: z.string(), staged: z.boolean() }) } }, description: "The download job." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "No pin for that engine on this machine." }, 409: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is already installed with a different checksum." } } });
const controlRoute = (action: "start" | "stop" | "restart") => createRoute({ method: "post", path: `/{name}/${action}`, tags: ["Engines"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} an engine`, request: { params: nameParam }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), reason: z.string().optional() }) } }, description: "The outcome." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown engine." } } });
const currentRoute = createRoute({ method: "put", path: "/{name}/current", tags: ["Engines"], summary: "Select an installed build (drain, swap, post-load check, rollback on failure)", request: { params: nameParam, body: { content: { "application/json": { schema: z.object({ tag: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), tag: z.string() }) } }, description: "The build is current." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The tag is not installed or the swap failed and was rolled back." } } });
const removeRoute = createRoute({ method: "delete", path: "/{name}/builds/{tag}", tags: ["Engines"], summary: "Remove an installed build that is not current", request: { params: z.object({ name: z.string().openapi({ param: { name: "name", in: "path" } }), tag: z.string().openapi({ param: { name: "tag", in: "path" } }) }) }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } }, description: "Removed." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The current build cannot be removed." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown build." } } });


export const enginesRoutes = apiRouter<AppEnv>();
/** The environment build in flight per engine, so two installs never
 * race on one venv and one engine's build never answers for another. */
const environmentJobs = new Map<string, string>();
const HealEventSchema = z.object({ id: z.string(), kind: z.enum(["crashed", "healed", "gave_up", "requested_by_canary"]), at: z.string(), role: z.string(), cause: z.string(), causeKind: z.string(), seconds: z.number().optional(), crashedAt: z.string().optional(), attempts: z.number().optional() });
const selfHealRoute = createRoute({ method: "get", path: "/self-heal", tags: ["Engines"], summary: "Engine crashes and the Stack's own restarts", description: "Crashes per day, the recent crash, restart and gave-up events (each with a stable id so a caller notifies once), the roles whose retries stopped, and the roles being restarted now.", responses: { 200: { content: { "application/json": { schema: z.object({ enabled: z.boolean(), crashesByDay: z.array(z.object({ day: z.string(), crashes: z.number(), healed: z.number(), gaveUp: z.number() })), events: z.array(HealEventSchema), stopped: z.array(z.string()), healing: z.array(z.string()), blocker: z.string().nullable() }) } }, description: "The record." } } });
enginesRoutes.openapi(selfHealRoute, (c) => c.json(selfHealSummary(), 200));
const gpuHealthRoute = createRoute({ method: "get", path: "/gpu-health", tags: ["Engines"], summary: "Whether the Mac's graphics compiler answers (GPU-HEALTH-01)", description: "Compiles one tiny shader through the same compiler service the engines use. `ok` is false with the household sentence in `reason` when it does not answer; a Mac that cannot be asked reads ok.", responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), reason: z.string().nullable() }) } }, description: "The result of one compile." } } });
enginesRoutes.openapi(gpuHealthRoute, async (c) => { const reason = await metalHostFault("llama-server"); return c.json({ ok: reason === null, reason }, 200); });
const restartRequestRoute = createRoute({ method: "post", path: "/self-heal/restart", tags: ["Engines"], summary: "A health check asks for one engine restart", description: "Goes through the self-heal gate, backoff and circuit breaker like a crash and counts as one failure; it never resets the breaker. Answers 200 with accepted false when self-heal is off, the circuit is open or a retry is pending.", request: { body: { content: { "application/json": { schema: z.object({ role: z.string(), reason: z.string().max(200) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ accepted: z.boolean(), why: z.string().nullable() }) } }, description: "The outcome." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown role." } } });
enginesRoutes.openapi(restartRequestRoute, async (c) => {
  const { role, reason } = c.req.valid("json");
  if (!(ROLE_IDS as readonly string[]).includes(role)) return c.json({ error: "Unknown role" }, 400);
  return c.json(await requestEngineRestart(role as (typeof ROLE_IDS)[number], reason), 200);
});
enginesRoutes.openapi(listRoute, async (c) => {
  const hardware = await detectHardware();
  const needsRestart = readSettings().some((setting) => (setting.key.startsWith("stack.engines.llama_server.") || setting.key === "stack.engines.chat.engine") && setting.pending !== null);
  const chosenChatEngine = chatEngine();
  const pins = ENGINE_BINARIES.map((pin) => {
    // Each engine name has its own pin for this machine and its own role.
    const selected = selectEngineBinary(hardware, pin.name);
    const status = getRoleStatus(engineRole(pin.name));
    // Only the build whose process serves the role has its identity
    // compared with its tag: for the chat wire the engine that is
    // running (the one the setting chose, once started; until then no
    // row), a llama-server pin for its other roles; never a tool pin
    // (uv) or a source pin (ComfyUI), and never a chat engine that is
    // installed but not running.
    const isChat = engineRole(pin.name) === "chat";
    // The coding role runs on llama-server or Splash, chosen by stack.engines.coding.engine: only the build whose process serves it is compared.
    const isCoding = engineRole(pin.name) === "coding";
    const runsTheRole = isChat ? runningEngine("chat") === pin.name : isCoding ? runningEngine("coding") === pin.name : !pin.tool || pin.tool === "llama-server";
    const running = runsTheRole ? status.identity?.build ?? null : null;
    const version = deriveEngineVersionState({ running, currentTag: currentEngine(pin.name), newestTag: selected?.id === pin.id ? pin.tag : null, needsRestart: isChat && pin.name === chosenChatEngine && needsRestart });
    return { id: pin.id, name: pin.name, label: pin.label, platform: pin.platform, arch: pin.arch, verified: pin.verified, installed: existsSync(join(engineDir(pin), ENGINE_READY_MARKER)), matchesThisMachine: selected?.id === pin.id, ...version, directory: engineDir(pin), roleState: status.state, roleReason: status.reason };
  });
  // The managed runtimes the Stack assembles (Pocket TTS): one row each,
  // on every platform, installed when the environment is built.
  const managed = MANAGED_RUNTIMES.map((runtime) => {
    const status = getRoleStatus(engineRole(runtime.name));
    const installed = runtime.name === POCKET_TTS_NAME ? pocketTtsInstalled() : runtime.name === MLX_AUDIO_NAME ? mlxAudioInstalled() : runtime.name === OMLX_NAME ? omlxInstalled() : runtime.name === COMFYUI_NAME ? comfyuiInstalled() : runtime.name === VIDEO_GEN_NAME ? videoGenEnvironmentReady() : runtime.name === MUSIC_GEN_NAME ? musicGenEnvironmentReady() : runtime.name === IMAGE_GEN_NAME ? imageGenEnvironmentReady() : false;
    const running = engineRole(runtime.name) === "chat" && runningEngine("chat") !== runtime.name ? null : status.identity?.build ?? null;
    const version = deriveEngineVersionState({ running, currentTag: installed ? runtime.version : null, newestTag: runtime.version, needsRestart: false });
    return { id: `${runtime.name}-${runtime.version}`, name: runtime.name, label: `${runtime.name} ${runtime.version}, an environment the Stack assembles through uv`, platform: process.platform, arch: process.arch, verified: true, installed, matchesThisMachine: true, ...version, directory: runtime.name === POCKET_TTS_NAME ? pocketTtsRoot() : runtime.name === MLX_AUDIO_NAME ? mlxAudioRoot() : runtime.name === OMLX_NAME ? omlxRoot() : runtime.name === COMFYUI_NAME ? comfyuiRoot() : runtime.name === VIDEO_GEN_NAME ? videoGenRoot() : runtime.name === MUSIC_GEN_NAME ? musicGenRoot() : "", roleState: status.state, roleReason: status.reason };
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
  if (name === IMAGE_GEN_NAME) {
    // The picture generator is an environment with no source archive (mflux comes from PyPI by hash): one build at a time, a second request joins it. Its models are pulled by POST /stack/v1/image/install or one by one.
    const inFlight = environmentJobs.get(IMAGE_GEN_NAME);
    if (inFlight) return c.json({ job: inFlight, engine: IMAGE_GEN_NAME, staged: false }, 202);
    const job = createJob({ kind: "engine.install", totalBytes: 0, status: "downloading", input: { engine: `${IMAGE_GEN_NAME}-env` } });
    environmentJobs.set(IMAGE_GEN_NAME, job.id);
    void ensureImageGenEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) })
      .then(() => { finishJob(job.id, { ok: true, result: { engine: IMAGE_GEN_NAME } }); emit({ id: "engine.state", data: { engine: IMAGE_GEN_NAME, state: "installed" } }); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(IMAGE_GEN_NAME); });
    return c.json({ job: job.id, engine: IMAGE_GEN_NAME, staged: false }, 202);
  }
  if (name === OMLX_NAME) {
    // The chat engine's environment (ENGINE-MLX-01): uv, a managed Python,
    // the hashed requirements synced. One build at a time: a second
    // request joins the job in flight.
    const inFlight = environmentJobs.get(OMLX_NAME);
    if (inFlight) return c.json({ job: inFlight, engine: OMLX_NAME, staged: false }, 202);
    const job = createJob({ kind: "engine.install", totalBytes: 0, status: "downloading", input: { engine: `${OMLX_NAME}-env` } });
    environmentJobs.set(OMLX_NAME, job.id);
    void ensureOmlxEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) })
      .then(async () => { finishJob(job.id, { ok: true, result: { engine: OMLX_NAME } }); emit({ id: "engine.state", data: { engine: OMLX_NAME, state: "installed" } }); await restartForNewChatEngine().catch(() => false); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(OMLX_NAME); });
    return c.json({ job: job.id, engine: OMLX_NAME, staged: false }, 202);
  }
  if (name === MLX_AUDIO_NAME) {
    // Not a download but a build: uv (a pinned build, fetched first if
    // missing), a managed Python, the hashed requirements synced. One
    // build at a time: a second request joins the job in flight.
    const inFlight = environmentJobs.get(MLX_AUDIO_NAME);
    if (inFlight) return c.json({ job: inFlight, engine: MLX_AUDIO_NAME, staged: false }, 202);
    const job = createJob({ kind: "engine.install", totalBytes: 0, status: "downloading", input: { engine: `${MLX_AUDIO_NAME}-env` } });
    // The status is the phase (uv, python, packages): uv reports no byte
    // counts the job could show.
    environmentJobs.set(MLX_AUDIO_NAME, job.id);
    void ensureMlxAudioEnvironment((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) })
      .then(() => { finishJob(job.id, { ok: true, result: { engine: MLX_AUDIO_NAME } }); emit({ id: "engine.state", data: { engine: MLX_AUDIO_NAME, state: "installed" } }); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(MLX_AUDIO_NAME); });
    return c.json({ job: job.id, engine: MLX_AUDIO_NAME, staged: false }, 202);
  }
  if (!ENGINE_BINARIES.some((candidate) => candidate.name === name)) return c.json({ error: `Unknown engine ${name}.` }, 404);
  if ((name === COMFYUI_NAME || name === VIDEO_GEN_NAME || name === MUSIC_GEN_NAME) && !staged) {
    // The source archive (a pinned engine build, checksummed), then the
    // environment on top of it, one job; a second request joins it. The
    // video engine (mlx-video's source and its Python environment) and the
    // music engine (ACE-Step's source and its environment) build
    // the same way; its models are pulled separately, as image's are.
    const inFlight = environmentJobs.get(name);
    if (inFlight) return c.json({ job: inFlight, engine: name, staged: false }, 202);
    const hardware = await detectHardware();
    const pin = selectEngineBinary(hardware, name);
    if (!pin) return c.json({ error: `No pinned ${name} build for this machine.` }, 404);
    const archives = [pin.archive, ...(pin.extraArchives ?? [])];
    const items = archives.map((archive) => ({ id: archive.label, label: archive.label, completedBytes: 0, totalBytes: archive.approxBytes, state: "queued" as const }));
    const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
    const job = createJob({ kind: "engine.install", totalBytes, items, status: "downloading", input: { engine: pin.id } });
    environmentJobs.set(name, job.id);
    void ensureEngine(pin, (progress) => { const nextItems = getJob(job.id)?.items?.map((item) => item.id !== progress.itemId ? item : { ...item, completedBytes: progress.itemCompletedBytes ?? progress.completedBytes, state: progress.itemState ?? "running" }); updateJob(job.id, { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes || totalBytes, ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }), ...(nextItems ? { items: nextItems } : {}), state: progress.itemState === "stalled" ? "stalled" : "running", status: progress.status }); }, { signal: jobSignal(job.id), activate: true })
      .then(() => (name === COMFYUI_NAME ? ensureComfyuiEnvironment : name === MUSIC_GEN_NAME ? ensureMusicGenEnvironment : ensureVideoGenEnvironment)((phase) => updateJob(job.id, { status: `building ${phase}` }), { signal: jobSignal(job.id) }))
      .then(() => { finishJob(job.id, { ok: true, result: { engine: name } }); emit({ id: "engine.state", data: { engine: name, state: "installed" } }); })
      .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }))
      .finally(() => { environmentJobs.delete(name); });
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
  const archives = [pin.archive, ...(pin.extraArchives ?? [])];
  const items = archives.map((archive) => ({ id: archive.label, label: archive.label, completedBytes: 0, totalBytes: archive.approxBytes, state: "queued" as const }));
  const totalBytes = items.reduce((sum, item) => sum + item.totalBytes, 0);
  const job = createJob({ kind: staged ? "engine.stage" : "engine.install", totalBytes, items, status: "downloading", input: { engine: pin.id } });
  void ensureEngine(pin, (progress) => { const nextItems = getJob(job.id)?.items?.map((item) => item.id !== progress.itemId ? item : { ...item, completedBytes: progress.itemCompletedBytes ?? progress.completedBytes, state: progress.itemState ?? "running" }); updateJob(job.id, { completedBytes: progress.completedBytes, totalBytes: progress.totalBytes || totalBytes, ...(progress.bytesPerSecond === undefined ? {} : { bytesPerSecond: progress.bytesPerSecond }), ...(nextItems ? { items: nextItems } : {}), state: progress.itemState === "stalled" ? "stalled" : "running", status: progress.status }); }, { signal: jobSignal(job.id), activate: !staged })
    .then(() => { finishJob(job.id, { ok: true, result: { engine: pin.id } }); if (!staged) emit({ id: "engine.state", data: { engine: name, state: "installed" } }); })
    .catch((error) => finishJob(job.id, { ok: false, reason: error instanceof Error ? error.message : String(error) }));
  return c.json({ job: job.id, engine: pin.id, staged }, 202);
});
/** The reason a chat engine cannot be started or restarted as the chat
 * role: the setting names the other one, so a start would run that.
 * A stop is judged on what runs (`stoppable`): the engine whose
 * process holds the role can always be stopped, chosen or not. */
function unchosenChatEngine(name: string, options: { stoppable?: boolean } = {}): string | null {
  if (!CHAT_ENGINES.includes(name as ChatEngine)) return null;
  if (options.stoppable) return runningEngine("chat") === name || (runningEngine("chat") === null && name === chatEngine()) ? null : `The chat role is not running ${name}.`;
  if (name === chatEngine()) return null;
  const running = runningEngine("chat");
  return `The chat role is set to ${chatEngine()}${running && running !== chatEngine() ? ` (${running} runs until the restart)` : ""}; set stack.engines.chat.engine to ${name} and restart the Stack to run it.`;
}
for (const action of ["start", "stop", "restart"] as const) enginesRoutes.openapi(controlRoute(action), async (c) => {
  const { name } = c.req.valid("param");
  if (!ENGINE_BINARIES.some((pin) => pin.name === name) && !MANAGED_RUNTIMES.some((runtime) => runtime.name === name)) return c.json({ error: "Unknown engine" }, 404);
  // The picture worker is the picture service's, started by the first picture and stopped after ten idle minutes.
  if (name === IMAGE_GEN_NAME) {
    if (action === "stop" || action === "restart") { imageGen.stop(); return c.json({ ok: true }, 200); }
    return c.json({ ok: true, reason: "The picture engine starts by itself when a picture is made." }, 200);
  }
  // The video worker is the video service's, started by the first clip and stopped after ten idle minutes.
  if (name === VIDEO_GEN_NAME) {
    if (action === "stop" || action === "restart") { videoGen.stop(); return c.json({ ok: true }, 200); }
    return c.json({ ok: true, reason: "The video engine starts by itself when a clip is made." }, 200);
  }
  // The music worker is the music service's, started by the first song and stopped after five idle minutes.
  if (name === MUSIC_GEN_NAME) {
    if (action === "stop" || action === "restart") { musicGen.stop(); return c.json({ ok: true }, 200); }
    return c.json({ ok: true, reason: "The music engine starts by itself when a song is made." }, 200);
  }
  const role = engineRole(name);
  const unchosen = unchosenChatEngine(name, { stoppable: action === "stop" });
  if (unchosen) return c.json({ ok: false, reason: unchosen }, 200);
  try {
    if (action === "stop") { await stopRole(role); return c.json({ ok: true }, 200); }
    if (action === "restart") { await restartRole(role, "route-engines-restart"); await getProcess(role); return c.json({ ok: true }, 200); }
    const status = getRoleStatus(role);
    // "Already running" only when the process is this engine's: a chat
    // role still on the other engine after the setting changed restarts.
    const other = CHAT_ENGINES.includes(name as ChatEngine) && runningEngine("chat") !== null && runningEngine("chat") !== name;
    if (other) { await restartRole(role, "route-engines-other"); await getProcess(role); return c.json({ ok: true }, 200); }
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
    // A chat engine the setting has not chosen swaps its link only: no
    // process to drain, and nothing to restart that would prove the build.
    if (unchosenChatEngine(name)) await swapEngine(name, tag);
    // The coding engine is on demand: it is drained, and the next coding request starts the new build (a build that does not start falls back to llama-server) rather than loading 20 GB here.
    else if (role === "coding") await swapEngine(name, tag, { drain: () => stopRole(role, "Draining for an engine change.") });
    else await swapEngine(name, tag, { drain: () => stopRole(role, "Draining for an engine change."), postLoadCheck: async () => { await restartRole(role); await getProcess(role); return true; } });
    return c.json({ ok: true as const, tag }, 200);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
enginesRoutes.openapi(removeRoute, (c) => {
  const { name, tag } = c.req.valid("param");
  const refusal = engineRemovalRefusal({
    isCurrent: currentEngine(name) === tag, hasCurrent: currentEngine(name) !== null,
    roleRunning: getRoleStatus(engineRole(name)).state !== "stopped", bound: engineIsBound(name, tag),
  });
  if (refusal) return c.json({ error: refusal }, 400);
  return removeEngine(name, tag) ? c.json({ ok: true as const }, 200) : c.json({ error: "Unknown build" }, 404);
});
