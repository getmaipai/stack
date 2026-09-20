// The three "as data" routes Home renders: the outbound rows for its
// privacy page, the precious state for its backup, and the storage sweep
// it schedules. Plus the diagnostics bundle for its support flow.
import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { PRIVACY_ROWS, PrivacyRowSchema } from "@/lib/privacy";
import { dataDir, keysDir, stackDbPath } from "@/lib/paths";
import { engineRoot, modelsRoot } from "@/lib/store/layout";
import { pruneUnreferenced } from "@/lib/store/manifests";
import { diagnosticsBundle } from "@/lib/diagnostics";
import { PreciousState } from "@/spec/ts/precious-state";

export function preciousState(): PreciousState {
  return PreciousState.parse({
    data_dir: dataDir,
    paths: [
      { path: stackDbPath, mode: "include" as const, what: "The Stack's state", why: "Settings values, model provenance, measured peaks and open health items live here and nowhere else." },
      { path: keysDir, mode: "include" as const, what: "Keys", why: "Small and not recoverable from anywhere else." },
      { path: modelsRoot, mode: "exclude" as const, what: "Model files", why: "Rebuilt from their pins: every file is downloaded again and verified by checksum." },
      { path: engineRoot, mode: "exclude" as const, what: "Engine builds", why: "Rebuilt from their pins on the next install." },
    ],
  });
}

const privacyRoute = createRoute({ method: "get", path: "/privacy", tags: ["Declarations"], summary: "The Stack's outbound endpoints, as rows for Home's privacy page", responses: { 200: { content: { "application/json": { schema: z.object({ rows: z.array(PrivacyRowSchema) }) } }, description: "What leaves the house, when, what it carries, who receives it." } } });
const backupRoute = createRoute({ method: "get", path: "/backup", tags: ["Declarations"], summary: "Which state is precious, for Home's backup", responses: { 200: { content: { "application/json": { schema: PreciousState } }, description: "Paths to include and to exclude, with the reason for each." } } });
const sweepRoute = createRoute({ method: "post", path: "/storage/sweep", tags: ["Declarations"], summary: "Prune orphaned blobs past their grace period", responses: { 200: { content: { "application/json": { schema: z.object({ removed: z.array(z.string()) }) } }, description: "The digests removed." } } });
const diagnosticsRoute = createRoute({ method: "get", path: "/diagnostics", tags: ["Declarations"], summary: "A redacted diagnostics bundle (zip)", responses: { 200: { content: { "application/zip": { schema: z.string() } }, description: "Log tail, health, hardware, settings, versions. Nothing is sent anywhere." } } });

export const declarationRoutes = apiRouter<AppEnv>();
declarationRoutes.openapi(privacyRoute, (c) => c.json({ rows: PRIVACY_ROWS }, 200));
declarationRoutes.openapi(backupRoute, (c) => c.json(preciousState(), 200));
declarationRoutes.openapi(sweepRoute, (c) => c.json({ removed: pruneUnreferenced() }, 200));
declarationRoutes.openapi(diagnosticsRoute, async (c) => new Response(await diagnosticsBundle(), { status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="maipai-stack-diagnostics.zip"' } }) as never);
