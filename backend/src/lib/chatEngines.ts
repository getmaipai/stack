// Which engine answers the chat wire (ENGINE-MLX-01). The setting is
// `stack.engines.chat.engine`: `auto` (the default) means the tier's own
// default, a name means that engine. A requested engine that cannot run
// here, is not installed, or failed to start twice falls back to
// llama-server with the reason said; a failed chat engine never leaves
// the household without chat. Pure except for the failure memory, which a
// restart of the chat engine clears (the voice engine's rule, VOICE-STUDIO-01).
//
// Why oMLX is the default where it fits: docs/design/chat-engine-comparison-2026-10-17.md
// in Home (23 percent faster generation and 36 to 42 percent faster prompt
// processing than llama-server on Muse Glimmer 30B, level on tool calls and
// reasoning). Rollback is one setting: `llama-server`.
import type { GovernorTier } from "@/lib/governor";

export type ChatEngineId = "llama-server" | "mlx-serve" | "omlx";
export const CHAT_ENGINE_SETTING = "stack.engines.chat.engine";
export const CHAT_ENGINE_CHOICES = ["auto", "llama-server", "mlx-serve", "omlx"] as const;

/** Tiers with room for the 19.4 GB MLX weights beside the 4B judge, embeddings, a voice and the tier's working margin (the voice engine's rule, p64 and p128). */
export const OMLX_DEFAULT_TIERS: GovernorTier[] = ["p64", "p128"];
/** A chat engine start that fails this many times in a row falls back to llama-server for the run. */
export const FALLBACK_AFTER_FAILURES = 2;

export function tierDefaultChatEngine(tier: GovernorTier | undefined | null, platform: string = process.platform, arch: string = process.arch): ChatEngineId {
  return tier && OMLX_DEFAULT_TIERS.includes(tier) && platform === "darwin" && arch === "arm64" ? "omlx" : "llama-server";
}

/** What the setting asks for: a named engine, or the tier's default for `auto` (and for any unknown value). */
export function requestedChatEngine(setting: unknown, tier: GovernorTier | undefined | null, platform: string = process.platform, arch: string = process.arch): ChatEngineId {
  return setting === "llama-server" || setting === "mlx-serve" || setting === "omlx" ? setting : tierDefaultChatEngine(tier, platform, arch);
}

const failures = new Map<ChatEngineId, { count: number; reason: string }>();
export function markChatEngineFailed(id: ChatEngineId, reason: string): number {
  if (id === "llama-server") return 0;
  const count = (failures.get(id)?.count ?? 0) + 1;
  failures.set(id, { count, reason });
  return count;
}
export function clearChatEngineFailures(): void { failures.clear(); }
export function chatEngineFailure(id: ChatEngineId): { count: number; reason: string } | null { return failures.get(id) ?? null; }

export interface ChatEngineChoice {
  /** The engine in effect. */
  engine: ChatEngineId;
  /** The engine the setting or the tier asked for. */
  requested: ChatEngineId;
  /** Why `engine` is not `requested`, in words a person can act on; null when it is. */
  reason: string | null;
}

export function resolveChatEngine(options: { setting: unknown; tier: GovernorTier | undefined | null; installed: (id: ChatEngineId) => boolean; unsupported?: (id: ChatEngineId) => string | null; platform?: string; arch?: string }): ChatEngineChoice {
  const requested = requestedChatEngine(options.setting, options.tier, options.platform, options.arch);
  if (requested === "llama-server") return { engine: "llama-server", requested, reason: null };
  const unsupported = options.unsupported?.(requested) ?? null;
  if (unsupported) return { engine: "llama-server", requested, reason: `${unsupported} Chat stays on llama-server.` };
  const failure = failures.get(requested);
  if (failure && failure.count >= FALLBACK_AFTER_FAILURES) return { engine: "llama-server", requested, reason: `${requested} did not start (${failure.reason}), so chat fell back to llama-server. Restart the chat engine to try again.` };
  if (!options.installed(requested)) return { engine: "llama-server", requested, reason: `${requested} is not installed on this computer yet (its environment or its model is missing), so chat stays on llama-server until it is.` };
  return { engine: requested, requested, reason: null };
}
