import { withTimeout } from "@maipai/core/src/withTimeout";
import { StackFitPlan, type StackFitPlan as StackFitPlanType } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { currentEngineBinaryPath } from "@/lib/engineInstall";

// An architecture joins this list only after one bench row agrees with a real load (docs/dev.md).
export const VERIFIED_ARCHITECTURES = ["qwen3"] as const;

export interface GgufEstimate {
  architecture: string;
  name: string | null;
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
    const item = root?.estimate?.items?.[0];
    const vram = item?.vrams?.[0];
    const name = root?.metadata?.name;
    const numbers = [root?.estimate?.contextSize, item?.ram?.uma, item?.ram?.nonuma, vram?.uma, vram?.nonuma];
    if (typeof architecture !== "string" || !architecture.trim() || typeof item?.fullOffloaded !== "boolean" || !numbers.every(isBytes)) return null;
    if (name !== undefined && name !== null && typeof name !== "string") return null;
    return { architecture, name: name ?? null, contextTokens: root.estimate.contextSize, fullOffloaded: item.fullOffloaded, ramUmaBytes: item.ram.uma, ramNonumaBytes: item.ram.nonuma, vramUmaBytes: vram.uma, vramNonumaBytes: vram.nonuma };
  } catch { return null; }
}

export async function runGgufParser(input: { target: { path: string } | { url: string }; contextTokens: number; kvCacheType: "f16" | "q8_0" | "q4_0"; gpuLayers: "all" | 0 }): Promise<GgufEstimate | null> {
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
  contextTokens: number;
  kvCacheType: "f16" | "q8_0" | "q4_0";
  estimate: GgufEstimate | null;
  cpuEstimate?: GgufEstimate | null;
  unifiedMemory: boolean;
  deviceBudgetsBytes: number[];
  capBytes: number;
  workingMarginBytes: number;
  asOf: string;
  tool: { name: string; version: string };
}

type Figure = { low: number; high: number; source: "measured" | "estimated"; as_of: string };
type UnknownFigure = { low: null; high: null; source: "unknown"; as_of: string };
const known = (low: number, high: number, source: Figure["source"], as_of: string): Figure => ({ low, high, source, as_of });
const unknown = (as_of: string): UnknownFigure => ({ low: null, high: null, source: "unknown", as_of });
const verified = (estimate: GgufEstimate | null | undefined): estimate is GgufEstimate => !!estimate && (VERIFIED_ARCHITECTURES as readonly string[]).includes(estimate.architecture);

export function buildFitPlan(input: PlanInput): StackFitPlanType {
  const date = input.asOf;
  const budget = Math.max(0, input.capBytes - input.workingMarginBytes);
  const paths: StackFitPlanType["paths"] = [];
  let peak: Figure | UnknownFigure = unknown(date);
  let verdict: "yes" | "slow" | "no" | "unknown" = "unknown";

  if (verified(input.estimate)) {
    const estimate = input.estimate;
    if (input.unifiedMemory) {
      peak = known(estimate.vramNonumaBytes, estimate.vramNonumaBytes + estimate.ramUmaBytes, "estimated", date);
      const fits = peak.high <= budget;
      verdict = fits ? "yes" : "no";
      const path: StackFitPlanType["paths"][number] = { path: "unified", fits, verdict: fits ? "yes" : "no" };
      if (!fits) path.shortfall = known(Math.max(0, peak.low - budget), Math.max(0, peak.high - budget), "estimated", date);
      paths.push(path);
    } else if (input.deviceBudgetsBytes.length) {
      peak = known(estimate.vramNonumaBytes, estimate.vramNonumaBytes, "estimated", date);
      const gpuFits = estimate.vramNonumaBytes <= Math.max(...input.deviceBudgetsBytes);
      paths.push({ path: "gpu", fits: gpuFits, verdict: gpuFits ? "yes" : "no" });
      const cpu = verified(input.cpuEstimate) ? input.cpuEstimate : null;
      const cpuFits = !!cpu && cpu.ramNonumaBytes <= budget;
      paths.push({ path: "cpu", fits: cpuFits, verdict: cpu ? (cpuFits ? "slow" : "no") : "unknown" });
      // Multi-GPU and CPU offload are not modeled yet.
      if (input.deviceBudgetsBytes.length >= 2) paths.push({ path: "multi-gpu", fits: false, verdict: "unknown" });
      paths.push({ path: "cpu-offload", fits: false, verdict: "unknown" });
      verdict = gpuFits ? "yes" : cpuFits ? "slow" : "no";
    } else {
      const cpu = verified(input.cpuEstimate) ? input.cpuEstimate : null;
      if (cpu) {
        peak = known(cpu.ramNonumaBytes, cpu.ramNonumaBytes, "estimated", date);
        const fits = cpu.ramNonumaBytes <= budget;
        verdict = fits ? "slow" : "no";
        paths.push({ path: "cpu", fits, verdict: fits ? "slow" : "no" });
      } else {
        paths.push({ path: "cpu", fits: false, verdict: "unknown" });
      }
    }
  } else {
    if (input.unifiedMemory) paths.push({ path: "unified", fits: false, verdict: "unknown" });
    else if (input.deviceBudgetsBytes.length) {
      paths.push({ path: "gpu", fits: false, verdict: "unknown" });
      paths.push({ path: "cpu", fits: false, verdict: "unknown" });
      if (input.deviceBudgetsBytes.length >= 2) paths.push({ path: "multi-gpu", fits: false, verdict: "unknown" });
      paths.push({ path: "cpu-offload", fits: false, verdict: "unknown" });
    } else paths.push({ path: "cpu", fits: false, verdict: "unknown" });
  }

  const total = peak;
  const role = { role: "chat" as const, choice: "proposed", peak };
  // Other roles are not included yet; a later item sums them.
  return { schema: 1, model: input.modelId, context_tokens: input.contextTokens, kv_cache_type: input.kvCacheType, roles: [role], total, cap: known(input.capBytes, input.capBytes, "measured", date), margin: known(input.workingMarginBytes, input.workingMarginBytes, "measured", date), paths, verdict, bottleneck: verdict === "unknown" ? "unknown" : "memory" };
}
