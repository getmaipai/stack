import { gguf } from "@huggingface/gguf";

export interface GgufFacts {
  architecture: string;
  layers: number;
  kvHeads: number;
  headDim: number;
  contextLength: number;
  quantization: string;
}

function numberValue(metadata: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
  }
  return 0;
}

export async function readGgufFacts(uri: string, options: { allowLocalFile?: boolean } = {}): Promise<GgufFacts> {
  const parsed = await gguf(uri, { typedMetadata: true, allowLocalFile: options.allowLocalFile ?? false });
  const metadata = parsed.metadata as unknown as Record<string, unknown>;
  const architecture = String(metadata["general.architecture"] ?? "llama");
  const layers = numberValue(metadata, [`${architecture}.block_count`]);
  const kvHeads = numberValue(metadata, [`${architecture}.attention.head_count_kv`, `${architecture}.attention.head_count`]);
  const embedding = numberValue(metadata, [`${architecture}.embedding_length`]);
  const heads = numberValue(metadata, [`${architecture}.attention.head_count`]);
  const headDim = numberValue(metadata, [`${architecture}.attention.key_length`]) || (heads ? Math.round(embedding / heads) : 0);
  const contextLength = numberValue(metadata, [`${architecture}.context_length`]);
  const quantization = String(metadata["general.file_type"] ?? "unknown");
  return { architecture, layers, kvHeads, headDim, contextLength, quantization };
}
