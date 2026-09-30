import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { buildFitPlan, parseGgufParserJson, runGgufParser, type GgufEstimate, type PlanInput } from "@/lib/fitPlan";

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
