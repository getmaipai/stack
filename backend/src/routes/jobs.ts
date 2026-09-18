import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireClientOrOperator } from "@/lib/clients";
import { emit } from "@/lib/events";
import { MAINTENANCE_JOB_KINDS } from "@/lib/maintenance";

const JobSchema = z.object({ id: z.string(), kind: z.string(), state: z.enum(["queued", "running", "paused", "done", "failed", "cancelled"]), completedBytes: z.number().int(), totalBytes: z.number().int(), partCount: z.number().int(), updatedAt: z.string() });
type Job = z.infer<typeof JobSchema>;
const jobs = new Map<string, Job>();
export const registeredMaintenanceJobKinds = MAINTENANCE_JOB_KINDS;
const createRoute_ = createRoute({ method: "post", path: "/", tags: ["Jobs"], summary: "Create a Stack job", middleware: [requireClientOrOperator] as const, request: { body: { content: { "application/json": { schema: z.object({ kind: z.string(), totalBytes: z.number().int().nonnegative().default(0), partCount: z.number().int().positive().default(8) }) } } } }, responses: { 201: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "Job created." } } });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Jobs"], summary: "List Stack jobs", middleware: [requireClientOrOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } }, description: "Known jobs." } } });
const getRoute = createRoute({ method: "get", path: "/{id}", tags: ["Jobs"], summary: "Get a Stack job", middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "Job state." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown job." } } });
const cancelRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Jobs"], summary: "Cancel a Stack job", middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "Job cancelled." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown job." } } });
const actionRoute = (action: "pause" | "resume") => createRoute({ method: "post", path: `/{id}/${action}`, tags: ["Jobs"], summary: `${action[0]!.toUpperCase()}${action.slice(1)} a Stack job`, middleware: [requireClientOrOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: `Job ${action}d.` }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown job." } } });
function touch(job: Job, state: Job["state"]): Job { const next = { ...job, state, updatedAt: new Date().toISOString() }; jobs.set(job.id, next); emit({ id: "job.progress", data: { job: job.id, percent: job.totalBytes ? Math.round(job.completedBytes / job.totalBytes * 100) : 0, state } }); return next; }
export const jobsRoutes = apiRouter();
jobsRoutes.openapi(createRoute_, (c) => { const body = c.req.valid("json"); const id = `job-${crypto.randomUUID()}`; const job: Job = { id, kind: body.kind, state: "queued", completedBytes: 0, totalBytes: body.totalBytes, partCount: body.partCount, updatedAt: new Date().toISOString() }; jobs.set(id, job); return c.json({ job }, 201); });
jobsRoutes.openapi(listRoute, (c) => c.json({ jobs: [...jobs.values()] }, 200));
jobsRoutes.openapi(getRoute, (c) => { const job = jobs.get(c.req.valid("param").id); return job ? c.json({ job }, 200) : c.json({ error: "Unknown job" }, 404); });
jobsRoutes.openapi(cancelRoute, (c) => { const job = jobs.get(c.req.valid("param").id); return job ? c.json({ job: touch(job, "cancelled") }, 200) : c.json({ error: "Unknown job" }, 404); });
for (const action of ["pause", "resume"] as const) jobsRoutes.openapi(actionRoute(action), (c) => { const job = jobs.get(c.req.valid("param").id); return job ? c.json({ job: touch(job, action === "pause" ? "paused" : "running") }, 200) : c.json({ error: "Unknown job" }, 404); });
