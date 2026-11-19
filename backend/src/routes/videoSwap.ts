import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { admissionCaller } from "@/lib/admissionCaller";
import { dataDir } from "@/lib/paths";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelJob, getJob, hasJobRunner, submitJob, waitForJob } from "@/lib/jobs";
import { h3SwapReady, H3_SWAP_JOB_KIND, H3_SWAP_MAX_SECONDS, stashH3Swap, unstashH3Swap, type SwapInput } from "@/video/swap";
import { deleteResult, isJobId, posterPath, readResult, videoPath } from "@/video/results";
import { existsSync } from "node:fs";
import { fileResponse } from "@/routes/videoGenerations";
import { discardStagedSwap, SWAP_MAKE_JOB_KIND } from "@/lib/makeDispatchSwap";

const isSwapKind = (kind: string): boolean => kind === H3_SWAP_JOB_KIND || kind === SWAP_MAKE_JOB_KIND;

const ErrorBody = z.object({ error: z.string(), code: z.string().optional(), job: z.string().optional() });
const Reply = z.object({ created: z.number().optional(), job: z.string(), state: z.string().optional(), data: z.array(z.unknown()).optional() });
const Request = z.object({ source_video: z.any().optional(), references: z.any().optional(), description: z.string().optional(), size: z.string().optional(), start_seconds: z.string().optional(), seconds: z.string().optional() });
const post = createRoute({ method: "post", path: "/swap", tags: ["Video"], summary: "Replace a visible head in a short source clip using reference photos", request: { body: { content: { "multipart/form-data": { schema: Request } } } }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Finished swap" }, 202: { content: { "application/json": { schema: Reply } }, description: "Swap job" }, 422: { content: { "application/json": { schema: ErrorBody } }, description: "The source, references or settings need correcting" }, 503: { content: { "application/json": { schema: ErrorBody } }, description: "Swap is not ready or memory is unavailable" } } });
export const videoSwapRoutes = apiRouter<AppEnv>();
videoSwapRoutes.openapi(post, async (c) => {
  const form = await c.req.parseBody({ all: true });
  const source = form.source_video;
  const refs = Array.isArray(form.references) ? form.references : form.references === undefined ? [] : [form.references];
  if (!(source instanceof File)) return c.json({ error: "Send the source MP4 as source_video." }, 422);
  if (source.size > 60 * 1024 * 1024) return c.json({ error: "The source clip is larger than 60 MB. Choose a smaller MP4 clip." }, 422);
  if (!source.name.toLowerCase().endsWith(".mp4") || (source.type && source.type !== "video/mp4")) return c.json({ error: "Send the source as an MP4 clip." }, 422);
  if (refs.length < 1) return c.json({ error: "Send at least one reference picture (PNG, JPEG or WebP)." }, 422);
  if (refs.length > 3) return c.json({ error: "Send no more than three reference pictures." }, 422);
  if (!refs.every((value): value is File => value instanceof File && /^image\/(png|jpeg|webp)$/.test(value.type))) return c.json({ error: "A reference is not a picture. Send PNG, JPEG or WebP photos." }, 422);
  const description = typeof form.description === "string" && form.description.trim() ? form.description.trim().replace(/[\r\n\0]/g, " ").slice(0, 300) : undefined;
  if (typeof form.description === "string" && /[\r\n\0]/.test(form.description)) return c.json({ error: "Description must be one line." }, 422);
  const size = form.size === undefined ? "640x480" : form.size;
  if (size !== "640x480" && size !== "512x384") return c.json({ error: "Choose size 640x480 or 512x384." }, 422);
  const start = form.start_seconds === undefined ? 0 : Number(form.start_seconds);
  const requested = form.seconds === undefined ? null : Number(form.seconds);
  if (!Number.isFinite(start) || start < 0 || (requested !== null && (!Number.isFinite(requested) || requested <= 0))) return c.json({ error: "Send a valid start_seconds and seconds window." }, 422);
  if (requested !== null && requested > H3_SWAP_MAX_SECONDS) return c.json({ error: "The window can be at most 10 seconds. It uses 5 segments of 56 frames (about 2.333 seconds each)." }, 422);
  const sourcePath = await saveSource(source);
  if (!h3SwapReady()) { try { await import("node:fs/promises").then(({ unlink }) => unlink(sourcePath)); } catch { /* nothing to remove */ } return c.json({ error: "H3 head swap is not installed on this computer. Install the binary, LoRA and model files." }, 503); }
  if (!hasJobRunner(H3_SWAP_JOB_KIND)) return c.json({ error: "H3 head swap is not available on this computer." }, 503);
  const token = crypto.randomUUID();
  const input: SwapInput = { source: sourcePath, references: await Promise.all(refs.map(async (file) => new Uint8Array(await file.arrayBuffer()))), referenceTypes: refs.map((file) => file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1]!), description: description ?? "A person matching the reference photos, with natural hair, facial hair and skin appearance", size, start, seconds: requested ?? Math.min(H3_SWAP_MAX_SECONDS, 7) };
  stashH3Swap(token, input);
  const submitted = submitJob({ caller: admissionCaller(c), kind: H3_SWAP_JOB_KIND, role: "video", input: { token, size, seconds: input.seconds, start, defaultWindow: requested === null } });
  if ("refused" in submitted) { unstashH3Swap(token); return c.json({ error: submitted.reason, code: submitted.code }, 503); }
  const settled = await waitForJob(submitted.job.id, 1000);
  if (!settled || settled.state === "queued" || settled.state === "running" || settled.state === "stalled") return c.json({ created: Math.floor(Date.now() / 1000), job: submitted.job.id, state: settled?.state ?? "queued" }, 202);
  if (settled.state !== "done") return c.json({ error: settled.reason ?? "The swap failed.", code: settled.status, job: settled.id }, 422);
  return c.json({ created: Math.floor(new Date(submitted.job.createdAt).getTime() / 1000), job: submitted.job.id, state: "done" }, 200);
});

const statusRoute = createRoute({ method: "get", path: "/swap/{job}", tags: ["Video"], summary: "Get H3 swap job progress", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "Job progress" }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "Unknown job" } } });
videoSwapRoutes.openapi(statusRoute, (c) => { const id = c.req.valid("param").job; const job = getJob(id); if (!job || !isSwapKind(job.kind)) return c.json({ error: "No such swap job." }, 404); return c.json({ job: id, state: job.state, progress: job.percent, status: job.status, error: job.reason ?? null, result: readResult(id) ? { video: `/v1/videos/swap/${id}/video.mp4`, poster: `/v1/videos/swap/${id}/poster.jpg` } : null }, 200); });
const videoRoute = createRoute({ method: "get", path: "/swap/{job}/video.mp4", tags: ["Video"], summary: "Fetch the finished H3 swap", request: { params: z.object({ job: z.string() }) }, responses: { 200: { description: "MP4" }, 206: { description: "MP4 range" }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "No result" } } });
videoSwapRoutes.openapi(videoRoute, (c) => { const id = c.req.valid("param").job; if (!isJobId(id) || !existsSync(videoPath(id))) return c.json({ error: "That swap clip is gone." }, 404); return fileResponse(c, videoPath(id), "video/mp4", c.req.header("range")) as never; });
const posterRoute = createRoute({ method: "get", path: "/swap/{job}/poster.jpg", tags: ["Video"], summary: "Fetch the H3 swap poster", request: { params: z.object({ job: z.string() }) }, responses: { 200: { description: "JPEG" }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "No poster" } } });
videoSwapRoutes.openapi(posterRoute, (c) => { const id = c.req.valid("param").job; if (!isJobId(id) || !existsSync(posterPath(id))) return c.json({ error: "That poster is gone." }, 404); return fileResponse(c, posterPath(id), "image/jpeg", undefined) as never; });
const deleteRoute = createRoute({ method: "delete", path: "/swap/{job}", tags: ["Video"], summary: "Cancel or delete an H3 swap", request: { params: z.object({ job: z.string() }) }, responses: { 200: { content: { "application/json": { schema: Reply } }, description: "Cancelled or deleted" }, 404: { content: { "application/json": { schema: ErrorBody } }, description: "Unknown swap" } } });
videoSwapRoutes.openapi(deleteRoute, (c) => { const id = c.req.valid("param").job; const job = getJob(id); if (job && isSwapKind(job.kind) && ["queued", "running", "stalled"].includes(job.state)) { cancelJob(id); const token = String((job.input as { token?: string } | null)?.token ?? ""); if (job.kind === H3_SWAP_JOB_KIND) unstashH3Swap(token); else discardStagedSwap(token); return c.json({ job: id, state: "cancelled" }, 200); } if (deleteResult(id)) return c.json({ job: id, state: "deleted" }, 200); return c.json({ error: "No such swap job." }, 404); });

async function saveSource(file: File): Promise<string> {
  const dir = join(dataDir, "tmp", "video-swap", "uploads"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${crypto.randomUUID()}.mp4`); writeFileSync(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 }); return path;
}
