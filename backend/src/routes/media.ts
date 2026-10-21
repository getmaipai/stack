// MEDIA-STACK-01: the media service's state and the two things Home sets on
// it. The work itself runs as jobs on POST /stack/v1/jobs, including
// media.companion_clip.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { laneStatus } from "@/lib/jobs";
import { QUIET_AFTER_FAILURES, QUIET_MS } from "@/media/hosts";
import { MEDIA_DEADLINES_MS, MEDIA_KINDS, MEDIA_LANE, MEDIA_QUEUE_CAP, mediaDeps } from "@/media/jobs";
import { getRoots, MediaPathError, releaseJobDir, setRoots } from "@/media/paths";
import { mediaToolsStatus } from "@/media/tools";

const RootsSchema = z.object({ read: z.array(z.string()).openapi({ description: "Folders the media jobs may read (the library roots Home scans). Absolute, existing, never `/` or the Stack's own data folder." }), write: z.array(z.string()).openapi({ description: "Folders a job may write into when it names an output_dir. Without one, a job writes into a folder it owns." }) }).openapi("MediaRoots");
const StatusSchema = z.object({
  supported: z.boolean(),
  platform: z.string(),
  tools: z.array(z.object({ name: z.enum(["ffmpeg", "ffprobe", "yt-dlp"]), installed: z.boolean().openapi({ description: "False until the first job that needs it (or a media.setup job) downloads it." }), version: z.string(), licence: z.string(), source: z.string() })),
  kinds: z.array(z.string()),
  lane: z.object({ name: z.string(), cap: z.number().int(), queued: z.number().int(), running_job: z.string().nullable(), deadlines_minutes: z.record(z.string(), z.number()) }),
  quiet_hosts: z.array(z.object({ host: z.string(), until: z.string(), failures: z.number().int() })).openapi({ description: "Sites resting now. A background media.fetch for one is refused (503, code media_quiet_mode); a person-initiated one still runs." }),
  quiet_policy: z.object({ failures: z.number().int(), minutes: z.number() }),
  roots: RootsSchema,
}).openapi("MediaStatus");

const statusRoute = createRoute({ method: "get", path: "/", tags: ["Media"], summary: "The media service: tools, the idle lane, resting sites, declared folders", responses: { 200: { content: { "application/json": { schema: z.object({ media: StatusSchema }) } }, description: "Additive. Home enables fetch from `tools` and `quiet_hosts`." } } });
const putRootsRoute = createRoute({ method: "put", path: "/roots", tags: ["Media"], summary: "Declare the folders media jobs may read and write", request: { body: { content: { "application/json": { schema: z.object({ read: z.array(z.string()), write: z.array(z.string()).optional() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ roots: RootsSchema }) } }, description: "Saved (it survives a Stack restart). Replaces the previous declaration." }, 422: { content: { "application/json": { schema: z.object({ error: z.string(), code: z.string() }) } }, description: "A folder does not exist, is `/`, or holds or sits inside the Stack's data folder." } } });
const releaseRoute = createRoute({ method: "delete", path: "/outputs/{job}", tags: ["Media"], summary: "Release a finished job's output folder", request: { params: z.object({ job: z.string().openapi({ param: { name: "job", in: "path" } }) }) }, responses: { 200: { content: { "application/json": { schema: z.object({ released: z.boolean() }) } }, description: "The folder the job owned is deleted (false when there was none). Home calls this after it has moved or copied what it keeps." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "Not a job id." } } });

export const mediaRoutes = apiRouter<AppEnv>();
mediaRoutes.openapi(statusRoute, (c) => {
  const lane = laneStatus(MEDIA_LANE);
  return c.json({ media: { ...mediaToolsStatus(), kinds: [...MEDIA_KINDS], lane: { name: MEDIA_LANE, cap: MEDIA_QUEUE_CAP, queued: lane.queued, running_job: lane.running, deadlines_minutes: Object.fromEntries(Object.entries(MEDIA_DEADLINES_MS).map(([kind, ms]) => [kind, Math.round(ms / 60_000)])) }, quiet_hosts: mediaDeps.limiter.quietHosts(), quiet_policy: { failures: QUIET_AFTER_FAILURES, minutes: QUIET_MS / 60_000 }, roots: getRoots() } }, 200);
});
mediaRoutes.openapi(putRootsRoute, (c) => {
  const body = c.req.valid("json");
  try { return c.json({ roots: setRoots(body) }, 200); } catch (error) {
    if (error instanceof MediaPathError) return c.json({ error: error.message, code: error.code }, 422);
    throw error;
  }
});
mediaRoutes.openapi(releaseRoute, (c) => {
  const { job } = c.req.valid("param");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(job)) return c.json({ error: "That is not a job id." }, 400);
  return c.json({ released: releaseJobDir(job) }, 200);
});
