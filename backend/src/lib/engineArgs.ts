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
  /** KV cache quantization, on by default on Apple silicon. */
  kvCacheQuantized?: boolean;
  /** Serve `/v1/embeddings` instead of chat: the `embed` role's launch. */
  embeddings?: boolean;
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
  // Quantized KV cache: the q8_0 pair for keys and values, on by
  // default on Apple silicon (hub, FAST-01).
  if (options.kvCacheQuantized ?? true) args.push("-ctk", "q8_0", "-ctv", "q8_0");
  // An embedding model is served with pooling on and no chat template.
  if (options.embeddings) args.push("--embeddings");
  return args;
}
