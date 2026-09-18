import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRecord } from "@/lib/modelStore";
import { listModels } from "@/lib/modelStore";
import { latestSpeedResult, recordSpeedResult, type SpeedResult } from "@/lib/series";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { getChatEngineStatus } from "@/lib/supervisor";
import { currentEngine } from "@/updates/engines";
import { engineToolPath } from "@/lib/engineInstall";
import { installedEnginePin } from "@/lib/engineCatalog";

export const SPEED_TEST_REPETITIONS = 3;
export const SPEED_TEST_CONTEXT_LENGTH = 4096;

export interface LlamaBenchEntry {
  model_filename?: string;
  build_number?: number;
  n_prompt?: number;
  n_gen?: number;
  avg_ts?: number;
  samples_ts?: number[];
}

export interface ParsedSpeedTest {
  promptTps: number;
  tokensPerSecond: number;
}

function numberAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonOutput(output: string): LlamaBenchEntry[] | null {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is LlamaBenchEntry => typeof entry === "object" && entry !== null) : null;
  } catch {
    return null;
  }
}

function parseMarkdownOutput(output: string): ParsedSpeedTest | null {
  const prompt = output.match(/(?:pp|prompt)[^|\n]*\|\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  const generation = output.match(/(?:tg|gen|generation)[^|\n]*\|\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
  if (!prompt || !generation) return null;
  return { promptTps: Number(prompt), tokensPerSecond: Number(generation) };
}

export function parseLlamaBenchOutput(output: string): ParsedSpeedTest {
  const entries = parseJsonOutput(output);
  if (entries) {
    const prompt = entries.find((entry) => (entry.n_prompt ?? 0) > 0 && (entry.n_gen ?? 0) === 0);
    const generation = entries.find((entry) => (entry.n_gen ?? 0) > 0);
    const promptTps = numberAt(prompt?.avg_ts ?? prompt?.samples_ts?.[0]);
    const tokensPerSecond = numberAt(generation?.avg_ts ?? generation?.samples_ts?.[0]);
    if (promptTps !== null && tokensPerSecond !== null) return { promptTps, tokensPerSecond };
  }
  const markdown = parseMarkdownOutput(output);
  if (markdown) return markdown;
  throw new Error("llama-bench returned no prompt-processing and generation measurements.");
}

export function llamaBenchArgs(modelPath: string, repetitions = SPEED_TEST_REPETITIONS): string[] {
  return ["-m", modelPath, "-p", "512", "-n", "128", "-r", String(repetitions), "-o", "json"];
}

function benchPath(): string {
  const pin = installedEnginePin();
  return pin ? engineToolPath(pin, "llama-bench") : join("", "llama-bench");
}

function regressionCode(modelId: string, contextLength: number): string {
  return `speed-regression.${modelId}.${contextLength}`;
}

export function applySpeedRegression(previous: SpeedResult | null, current: SpeedResult): void {
  if (!current.modelId || current.tokensPerSecond === null) return;
  const code = regressionCode(current.modelId, current.contextLength ?? SPEED_TEST_CONTEXT_LENGTH);
  if (previous?.tokensPerSecond && current.tokensPerSecond < previous.tokensPerSecond * 0.9) {
    const engine = current.engine ?? "the current engine";
    raise({
      code,
      severity: "warning",
      title: "Chat got slower",
      text: `Chat got slower after engine ${engine}: ${current.tokensPerSecond} tokens per second, was ${previous.tokensPerSecond}.`,
      cause: "The speed test fell more than ten percent for the same model and context.",
      fix: { label: "Go back", action: "rollback_engine" },
    });
  } else {
    resolveHealth(code);
  }
}

export async function runSpeedTest(model: ModelRecord, options: { contextLength?: number; repetitions?: number } = {}): Promise<SpeedResult> {
  if (!model.modelPath) throw new Error(`Model ${model.id} has no installed path.`);
  const executable = benchPath();
  if (!existsSync(executable)) throw new Error("The installed llama-server build does not include llama-bench.");
  const contextLength = options.contextLength ?? model.measuredContextLength ?? SPEED_TEST_CONTEXT_LENGTH;
  const repetitions = options.repetitions ?? SPEED_TEST_REPETITIONS;
  const processHandle = Bun.spawn([executable, ...llamaBenchArgs(model.modelPath, repetitions)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    processHandle.stderr ? new Response(processHandle.stderr).text() : Promise.resolve(""),
    processHandle.exited,
  ]);
  if (exitCode !== 0) throw new Error(`llama-bench failed with exit code ${exitCode}.${stderr.trim() ? ` ${stderr.trim().split("\n").slice(-1)[0]}` : ""}`);
  const parsed = parseLlamaBenchOutput(stdout);
  const status = getChatEngineStatus();
  const previous = latestSpeedResult(model.id, contextLength);
  const result = recordSpeedResult({
    ability: "chat",
    modelId: model.id,
    engine: currentEngine("llama-server") ?? status.identity?.build ?? null,
    firstTokenMs: status.postLoadCheck?.firstTokenMs ?? null,
    loadMs: status.postLoadCheck?.loadMs ?? null,
    measuredFootprintBytes: model.measuredFootprintBytes,
    promptTps: Math.round(parsed.promptTps),
    tokensPerSecond: Math.round(parsed.tokensPerSecond),
    contextLength,
  });
  applySpeedRegression(previous, result);
  return result;
}

export function residentChatModel(): ModelRecord | null {
  return listModels().find((model) => model.roles.includes("chat") && model.modelPath && model.verifiedAt && model.sha256 && model.licence) ?? null;
}

export function scheduleSpeedTest(): void {
  if (process.env.NODE_ENV === "test") return;
  const model = residentChatModel();
  const status = getChatEngineStatus();
  if (!model || status.state !== "ready") return;
  void runSpeedTest(model).catch(() => {});
}
