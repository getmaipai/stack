import { withTimeout } from "@maipai/core/src/withTimeout";
import { StackFitPlan, type StackFitPlan as StackFitPlanType } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { currentEngineBinaryPath } from "@/lib/engineInstall";
import type { KvCacheType } from "@/lib/engineArgs";
import { existsSync } from "node:fs";
import { MLX_IDLE_FACTOR, MLX_KV_PEAK_FACTOR, MLX_KV_PEAK_FACTOR_LOW, MLX_PREFIX_CACHE_BYTES, parseMlxKvBytesPerToken } from "@/lib/mlxMemory";
import { GovernorRules } from "@/lib/governor";

// qwen3 and llama were each agreed with real loads (SIZER-BAKE-03; SIZER-LLAMA-01 on Llama 3.2 3B Q4_K_M); dense files only.
export const VERIFIED_ARCHITECTURES = ["qwen3", "llama"] as const;

export function estimatorAvailable(): boolean {
  const configured = process.env.STACK_GGUF_PARSER_BINARY;
  return (configured ? existsSync(configured) : false) || currentEngineBinaryPath("gguf-parser") !== null;
}

export interface GgufEstimate {
  architecture: string;
  expertCount: number;
  name: string | null;
  modelFileBytes?: number;
  contextTokens: number;
  fullOffloaded: boolean;
  ramUmaBytes: number;
  ramNonumaBytes: number;
  vramUmaBytes: number;
  vramNonumaBytes: number;
}

function isBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function parseGgufParserJson(text: string): GgufEstimate | null {
  try {
    const root = JSON.parse(text) as Record<string, any>;
    const architecture = root?.architecture?.architecture;
    const expertCount = root?.architecture?.expertCount;
    const item = root?.estimate?.items?.[0];
    const vram = item?.vrams?.[0];
    const name = root?.metadata?.name;
    const modelFileBytes = root?.metadata?.fileSize;
    const numbers = [root?.estimate?.contextSize, item?.ram?.uma, item?.ram?.nonuma, vram?.uma, vram?.nonuma];
    if (typeof architecture !== "string" || !architecture.trim() || typeof item?.fullOffloaded !== "boolean" || !numbers.every(isBytes)) return null;
    if (expertCount !== undefined && expertCount !== null && !isBytes(expertCount)) return null;
    if (name !== undefined && name !== null && typeof name !== "string") return null;
    if (modelFileBytes !== undefined && !isBytes(modelFileBytes)) return null;
    return { architecture, expertCount: expertCount ?? 0, name: name ?? null, ...(modelFileBytes === undefined ? {} : { modelFileBytes }), contextTokens: root.estimate.contextSize, fullOffloaded: item.fullOffloaded, ramUmaBytes: item.ram.uma, ramNonumaBytes: item.ram.nonuma, vramUmaBytes: vram.uma, vramNonumaBytes: vram.nonuma };
  } catch { return null; }
}

export async function runGgufParser(input: { target: { path: string } | { url: string }; contextTokens: number; kvCacheType: KvCacheType; gpuLayers: "all" | 0 }): Promise<GgufEstimate | null> {
  try {
    const binary = process.env.STACK_GGUF_PARSER_BINARY || currentEngineBinaryPath("gguf-parser");
    if (!binary) return null;
    const target = "path" in input.target ? ["--path", input.target.path] : ["--url", input.target.url];
    const args = [binary, ...target, "--ctx-size", String(input.contextTokens), "--cache-type-k", input.kvCacheType, "--cache-type-v", input.kvCacheType, "--parallel", "1", "--flash-attention", "--gpu-layers", input.gpuLayers === "all" ? "99" : "0", "--json"];
    const processHandle = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const outputPromise = (async () => `${await new Response(processHandle.stdout).text()}\n${await new Response(processHandle.stderr).text()}`)();
    try {
      const [output, exitCode] = await withTimeout(Promise.all([outputPromise, processHandle.exited]), 60_000, () => new Error("gguf-parser timed out."));
      return exitCode === 0 ? parseGgufParserJson(output) : null;
    } catch (error) {
      if ((error as Error).message === "gguf-parser timed out.") processHandle.kill();
      return null;
    }
  } catch { return null; }
}

export interface PlanInput {
  modelId: string;
  modelFileBytes?: number;
  /** Whole-process footprint recorded after the model's latest successful load. */
  measuredPeakBytes?: number | null;
  contextTokens: number;
  kvCacheType: KvCacheType;
  estimate: GgufEstimate | null;
  mlx?: { weightsBytes: number; config: unknown } | null;
  cpuEstimate?: GgufEstimate | null;
  unifiedMemory: boolean;
  deviceBudgetsBytes: number[];
  capBytes: number;
  workingMarginBytes: number;
  loaded?: { role: string; kind: "resident" | "jit" | "generator"; peakBytes: number; measured: boolean }[];
  asOf: string;
  tool: { name: string; version: string };
}

type Figure = { low: number; high: number; source: "measured" | "estimated"; as_of: string };
type UnknownFigure = { low: null; high: null; source: "unknown"; as_of: string };
const specRoles = new Set<string>(StackFitPlan.shape.roles.element.shape.role.options);
const known = (low: number, high: number, source: Figure["source"], as_of: string): Figure => ({ low, high, source, as_of });
const unknown = (as_of: string): UnknownFigure => ({ low: null, high: null, source: "unknown", as_of });
const verified = (estimate: GgufEstimate | null | undefined): estimate is GgufEstimate => !!estimate && estimate.expertCount === 0 && (VERIFIED_ARCHITECTURES as readonly string[]).includes(estimate.architecture);

function allUnknownPaths(input: PlanInput): StackFitPlanType["paths"] {
  if (input.unifiedMemory) return [{ path: "unified", fits: false, verdict: "unknown" }];
  if (input.deviceBudgetsBytes.length) {
    const paths: StackFitPlanType["paths"] = [
      { path: "gpu", fits: false, verdict: "unknown" },
      { path: "cpu", fits: false, verdict: "unknown" },
    ];
    if (input.deviceBudgetsBytes.length >= 2) paths.push({ path: "multi-gpu", fits: false, verdict: "unknown" });
    paths.push({ path: "cpu-offload", fits: false, verdict: "unknown" });
    return paths;
  }
  return [{ path: "cpu", fits: false, verdict: "unknown" }];
}

export function buildFitPlan(input: PlanInput): StackFitPlanType {
  const date = input.asOf;
  const loaded = input.loaded ?? [];
  const others = loaded.filter((item) => item.role !== "chat");
  const othersBytes = others.reduce((sum, item) => sum + item.peakBytes, 0);
  // mirrors the first condition of canAdmit in governor.ts (loaded plus the candidate within the cap, with the current chat model unloaded); the second condition, free memory now, is a moment-in-time question that admission answers by queueing, so the plan does not include it
  const available = Math.max(0, input.capBytes - othersBytes);
  const paths: StackFitPlanType["paths"] = [];
  let peak: Figure | UnknownFigure = unknown(date);
  let verdict: "yes" | "slow" | "no" | "unknown" = "unknown";

  if ((input.measuredPeakBytes ?? 0) > 0) {
    const measured = input.measuredPeakBytes!;
    peak = known(measured, measured, "measured", date);
    if (input.unifiedMemory) {
      const fits = measured <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "unified", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(measured - available, measured - available, "measured", date);
      paths.push(path);
    } else if (input.deviceBudgetsBytes.length) {
      const fits = measured <= Math.max(...input.deviceBudgetsBytes) && measured <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "gpu", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, measured - Math.min(available, Math.max(...input.deviceBudgetsBytes))), Math.max(0, measured - Math.min(available, Math.max(...input.deviceBudgetsBytes))), "measured", date);
      paths.push(path);
    } else {
      const fits = measured <= available;
      verdict = fits ? "slow" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "cpu", fits, verdict: fits ? "slow" : "no" };
      if (!fits) path.shortfall = known(measured - available, measured - available, "measured", date);
      paths.push(path);
    }
  } else if (!input.estimate && input.mlx) {
    const kvPerToken = parseMlxKvBytesPerToken(input.mlx.config);
    if (input.unifiedMemory && kvPerToken !== null) {
      const low = Math.ceil(MLX_IDLE_FACTOR * input.mlx.weightsBytes) + MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR_LOW * kvPerToken * input.contextTokens);
      const high = Math.ceil(GovernorRules.engineMultipliers["mlx-serve"] * input.mlx.weightsBytes) + MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR * kvPerToken * input.contextTokens);
      peak = known(low, high, "estimated", date);
      const fits = peak.high <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "unified", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, peak.low - available), Math.max(0, peak.high - available), "estimated", date);
      paths.push(path);
    } else {
      paths.push(...allUnknownPaths(input));
    }
  } else if (verified(input.estimate)) {
    const estimate = input.estimate;
    if (input.unifiedMemory) {
      peak = known(estimate.vramNonumaBytes, estimate.vramNonumaBytes + estimate.ramUmaBytes, "estimated", date);
      const fits = peak.high <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "unified", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, peak.low - available), Math.max(0, peak.high - available), "estimated", date);
      paths.push(path);
    } else if (input.deviceBudgetsBytes.length) {
      peak = known(estimate.vramNonumaBytes, estimate.vramNonumaBytes, "estimated", date);
      const gpuFits = estimate.vramNonumaBytes <= Math.max(...input.deviceBudgetsBytes) && estimate.ramNonumaBytes <= available;
      paths.push({ path: "gpu", fits: gpuFits, verdict: gpuFits ? "yes" : "no" });
      const cpu = verified(input.cpuEstimate) ? input.cpuEstimate : null;
      const cpuFits = !!cpu && cpu.ramNonumaBytes <= available;
      paths.push({ path: "cpu", fits: cpuFits, verdict: cpu ? (cpuFits ? "slow" : "no") : "unknown" });
      // Multi-GPU and CPU offload are not modeled yet.
      if (input.deviceBudgetsBytes.length >= 2) paths.push({ path: "multi-gpu", fits: false, verdict: "unknown" });
      paths.push({ path: "cpu-offload", fits: false, verdict: "unknown" });
      verdict = gpuFits ? "yes" : cpuFits ? "slow" : "no";
    } else {
      const cpu = verified(input.cpuEstimate) ? input.cpuEstimate : null;
      if (cpu) {
        peak = known(cpu.ramNonumaBytes, cpu.ramNonumaBytes, "estimated", date);
        const fits = cpu.ramNonumaBytes <= available;
        verdict = fits ? "slow" : "no";
        paths.push({ path: "cpu", fits, verdict: fits ? "slow" : "no" });
      } else {
        paths.push({ path: "cpu", fits: false, verdict: "unknown" });
      }
    }
  } else if ((input.modelFileBytes ?? 0) > 0) {
    // Installed models remain plannable when gguf-parser is absent or
    // does not recognize their architecture. Prefer the latest measured
    // footprint; otherwise mirror the governor's catalog estimate:
    // model file bytes times its llama-server multiplier.
    const high = Math.ceil(input.modelFileBytes! * GovernorRules.engineMultipliers["llama-server"]);
    peak = known(high, high, "estimated", date);
    if (input.unifiedMemory) {
      const fits = high <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "unified", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, high - available), Math.max(0, high - available), "estimated", date);
      paths.push(path);
    } else if (input.deviceBudgetsBytes.length) {
      const fits = high <= Math.max(...input.deviceBudgetsBytes) && high <= available;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "gpu", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, high - Math.min(available, Math.max(...input.deviceBudgetsBytes))), Math.max(0, high - Math.min(available, Math.max(...input.deviceBudgetsBytes))), "estimated", date);
      paths.push(path);
    } else {
      const fits = high <= available;
      verdict = fits ? "slow" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "cpu", fits, verdict: fits ? "slow" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, high - available), Math.max(0, high - available), "estimated", date);
      paths.push(path);
    }
  } else {
    paths.push(...allUnknownPaths(input));
  }

  const total = peak.low === null ? peak : known(peak.low + othersBytes, peak.high! + othersBytes, "estimated", date);
  const role = { role: "chat" as const, choice: "proposed", peak };
  // a loaded role the spec vocabulary does not name (a Stack role added ahead of the spec) still counts in the total but is not listed, so a response can never fail the schema
  const loadedRoles = verdict === "unknown" ? [] : others.filter((item) => specRoles.has(item.role)).map((item) => ({ role: item.role as (typeof StackFitPlan.shape.roles.element.shape.role.options)[number], choice: "loaded" as const, peak: known(item.peakBytes, item.peakBytes, item.measured ? "measured" : "estimated", date) }));
  return { schema: 1, model: input.modelId, ...(input.modelFileBytes === undefined ? {} : { model_file_bytes: input.modelFileBytes }), context_tokens: input.contextTokens, kv_cache_type: input.kvCacheType, roles: [role, ...loadedRoles], total, cap: known(input.capBytes, input.capBytes, "measured", date), margin: known(input.workingMarginBytes, input.workingMarginBytes, "measured", date), paths, verdict, bottleneck: verdict === "unknown" ? "unknown" : "memory" };
}

/** Select the largest context admitted by the same estimator used by the
 * fit-plan route. Unknown estimates never authorize a larger launch. */
export async function largestAdmittedContext(input: Omit<PlanInput, "contextTokens" | "cpuEstimate"> & { modelContextTokens: number; minimumTokens?: number; stepTokens?: number; estimateAt: (contextTokens: number) => Promise<GgufEstimate | null> | GgufEstimate | null; cpuEstimateAt?: (contextTokens: number) => Promise<GgufEstimate | null> | GgufEstimate | null; memoryContextMultiplier?: number }): Promise<{ contextTokens: number; plan: StackFitPlanType }> {
  const maximum = Math.max(0, Math.floor(input.modelContextTokens / 512) * 512);
  const minimum = input.minimumTokens ?? 8192;
  const step = input.stepTokens ?? 512;
  for (let contextTokens = maximum; contextTokens >= minimum; contextTokens -= step) {
    const { modelContextTokens: _modelContextTokens, minimumTokens: _minimumTokens, stepTokens: _stepTokens, estimateAt, cpuEstimateAt, memoryContextMultiplier: _memoryContextMultiplier, ...planInput } = input;
    const memoryContextMultiplier = input.memoryContextMultiplier ?? 1;
    const plan = buildFitPlan({ ...planInput, contextTokens: contextTokens * memoryContextMultiplier, estimate: await estimateAt(contextTokens), cpuEstimate: await cpuEstimateAt?.(contextTokens) ?? null });
    if (plan.verdict === "yes" || plan.verdict === "slow") return { contextTokens, plan };
  }
  const contextTokens = Math.min(minimum, maximum);
  const { modelContextTokens: _modelContextTokens, minimumTokens: _minimumTokens, stepTokens: _stepTokens, estimateAt, cpuEstimateAt, memoryContextMultiplier: _memoryContextMultiplier, ...planInput } = input;
  const memoryContextMultiplier = input.memoryContextMultiplier ?? 1;
  return { contextTokens, plan: buildFitPlan({ ...planInput, contextTokens: contextTokens * memoryContextMultiplier, estimate: await estimateAt(contextTokens), cpuEstimate: await cpuEstimateAt?.(contextTokens) ?? null }) };
}
