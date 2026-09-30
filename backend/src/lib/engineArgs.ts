// The llama-server argument list, one definition. The settings are
// declared in settings/engineKeys.ts; this file is only the spelling,
// matching the hub's launch (home/backend/src/lib/engineAutotune.ts
// `launchFlagsToArgs`).

export interface LlamaServerArgsOptions {
  modelPath: string;
  port: number;
  /** The declared engine settings: what settingValues returns. */
  config: Record<string, number | boolean | string | string[]>;
  /** The context length the spawn and the post-load check both use. */
  contextLength: number;
  /** KV cache type; defaults to q8_0 on macOS and f16 elsewhere. */
  kvCacheType?: KvCacheType;
  /** Serve `/v1/embeddings` instead of chat: the `embed` role's launch. */
  embeddings?: boolean;
}

export type KvCacheType = "f16" | "q8_0" | "q4_0";
export type KvCacheOverride = "auto" | "quantized" | "full";

export function mlxKvQuantFor(override: KvCacheOverride | undefined): 8 | null {
  return override === "quantized" ? 8 : null;
}

export function mlxServeArgs(options: { modelPath: string; port: number; contextLength: number; slots: number; prefixCacheFlag: string; kvQuant?: 8 | null }): string[] {
  const args = [
    "--model", options.modelPath,
    "--serve",
    "--host", "127.0.0.1",
    "--port", String(options.port),
    "--ctx-size", String(options.contextLength),
    "--max-concurrent", String(options.slots),
    "--prefix-cache-mem", options.prefixCacheFlag,
  ];
  if (options.kvQuant === 8) args.push("--kv-quant", String(options.kvQuant));
  return args;
}

export function defaultKvCacheType(platform: NodeJS.Platform = process.platform): KvCacheType {
  return platform === "darwin" ? "q8_0" : "f16";
}

export function kvCacheTypeFor(override: KvCacheOverride | undefined, platform: NodeJS.Platform = process.platform): KvCacheType {
  if (override === "full") return "f16";
  if (override === "quantized") return "q8_0";
  return defaultKvCacheType(platform);
}

export function llamaServerArgs(options: LlamaServerArgsOptions): string[] {
  const { config, contextLength } = options;
  // `-c` is the context size: the ceiling every other budget is
  // measured against, and a spawn with a larger ubatch than it would
  // be rejected (hub, 2026-09-06 review).
  const ubatch = Math.min(1024, contextLength);
  const args = [
    "--model", options.modelPath,
    "--port", String(options.port),
    // Localhost only: the server is reached only through its own client.
    "--host", "127.0.0.1",
    "-c", String(contextLength),
    // Flash attention: declared on by default; spelled off when not.
    ...(config.flashAttention === false ? ["-fa", "off"] : ["-fa", "on"]),
    // All layers on the accelerator: nothing stays on the CPU.
    "-ngl", "all",
    // Thinking mode off by default (hub, 2026-09-04): without this a
    // Qwen3-style model answers in reasoning_content with empty content,
    // which is exactly what broke the post-load check on this Mac.
    // Per-request `chat_template_kwargs` still overrides it.
    "--reasoning", "off",
    // `-ub` 1024: ~21% higher prefill throughput in one GPU-bound
    // benchmark for no extra VRAM (hub, 2026-09-06 latency review).
    "-ub", String(ubatch),
    // No bundled HTML UI: this process is only ever reached through
    // its own client, never a browser, so it is attack surface with
    // no benefit.
    "--no-webui",
    // Prometheus counters at /metrics: the harness for seeing slot
    // queueing and KV reuse from the first launch.
    "--metrics",
    // Jinja chat template: required for Qwen3 Hermes-style tool
    // calling; pinned explicitly so a binary upgrade cannot silently
    // drop the default (hub, 2026-09-07).
    "--jinja",
    // Prefix cache reuse: stable system messages are not re-prefilled
    // on every turn (hub, FAST-01).
    "--cache-reuse", "256",
  ];
  const slots = typeof config.slots === "number" ? config.slots : 1;
  if (slots > 1) args.push("--parallel", String(slots));
  const threads = typeof config.threads === "number" ? config.threads : 0;
  if (threads > 0) args.push("--threads", String(threads));
  const cacheRamMb = typeof config.cacheRamMb === "number" ? config.cacheRamMb : 0;
  if (cacheRamMb > 0) args.push("--cache-ram-mb", String(cacheRamMb));
  // f16 is llama-server's default; auto means q8_0 on macOS and f16 elsewhere.
  const kvCacheType = options.kvCacheType ?? defaultKvCacheType();
  if (kvCacheType !== "f16") args.push("-ctk", kvCacheType, "-ctv", kvCacheType);
  // An embedding model is served with pooling on and no chat template.
  if (options.embeddings) args.push("--embeddings");
  return args;
}
