import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter, ErrorSchema, idParamSchema } from "@/lib/openapi";
import { requireOperator } from "@/lib/operator";
import { adoptDetected, detectAll, forgetDetected, listDetected, type DetectedRecord } from "@/lib/detect";
import { showroom, showroomAdoptDetected, showroomDetected } from "@/showroom/fixture";

const DetectedSchema = z.object({ id: z.string(), kind: z.string(), name: z.string(), version: z.string(), where: z.string(), couldHold: z.array(z.string()), firstSeen: z.string(), lastSeen: z.string(), forgotten: z.boolean(), adopted: z.boolean(), target: z.string().nullable() });
const listRoute = createRoute({ method: "get", path: "/", tags: ["Detected"], summary: "List locally detected engines and folders", middleware: [requireOperator] as const, request: { query: z.object({ all: z.coerce.boolean().optional() }) }, responses: { 200: { content: { "application/json": { schema: z.object({ detected: z.array(DetectedSchema) }) } }, description: "Detected rows, excluding forgotten rows unless requested." } } });
const scanRoute = createRoute({ method: "post", path: "/scan", tags: ["Detected"], summary: "Run the local detection sweep", middleware: [requireOperator] as const, responses: { 200: { content: { "application/json": { schema: z.object({ detected: z.array(DetectedSchema) }) } }, description: "Current local detection results." } } });
const adoptRoute = createRoute({ method: "post", path: "/{id}/adopt", tags: ["Detected"], summary: "Adopt a detected engine or folder", middleware: [requireOperator] as const, request: { params: idParamSchema("id"), body: { content: { "application/json": { schema: z.object({ roles: z.array(z.string()).min(1) }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), id: z.string(), target: z.string(), roles: z.array(z.string()) }) } }, description: "The detected item is now managed or imported." }, 400: { content: { "application/json": { schema: ErrorSchema } }, description: "The host disappeared or roles are invalid." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown detected item." } } });
const forgetRoute = createRoute({ method: "post", path: "/{id}/forget", tags: ["Detected"], summary: "Forget a detected engine or folder", middleware: [requireOperator] as const, request: { params: idParamSchema("id") }, responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.literal(true), id: z.string() }) } }, description: "The row is hidden without changing the source." }, 404: { content: { "application/json": { schema: ErrorSchema } }, description: "Unknown detected item." } } });

function showroomRows(): DetectedRecord[] {
  const now = new Date().toISOString(); return showroomDetected.map((item) => ({ id: item.id, kind: item.kind === "server" ? "comfyui" : "folder", name: item.name, version: item.version, where: item.path, couldHold: item.roles as DetectedRecord["couldHold"], firstSeen: now, lastSeen: now, forgotten: false, adopted: false, target: null }));
}

export const detectedRoutes = apiRouter();
detectedRoutes.openapi(listRoute, (c) => { const includeForgotten = c.req.valid("query").all === true; return c.json({ detected: (showroom() ? showroomRows() : listDetected(includeForgotten)).filter((item) => includeForgotten || !item.forgotten) } as never, 200); });
detectedRoutes.openapi(scanRoute, async (c) => c.json({ detected: showroom() ? showroomRows() : await detectAll() } as never, 200));
detectedRoutes.openapi(adoptRoute, async (c) => {
  const id = c.req.valid("param").id; const roles = c.req.valid("json").roles;
  if (showroom()) { if (!showroomDetected.some((item) => item.id === id)) return c.json({ error: "Unknown detected item" }, 404); showroomAdoptDetected(id); return c.json({ ok: true as const, id, target: `showroom:${id}`, roles }, 200); }
  try { const result = await adoptDetected(id, roles); return c.json({ ok: true as const, ...result }, 200); } catch (error) { const message = error instanceof Error ? error.message : "Could not adopt detected item."; return c.json({ error: message }, message === "Unknown detected item." ? 404 : 400); }
});
detectedRoutes.openapi(forgetRoute, (c) => {
  const id = c.req.valid("param").id;
  if (showroom()) { if (!showroomDetected.some((item) => item.id === id)) return c.json({ error: "Unknown detected item" }, 404); showroomAdoptDetected(id); return c.json({ ok: true as const, id }, 200); }
  if (!forgetDetected(id)) return c.json({ error: "Unknown detected item" }, 404); return c.json({ ok: true as const, id }, 200);
});
