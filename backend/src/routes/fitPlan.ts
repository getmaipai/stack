import { createRoute, z } from "@hono/zod-openapi";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { apiRouter, ErrorSchema } from "@maipai/core/src/openapi";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import type { AppEnv } from "@/types";
import { buildFitPlan, estimatorAvailable, runGgufParser } from "@/lib/fitPlan";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getGovernorStatus } from "@/lib/governor";
import { detectHardware } from "@/lib/hardware";
import { modelsRoot } from "@/lib/store/layout";
import { installedEnginePin } from "@/lib/engineCatalog";
import { defaultKvCacheType } from "@/lib/engineArgs";
import { fetchMlxRepoFacts, isValidMlxRepo, isValidMlxRevision } from "@/lib/mlxMemory";

const SourceSchema = z.union([
  z.object({ url: z.string() }).strict(),
  z.object({ path: z.string() }).strict(),
  z.object({ repo: z.string(), revision: z.string().optional() }).strict(),
]);
const FitPlanRequestSchema = z.object({
  source: SourceSchema,
  context_tokens: z.number().int().min(256).max(1_048_576).default(4096),
  kv_cache_type: z.enum(["f16", "q8_0", "q4_0"]).optional().openapi({ description: "Defaults to what the Stack will actually launch with on this computer (q8_0 on macOS, f16 elsewhere)." }),
}).strict();
const route = createRoute({
  method: "post", path: "/", tags: ["Hardware"], summary: "Would this model fit this machine, before it is downloaded",
  request: { body: { content: { "application/json": { schema: FitPlanRequestSchema } } } },
  responses: {
    200: { content: { "application/json": { schema: StackFitPlan } }, description: "The model fit plan." },
    400: { content: { "application/json": { schema: ErrorSchema } }, description: "The source must be a Hugging Face GGUF address, a GGUF path in the model store, or a Hugging Face model repository." },
  },
});

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

export const fitPlanRoutes = apiRouter<AppEnv>();
fitPlanRoutes.openapi(route, async (c) => {
  const { source, context_tokens: contextTokens, kv_cache_type: requestedKvCacheType } = c.req.valid("json");
  const kvCacheType = requestedKvCacheType ?? defaultKvCacheType();
  if ("repo" in source) {
    const revision = source.revision ?? "main";
    if (!isValidMlxRepo(source.repo) || !isValidMlxRevision(revision)) return c.json({ error: "The repository must look like owner/name, and the revision must be a plain tag, branch or commit." }, 400);
    const hw = await detectHardware();
    const unifiedMemory = hw.isAppleSilicon;
    const deviceBudgetsBytes = unifiedMemory ? [] : hw.cudaDevices.map((d) => d.vramBytes - (d.usedVramBytes ?? 0));
    const status = getGovernorStatus();
    const facts = await fetchMlxRepoFacts({ repo: source.repo, revision });
    return c.json(buildFitPlan({
      modelId: source.repo, contextTokens, kvCacheType: "f16", estimate: null, cpuEstimate: undefined,
      mlx: facts ? { weightsBytes: facts.weightsBytes, config: facts.config } : null,
      unifiedMemory, deviceBudgetsBytes, capBytes: status.capBytes, workingMarginBytes: status.marginBytes,
      loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })),
      asOf: new Date().toISOString().slice(0, 10),
      tool: { name: "huggingface-metadata", version: "api" },
      // mlx-serve is launched without --kv-quant; STACK-SIZE-11 changes that later.
    }), 200);
  }
  let target: { url: string } | { path: string };
  let modelId: string;
  if ("url" in source) {
    let url: URL;
    try { url = new URL(source.url); } catch { return c.json({ error: "The URL must be a Hugging Face GGUF address." }, 400); }
    if (url.protocol !== "https:" || url.host !== "huggingface.co" || !url.pathname.endsWith(".gguf")) return c.json({ error: "The URL must be a Hugging Face GGUF address." }, 400);
    target = { url: source.url };
    modelId = url.pathname.split("/").at(-1)!.slice(0, -5);
  } else {
    const resolvedPath = resolve(source.path);
    const root = resolve(modelsRoot);
    if (!resolvedPath.endsWith(".gguf") || !inside(root, resolvedPath)) return c.json({ error: "The path must be a GGUF file inside the model store." }, 400);
    try {
      const realRoot = realpathSync(root);
      const realTarget = realpathSync(resolvedPath);
      if (!inside(realRoot, realTarget)) return c.json({ error: "The path must be a GGUF file inside the model store." }, 400);
    } catch {
      // A not-yet-present in-store path is allowed for planning; existing
      // symlinks are resolved above and cannot escape the model store.
    }
    target = { path: resolvedPath };
    modelId = basename(resolvedPath).slice(0, -5);
  }

  if (!estimatorAvailable()) raise({ code: "engine-missing.gguf-parser", severity: "warning", title: "The model size checker is not installed", text: "Until it is installed, whether a model fits this computer is reported as unknown.", cause: "gguf-parser is pinned by the Stack but has not been downloaded on this machine.", fix: { label: "Install the size checker", action: "reinstall_engine" } });
  else resolveHealth("engine-missing.gguf-parser");

  const hw = await detectHardware();
  const unifiedMemory = hw.isAppleSilicon;
  const deviceBudgetsBytes = unifiedMemory ? [] : hw.cudaDevices.map((d) => d.vramBytes - (d.usedVramBytes ?? 0));
  const status = getGovernorStatus();
  const estimate = await runGgufParser({ target, contextTokens, kvCacheType, gpuLayers: "all" });
  const cpuEstimate = unifiedMemory ? undefined : await runGgufParser({ target, contextTokens, kvCacheType, gpuLayers: 0 });
  const pin = installedEnginePin("gguf-parser");
  return c.json(buildFitPlan({
    modelId, contextTokens, kvCacheType, estimate, cpuEstimate, unifiedMemory,
    deviceBudgetsBytes, capBytes: status.capBytes, workingMarginBytes: status.marginBytes,
    loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })),
    asOf: new Date().toISOString().slice(0, 10),
    tool: pin ? { name: "gguf-parser", version: pin.tag } : { name: "gguf-parser", version: "not-installed" },
  }), 200);
});
