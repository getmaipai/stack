import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { buildFitPlan, largestAdmittedContext, parseGgufParserJson, runGgufParser, type GgufEstimate, type PlanInput } from "@/lib/fitPlan";
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
  expect(estimate.expertCount).toBe(0);
  for (const mutate of [
    (x: any) => { x.estimate.items[0].ram.uma = -1; },
    (x: any) => { x.estimate.items[0].ram.uma = 1.5; },
    (x: any) => { delete x.estimate.items[0].vrams; },
  ]) {
    const data = JSON.parse(fixtureText); mutate(data);
    expect(parseGgufParserJson(JSON.stringify(data))).toBeNull();
  }
});

test("parses the parser's exact model file size when present", () => {
  const saved = JSON.parse(readFileSync("/Users/jessetorres/Developer/github.com/getmaipai/stack/data-scratch/sizer-bake/local-32768-f16.json", "utf8"));
  expect(saved.metadata.fileSize).toBe(1834426016);
  expect(parseGgufParserJson(JSON.stringify(saved))?.modelFileBytes).toBe(1834426016);
  const withoutSize = JSON.parse(fixtureText);
  delete withoutSize.metadata.fileSize;
  expect(parseGgufParserJson(JSON.stringify(withoutSize))?.modelFileBytes).toBeUndefined();
});

test("parses measured dense llama, rejects invalid expert counts, and plans only dense models", () => {
  const llamaText = readFileSync(join(import.meta.dir, "fixtures/gguf-parser-llama-3.2-3b-4096.json"), "utf8");
  const llamaFixture = JSON.parse(llamaText);
  const llama = parseGgufParserJson(llamaText)!;
  expect(llama).toMatchObject({ architecture: "llama", expertCount: 0 });
  expect(llama).toMatchObject({
    ramUmaBytes: llamaFixture.estimate.items[0].ram.uma,
    ramNonumaBytes: llamaFixture.estimate.items[0].ram.nonuma,
    vramUmaBytes: llamaFixture.estimate.items[0].vrams[0].uma,
    vramNonumaBytes: llamaFixture.estimate.items[0].vrams[0].nonuma,
  });
  const withExperts = (expertCount: unknown) => {
    const data = JSON.parse(llamaText);
    data.architecture.expertCount = expertCount;
    return parseGgufParserJson(JSON.stringify(data));
  };
  expect(withExperts(8)?.expertCount).toBe(8);
  for (const expertCount of ["8", -1, 1.5]) expect(withExperts(expertCount)).toBeNull();

  const plan = broken({ ...base, estimate: llama });
  expect(plan.verdict).toBe("yes");
  expect(plan.roles[0]?.peak).toMatchObject({ low: llama.vramNonumaBytes, high: llama.vramNonumaBytes + llama.ramUmaBytes, source: "estimated" });
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
  const moe = broken({ ...base, estimate: { ...llama, expertCount: 8 } });
  expect(moe).toMatchObject({ verdict: "unknown", total: { low: null, high: null, source: "unknown" }, roles: [{ peak: { low: null, high: null, source: "unknown" } }] });
  const gemma = broken({ ...base, estimate: { ...llama, architecture: "gemma3" } });
  expect(gemma.verdict).toBe("unknown");
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
  const no = broken({ ...base, estimate, capBytes: 3 * 1024 ** 3 });
  expect(no.verdict).toBe("no");
  expect(no.paths[0]?.shortfall).toMatchObject({ low: 0, high: 3326314344 - 3 * 1024 ** 3, source: "estimated" });
});

test("plans the candidate alongside loaded roles and sums their peaks", () => {
  const loaded = [
    { role: "stt", kind: "resident" as const, peakBytes: 500 * 1024 ** 2, measured: true },
    { role: "tts", kind: "jit" as const, peakBytes: 1024 ** 3, measured: false },
  ];
  const plan = broken({ ...base, estimate, loaded });
  expect(plan.roles.map(({ role, choice }) => [role, choice])).toEqual([["chat", "proposed"], ["stt", "loaded"], ["tts", "loaded"]]);
  expect(plan.roles[1]?.peak).toMatchObject({ source: "measured" });
  expect(plan.roles[2]?.peak).toMatchObject({ source: "estimated" });
  expect(plan.total).toMatchObject({ low: 2635880448 + 500 * 1024 ** 2 + 1024 ** 3, high: 3326314344 + 500 * 1024 ** 2 + 1024 ** 3, source: "estimated" });
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
});

test("a loaded chat model is replaced by the candidate, not added to it", () => {
  const high = estimate.vramNonumaBytes + estimate.ramUmaBytes;
  const capBytes = high + 1024 ** 3;
  const chat = { role: "chat", kind: "resident" as const, peakBytes: 2 * 1024 ** 3, measured: true };
  const replaced = broken({ ...base, estimate, capBytes, loaded: [chat] });
  expect(replaced.verdict).toBe("yes");
  expect(replaced.roles).toHaveLength(1);
  expect(replaced.total.high).toBe(high);
  const withStt = broken({ ...base, estimate, capBytes, loaded: [chat, { role: "stt", kind: "resident" as const, peakBytes: capBytes - high + 1, measured: true }] });
  expect(withStt.verdict).toBe("no");
});

test("free memory does not change the verdict", () => {
  const input = { ...base, estimate, capBytes: 16 * 1024 ** 3 };
  const ordinary = broken(input);
  const withLegacyFreeMemory = broken({ ...input, ...({ freeMemoryBytes: 0 } as Partial<PlanInput>) });
  expect(withLegacyFreeMemory.verdict).toBe(ordinary.verdict);
  expect(withLegacyFreeMemory.total).toEqual(ordinary.total);
});

test("loaded others can make an otherwise known candidate fail", () => {
  const plan = broken({ ...base, estimate, loaded: [{ role: "stt", kind: "resident", peakBytes: base.capBytes - 1 * 1024 ** 3, measured: true }] });
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
  const plan = broken({ ...base, capBytes, estimate, loaded });
  const withoutFutureRole = broken({ ...base, capBytes, estimate, loaded: loaded.slice(1) });
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
  const plan = broken({ ...base, unifiedMemory: false, deviceBudgetsBytes: [8 * 1024 ** 3], estimate: { ...estimate, ramNonumaBytes: 20 * 1024 ** 3 } });
  expect(plan.paths.find((path) => path.path === "gpu")).toMatchObject({ fits: false, verdict: "no" });
});

test("unknown architectures and absent estimates stay unknown", () => {
  for (const candidate of [{ ...estimate, architecture: "gemma3" }, null]) {
    const plan = broken({ ...base, estimate: candidate });
    expect(plan).toMatchObject({ verdict: "unknown", bottleneck: "unknown", total: { low: null, high: null, source: "unknown" }, roles: [{ peak: { low: null, high: null, source: "unknown" } }], paths: [{ fits: false, verdict: "unknown" }] });
  }
});

test("admits the installed Nomic embed model from its measured footprint when parser estimate is absent", () => {
  const measuredBytes = 132_039_496;
  const modelFileBytes = 84_106_624;
  const plan = broken({
    ...base,
    modelId: "nomic-embed-text-v1-5-q4-k-m",
    contextTokens: 8192,
    capBytes: 16 * 1024 ** 3,
    estimate: null,
    modelFileBytes,
    measuredPeakBytes: measuredBytes,
  });
  expect(plan.verdict).toBe("yes");
  expect(plan.roles[0]?.peak).toMatchObject({ low: measuredBytes, high: measuredBytes, source: "measured" });
});

test("uses the documented governor catalog estimate when an installed model has size but no measurement", () => {
  const modelFileBytes = 84_106_624;
  const expected = Math.ceil(modelFileBytes * GovernorRules.engineMultipliers["llama-server"]);
  const plan = broken({
    ...base,
    modelId: "nomic-embed-text-v1-5-q4-k-m",
    contextTokens: 8192,
    estimate: null,
    modelFileBytes,
  });
  expect(plan.verdict).toBe("yes");
  expect(plan.roles[0]?.peak).toMatchObject({ low: expected, high: expected, source: "estimated" });
});

test("known model file size gets a catalog estimate even for an unverified architecture", () => {
  const withBytes = broken({ ...base, estimate: { ...estimate, architecture: "gemma3", modelFileBytes: 1834426016 }, modelFileBytes: 1834426016 });
  expect(withBytes).toMatchObject({ verdict: "yes", model_file_bytes: 1834426016, roles: [{ peak: { source: "estimated", high: Math.ceil(1834426016 * GovernorRules.engineMultipliers["llama-server"]) } }] });
  expect(() => StackFitPlan.parse(withBytes)).not.toThrow();
  const withoutBytes = broken({ ...base, estimate: { ...estimate, architecture: "gemma3" } });
  expect(withoutBytes).not.toHaveProperty("model_file_bytes");
  expect(() => StackFitPlan.parse(withoutBytes)).not.toThrow();
});

test("a fit plan with the optional model file size validates against the generated schema", () => {
  const plan = broken({ ...base, estimate, modelFileBytes: 11800000000 });
  expect(plan.model_file_bytes).toBe(11800000000);
  expect(() => StackFitPlan.parse(plan)).not.toThrow();
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
  const plan = mlxPlan();
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

test("automatic context chooses the largest admitted size and respects the model cap", async () => {
  const rows = new Map<number, GgufEstimate>();
  for (const contextTokens of [8192, 16384, 32768, 40960]) {
    rows.set(contextTokens, { ...estimate, contextTokens, ramNonumaBytes: contextTokens * 100_000, ramUmaBytes: contextTokens * 100_000, vramNonumaBytes: contextTokens * 100_000, fullOffloaded: false, architecture: "qwen3", expertCount: 0 });
  }
  const choose = (capBytes: number, modelContextTokens = 40960) => largestAdmittedContext({
    ...base, unifiedMemory: true, deviceBudgetsBytes: [], estimate: null, modelContextTokens, capBytes: capBytes + base.workingMarginBytes,
    estimateAt: (contextTokens) => rows.get(contextTokens) ?? null,
  });
  const only8k = await choose(100_000_000, 8192);
  expect(only8k.contextTokens).toBe(8192);
  const thirtyTwoK = await choose(3_500_000_000, 40960);
  expect(thirtyTwoK.contextTokens).toBe(32768);
  const capped = await choose(16 * 1024 ** 3, 32768);
  expect(capped.contextTokens).toBe(32768);
  const refused = await choose(0, 8192);
  expect(refused.contextTokens).toBe(8192);
});
