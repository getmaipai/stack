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
import { runSweeps } from "@/lib/sweeps";
import { diagnosticsBundle } from "@/lib/diagnostics";
import { PreciousState } from "@maipai/spec/stack/ts/precious-state.js";
import { clearOutsideCache, planCaches } from "@/lib/cacheGuard";

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
const sweepRoute = createRoute({ method: "post", path: "/storage/sweep", tags: ["Declarations"], summary: "Prune orphaned blobs and run the tidy cleanup", responses: { 200: { content: { "application/json": { schema: z.object({ removed: z.array(z.string()), sweep: z.object({ reason: z.string(), removed_files: z.number().int(), freed_bytes: z.number().int(), per_sweep: z.array(z.object({ name: z.string(), removed: z.number().int(), bytes: z.number().int() })) }) }) } }, description: "Orphaned blobs removed and per-sweep cleanup totals, including tidy." } } });
const cachesRoute = createRoute({ method: "get", path: "/storage/caches", tags: ["Declarations"], summary: "Plan Stack-owned and outside cache cleanup", responses: { 200: { content: { "application/json": { schema: z.object({ owned: z.array(z.object({ path: z.string(), kind: z.enum(["tmp_leftover", "dangling_link"]), bytes: z.number(), ageHours: z.number() })), outside: z.array(z.object({ path: z.string(), bytes: z.number(), note: z.string() })), tidy: z.object({ reclaimable_bytes: z.number() }) } ) } }, description: "Cache cleanup candidates and tidy reclaimable bytes." } } });
const clearCacheRoute = createRoute({ method: "post", path: "/storage/caches/clear", tags: ["Declarations"], summary: "Clear an outside cache while preserving tokens and settings", request: { body: { content: { "application/json": { schema: z.object({ path: z.string() }) } } } }, responses: { 200: { content: { "application/json": { schema: z.object({ freed_bytes: z.number(), kept: z.array(z.string()), problems: z.array(z.string()) }) } }, description: "Cleared cache totals and any preserved files or errors." } } });
const diagnosticsRoute = createRoute({ method: "get", path: "/diagnostics", tags: ["Declarations"], summary: "A redacted diagnostics bundle (zip)", responses: { 200: { content: { "application/zip": { schema: z.string() } }, description: "Log tail, health, hardware, settings, versions. Nothing is sent anywhere." } } });

export const declarationRoutes = apiRouter<AppEnv>();
declarationRoutes.openapi(privacyRoute, (c) => c.json({ rows: PRIVACY_ROWS }, 200));
declarationRoutes.openapi(backupRoute, (c) => c.json(preciousState(), 200));
declarationRoutes.openapi(sweepRoute, async (c) => { const removed = pruneUnreferenced(); const sweep = await runSweeps("storage"); return c.json({ removed, sweep }, 200); });
declarationRoutes.openapi(cachesRoute, async (c) => c.json(await planCaches(), 200));
declarationRoutes.openapi(clearCacheRoute, async (c) => c.json(await clearOutsideCache(c.req.valid("json").path), 200));
declarationRoutes.openapi(diagnosticsRoute, async (c) => new Response(await diagnosticsBundle(), { status: 200, headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="maipai-stack-diagnostics.zip"' } }) as never);
