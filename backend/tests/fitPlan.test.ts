import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { buildFitPlan, parseGgufParserJson, runGgufParser, type GgufEstimate, type PlanInput } from "@/lib/fitPlan";
import { MLX_IDLE_FACTOR, MLX_KV_PEAK_FACTOR, MLX_KV_PEAK_FACTOR_LOW, MLX_PREFIX_CACHE_BYTES, mlxHeadroomBytes } from "@/lib/mlxMemory";
import { peakFor, GovernorRules } from "@/lib/governor";

const fixturePath = join(import.meta.dir, "fixtures/gguf-parser-qwen3-1.7b-4096.json");
const fixtureText = readFileSync(fixturePath, "utf8");
const estimate = parseGgufParserJson(fixtureText)!;
const dirs: string[] = [];
const oldBinary = process.env.STACK_GGUF_PARSER_BINARY;
afterEach(() => {
  if (oldBinary === undefined) delete process.env.STACK_GGUF_PARSER_BINARY;
  else process.env.STACK_GGUF_PARSER_BINARY = oldBinary;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("parses the measured qwen3 estimate and rejects malformed values", () => {
  expect(estimate).toMatchObject({ architecture: "qwen3", ramUmaBytes: 690433896, ramNonumaBytes: 847720296, vramUmaBytes: 469762048, vramNonumaBytes: 2635880448, fullOffloaded: true });
  for (const text of ["{}", "", "not json"]) expect(parseGgufParserJson(text)).toBeNull();
  for (const mutate of [
    (x: any) => { x.estimate.items[0].ram.uma = -1; },
    (x: any) => { x.estimate.items[0].ram.uma = 1.5; },
    (x: any) => { delete x.estimate.items[0].vrams; },
  ]) {
    const data = JSON.parse(fixtureText); mutate(data);
    expect(parseGgufParserJson(JSON.stringify(data))).toBeNull();
  }
});

test("runs the configured parser with exact arguments for path and URL targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maipai-gguf-parser-")); dirs.push(dir);
  const argsFile = join(dir, "args");
  const binary = join(dir, "parser");
  writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat '${fixturePath}'\n`); chmodSync(binary, 0o755);
  process.env.STACK_GGUF_PARSER_BINARY = binary;
  expect(await runGgufParser({ target: { path: "/models/test.gguf" }, contextTokens: 4096, kvCacheType: "f16", gpuLayers: "all" })).toEqual(estimate);
  expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["--path", "/models/test.gguf", "--ctx-size", "4096", "--cache-type-k", "f16", "--cache-type-v", "f16", "--parallel", "1", "--flash-attention", "--gpu-layers", "99", "--json"]);
  expect(await runGgufParser({ target: { url: "https://example.invalid/model.gguf" }, contextTokens: 4096, kvCacheType: "f16", gpuLayers: 0 })).toEqual(estimate);
  expect(readFileSync(argsFile, "utf8").trim().split("\n").slice(0, 2)).toEqual(["--url", "https://example.invalid/model.gguf"]);
  const failing = join(dir, "fail"); writeFileSync(failing, "#!/bin/sh\nexit 1\n"); chmodSync(failing, 0o755);
  process.env.STACK_GGUF_PARSER_BINARY = failing;
  expect(await runGgufParser({ target: { path: "x" }, contextTokens: 4096, kvCacheType: "q8_0", gpuLayers: 0 })).toBeNull();
  process.env.STACK_GGUF_PARSER_BINARY = join(dir, "missing");
  expect(await runGgufParser({ target: { path: "x" }, contextTokens: 4096, kvCacheType: "f16", gpuLayers: 0 })).toBeNull();
});

const base: Omit<PlanInput, "estimate"> = { modelId: "qwen3-test", contextTokens: 4096, kvCacheType: "f16", unifiedMemory: true, deviceBudgetsBytes: [], capBytes: 16 * 1024 ** 3, workingMarginBytes: 4 * 1024 ** 3, asOf: "2026-09-30", tool: { name: "gguf-parser", version: "v0.26.4" } };
const broken = (input: Omit<PlanInput, "estimate"> & { estimate: GgufEstimate | null }) => buildFitPlan(input);

test("builds unified yes and no plans with estimate ranges and shortfalls", () => {
  const yes = broken({ ...base, estimate });
  expect(yes).toMatchObject({ verdict: "yes", paths: [{ path: "unified", fits: true, verdict: "yes" }], roles: [{ peak: { low: 2635880448, high: 3326314344, source: "estimated" } }] });
  expect(yes.paths[0]).not.toHaveProperty("shortfall");
  const no = broken({ ...base, estimate, capBytes: 3 * 1024 ** 3, workingMarginBytes: 1024 ** 3 });
  expect(no.verdict).toBe("no");
  expect(no.paths[0]?.shortfall).toMatchObject({ low: 2635880448 - (3 * 1073741824 - 1 * 1073741824), high: 3326314344 - (3 * 1073741824 - 1 * 1073741824), source: "estimated" });
});

test("plans the candidate alongside loaded roles and sums their peaks", () => {
  const loaded = [
    { role: "stt", kind: "resident" as const, peakBytes: 500 * 1024 ** 2, measured: true },
    { role: "tts", kind: "jit" as const, peakBytes: 1024 ** 3, measured: false },
  ];
  const plan = broken({ ...base, estimate, loaded, freeMemoryBytes: 12 * 1024 ** 3 });
  expect(plan.roles.map(({ role, choice }) => [role, choice])).toEqual([["chat", "proposed"], ["stt", "loaded"], ["tts", "loaded"]]);
  expect(plan.roles[1]?.peak).toMatchObject({ source: "measured" });
  expect(plan.roles[2]?.peak).toMatchObject({ source: "estimated" });
  expect(plan.total).toMatchObject({ low: 2635880448 + 500 * 1024 ** 2 + 1024 ** 3, high: 3326314344 + 500 * 1024 ** 2 + 1024 ** 3, source: "estimated" });
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
});

test("unloading the current chat makes room while other loaded roles still count", () => {
  const common = { ...base, estimate, capBytes: 16 * 1024 ** 3, workingMarginBytes: 4 * 1024 ** 3, freeMemoryBytes: 6 * 1024 ** 3 };
  const withChat = broken({ ...common, loaded: [{ role: "chat", kind: "resident", peakBytes: 2 * 1024 ** 3, measured: true }] });
  const withoutChat = broken({ ...common, loaded: [] });
  expect(withChat.verdict).toBe("yes");
  expect(withChat.roles).toHaveLength(1);
  expect(withoutChat.verdict).toBe("no");
});

test("loaded others can make an otherwise known candidate fail", () => {
  const plan = broken({ ...base, estimate, loaded: [{ role: "stt", kind: "resident", peakBytes: base.capBytes - 1 * 1024 ** 3, measured: true }], freeMemoryBytes: 16 * 1024 ** 3 });
  expect(plan.verdict).toBe("no");
  expect(plan.paths[0]).toHaveProperty("shortfall");
});

test("unlisted loaded roles count toward the fit plan total and verdict", () => {
  const loaded = [
    { role: "future-role", kind: "resident" as const, peakBytes: 500 * 1024 ** 2, measured: true },
    { role: "stt", kind: "resident" as const, peakBytes: 1024 ** 3, measured: false },
  ];
  const high = estimate.vramNonumaBytes + estimate.ramUmaBytes;
  const capBytes = high + 1024 ** 3 + 200 * 1024 ** 2;
  const freeMemoryBytes = 64 * 1024 ** 3;
  const plan = broken({ ...base, capBytes, estimate, loaded, freeMemoryBytes });
  const withoutFutureRole = broken({ ...base, capBytes, estimate, loaded: loaded.slice(1), freeMemoryBytes });
  expect(plan.roles).toHaveLength(2);
  expect(plan.roles.map(({ role }) => role)).toEqual(["chat", "stt"]);
  expect(plan.total).toMatchObject({ low: 2635880448 + 500 * 1024 ** 2 + 1024 ** 3, high: 3326314344 + 500 * 1024 ** 2 + 1024 ** 3, source: "estimated" });
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
  expect(withoutFutureRole.verdict).toBe("yes");
  expect(plan.verdict).toBe("no");
});

test("lists newly named loaded roles from the spec vocabulary", () => {
  const chatPeak = 2635880448;
  const plan = broken({ ...base, estimate, loaded: [
    { role: "judge", kind: "resident", peakBytes: 500 * 1024 ** 2, measured: true },
    { role: "stt", kind: "resident", peakBytes: 1024 ** 3, measured: false },
  ] });
  expect(plan.roles.map((r) => r.role)).toEqual(["chat", "judge", "stt"]);
  expect(plan.total.low).toBe(chatPeak + 500 * 1024 ** 2 + 1024 ** 3);
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
  for (const role of ["rerank", "music"] as const) {
    const listed = broken({ ...base, estimate, loaded: [{ role, kind: "resident", peakBytes: 500 * 1024 ** 2, measured: true }] });
    expect(listed.roles.map((r) => r.role)).toContain(role);
    expect(() => StackFitPlan.parse(listed)).not.toThrow();
  }
});

test("GPU device fit also checks the host memory estimate", () => {
  const plan = broken({ ...base, unifiedMemory: false, deviceBudgetsBytes: [8 * 1024 ** 3], estimate: { ...estimate, ramNonumaBytes: 20 * 1024 ** 3 }, freeMemoryBytes: 10 * 1024 ** 3 });
  expect(plan.paths.find((path) => path.path === "gpu")).toMatchObject({ fits: false, verdict: "no" });
});

test("unknown architectures and absent estimates stay unknown", () => {
  for (const candidate of [{ ...estimate, architecture: "gemma3" }, null]) {
    const plan = broken({ ...base, estimate: candidate });
    expect(plan).toMatchObject({ verdict: "unknown", bottleneck: "unknown", total: { low: null, high: null, source: "unknown" }, roles: [{ peak: { low: null, high: null, source: "unknown" } }], paths: [{ fits: false, verdict: "unknown" }] });
  }
});

test("plans discrete GPU and CPU paths and validates every plan against spec", () => {
  const gpuBase = { ...base, unifiedMemory: false, deviceBudgetsBytes: [8 * 1024 ** 3], capBytes: 32 * 1024 ** 3, workingMarginBytes: 4 * 1024 ** 3 };
  const plans = [
    broken({ ...gpuBase, estimate }),
    broken({ ...gpuBase, deviceBudgetsBytes: [8 * 1024 ** 3, 8 * 1024 ** 3], estimate }),
    broken({ ...gpuBase, estimate: { ...estimate, vramNonumaBytes: 9 * 1024 ** 3 }, cpuEstimate: { ...estimate, ramNonumaBytes: 1024 ** 3 } }),
    broken({ ...base, estimate }),
    broken({ ...base, estimate, capBytes: 3 * 1024 ** 3, workingMarginBytes: 1024 ** 3 }),
    broken({ ...base, estimate: { ...estimate, architecture: "gemma3" } }),
  ];
  expect(plans[0]!.verdict).toBe("yes");
  expect(plans[0]!.paths.find((p) => p.path === "gpu")).toMatchObject({ fits: true, verdict: "yes" });
  expect(plans[0]!.paths.find((p) => p.path === "cpu-offload")?.verdict).toBe("unknown");
  expect(plans[0]!.paths.find((p) => p.path === "multi-gpu")).toBeUndefined();
  expect(plans[1]!.paths.find((p) => p.path === "multi-gpu")?.verdict).toBe("unknown");
  expect(plans[2]!.verdict).toBe("slow");
  for (const plan of plans) expect(() => StackFitPlan.parse(plan)).not.toThrow();
  const invalid = { ...plans[0] } as Record<string, unknown>; delete invalid.verdict;
  expect(() => StackFitPlan.parse(invalid)).toThrow();
});

const mlxConfig = { model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128 };
const mlxFacts = { weightsBytes: 968080210, config: mlxConfig };
const mlxPlan = (input: Partial<PlanInput> = {}) => buildFitPlan({ ...base, estimate: null, mlx: mlxFacts, ...input });

test("plans an MLX repository on unified memory and leaves unverified cases unknown", () => {
  const plan = mlxPlan({ freeMemoryBytes: 12 * 1024 ** 3 });
  const kvPerToken = 28 * 8 * 128 * 2 * 2;
  const low = Math.ceil(MLX_IDLE_FACTOR * mlxFacts.weightsBytes) + MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR_LOW * kvPerToken * base.contextTokens);
  const high = Math.ceil(GovernorRules.engineMultipliers["mlx-serve"] * mlxFacts.weightsBytes) + MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR * kvPerToken * base.contextTokens);
  expect(plan.verdict).toBe("yes");
  expect(plan.roles[0]?.peak).toMatchObject({ low, high, source: "estimated" });
  expect(low).toBeLessThan(high);
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
  expect(mlxPlan({ mlx: { ...mlxFacts, config: { ...mlxConfig, model_type: "gemma3" } } })).toMatchObject({ verdict: "unknown", roles: [{ peak: { low: null, high: null, source: "unknown" } }] });
  expect(mlxPlan({ unifiedMemory: false })).toMatchObject({ verdict: "unknown", roles: [{ peak: { low: null, high: null, source: "unknown" } }] });
  const no = mlxPlan({ capBytes: 1, workingMarginBytes: 0 });
  expect(no.verdict).toBe("no");
  expect(no.paths[0]).toHaveProperty("shortfall");
});

test("MLX planning high equals the governor admission peak", () => {
  const modelDir = mkdtempSync(join(tmpdir(), "maipai-mlx-plan-parity-")); dirs.push(modelDir);
  writeFileSync(join(modelDir, "config.json"), JSON.stringify(mlxConfig));
  const plan = mlxPlan();
  expect(plan.roles[0]?.peak.high).toBe(peakFor({ id: "chat", kind: "resident", requestedBytes: 0, modelFileBytes: mlxFacts.weightsBytes, engine: "mlx-serve", headroomBytes: mlxHeadroomBytes({ modelDir, contextTokens: base.contextTokens }) }).bytes);
});
