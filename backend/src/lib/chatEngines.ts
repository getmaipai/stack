// Which engine answers the chat wire (ENGINE-MLX-01). The setting is
// `stack.engines.chat.engine`: `auto` (the default) means the tier's own
// default, a name means that engine. A requested engine that cannot run
// here, is not installed, or failed to start twice falls back to
// llama-server with the reason said; a failed chat engine never leaves
// the household without chat. Pure except for the failure memory, which a
// restart of the chat engine clears (the voice engine's rule, VOICE-STUDIO-01).
//
// `auto` is llama-server on every tier and platform (owner ruling 2026-10-17,
// ENGINE-MLX-02): oMLX is faster, but on the quality benches it lost on tool
// names (15 of 70 right before the namespace fix, 58 of 70 after, llama-server
// 65 of 70), made fewer tool calls on math and conversions, leaked raw tool
// markup once in 60 replies and searched 26 of 30 against 28 of 30. oMLX stays
// available as an opt-in: set `stack.engines.chat.engine` to `omlx`.
import type { GovernorTier } from "@/lib/governor";

export type ChatEngineId = "llama-server" | "mlx-serve" | "omlx";
export const CHAT_ENGINE_SETTING = "stack.engines.chat.engine";
export const CHAT_ENGINE_CHOICES = ["auto", "llama-server", "mlx-serve", "omlx"] as const;

/** Tiers with room for the 19.4 GB MLX weights beside the 4B judge, embeddings, a voice and the tier's working margin (the voice engine's rule, p64 and p128). oMLX is offered there as an optional install; it is never the default. */
export const OMLX_OPTIONAL_TIERS: GovernorTier[] = ["p64", "p128"];
/** A chat engine start that fails this many times in a row falls back to llama-server for the run. */
export const FALLBACK_AFTER_FAILURES = 2;

/** What `auto` means: llama-server on every tier and platform, whether or not oMLX is installed. The arguments stay so a tier can get another default later without touching the callers. */
export function tierDefaultChatEngine(_tier?: GovernorTier | undefined | null, _platform: string = process.platform, _arch: string = process.arch): ChatEngineId {
  return "llama-server";
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
