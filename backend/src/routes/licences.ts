// GLOBAL-LICENCE: one acceptance for every part's licence, current and future.
// An admin accepts here once and no install asks again until the terms version
// changes. The same guard as the settings routes applies (admin session with
// CSRF, or Home's token); this router adds none of its own.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { allLicenceNotices } from "@/lib/components";
import { GLOBAL_LICENCE_TERMS_VERSION, globalLicenceAcceptance, recordGlobalLicenceAcceptance } from "@/lib/licenceAcceptance";

const ResponseSchema = z.object({
  terms_version: z.string().openapi({ description: "The licence terms version this acceptance covers; a new one asks again." }),
  accepted: z.boolean(),
  accepted_at: z.string().nullable(),
  by: z.string().nullable(),
  licences: z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), summary: z.array(z.string()) })).openapi({ description: "Every licence notice any part carries, de-duplicated." }),
});

const readRoute = createRoute({ method: "get", path: "/", tags: ["Licences"], summary: "Whether the admin has accepted every licence, and what is covered", responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "The global acceptance state and every notice it covers." } } });
const acceptRoute = createRoute({
  method: "post", path: "/", tags: ["Licences"], summary: "Accept every licence at once (an admin did)",
  request: { body: { required: false, content: { "application/json": { schema: z.object({ by: z.string().max(200).optional().openapi({ description: "An opaque label Home keeps for who accepted it." }) }) } } } },
  responses: { 200: { content: { "application/json": { schema: ResponseSchema } }, description: "The acceptance state after the change." } },
});

export const licencesRoutes = apiRouter<AppEnv>();
function view() {
  const acceptance = globalLicenceAcceptance();
  return {
    terms_version: GLOBAL_LICENCE_TERMS_VERSION,
    accepted: acceptance !== null,
    accepted_at: acceptance?.accepted_at ?? null,
    by: acceptance?.by ?? null,
    licences: allLicenceNotices().map(({ id, name, url, summary }) => ({ id, name, url, summary })),
  };
}
licencesRoutes.openapi(readRoute, (c) => c.json(view(), 200));
licencesRoutes.openapi(acceptRoute, (c) => {
  const body = c.req.valid("json") as { by?: string } | undefined;
  recordGlobalLicenceAcceptance(body?.by ?? null);
  return c.json(view(), 200);
});
