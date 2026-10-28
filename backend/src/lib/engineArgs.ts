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
  /** Where the layers live: every layer on the accelerator (the default,
   * `-ngl all`) or none (`-ngl 0`, the processor), STACK-EMBED-02. */
  gpuLayers?: "all" | 0;
  /** Serve `/v1/embeddings` instead of chat: the `embed` role's launch. */
  embeddings?: boolean;
  /** The multimodal projector a model loads beside its weights
   * (`--mmproj`): the `vision` role's launch (VISION-01b), or a chat model
   * that reads pictures itself (VISION-02b). */
  projectorPath?: string;
  /** The `vision` role's own process: one slot, whatever the chat
   * settings say. A chat process with a projector keeps its slots. */
  onePictureSlot?: boolean;
  /** The most tokens one picture may take (`--image-max-tokens`): the
   * engine scales a larger picture down itself, so a picture's cost in the
   * context is bounded by a declared number, never guessed. */
  imageMaxTokens?: number;
  /** Template variables the record's launch pins (`--chat-template-kwargs`):
   * Muse Glimmer's `reasoning_strength` (STACK-MUSE-01), which `--reasoning
   * off` cannot reach because that template has no `enable_thinking`
   * switch. A request's own `chat_template_kwargs` still win key by key. */
  chatTemplateKwargs?: Record<string, string>;
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

/** The host prompt cache a chat process may fill, in MiB: the setting when it is above zero, else this default. */
export const LLAMA_CACHE_RAM_DEFAULT_MIB = 1024;
export const LLAMA_CTX_CHECKPOINTS = 8;
export function llamaCacheRamMib(config: { cacheRamMb?: unknown }): number {
  return typeof config.cacheRamMb === "number" && config.cacheRamMb > 0 ? config.cacheRamMb : LLAMA_CACHE_RAM_DEFAULT_MIB;
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
    // All layers on the accelerator unless the role is set to run on the
    // processor (`gpuLayers: 0`).
    "-ngl", String(options.gpuLayers ?? "all"),
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
  ];
  // The record's pinned template variables, as one JSON object (the form
  // llama-server b10797 parses for this flag).
  if (options.chatTemplateKwargs && Object.keys(options.chatTemplateKwargs).length > 0) args.push("--chat-template-kwargs", JSON.stringify(options.chatTemplateKwargs));
  // Prefix cache reuse: stable system messages are not re-prefilled on
  // every turn (hub, FAST-01). llama-server b10797 turns chunk reuse off
  // itself once a projector is loaded ("cache_reuse is not supported by
  // multimodal"; plain longest-prefix caching stays on), so it is not
  // asked for there; the measured cost is in docs/dev.md, "The chat
  // model reads pictures".
  if (!options.projectorPath) args.push("--cache-reuse", "256");
  const slots = typeof config.slots === "number" ? config.slots : 1;
  if (options.projectorPath) args.push("--mmproj", options.projectorPath);
  if (options.projectorPath && options.imageMaxTokens) args.push("--image-max-tokens", String(options.imageMaxTokens));
  // A vision process is one slot: one picture is described at a time,
  // and the engine's automatic slot count would split its short context.
  // A chat process keeps the slots its settings declare (the judge's
  // shared slot on p16), projector or not.
  // Left on auto, llama-server b10797 picks four slots that share one
  // cache pool, and each slot keeps its own recurrent-state snapshots on a
  // hybrid model, so a chat process always spells the slots its settings
  // declare (one by default).
  if (options.onePictureSlot) args.push("--parallel", "1");
  else if (!options.embeddings) args.push("--parallel", String(Math.max(1, slots)));
  const threads = typeof config.threads === "number" ? config.threads : 0;
  if (threads > 0) args.push("--threads", String(threads));
  // The prompt cache that llama-server keeps in host memory defaults to
  // 8 GiB and fills with use; the Stack bounds it so the memory it admits a
  // chat process for is the memory the process stays within. `--cache-ram`
  // is the flag b10797 knows (it rejects `--cache-ram-mb`). A recurrent model
  // (Gated DeltaNet layers) restarts a prompt only from a saved snapshot, and
  // the default spacing is 8192 tokens, so a 4.8k-token chat prompt had none and
  // was reprocessed in full every turn (7 to 8 s). `--checkpoint-min-step 0`
  // lets a snapshot land wherever the prompt ended; measured on the Studio, a
  // repeat turn reused 4429 of 4451 tokens (0.6 s). Eight snapshots bound memory.
  if (!options.embeddings) {
    args.push("--cache-ram", String(llamaCacheRamMib(config)));
    args.push("--checkpoint-min-step", "0");
    args.push("--ctx-checkpoints", String(LLAMA_CTX_CHECKPOINTS));
  }
  // f16 is llama-server's default; auto means q8_0 on macOS and f16 elsewhere.
  const kvCacheType = options.kvCacheType ?? defaultKvCacheType();
  if (kvCacheType !== "f16") args.push("-ctk", kvCacheType, "-ctv", kvCacheType);
  // An embedding model is served with pooling on and no chat template.
  if (options.embeddings) args.push("--embeddings");
  return args;
}

export interface CodingServerArgsOptions {
  modelPath: string;
  port: number;
  /** The window the coding process serves, in tokens: one KV pool shared by every slot (`--kv-unified`), so one long session may use all of it. */
  contextLength: number;
  /** Server slots: concurrent coding requests (2 on a 128 GB Mac, 1 on a 64 GB one). */
  slots: number;
  /** The most tokens the model may spend thinking before it answers, at the server (`--reasoning-budget`). */
  thinkingBudgetTokens: number;
  /** The model name the engine reports in its replies (`--alias`): the pin's id, not the model file's path. */
  alias: string;
}

/** The coding role's own llama-server launch (CODE-STACK-01 S2). Not the
 * chat launch: thinking is ON (the model reasons by default; a request's
 * `chat_template_kwargs` may still turn it off) under a server-side token
 * budget, the cache is q8_0 on every platform, the window is one shared
 * KV pool, and the process never reaches the network (`--offline`; the
 * build has no telemetry or update check of its own). Flag spellings are
 * those of llama-server b10797 `--help`. `--cache-reuse` is left out on
 * purpose: its KV shifting is not measured on this model, and the prompt
 * cache and context checkpoints stay at the engine's defaults. */
export function codingServerArgs(options: CodingServerArgsOptions): string[] {
  const ubatch = Math.min(1024, options.contextLength);
  return [
    "--model", options.modelPath,
    "--alias", options.alias,
    "--port", String(options.port),
    "--host", "127.0.0.1",
    "-c", String(options.contextLength),
    "-fa", "on",
    "-ngl", "all",
    "--reasoning", "on",
    "--reasoning-budget", String(options.thinkingBudgetTokens),
    "-ub", String(ubatch),
    "--no-webui",
    "--metrics",
    "--jinja",
    "--parallel", String(options.slots),
    "--kv-unified",
    "-ctk", "q8_0", "-ctv", "q8_0",
    "--offline",
  ];
}

export interface SplashArgsOptions {
  /** `<owner>/<repo>:<variant>` of the target in Splash's hub cache. */
  model: string;
  /** The target's commit: a 40-hex revision needs no `refs/` entry and no Hub request. */
  revision: string;
  port: number;
  /** The name the engine serves and reports: the pin's id (`--served-model-name` with `--announce-served-name`). */
  servedModelName: string;
  /** Thinking tokens a request that sets none may spend, at the server (`--thinking-token-budget`): the ceiling setting. */
  thinkingBudgetTokens: number;
  /** The coding window (`--max-context` can only lower Splash's own limit). */
  contextLength: number;
  /** Disk Splash may use for its temporary SSD cache, in whole GB; 0 turns the cache off (`--max-cache-disk 0`). */
  cacheGb: number;
  defaultReasoningEffort?: "none" | "medium";
  maxMemory?: string;
  decodeShare?: number;
  languageOnly?: boolean;
}

/** The arguments after `install/launcher.py` for the coding role on Splash (CODE-STACK-01 S5a). Flag spellings are Splash 1.3.2's
 * `serve --help`. `--offline` (with HF_HUB_OFFLINE=1 in the environment) means no Hugging Face request, the model and its draft
 * being the files the Stack laid out; `--language-only` skips the vision encoder; thinking is capped at the server the way
 * llama-server's `--reasoning-budget` caps it (reasoning effort medium and 2,000 tokens scored 10 of 10 on the Studio bench;
 * uncapped thinking lost 3 of 10); `--idle-release off` leaves keep-warm to the Stack; the SSD cache is bounded (Splash's default is up to 32 GiB of temporary files) and not persistent;
 * loopback only, so no `--api-key`; no chat page. The Neural Engine stays on (the benchmark's setting), and `--draft-model` is
 * left to Splash's own pairing for the Qwen3.8-27B family (`incoai/Qwen3.8-27B-DFlash2`), which is the draft the Stack pinned
 * and laid out, and the only one in its cache. */
export function splashArgs(options: SplashArgsOptions): string[] {
  return [
    "serve",
    "--model", options.model,
    "--revision", options.revision,
    "--offline",
    "--host", "127.0.0.1",
    "--port", String(options.port),
    ...(options.languageOnly === false ? [] : ["--language-only"]),
    "--served-model-name", options.servedModelName,
    "--announce-served-name",
    "--default-reasoning-effort", options.defaultReasoningEffort ?? "medium",
    "--thinking-token-budget", String(options.thinkingBudgetTokens),
    "--max-context", String(options.contextLength),
    "--max-cache-disk", options.cacheGb > 0 ? `${options.cacheGb}G` : "0",
    ...(options.maxMemory ? ["--max-memory", options.maxMemory] : []),
    ...(options.decodeShare !== undefined ? ["--decode-share", options.decodeShare.toFixed(1)] : []),
    // Splash frees its weights after 10 idle minutes by default; the Stack owns keep-warm (stack.engines.coding.keep_warm_minutes) and unloads the whole engine itself.
    "--idle-release", "off",
    "--no-webui",
  ];
}
