import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MLX_PREFIX_CACHE_BYTES = 1024 ** 3;
export const MLX_PREFIX_CACHE_FLAG = "1024MB";
// Measured idle footprint on one model (Qwen3 1.7B 4-bit, mlx-serve v26.9.4); confirm on the Studio.
export const MLX_IDLE_FACTOR = 1.27;
// Measured low peak growth on one model (Qwen3 1.7B 4-bit, mlx-serve v26.9.4); confirm on the Studio.
export const MLX_KV_PEAK_FACTOR_LOW = 1.9;
// Largest observed peak growth over the f16 KV formula on one model
// (Qwen3 1.7B 4-bit, contexts 4096 to 32768); the ratio fell as context
// grew. Confirm on the Studio for other models.
// Keep this unquantized factor even when launch passes --kv-quant 8; a quantized cache needs its own Studio measurement before a smaller factor is written (STACK-14).
export const MLX_KV_PEAK_FACTOR = 2.9;
// Placeholder reserve for a model whose architecture or config is not verified.
export const MLX_UNKNOWN_HEADROOM_BYTES = 2 * 1024 ** 3;
export const VERIFIED_MLX_MODEL_TYPES = ["qwen3"] as const;

export function parseMlxKvBytesPerToken(config: unknown): number | null {
  try {
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

export function readMlxKvBytesPerToken(modelDir: string): number | null {
  try {
    return parseMlxKvBytesPerToken(JSON.parse(readFileSync(join(modelDir, "config.json"), "utf8")));
  } catch { return null; }
}

export interface MlxRepoFacts { weightsBytes: number; config: unknown }

export function isValidMlxRepo(repo: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) && !repo.split("/").some((part) => part === "." || part === "..");
}

export function isValidMlxRevision(revision: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(revision);
}

export async function fetchMlxRepoFacts(input: { repo: string; revision: string; fetchImpl?: typeof fetch }): Promise<MlxRepoFacts | null> {
  if (!isValidMlxRepo(input.repo) || !isValidMlxRevision(input.revision)) return null;
  const fetchImpl = input.fetchImpl ?? fetch;
  const readBounded = async (response: Response, limit: number): Promise<string | null> => {
    if (!response.ok) return null;
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= limit ? text : null;
  };
  try {
    const treeResponse = await fetchImpl(`https://huggingface.co/api/models/${input.repo}/tree/${input.revision}`, { signal: AbortSignal.timeout(15_000) });
    const treeText = await readBounded(treeResponse, 2 * 1024 ** 2);
    if (treeText === null) return null;
    const tree: unknown = JSON.parse(treeText);
    if (!Array.isArray(tree)) return null;
    let weightsBytes = 0;
    let found = false;
    for (const entry of tree) {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      if (typeof item.type !== "string" || typeof item.path !== "string" || typeof item.size !== "number") return null;
      if (item.type !== "file" || item.path.includes("/") || !item.path.endsWith(".safetensors")) continue;
      const lfs = item.lfs && typeof item.lfs === "object" ? item.lfs as Record<string, unknown> : undefined;
      const size = lfs?.size ?? item.size;
      if (typeof size !== "number" || !Number.isFinite(size) || !Number.isInteger(size) || size < 0) return null;
      weightsBytes += size;
      found = true;
    }
    if (!found) return null;
    let config: unknown = null;
    try {
      const configResponse = await fetchImpl(`https://huggingface.co/${input.repo}/resolve/${input.revision}/config.json`, { signal: AbortSignal.timeout(15_000) });
      const configText = await readBounded(configResponse, 1024 ** 2);
      if (configText !== null) config = JSON.parse(configText);
    } catch { config = null; }
    return { weightsBytes, config };
  } catch { return null; }
}

export function mlxHeadroomBytes(input: { modelDir: string; contextTokens: number }): number {
  const kvPerToken = readMlxKvBytesPerToken(input.modelDir);
  return kvPerToken === null
    ? MLX_PREFIX_CACHE_BYTES + MLX_UNKNOWN_HEADROOM_BYTES
    : MLX_PREFIX_CACHE_BYTES + Math.ceil(MLX_KV_PEAK_FACTOR * kvPerToken * input.contextTokens);
}
