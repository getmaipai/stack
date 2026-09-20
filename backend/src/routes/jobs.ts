import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { cancelJob, getJob, JobSchema, listJobs, submitJob } from "@/lib/jobs";
import { RoleIdSchema } from "@/roles";

const submitRoute = createRoute({ method: "post", path: "/", tags: ["Jobs"], summary: "Submit a generator job", request: { body: { content: { "application/json": { schema: z.object({ kind: z.string(), role: RoleIdSchema.optional(), input: z.record(z.string(), z.unknown()).optional() }) } } } }, responses: { 202: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "Queued; progress arrives on the event feed." }, 503: { content: { "application/json": { schema: ErrorSchema } }, description: "Nothing on this machine can run the kind." } } });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Jobs"], summary: "Recent jobs", responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.array(JobSchema) }) } }, description: "Running and recently finished jobs." } } });
const getRoute = createRoute({ method: "get", path: "/{id}", tags: ["Jobs"], summary: "A job and its result", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "The job." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown job." } } });
const cancelRoute = createRoute({ method: "delete", path: "/{id}", tags: ["Jobs"], summary: "Cancel a job", request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ job: JobSchema }) } }, description: "Cancelled (or already finished)." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown job." } } });

export const jobsRoutes = apiRouter<AppEnv>();
jobsRoutes.openapi(submitRoute, (c) => { const body = c.req.valid("json"); const result = submitJob({ kind: body.kind, role: body.role ?? null, input: body.input }); return "refused" in result ? c.json({ error: result.reason }, 503) : c.json({ job: result.job }, 202); });
jobsRoutes.openapi(listRoute, (c) => c.json({ jobs: listJobs() }, 200));
jobsRoutes.openapi(getRoute, (c) => { const job = getJob(c.req.valid("param").id); return job ? c.json({ job }, 200) : c.json({ error: "Unknown job" }, 404); });
jobsRoutes.openapi(cancelRoute, (c) => { const job = cancelJob(c.req.valid("param").id); return job ? c.json({ job }, 200) : c.json({ error: "Unknown job" }, 404); });
