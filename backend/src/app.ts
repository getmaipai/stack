// The daemon's routes: the role routes on /v1, the control routes on
// /stack/v1, liveness on /healthz, the generated document and its
// explorer under /api. No static files. Who may call is decided in front of
// this app by lib/requestGuard.ts (ISOLATION-04: Host, Origin and Home's token
// on every write, wired in daemon.ts `serveOptions`); index.ts binds 127.0.0.1
// and nothing else.
import { apiReference } from "@scalar/hono-api-reference";
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import packageJson from "../../package.json";
import { v1Routes } from "@/routes/v1";
import { lookRoutes } from "@/routes/look";
import { rolesRoutes } from "@/routes/roles";
import { enginesRoutes } from "@/routes/engines";
import { modelsRoutes } from "@/routes/models";
import { jobsRoutes } from "@/routes/jobs";
import { jobsCatalogRoutes } from "@/routes/jobsCatalog";
import { jobsMakeRoutes } from "@/routes/jobsMake";
import { healthRoutes } from "@/routes/health";
import { statusRoutes } from "@/routes/status";
import { checkRoutes } from "@/routes/check";
import { updatesRoutes } from "@/routes/updates";
import { eventsRoutes } from "@/routes/events";
import { hardwareRoutes } from "@/routes/hardware";
import { tiersRoutes } from "@/routes/tiers";
import { profilesRoutes } from "@/routes/profiles";
import { capabilitiesRoutes } from "@/routes/capabilities";
import { installPlanRoutes } from "@/routes/installPlan";
import { settingsRoutes } from "@/routes/settings";
import { licencesRoutes } from "@/routes/licences";
import { declarationRoutes } from "@/routes/declarations";
import { voicesRoutes } from "@/routes/voices";
import { homeModeRoutes } from "@/routes/homeMode";
import { fitPlanRoutes } from "@/routes/fitPlan";
import { warmupRoutes } from "@/routes/warmup";
import { searchRoutes } from "@/routes/search";
import { imageToolsRoutes } from "@/routes/imageTools";
import { talkFramesRoutes } from "@/routes/talkFrames";
import { componentsRoutes } from "@/routes/components";
import { partsRoutes } from "@/routes/parts";
import { choicesRoutes } from "@/routes/choices";
import { registerImageToolJobs } from "@/imagetools/jobs";
import { registerTalkFrameJobs } from "@/liveportrait/jobs";
import { mediaRoutes } from "@/routes/media";
import { registerMediaJobs } from "@/media/jobs";
import { videoRoutes } from "@/routes/video";
import { videoV1Routes } from "@/routes/videoGenerations";
import { registerVideoJobs } from "@/video/jobs";
import { videoSwapRoutes } from "@/routes/videoSwap";
import { videoEnhanceRoutes } from "@/routes/videoEnhance";
import { registerH3SwapJobs } from "@/video/swap";
import { registerSwapMakeJobs } from "@/lib/makeDispatchSwap";
import { musicV1Routes } from "@/routes/musicGenerations";
import { musicRoutes } from "@/routes/music";
import { registerMusicJobs } from "@/music/jobs";
import { registerStemsJobs } from "@/stems/jobs";
import { stemsV1Routes } from "@/routes/stems";
import { audioEnhanceRoutes } from "@/routes/audioEnhance";
import { stemsRoutes } from "@/routes/stemsStatus";
import { registerSoundJobs } from "@/sound/jobs";
import { soundRoutes, soundV1Routes } from "@/routes/sound";
import { scoreRoutes, scoreV1Routes } from "@/routes/score";
import { registerScoreJobs } from "@/score/jobs";
import { registerAlignJobs } from "@/align/jobs";
import { alignV1Routes } from "@/routes/align";
import { registerTranscriptionJobs } from "@/speech/transcriptionJobs";
import { transcriptionV1Routes } from "@/routes/transcriptionJobs";
import { mouthTimingsRoutes } from "@/routes/mouthTimings";
import { registerBeatsJobs } from "@/beats/jobs";
import { beatsV1Routes } from "@/routes/beats";
import { beatsRoutes } from "@/routes/beatsStatus";
import { registerVoiceConvertJobs } from "@/voiceConvert/jobs";
import { voiceConvertV1Routes } from "@/routes/voiceConvert";
import { voiceConvertRoutes } from "@/routes/voiceConvertStatus";
import { recordedSpeechV1Routes } from "@/routes/recordedSpeech";
import { recordedSpeechRoutes } from "@/routes/recordedSpeechStatus";
import { registerRecordedSpeechJobs } from "@/recordedSpeech/jobs";
import { imageRoutes } from "@/routes/image";
import { imageV1Routes } from "@/routes/imageGenerations";
import { registerImageJobs } from "@/images/jobs";
import { memoryRoutes } from "@/routes/memory";
import { resourcesRoutes } from "@/routes/resources";
import { adminRoutes } from "@/routes/admin";
import { adminActionRoutes } from "@/routes/adminActions";
import { helperRoutes } from "@/routes/helper";
import { diskRoutes } from "@/routes/disk";
import { disksRoutes } from "@/routes/disks";
import { connectionsRoutes } from "@/routes/connections";
import { sandboxRoutes } from "@/routes/sandboxes";
import { isStopping } from "@/lib/lifecycle";
import { serveAdminUi } from "@/lib/adminUi";
import { fullViewAllowed, fullViewAsked } from "@/lib/adultView";
import { speechRoutes, websocket } from "@/routes/speech";
import { registerGenerators } from "@/generators";
import { SESSION_PATH } from "@/speech/server";

/** The websocket handler Bun.serve needs beside `app.fetch` for the
 * speech session; index.ts passes it through. */
export { websocket };

export const version = packageJson.version;
/** The wire contract number Home compares before it talks to this Stack.
 * Bumped only when a route or field is removed or repurposed. */
export const CONTRACT = 1;
export const app = apiRouter<AppEnv>();
// The generator runners exist from the first request; a role with no
// engine still answers the honest 503 through the route's bound check.
registerGenerators();
registerImageToolJobs();
registerTalkFrameJobs();
registerMediaJobs();
registerVideoJobs();
registerH3SwapJobs();
registerSwapMakeJobs();
registerMusicJobs();
registerStemsJobs();
registerSoundJobs();
registerScoreJobs();
registerRecordedSpeechJobs();
registerAlignJobs();
registerTranscriptionJobs();
registerBeatsJobs();
registerVoiceConvertJobs();
registerImageJobs();

const livenessRoute = createRoute({
  method: "get", path: "/healthz", tags: ["Health"], summary: "Stack process liveness",
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), version: z.string(), contract: z.number().int(), uptimeSeconds: z.number() }) } }, description: "The daemon is running; Home checks its pinned minimum version and the contract number here." } },
});
app.openapi(livenessRoute, (c) => c.json({ ok: true as const, version, contract: CONTRACT, uptimeSeconds: process.uptime() }, 200));

// While the Stack is shutting down (an update, a restart) a new request is
// told so plainly, with when to come back, instead of reaching a half-stopped
// engine and dropping mid-answer. Liveness stays answerable.
app.use("*", async (c, next) => {
  if (isStopping() && c.req.path !== "/healthz") {
    return c.json({ error: "The Stack is restarting. Try again in a few seconds.", code: "stack_restarting" }, 503, { "Retry-After": "5" });
  }
  await next();
});

// ADULT-LOCK-04: a full-view ask (x-maipai-view: full) without Home's
// credential is refused on every route, adult job or not, so a caller cannot
// find out which jobs are adult by trying.
app.use("*", async (c, next) => {
  if (fullViewAsked((name) => c.req.header(name)) && !fullViewAllowed((name) => c.req.header(name))) {
    return c.json({ error: "The full view is for Home only. Ask without the x-maipai-view header to get the standard view.", code: "full_view_forbidden" }, 403);
  }
  await next();
});

app.doc("/api/openapi.json", { openapi: "3.0.0", info: { title: "MaiPai Stack API", version } });
app.get("/api/docs", apiReference({ url: "/api/openapi.json" }));

// The session route is mounted before the JSON role routes so the
// upgrade is never read as a POST body.
app.route(SESSION_PATH, speechRoutes);
app.route("/v1", v1Routes);
app.route("/v1", talkFramesRoutes);
app.route("/v1", lookRoutes);
app.route("/v1/videos", videoV1Routes);
app.route("/v1/videos", videoSwapRoutes);
app.route("/v1/videos", videoEnhanceRoutes);
app.route("/v1/audio/music", musicV1Routes);
app.route("/v1/audio/stems", stemsV1Routes);
app.route("/v1/audio/enhance", audioEnhanceRoutes);
app.route("/v1/audio/sound", soundV1Routes);
app.route("/v1/audio/score", scoreV1Routes);
app.route("/v1/audio/align", alignV1Routes);
app.route("/v1/audio/transcriptions", transcriptionV1Routes);
app.route("/v1/audio/mouth-timings", mouthTimingsRoutes);
app.route("/v1/audio/beats", beatsV1Routes);
app.route("/v1/audio/voice-convert", voiceConvertV1Routes);
app.route("/v1/audio/speech/recorded", recordedSpeechV1Routes);
app.route("/v1/images", imageV1Routes);
app.route("/stack/v1/roles", rolesRoutes);
app.route("/stack/v1/engines", enginesRoutes);
app.route("/stack/v1/models", modelsRoutes);
// MODELPACK-JOBS-01: the catalog is registered before the jobs router so "catalog" is never read as a job id.
app.route("/stack/v1/jobs/catalog", jobsCatalogRoutes);
app.route("/stack/v1/jobs/make", jobsMakeRoutes);
app.route("/stack/v1/jobs", jobsRoutes);
app.route("/stack/v1/health", healthRoutes);
app.route("/stack/v1/status", statusRoutes);
app.route("/stack/v1/check", checkRoutes);
app.route("/stack/v1/updates", updatesRoutes);
app.route("/stack/v1", eventsRoutes);
app.route("/stack/v1/hardware", hardwareRoutes);
app.route("/stack/v1/tiers", tiersRoutes);
app.route("/stack/v1/profiles", profilesRoutes);
app.route("/stack/v1/capabilities", capabilitiesRoutes);
app.route("/stack/v1/memory", memoryRoutes);
app.route("/stack/v1/resources", resourcesRoutes);
app.route("/stack/v1/admin", adminRoutes);
app.route("/stack/v1", adminActionRoutes);
app.route("/stack/v1/helper", helperRoutes);
app.route("/stack/v1/disk", diskRoutes);
app.route("/stack/v1/disks", disksRoutes);
app.route("/stack/v1/connections", connectionsRoutes);
app.route("/stack/v1/sandboxes", sandboxRoutes);
app.route("/stack/v1/install-plan", installPlanRoutes);
app.route("/stack/v1/fit-plan", fitPlanRoutes);
app.route("/stack/v1/warmup", warmupRoutes);
app.route("/stack/v1/search", searchRoutes);
app.route("/stack/v1/image-tools", imageToolsRoutes);
app.route("/stack/v1/media", mediaRoutes);
app.route("/stack/v1/components", componentsRoutes);
app.route("/stack/v1/parts", partsRoutes);
app.route("/stack/v1/choices", choicesRoutes);
app.route("/stack/v1", componentsRoutes);
app.route("/stack/v1/video", videoRoutes);
app.route("/stack/v1/music", musicRoutes);
app.route("/stack/v1/stems", stemsRoutes);
app.route("/stack/v1/sound", soundRoutes);
app.route("/stack/v1/score", scoreRoutes);
app.route("/stack/v1/beats", beatsRoutes);
app.route("/stack/v1/voice-convert", voiceConvertRoutes);
app.route("/stack/v1/speech-recorded", recordedSpeechRoutes);
app.route("/stack/v1/image", imageRoutes);
app.route("/stack/v1/settings", settingsRoutes);
app.route("/stack/v1/licences", licencesRoutes);
app.route("/stack/v1", declarationRoutes);
app.route("/stack/v1/voices", voicesRoutes);
app.route("/stack/v1", homeModeRoutes);

// The admin page (admin-ui/, built with `bun run build:admin`): static files only, GET and HEAD; its data comes from /stack/v1/* behind the sign-in.
app.on(["GET", "HEAD"], "/admin/*", (c) => serveAdminUi(c.req.path));
app.on(["GET", "HEAD"], "/admin", (c) => serveAdminUi(c.req.path));

app.notFound((c) => c.json({ error: "Not found" }, 404));
