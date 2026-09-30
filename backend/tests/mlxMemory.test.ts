import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MLX_KV_PEAK_FACTOR, MLX_PREFIX_CACHE_BYTES, MLX_UNKNOWN_HEADROOM_BYTES, mlxHeadroomBytes, readMlxKvBytesPerToken } from "@/lib/mlxMemory";

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
