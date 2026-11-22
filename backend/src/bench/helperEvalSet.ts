// The Helper's answer-quality eval set: owner-style questions and actions with what a correct answer must
// contain, computed from a seeded SCRATCH Stack (src/bench/helperEvalSeed.ts), not typed in. Run by
// src/bench/helperEval.ts against a running scratch Stack with the real Helper model. A case passes
// on the answer the admin reads, not on which tool the model happened to pick.
export interface Truth {
  roles: Array<Record<string, any>>;
  tiersPictures: { levels: Array<{ tier: string; recommended: string | null; candidates: Array<{ id: string; label: string }> }> };
  memory: Record<string, any>;
  hardware: Record<string, any>;
  /** Largest `splash` process the memory route shows right now, in GB, or null when none runs. */
  splashGb: number | null;
  availableGb: number;
}
export interface Expect {
  /** Every inner list is "one of these words"; the reply must contain one word from each list (case-insensitive). */
  facts?: string[][];
  /** The reply must state a size in GB within 0.6 of this (a moving figure is read when the case runs). */
  gbNear?: (t: Truth) => number | null;
  gbTolerance?: number;
  /** A proposal card with this action and these parameters must come back (and no other card). */
  proposal?: { action: string; params?: Record<string, string | number | boolean> };
  /** No proposal card may come back. */
  noProposal?: boolean;
  /** The reply must be one short question. */
  question?: boolean;
  /** Words that must not appear (on top of the defaults: raw byte counts, tool names, "could not read"). */
  forbid?: Array<string | RegExp>;
}
export interface EvalCase { id: string; kind: "read" | "follow-up" | "action" | "ambiguous" | "impossible"; before?: string[]; say: string; expect: Expect }

const label = (t: Truth, id: string, key: string): string => String(t.roles.find((r) => r.id === id)?.[key] ?? "");
const coding = (t: Truth) => t.roles.find((r) => r.id === "coding")!;

export const EVAL_SET: EvalCase[] = [
  // The owner's own chat, verbatim.
  { id: "owner-splash-memory", kind: "read", say: "why is splash taking so much memoru", expect: { facts: [["engine"]], gbNear: (t) => t.splashGb, gbTolerance: 1.5, forbid: [/splash is a tier/i, /splash is a model/i] } },
  { id: "owner-coding-models", kind: "read", say: "what are my coding models", expect: { facts: [["27b"]], forbid: [/ornith/i] } },
  { id: "owner-what-about-max", kind: "follow-up", before: ["what are my coding models"], say: "what about max", expect: { facts: [["max"], ["flash next", "no tier", "no separate tier", "does not have", "doesn't have", "only"]] } },
  // Words: tiers, engines, roles.
  { id: "what-is-splash", kind: "read", say: "what is splash", expect: { facts: [["engine"]], forbid: [/splash is a tier/i, /splash is a model/i] } },
  { id: "what-is-max-tier", kind: "read", say: "what is the max tier", expect: { facts: [["biggest", "largest", "top", "most"]] } },
  { id: "what-are-tiers", kind: "read", say: "what are the tiers", expect: { facts: [["reduced"], ["standard"], ["boost"], ["max"]] } },
  { id: "role-engine-model", kind: "read", say: "what is the difference between a role, an engine and a model", expect: { facts: [["role"], ["engine"], ["model"], ["program", "runs", "runner"]] } },
  { id: "what-is-boost", kind: "read", say: "what does boost mean", expect: { facts: [["bigger", "better", "more memory"]] } },
  { id: "what-is-priority", kind: "read", say: "what does priority mean here", expect: { facts: [["lower"], ["first", "served"]] } },
  { id: "tiers-for-chat", kind: "read", say: "what are the tiers for chat", expect: { facts: [["standard"], ["boost"], ["max"]] } },
  { id: "max-for-pictures", kind: "read", say: "what is the max tier for pictures", expect: { facts: [["max"], ["qwen-image", "qwen image"]] } },
  { id: "chat-models", kind: "read", say: "which model does chat use", expect: { facts: [["not installed", "none", "no model", "isn't installed", "is not set up", "not set up"]] } },
  { id: "helper-model", kind: "read", say: "which model does the helper use", expect: { facts: [["qwen3 4b", "qwen3-4b"]] } },
  { id: "coding-engine", kind: "read", say: "what engine does coding use", expect: { facts: [["llama-server", "llama server"]] } },
  { id: "voice-engine", kind: "read", say: "what voice engine is in use", expect: { facts: [["pocket"]] } },
  { id: "headroom", kind: "read", say: "how much extra room can splash take for its cache", expect: { facts: [["12"]] } },
  // State of the machine.
  { id: "features-on", kind: "read", say: "which features are on", expect: { facts: [["music"], ["off", "turned off"]] } },
  { id: "video-on", kind: "read", say: "is video turned on", expect: { facts: [["on", "yes", "enabled", "running"]] } },
  { id: "music-priority", kind: "read", say: "what is the priority of music", expect: { facts: [["100"]] } },
  { id: "healthy", kind: "read", say: "is everything healthy?", expect: { facts: [["healthy", "no problems", "nothing wrong"]] } },
  { id: "memory-free", kind: "read", say: "how much memory is free?", expect: { gbNear: (t) => t.availableGb, gbTolerance: 8 } },
  { id: "memory-total", kind: "read", say: "how much memory does this computer have", expect: { facts: [["128"]] } },
  { id: "chip", kind: "read", say: "what kind of computer is this", expect: { facts: [["apple silicon", "apple"]] } },
  { id: "updates", kind: "read", say: "is an update available?", expect: { facts: [["no newer", "no update", "up to date", "none", "not"]] } },
  // Actions.
  { id: "act-video-off", kind: "action", say: "turn video off", expect: { proposal: { action: "set_role_enabled", params: { role: "video", enabled: false } } } },
  { id: "act-images-off", kind: "action", say: "please turn off the pictures feature", expect: { proposal: { action: "set_role_enabled", params: { role: "image", enabled: false } } } },
  { id: "act-music-on", kind: "action", say: "turn music on", expect: { proposal: { action: "set_role_enabled", params: { role: "music", enabled: true } } } },
  { id: "act-music-above-voice-out", kind: "action", say: "move music above voice out", expect: { proposal: { action: "set_role_priority", params: { role: "music", priority: 99 } } } },
  { id: "act-coding-priority", kind: "action", say: "set the coding priority to 5", expect: { proposal: { action: "set_role_priority", params: { role: "coding", priority: 5 } } } },
  { id: "act-profile", kind: "action", say: "apply the recommended profile", expect: { proposal: { action: "apply_profile", params: { mode: "custom_recommended" } } } },
  { id: "act-restart-voice-out", kind: "action", say: "restart the voice out engine", expect: { proposal: { action: "restart_engine", params: { name: "pocket-tts" } } } },
  { id: "act-restart-stack", kind: "action", say: "restart the stack", expect: { proposal: { action: "restart_stack" } } },
  { id: "act-check-updates", kind: "action", say: "check for updates", expect: { proposal: { action: "check_updates" } } },
  { id: "act-it-off", kind: "follow-up", before: ["is video turned on"], say: "turn it off", expect: { proposal: { action: "set_role_enabled", params: { role: "video", enabled: false } } } },
  { id: "act-already-on", kind: "action", say: "turn video on", expect: { noProposal: true, facts: [["already"]] } },
  // Ambiguous: one short question, no guess.
  { id: "amb-music-above-speech", kind: "ambiguous", say: "move music above speech", expect: { noProposal: true, question: true, facts: [["voice in", "voice out", "speech to text", "text to speech"]] } },
  { id: "amb-restart-speech", kind: "ambiguous", say: "restart the speech engine", expect: { noProposal: true, question: true, facts: [["voice in", "voice out", "speech to text", "text to speech"]] } },
  { id: "amb-turn-it-off", kind: "ambiguous", say: "turn it off", expect: { noProposal: true, question: true } },
  { id: "amb-max-alone", kind: "ambiguous", say: "what about max", expect: { noProposal: true, facts: [["max"]] } },
  // Impossible or not offered.
  { id: "no-reboot", kind: "impossible", say: "reboot the computer", expect: { noProposal: true, facts: [["tools"]] } },
  { id: "no-remove-model", kind: "impossible", say: "delete the coding model", expect: { noProposal: true, facts: [["models screen", "models"]] } },
  { id: "no-password", kind: "impossible", say: "what is my admin password", expect: { noProposal: true, facts: [["cannot", "can't", "can not", "not able", "unable", "not"]] } },
  { id: "no-helper-off", kind: "impossible", say: "turn the helper off", expect: { noProposal: true } },
];

/**
 * Held out: paraphrases written after the question set above had been tuned against, and not used to shape the
 * interpreter or the prompt afterwards (a miss here is reported, not fixed for this set). They measure whether the
 * Helper generalises past the phrasings it was tuned on. Run with `--set held`.
 */
export const HELD_OUT: EvalCase[] = [
  { id: "held-splash-ram", kind: "read", say: "how much ram is splash using?", expect: { gbNear: (t) => t.splashGb, gbTolerance: 1.5 } },
  { id: "held-coding-models", kind: "read", say: "which models can coding run?", expect: { facts: [["27b"]], forbid: [/ornith/i] } },
  { id: "held-images-after-coding", kind: "follow-up", before: ["which model is chosen for coding"], say: "how about images?", expect: { facts: [["standard", "boost", "max"]] } },
  { id: "held-video-off-polite", kind: "action", say: "could you switch the video feature off for me", expect: { proposal: { action: "set_role_enabled", params: { role: "video", enabled: false } } } },
  { id: "held-disable-music", kind: "action", say: "disable music", expect: { noProposal: true, facts: [["already"]] } },
  { id: "held-image-ahead-of-video", kind: "action", say: "put image generation ahead of video", expect: { proposal: { action: "set_role_priority", params: { role: "image", priority: 99 } } } },
  { id: "held-coding-priority-20", kind: "action", say: "make coding priority 20", expect: { proposal: { action: "set_role_priority", params: { role: "coding", priority: 20 } } } },
  { id: "held-restart-splash", kind: "action", say: "restart splash", expect: { proposal: { action: "restart_engine", params: { name: "splash" } } } },
  { id: "held-problems", kind: "read", say: "is there a problem with anything", expect: { facts: [["healthy", "no problems", "nothing wrong", "no problem"]] } },
  { id: "held-what-is-reduced", kind: "read", say: "what does reduced mean", expect: { facts: [["small"]] } },
  { id: "held-splash-model", kind: "read", say: "is splash a model", expect: { facts: [["engine"]], forbid: [/splash is a model/i] } },
  { id: "held-wipe-model", kind: "impossible", say: "wipe the 27b model", expect: { noProposal: true, facts: [["models screen", "models"]] } },
  { id: "held-switch-off-pc", kind: "impossible", say: "shut down the pc", expect: { noProposal: true, facts: [["tools"]] } },
  { id: "held-wakeword-on", kind: "action", say: "enable the wake word", expect: { noProposal: true, facts: [["already"]] } },
  { id: "held-switched-off", kind: "read", say: "which features are switched off", expect: { facts: [["music"]] } },
  { id: "held-voice-on", kind: "ambiguous", say: "turn on the voice", expect: { noProposal: true, question: true } },
];

export { coding, label };
