import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchMlxRepoFacts, MLX_IDLE_FACTOR, MLX_KV_PEAK_FACTOR, MLX_KV_PEAK_FACTOR_LOW, MLX_PREFIX_CACHE_BYTES, MLX_UNKNOWN_HEADROOM_BYTES, mlxHeadroomBytes, parseMlxKvBytesPerToken, pickGgufFile, readMlxKvBytesPerToken } from "@/lib/mlxMemory";

const directories: string[] = [];
function modelDir(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "maipai-mlx-memory-"));
  directories.push(dir);
  if (config !== undefined) writeFileSync(join(dir, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("reads verified Qwen3 KV bytes per token and derives a missing head dimension", () => {
  expect(readMlxKvBytesPerToken(modelDir({ model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128 }))).toBe(28 * 8 * 128 * 2 * 2);
  expect(readMlxKvBytesPerToken(modelDir({ model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, hidden_size: 2048, num_attention_heads: 16 }))).toBe(28 * 8 * 128 * 2 * 2);
});

test("unknown or malformed MLX configs have no verified KV estimate", () => {
  expect(readMlxKvBytesPerToken(modelDir({ model_type: "gemma3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128 }))).toBeNull();
  expect(readMlxKvBytesPerToken(modelDir())).toBeNull();
  expect(readMlxKvBytesPerToken(modelDir("{"))).toBeNull();
  expect(readMlxKvBytesPerToken(modelDir({ model_type: "qwen3", num_hidden_layers: 1.5, num_key_value_heads: 8, head_dim: 128 }))).toBeNull();
  expect(readMlxKvBytesPerToken(modelDir({ model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 0, head_dim: 128 }))).toBeNull();
});

test("headroom uses the verified context formula or the unknown architecture reserve", () => {
  const qwen = modelDir({ model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128 });
  expect(mlxHeadroomBytes({ modelDir: qwen, contextTokens: 4096 })).toBe(MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR * (28 * 8 * 128 * 2 * 2) * 4096));
  expect(mlxHeadroomBytes({ modelDir: modelDir({ model_type: "gemma3" }), contextTokens: 4096 })).toBe(MLX_PREFIX_CACHE_BYTES + MLX_UNKNOWN_HEADROOM_BYTES);
});

const qwenConfig = { model_type: "qwen3", num_hidden_layers: 28, num_key_value_heads: 8, head_dim: 128 };
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fetchStub = (handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

test("parses verified MLX KV facts and exposes measured factors", () => {
  expect(parseMlxKvBytesPerToken(qwenConfig)).toBe(28 * 8 * 128 * 2 * 2);
  expect(parseMlxKvBytesPerToken({ ...qwenConfig, model_type: "gemma3" })).toBeNull();
  for (const config of [null, "config", []]) expect(parseMlxKvBytesPerToken(config)).toBeNull();
  expect(typeof MLX_IDLE_FACTOR).toBe("number");
  expect(typeof MLX_KV_PEAK_FACTOR_LOW).toBe("number");
  expect(MLX_IDLE_FACTOR).toBeLessThan(MLX_KV_PEAK_FACTOR);
  expect(MLX_KV_PEAK_FACTOR_LOW).toBeLessThan(MLX_KV_PEAK_FACTOR);
});

test("fetches only top-level safetensors sizes and config with injected fetch", async () => {
  const urls: string[] = [];
  const facts = await fetchMlxRepoFacts({ repo: "org/model", revision: "main", fetchImpl: fetchStub(async (input) => {
    urls.push(String(input));
    return urls.length === 1
      ? jsonResponse([{ type: "file", path: "model.safetensors", size: 20, lfs: { size: 100 } }, { type: "file", path: "config.json", size: 1 }, { type: "file", path: "sub/x.safetensors", size: 50 }])
      : jsonResponse(qwenConfig);
  }) });
  expect(facts).toEqual({ weightsBytes: 100, config: qwenConfig });
  expect(urls).toEqual(["https://huggingface.co/api/models/org/model/tree/main", "https://huggingface.co/org/model/resolve/main/config.json"]);
  let calls = 0;
  const shards = await fetchMlxRepoFacts({ repo: "org/model", revision: "rev", fetchImpl: fetchStub(async () => { calls += 1; return calls === 1 ? jsonResponse([{ type: "file", path: "a.safetensors", size: 10 }, { type: "file", path: "b.safetensors", size: 20 }]) : jsonResponse(qwenConfig); }) });
  expect(shards?.weightsBytes).toBe(10 + 20);
});

test("returns null for absent weights or tree failures, and unknown config for config failures", async () => {
  expect(await fetchMlxRepoFacts({ repo: "org/model", revision: "main", fetchImpl: fetchStub(async () => jsonResponse([{ type: "file", path: "config.json", size: 1 }])) })).toBeNull();
  expect(await fetchMlxRepoFacts({ repo: "org/model", revision: "main", fetchImpl: fetchStub(async () => { throw new Error("offline"); }) })).toBeNull();
  expect(await fetchMlxRepoFacts({ repo: "org/model", revision: "main", fetchImpl: fetchStub(async () => jsonResponse({}, 404)) })).toBeNull();
  let calls = 0;
  const facts = await fetchMlxRepoFacts({ repo: "org/model", revision: "main", fetchImpl: fetchStub(async () => { calls += 1; return calls === 1 ? jsonResponse([{ type: "file", path: "model.safetensors", size: 12 }]) : jsonResponse({}, 404); }) });
  expect(facts).toEqual({ weightsBytes: 12, config: null });
});

test("rejects invalid repositories and revisions without calling fetch", async () => {
  let calls = 0;
  const fetchImpl = fetchStub(async () => { calls += 1; return jsonResponse([]); });
  for (const repo of ["../x", "a/b/c", ""]) expect(await fetchMlxRepoFacts({ repo, revision: "main", fetchImpl })).toBeNull();
  expect(await fetchMlxRepoFacts({ repo: "org/model", revision: "a b", fetchImpl })).toBeNull();
  expect(calls).toBe(0);
});

test("prefers GGUF files in the requested quant order", () => {
  const files = ["model-Q8_0.gguf", "model-Q5_K_S.gguf", "model-Q4_0.gguf", "model-Q4_K_S.gguf", "model-Q4_K_M.gguf"].map((path) => ({ path, size: 200_000_000 }));
  expect(pickGgufFile(files)?.path).toBe("model-Q4_K_M.gguf");
  expect(pickGgufFile(files.slice(0, 4))?.path).toBe("model-Q4_K_S.gguf");
  expect(pickGgufFile(files.slice(0, 3))?.path).toBe("model-Q4_0.gguf");
  expect(pickGgufFile(files.slice(0, 2))?.path).toBe("model-Q5_K_S.gguf");
  expect(pickGgufFile(files.slice(0, 1))?.path).toBe("model-Q8_0.gguf");
});

test("prefers IQ3_S in the Qwen3.8 repository tree and skips drafts and auxiliary GGUF files", () => {
  const files = [
    { path: "Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp.gguf", size: 9_600_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ2_S.gguf", size: 9_300_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf", size: 8_800_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ2_XS.gguf", size: 8_400_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf", size: 12_100_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf", size: 11_800_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf", size: 10_400_000_000 },
    { path: "Qwen3.8-27B-GSQ-RCO-IQ3_XXS.gguf", size: 10_100_000_000 },
    { path: "imatrix-qwen3.8-27b.gguf", size: 13_600_000 },
    { path: "mmproj-Qwen3.8-27B-BF16.gguf", size: 900_000_000 },
  ];
  expect(pickGgufFile(files)?.path).toBe("Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf");
});

test("allows the preferred draft GGUF when every usable candidate is a draft", () => {
  expect(pickGgufFile([
    { path: "model-IQ2_S-mtp.gguf", size: 200_000_000 },
    { path: "model-IQ3_S-mtp.gguf", size: 300_000_000 },
  ])?.path).toBe("model-IQ3_S-mtp.gguf");
});

test("ignores importance-matrix GGUF files", () => {
  expect(pickGgufFile([{ path: "imatrix-Q4_K_M.gguf", size: 500_000_000 }])).toBeNull();
});

test("ignores GGUF vision projectors", () => {
  expect(pickGgufFile([{ path: "mmproj-Q4_K_M.gguf", size: 1 }])).toBeNull();
});

test("keeps the first shard of a split GGUF model", () => {
  expect(pickGgufFile([
    { path: "model-Q4_K_M-00002-of-00003.gguf", size: 200_000_000 },
    { path: "model-Q4_K_M-00001-of-00003.gguf", size: 300_000_000 },
  ])?.path).toBe("model-Q4_K_M-00001-of-00003.gguf");
});

test("chooses the smallest unmatched GGUF name", () => {
  expect(pickGgufFile([{ path: "z.gguf", size: 220_000_000 }, { path: "a.gguf", size: 110_000_000 }])?.path).toBe("a.gguf");
});

test("never picks an undersized GGUF file as a fallback", () => {
  expect(pickGgufFile([{ path: "tiny.gguf", size: 100 * 1024 ** 2 }])).toBeNull();
});

test("matches GGUF quant names by whole segment", () => {
  expect(pickGgufFile([
    { path: "x-IQ3_XS.gguf", size: 300_000_000 },
    { path: "x-IQ3_XXS.gguf", size: 400_000_000 },
  ])?.path).toBe("x-IQ3_XXS.gguf");
  expect(pickGgufFile([
    { path: "x-Q4_K_M.gguf", size: 300_000_000 },
    { path: "x-Q4_0.gguf", size: 400_000_000 },
  ])?.path).toBe("x-Q4_K_M.gguf");
});

test("returns null for an empty GGUF file list", () => {
  expect(pickGgufFile([])).toBeNull();
});
