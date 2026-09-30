import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StackFitPlan } from "@maipai/spec/gen/ts/stack-fit-plan.js";
import { app } from "@/app";
import { modelsRoot } from "@/lib/store/layout";

const fixture = join(import.meta.dir, "fixtures", "gguf-parser-qwen3-1.7b-4096.json");
let originalBinary: string | undefined;
let tempRoot = "";
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { originalBinary = process.env.STACK_GGUF_PARSER_BINARY; tempRoot = mkdtempSync(join(tmpdir(), "stack-fit-plan-")); });
afterEach(() => {
  if (originalBinary === undefined) delete process.env.STACK_GGUF_PARSER_BINARY;
  else process.env.STACK_GGUF_PARSER_BINARY = originalBinary;
  rmSync(tempRoot, { recursive: true, force: true });
});

function fakeParser(): void {
  const output = join(tempRoot, "fixture.json");
  writeFileSync(output, readFileSync(fixture));
  const script = join(tempRoot, "gguf-parser");
  writeFileSync(script, `#!/bin/sh\ncat '${output}'\n`);
  chmodSync(script, 0o755);
  process.env.STACK_GGUF_PARSER_BINARY = script;
}

test("POST /stack/v1/fit-plan returns the spec plan for a Hugging Face GGUF", async () => {
  fakeParser();
  const request = { source: { url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/qwen3-1.7b-q8_0.gguf" }, context_tokens: 8192, kv_cache_type: "q8_0" };
  const response = await app.request("/stack/v1/fit-plan", json(request));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(() => StackFitPlan.parse(body)).not.toThrow();
  expect(body).toMatchObject({ context_tokens: 8192, kv_cache_type: "q8_0" });
  expect(body.roles[0].peak.source).toBe("estimated");
  expect(["yes", "slow", "no", "unknown"]).toContain(body.verdict);

  const defaults = await (await app.request("/stack/v1/fit-plan", json({ source: request.source }))).json() as { context_tokens: number; kv_cache_type: string };
  expect(defaults).toMatchObject({ context_tokens: 4096, kv_cache_type: "f16" });
});

test("an uninstalled estimator returns an unknown plan", async () => {
  process.env.STACK_GGUF_PARSER_BINARY = join(tempRoot, "missing-binary");
  const response = await app.request("/stack/v1/fit-plan", json({ source: { url: "https://huggingface.co/a/b.gguf" } }));
  expect(response.status).toBe(200);
  const body = await response.json() as { verdict: string; paths: Array<{ verdict: string }> };
  expect(body.verdict).toBe("unknown");
  expect(body.paths.every((item) => item.verdict === "unknown")).toBe(true);
});

test("fit planning accepts only Hugging Face GGUF URLs and model-store paths", async () => {
  const invalid = [
    { source: { url: "http://huggingface.co/x/y.gguf" } },
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
  const link = join(modelsRoot, `fit-plan-link-${process.pid}.gguf`);
  try {
    mkdirSync(modelsRoot, { recursive: true });
    writeFileSync(join(tempRoot, "target.gguf"), "x");
    symlinkSync(join(tempRoot, "target.gguf"), link);
    const response = await app.request("/stack/v1/fit-plan", json({ source: { path: link } }));
    expect(response.status).toBe(400);
  } finally { rmSync(link, { force: true }); }
});
