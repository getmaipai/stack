import { createRoute, z } from "@hono/zod-openapi";
import { apiRouter } from "@maipai/core/src/openapi";
import type { AppEnv } from "@/types";
import { latestDisk } from "@/lib/diskState";
import { selectedModel } from "@/lib/supervisor";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function missingSelectedModels(): Array<{ role: string; model: string; missing_paths: string[] }> {
  const result: Array<{ role: string; model: string; missing_paths: string[] }> = [];
  const seen = new Set<string>();
  for (const role of ["chat", "coding", "embed", "vision", "stt", "tts", "wakeword"] as const) {
    const model = selectedModel(role); if (!model || seen.has(`${role}:${model.id}`)) continue;
    seen.add(`${role}:${model.id}`);
    const env = Object.entries(process.env).find(([key, value]) => key.startsWith("MAIPAI_") && key.endsWith("_HOME") && value && value === model.modelPath);
    const path = env?.[1] ?? model.modelPath;
    if (!path) continue;
    const expected = model.modelPath && existsSync(model.modelPath) ? [model.modelPath] : [path];
    const missing = expected.filter((file) => { try { const s = statSync(file); return !s.isFile() && !s.isDirectory(); } catch { return true; } });
    if (missing.length) result.push({ role, model: model.id, missing_paths: missing });
  }
  return result;
}
const Volume = z.object({ path: z.string(), free_bytes: z.number(), total_bytes: z.number(), level: z.enum(["normal", "warn", "critical"]), warn_bytes: z.number(), critical_bytes: z.number() });
const route = createRoute({ method: "get", path: "/", tags: ["Disk"], summary: "Disk space and selected model files", responses: { 200: { content: { "application/json": { schema: z.object({ level: z.enum(["normal", "warn", "critical"]), volumes: z.array(Volume), missing: z.array(z.object({ role: z.string(), model: z.string(), missing_paths: z.array(z.string()) })) }) } }, description: "Current disk volume levels and missing files for selected models." } } });
export const diskRoutes = apiRouter<AppEnv>();
diskRoutes.openapi(route, (c) => c.json({ ...latestDisk(), missing: missingSelectedModels() }, 200));
