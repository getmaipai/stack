import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MLX_PREFIX_CACHE_BYTES = 1024 ** 3;
export const MLX_PREFIX_CACHE_FLAG = "1024MB";
// Largest observed peak growth over the f16 KV formula on one model
// (Qwen3 1.7B 4-bit, contexts 4096 to 32768); the ratio fell as context
// grew. Confirm on the Studio for other models.
export const MLX_KV_PEAK_FACTOR = 2.9;
// Placeholder reserve for a model whose architecture or config is not verified.
export const MLX_UNKNOWN_HEADROOM_BYTES = 2 * 1024 ** 3;
export const VERIFIED_MLX_MODEL_TYPES = ["qwen3"] as const;

export function readMlxKvBytesPerToken(modelDir: string): number | null {
  try {
    const config: unknown = JSON.parse(readFileSync(join(modelDir, "config.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    const value = config as Record<string, unknown>;
    if (typeof value.model_type !== "string" || !VERIFIED_MLX_MODEL_TYPES.includes(value.model_type as typeof VERIFIED_MLX_MODEL_TYPES[number])) return null;
    const layers = value.num_hidden_layers;
    const kvHeads = value.num_key_value_heads;
    if (!Number.isInteger(layers) || (layers as number) < 1 || !Number.isInteger(kvHeads) || (kvHeads as number) < 1) return null;
    let headDim = value.head_dim;
    if (headDim === undefined) {
      const hiddenSize = value.hidden_size;
      const attentionHeads = value.num_attention_heads;
      if (!Number.isInteger(hiddenSize) || (hiddenSize as number) < 1 || !Number.isInteger(attentionHeads) || (attentionHeads as number) < 1) return null;
      if ((hiddenSize as number) % (attentionHeads as number) !== 0) return null;
      headDim = (hiddenSize as number) / (attentionHeads as number);
    }
    if (!Number.isInteger(headDim) || (headDim as number) < 1) return null;
    return (layers as number) * (kvHeads as number) * (headDim as number) * 2 * 2;
  } catch {
    return null;
  }
}

export function mlxHeadroomBytes(input: { modelDir: string; contextTokens: number }): number {
  const kvPerToken = readMlxKvBytesPerToken(input.modelDir);
  return kvPerToken === null
    ? MLX_PREFIX_CACHE_BYTES + MLX_UNKNOWN_HEADROOM_BYTES
    : MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR * kvPerToken * input.contextTokens);
}
