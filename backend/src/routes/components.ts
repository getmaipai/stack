// COMPONENTS-01: the installable parts of the Stack as one list, with an
// install and an uninstall for each (Home's Models and storage page, the
// setup wizard's estimate). Install runs as a job on the same job list as
// every download, so the install strip shows it; uninstall is immediate
// and reports the bytes it freed. Both are idempotent.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { ComponentError, listComponents, startComponentInstall, uninstallComponent } from "@/lib/components";

const ComponentSchema = z.object({
  id: z.string(), label: z.string(), summary: z.string(), group: z.enum(["chat", "voice", "pictures", "video", "music", "tools", "loras"]), kind: z.enum(["model", "lora"]),
  state: z.enum(["installed", "installing", "notInstalled", "failed"]),
  size_bytes: z.number().int().nullable().openapi({ description: "Bytes on disk now (models and their engine environment); null when nothing is installed." }),
  download_bytes: z.number().int().openapi({ description: "What an install would still download; 0 when installed." }),
  full_bytes: z.number().int().openapi({ description: "The size of a fresh install, for the setup estimate." }),
  required_free_bytes: z.number().int().openapi({ description: "Free space the data volume needs before an install starts (the disk plan's sum: installed size, margin and peak temporary space); 0 when installed." }),
  plan_need: z.enum(["required", "recommended", "optional"]).nullable().openapi({ description: "The setup wizard plan's word for it on this tier; recommended parts are on by default, optional ones (Z-Image-Turbo) off." }),
  requirement: z.enum(["required", "optional", "unsupported"]).openapi({ description: "For this computer's tier: required (Home installs it), optional, or unsupported (see requirement_reason)." }),
  requirement_reason: z.string().nullable(), last_used_at: z.string().nullable(), used_by: z.array(z.string()), depends_on: z.array(z.string()),
  job: z.string().nullable(), percent: z.number().nullable(), failure: z.string().nullable(),
  can_install: z.boolean(), install_block: z.string().nullable(), can_uninstall: z.boolean(), uninstall_block: z.string().nullable(),
});
const ErrorBody = z.object({ error: z.string(), code: z.string() });
const idParam = z.object({ id: z.string().min(1).max(200).openapi({ param: { name: "id", in: "path" }, example: "z-image-turbo" }) });

const listRoute = createRoute({
  method: "get", path: "/", tags: ["Components"], summary: "Every installable component, its state, size and what it needs",
  responses: { 200: { content: { "application/json": { schema: z.object({ tier: z.string().nullable(), free_disk_bytes: z.number().int().nullable(), disk_margin_bytes: z.number().int(), installed_bytes: z.number().int(), components: z.array(ComponentSchema) }) } }, description: "Additive. `free_disk_bytes` is the data volume's, the same figure the install plan uses." } },
});
const installRoute = createRoute({
  method: "post", path: "/{id}/install", tags: ["Components"], summary: "Install a component (one job: the files, then its engine environment)", request: { params: idParam },
  responses: {
    202: { content: { "application/json": { schema: z.object({ job: z.string(), component: z.string(), joined: z.boolean() }) } }, description: "The install job (/stack/v1/jobs/{id}); a second call while one runs joins it." },
    200: { content: { "application/json": { schema: z.object({ job: z.null(), component: z.string(), already_installed: z.literal(true) }) } }, description: "Already installed." },
    404: { content: { "application/json": { schema: ErrorBody } }, description: "unknown_component." },
    409: { content: { "application/json": { schema: ErrorBody } }, description: "not_available (this computer cannot run it) or not_enough_space (the data volume cannot hold it); the error is a sentence for the person." },
  },
});
const removeRoute = createRoute({
  method: "delete", path: "/{id}", tags: ["Components"], summary: "Uninstall a component and report the space freed", request: { params: idParam },
  responses: {
    200: { content: { "application/json": { schema: z.object({ component: z.string(), freed_bytes: z.number().int(), removed: z.boolean() }) } }, description: "Removed; removed=false (and freed_bytes 0) when it was not installed." },
    404: { content: { "application/json": { schema: ErrorBody } }, description: "unknown_component." },
    409: { content: { "application/json": { schema: ErrorBody } }, description: "in_use (a request or job is using it), required (Home needs it on this tier), chat_model_in_use or only_chat_model (chat would be left with no model); the error says what to do first." },
  },
});

export const componentsRoutes = apiRouter<AppEnv>();
componentsRoutes.openapi(listRoute, async (c) => c.json(await listComponents(), 200));
componentsRoutes.openapi(installRoute, async (c) => {
  try {
    const started = await startComponentInstall(c.req.valid("param").id);
    return started.job ? c.json({ job: started.job, component: started.component, joined: started.joined }, 202) : c.json({ job: null, component: started.component, already_installed: true as const }, 200);
  } catch (error) {
    if (error instanceof ComponentError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409);
    throw error;
  }
});
componentsRoutes.openapi(removeRoute, async (c) => {
  try { return c.json(await uninstallComponent(c.req.valid("param").id), 200); }
  catch (error) {
    if (error instanceof ComponentError) return c.json({ error: error.message, code: error.code }, error.status as 404 | 409);
    throw error;
  }
});
