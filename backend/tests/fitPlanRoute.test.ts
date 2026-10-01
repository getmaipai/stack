import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { app } from "@/app";
import { modelsRoot } from "@/lib/store/layout";
import { __resetHealthForTests } from "@/lib/health";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit } from "@/lib/governor";
import { defaultKvCacheType } from "@/lib/engineArgs";
import { raise } from "@/lib/health";
import { __setFitPlanInstallerForTests } from "@/routes/fitPlan";

const fixture = join(import.meta.dir, "fixtures", "gguf-parser-qwen3-1.7b-4096.json");
let originalBinary: string | undefined;
let originalFetch: typeof fetch;
const MLX_WEIGHT_BYTES = 968080210;
const MLX_CONFIG_BYTES = 937;
const mlxUrls = ["https://huggingface.co/api/models/mlx-community/Qwen3-1.7B-4bit/tree/main", "https://huggingface.co/mlx-community/Qwen3-1.7B-4bit/resolve/main/config.json"];
let mlxCalls: string[] = [];
let tempRoot = "";
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const planWithoutTool = (body: Record<string, unknown>) => { const { tool: _tool, ...plan } = body; return plan; };

beforeEach(() => { __setFitPlanInstallerForTests({}); originalFetch = globalThis.fetch; mlxCalls = []; originalBinary = process.env.STACK_GGUF_PARSER_BINARY; delete process.env.STACK_GGUF_PARSER_BINARY; tempRoot = mkdtempSync(join(tmpdir(), "stack-fit-plan-")); __resetHealthForTests(); __resetGovernorForTests(); });
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setFitPlanInstallerForTests({});
  if (originalBinary === undefined) delete process.env.STACK_GGUF_PARSER_BINARY;
  else process.env.STACK_GGUF_PARSER_BINARY = originalBinary;
  rmSync(tempRoot, { recursive: true, force: true });
  __resetGovernorForTests();
});

function fakeParser(): void {
  const output = join(tempRoot, "fixture.json");
  writeFileSync(output, readFileSync(fixture));
  const script = join(tempRoot, "gguf-parser");
  writeFileSync(script, `#!/bin/sh\ncat '${output}'\n`);
  chmodSync(script, 0o755);
  process.env.STACK_GGUF_PARSER_BINARY = script;
}

function stubMlxFetch(fail: "throw" | "404" | null = null, tree?: unknown): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    mlxCalls.push(url);
    if (fail === "throw") throw new Error("offline");
    if (url.includes("/api/models/") && url.includes("/tree/")) return fail === "404" ? new Response("not found", { status: 404 }) : Response.json(tree ?? [
      { type: "file", path: "model.safetensors", size: MLX_WEIGHT_BYTES, lfs: { size: MLX_WEIGHT_BYTES } },
      { type: "file", path: "config.json", size: MLX_CONFIG_BYTES },
    ]);
    if (url === mlxUrls[1]) return Response.json({ model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128, hidden_size: 2048, num_attention_heads: 16 });
    return new Response("unexpected URL", { status: 500 });
  }) as typeof fetch;
}

test("sizes a GGUF-only repository from its preferred quant file URL", async () => {
  fakeParser();
  const files = [
    { type: "file", path: "model-Q8_0.gguf", size: 200_000_000 },
    { type: "file", path: "model-Q4_K_M.gguf", size: 180_000_000 },
  ];
  stubMlxFetch(null, files);
  const parserStub = join(tempRoot, "record-parser");
  writeFileSync(parserStub, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${join(tempRoot, "parser-args.txt")}'\ncat '${fixture}'\n`);
  chmodSync(parserStub, 0o755);
  process.env.STACK_GGUF_PARSER_BINARY = parserStub;
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "org/model" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
  const args = readFileSync(join(tempRoot, "parser-args.txt"), "utf8");
  expect(body.model).toBe("model-Q4_K_M");
  expect(body.model_file_bytes).toBe(180_000_000);
  expect(args).toContain("https://huggingface.co/org/model/resolve/main/model-Q4_K_M.gguf");
});

test("MLX repository plans carry the safetensors weights sum as model file bytes", async () => {
  stubMlxFetch();
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.model_file_bytes).toBe(MLX_WEIGHT_BYTES);
  expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
});

test("store path plans carry the existing GGUF file's on-disk size", async () => {
  fakeParser();
  const path = join(modelsRoot, `fit-plan-size-${process.pid}.gguf`);
  mkdirSync(modelsRoot, { recursive: true });
  writeFileSync(path, Buffer.alloc(1234));
  try {
    const response = await app.request("/stack/v1/fit-plan", json({ source: { path } }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.model_file_bytes).toBe(1234);
    expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
  } finally { rmSync(path, { force: true }); }
});

test("safetensors repositories keep the MLX path when GGUF files are present", async () => {
  stubMlxFetch(null, [
    { type: "file", path: "model.safetensors", size: MLX_WEIGHT_BYTES },
    { type: "file", path: "model-Q4_K_M.gguf", size: 10 },
  ]);
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.model).toBe("mlx-community/Qwen3-1.7B-4bit");
  expect(mlxCalls).toEqual(mlxUrls);
});

test("a repository with only a vision projector stays unknown", async () => {
  stubMlxFetch(null, [{ type: "file", path: "mmproj-Q4_K_M.gguf", size: 10 }]);
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "org/model" } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { verdict: string }).verdict).toBe("unknown");
});

test("a missing GGUF repository returns 404", async () => {
  stubMlxFetch("404");
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "org/model" } }));
  expect(response.status).toBe(404);
});

test("safetensors take precedence over GGUF files", async () => {
  stubMlxFetch(null, [
    { type: "file", path: "model.safetensors", size: MLX_WEIGHT_BYTES },
    { type: "file", path: "model-Q4_K_M.gguf", size: 10 },
  ]);
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { model: string }).model).toBe("mlx-community/Qwen3-1.7B-4bit");
});

test("POST /stack/v1/fit-plan returns the spec plan for a Hugging Face GGUF", async () => {
  fakeParser();
  const request = { source: { url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/qwen3-1.7b-q8_0.gguf" }, context_tokens: 8192, kv_cache_type: "q8_0" };
  const response = await app.request("/stack/v1/fit-plan", json(request));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
  expect(body).toMatchObject({ context_tokens: 8192, kv_cache_type: "q8_0" });
  expect(body.roles[0].peak.source).toBe("estimated");
  expect(["yes", "slow", "no", "unknown"]).toContain(body.verdict);

  const defaults = await (await app.request("/stack/v1/fit-plan", json({ source: request.source }))).json() as { context_tokens: number; kv_cache_type: string };
  expect(defaults).toMatchObject({ context_tokens: 4096, kv_cache_type: defaultKvCacheType() });
  const explicit = await (await app.request("/stack/v1/fit-plan", json({ source: request.source, kv_cache_type: "q4_0" }))).json() as { kv_cache_type: string };
  expect(explicit.kv_cache_type).toBe("q4_0");
});

test("a failed parser install retries and returns unknown with not-installed", async () => {
  let installs = 0;
  __setFitPlanInstallerForTests({ install: async () => { installs++; throw new Error("offline"); } });
  const request = json({ source: { url: "https://huggingface.co/a/b.gguf" } });
  const response = await app.request("/stack/v1/fit-plan", request);
  expect(response.status).toBe(200);
  const body = await response.json() as { verdict: string; paths: Array<{ verdict: string }>; tool: { version: string } };
  expect(body.verdict).toBe("unknown");
  expect(body.tool.version).toBe("not-installed");
  expect(body.paths.every((item) => item.verdict === "unknown")).toBe(true);
  await app.request("/stack/v1/fit-plan", request);
  expect(installs).toBe(2);
  const health = await (await app.request("/stack/v1/health")).json() as { health: Array<{ code: string; fix?: { action: string } }> };
  expect(health.health).toContainEqual(expect.objectContaining({ code: "engine-missing.gguf-parser", fix: { label: "Install the size checker", action: "reinstall_engine" } }));
});

test("a missing parser installs on demand before planning and resolves its health item", async () => {
  __setFitPlanInstallerForTests({ install: async () => { fakeParser(); } });
  const response = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.roles[0].peak.source).toBe("estimated");
  const health = await (await app.request("/stack/v1/health")).json() as { health: Array<{ code: string }> };
  expect(health.health.some((item) => item.code === "engine-missing.gguf-parser")).toBe(false);
});

test("concurrent fit plans share one parser install", async () => {
  let installs = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  __setFitPlanInstallerForTests({ install: async () => { installs++; await held; fakeParser(); } });
  const request = () => app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  const first = request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = request();
  release();
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect(installs).toBe(1);
});

test("a platform without a parser pin stays unknown without installing", async () => {
  let installs = 0;
  __setFitPlanInstallerForTests({ selectPin: () => null, install: async () => { installs++; } });
  const response = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { tool: { version: string } }).tool.version).toBe("not-installed");
  expect(installs).toBe(0);
});

test("an available estimator resolves its missing-engine health item", async () => {
  const { raise, list } = await import("@/lib/health");
  raise({ code: "engine-missing.gguf-parser", severity: "warning", title: "missing", text: "missing", cause: "not installed", fix: { label: "Install", action: "reinstall_engine" } });
  fakeParser();
  const response = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(response.status).toBe(200);
  expect(list().some((item) => item.code === "engine-missing.gguf-parser")).toBe(false);
});

test("POST fit plan includes a currently loaded role", async () => {
  fakeParser();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * 1024 ** 3, freeMemoryBytes: 24 * 1024 ** 3, tier: "p32" });
  const loaded = await admit({ id: "stt", kind: "resident", requestedBytes: 1024 ** 3, measuredPeakBytes: 1024 ** 3 });
  expect("id" in loaded).toBe(true);
  const response = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
  expect(body.roles).toContainEqual(expect.objectContaining({ role: "stt", choice: "loaded" }));
});

test("fit planning accepts MLX repositories with f16 KV and never touches estimator health", async () => {
  stubMlxFetch();
  __setFitPlanInstallerForTests({ install: async () => { throw new Error("offline"); } });
  const { list } = await import("@/lib/health");
  const first = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(first.status).toBe(200);
  expect(list().some((item) => item.code === "engine-missing.gguf-parser")).toBe(true);
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" }, context_tokens: 4096, kv_cache_type: "q4_0" }));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(() => StackFitPlan.parse(planWithoutTool(body))).not.toThrow();
  expect(body).toMatchObject({ model: "mlx-community/Qwen3-1.7B-4bit", kv_cache_type: "f16" });
  expect(mlxCalls).toEqual(mlxUrls);
  expect(list().some((item) => item.code === "engine-missing.gguf-parser")).toBe(true);
  if (process.platform === "darwin" && process.arch === "arm64") {
    expect(body.roles[0].peak.source).toBe("estimated");
    expect(body.roles[0].peak.low).toBeLessThan(body.roles[0].peak.high);
  } else expect(body.verdict).toBe("unknown");
});

test("MLX metadata network failures return unknown and a missing repository returns 404", async () => {
  stubMlxFetch("throw");
  const response = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { verdict: string }).verdict).toBe("unknown");
  stubMlxFetch("404");
  const notFound = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(notFound.status).toBe(404);
  expect(await notFound.json()).toEqual({ error: "That model was not found on Hugging Face." });
  globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as unknown as typeof fetch;
  const unavailable = await app.request("/stack/v1/fit-plan", json({ source: { repo: "mlx-community/Qwen3-1.7B-4bit" } }));
  expect(unavailable.status).toBe(200);
  expect((await unavailable.json() as { verdict: string }).verdict).toBe("unknown");
});

test("fit planning accepts only Hugging Face GGUF URLs, model-store paths, and valid MLX repositories", async () => {
  raise({ code: "engine-missing.gguf-parser", severity: "warning", title: "missing", text: "missing", cause: "not installed", fix: { label: "Install", action: "reinstall_engine" } });
  const invalid = [
    { source: { url: "http://huggingface.co/x/y.gguf" } },
    { source: { repo: "../x" } },
    { source: { repo: "a/b/c" } },
    { source: { repo: "noslash" } },
    { source: { repo: "" } },
    { source: { repo: "mlx-community/model", revision: "a b" } },
    { source: { repo: "mlx-community/model", url: "https://huggingface.co/x/y.gguf" } },
    { source: { repo: "mlx-community/model", mystery: true } },
    { source: { url: "https://example.com/x.gguf" } },
    { source: { url: "https://huggingface.co/x/y.bin" } },
    { source: { path: join(tempRoot, "outside.gguf") } },
    { source: { path: join(modelsRoot, "..", "outside.gguf") } },
    { source: { url: "https://huggingface.co/x/y.gguf" }, extra: true },
    { source: { url: "https://huggingface.co/x/y.gguf" }, context_tokens: 10 },
  ];
  for (const body of invalid) {
    const response = await app.request("/stack/v1/fit-plan", json(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
  }
  const health = await (await app.request("/stack/v1/health")).json() as { health: Array<{ code: string }> };
  expect(health.health.some((item) => item.code === "engine-missing.gguf-parser")).toBe(true);
  const link = join(modelsRoot, `fit-plan-link-${process.pid}.gguf`);
  try {
    mkdirSync(modelsRoot, { recursive: true });
    writeFileSync(join(tempRoot, "target.gguf"), "x");
    symlinkSync(join(tempRoot, "target.gguf"), link);
    const response = await app.request("/stack/v1/fit-plan", json({ source: { path: link } }));
    expect(response.status).toBe(400);
  } finally { rmSync(link, { force: true }); }
});
