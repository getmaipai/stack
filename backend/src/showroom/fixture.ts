type EngineRecord = { id: string; label: string; platform: string; arch: string; verified: boolean; installed: boolean; matchesThisMachine: boolean; running: string | null; currentTag: string | null; newestTag: string | null; current: boolean; notCurrent: boolean; needsRestart: boolean; state: "current" | "notCurrent"; stateReason: "newer installed" | "newer available" | null };

export function showroom(): boolean { return process.env.STACK_SHOWROOM === "1" && process.env.NODE_ENV !== "production"; }
export function assertShowroomAllowed(): void { if (process.env.STACK_SHOWROOM === "1" && process.env.NODE_ENV === "production") throw new Error("STACK_SHOWROOM is disabled in production."); }

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

export const showroomHardware = { platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 2_400_000_000_000, osVersion: "15.6" };
export const showroomProfile = { id: "p128" as const, label: "This Studio can run every ability, with the heaviest work on demand.", minUnifiedGb: 128, minVramGb: 0, resident: ["chat", "coding", "judge", "router", "embed", "rerank", "stt", "tts"], onDemand: ["vision", "image", "video", "music"], installedOnly: [], notAvailable: [] };

export const showroomModels = [
  { id: "qwen3-27b-instruct", roles: ["chat", "coding", "judge"], state: "installed" as const, sizeBytes: 17_200_000_000, measuredFootprintBytes: 21_600_000_000, estimated: false, source: "catalog", groupId: "group-family", nickname: "Family chat", provenance: { source: "getmaipai/catalog", licence: "Apache-2.0", nickname: "Family chat" } },
  { id: "qwen3-8b-instruct", roles: ["chat"], state: "installed" as const, sizeBytes: 5_100_000_000, measuredFootprintBytes: 6_800_000_000, estimated: false, source: "huggingface", groupId: "group-family", nickname: "Family chat", provenance: { repo: "Qwen/Qwen3-8B", licence: "Apache-2.0", nickname: "Family chat" } },
  { id: "qwen3-4b-kids", roles: ["chat"], state: "installed" as const, sizeBytes: 2_600_000_000, measuredFootprintBytes: 3_400_000_000, estimated: false, source: "catalog", groupId: "group-kids", nickname: "Kids", provenance: { source: "getmaipai/catalog", licence: "Apache-2.0", nickname: "Kids" } },
  { id: "moonshine-base", roles: ["stt"], state: "installed" as const, sizeBytes: 230_000_000, measuredFootprintBytes: 420_000_000, estimated: false, source: "catalog", groupId: "group-voice", nickname: "Voice", provenance: { source: "getmaipai/catalog", licence: "MIT", nickname: "Voice" } },
  { id: "piper-en-us", roles: ["tts"], state: "installed" as const, sizeBytes: 65_000_000, measuredFootprintBytes: 180_000_000, estimated: false, source: "catalog", groupId: "group-voice", nickname: "Voice", provenance: { source: "getmaipai/catalog", licence: "MIT", nickname: "Voice" } },
  { id: "flux2-klein", roles: ["image"], state: "installed" as const, sizeBytes: 12_800_000_000, measuredFootprintBytes: 19_100_000_000, estimated: false, source: "huggingface", groupId: "group-voice", nickname: "Pictures", provenance: { repo: "black-forest-labs/FLUX.2-klein", licence: "Apache-2.0", nickname: "Pictures" } },
  { id: "llama-3-8b-experiment", roles: ["chat"], state: "installed" as const, sizeBytes: 4_800_000_000, measuredFootprintBytes: null, estimated: true, source: "huggingface", groupId: "group-family", nickname: "Experiments", provenance: { repo: "meta-llama/Llama-3-8B", licence: "Llama 3", nickname: "Experiments" } },
  { id: "mistral-small-experiment", roles: ["chat"], state: "installed" as const, sizeBytes: 8_100_000_000, measuredFootprintBytes: null, estimated: true, source: "huggingface", groupId: "group-family", nickname: "Experiments", provenance: { repo: "mistralai/Mistral-Small", licence: "Apache-2.0", nickname: "Experiments" } },
];

export const showroomEngines: EngineRecord[] = [
  { id: "llama-server-b10797", label: "llama-server · Family chat", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "b10797", currentTag: "b10797", newestTag: "b11026", current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer available" },
  { id: "mlx-serve-managed", label: "mlx-serve · Pictures", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.8.4", currentTag: "0.8.4", newestTag: "0.8.4", current: true, notCurrent: false, needsRestart: false, state: "current", stateReason: null },
  { id: "comfyui-managed", label: "ComfyUI · Pictures", platform: "darwin", arch: "arm64", verified: true, installed: false, matchesThisMachine: false, running: null, currentTag: null, newestTag: null, current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer installed" },
];

export const showroomRoles = [
  ...["chat", "coding", "judge"].map((id) => ({ id, wire: id, residency: "resident", description: `${id} runs on Family chat.`, state: "ready", reason: null, model: { id: "qwen3-27b-instruct", sizeBytes: 17_200_000_000, measuredFootprintBytes: 21_600_000_000, measuredContextLength: 8192, estimated: false } })),
  { id: "image", wire: "job", residency: "jit", description: "Make pictures locally.", state: "ready", reason: null, model: { id: "flux2-klein", sizeBytes: 12_800_000_000, measuredFootprintBytes: 19_100_000_000, measuredContextLength: null, estimated: false } },
  { id: "video", wire: "job", residency: "jit", description: "Make short videos locally.", state: "ready", reason: null, model: null },
  { id: "music", wire: "job", residency: "jit", description: "Make music locally.", state: "ready", reason: null, model: null },
  { id: "stt", wire: "transcription", residency: "resident", description: "Listen locally.", state: "ready", reason: null, model: { id: "moonshine-base", sizeBytes: 230_000_000, measuredFootprintBytes: 420_000_000, measuredContextLength: null, estimated: false } },
  { id: "tts", wire: "speech", residency: "resident", description: "Speak locally.", state: "ready", reason: null, model: { id: "piper-en-us", sizeBytes: 65_000_000, measuredFootprintBytes: 180_000_000, measuredContextLength: null, estimated: false } },
];

export const showroomClients = [
  { id: "client-home", name: "Home", keyPrefix: "mp_home_", allowedRoles: ["chat", "embed", "stt", "tts", "image"], createdAt: new Date(now.getTime() - 30 * 86400000).toISOString(), lastSeenAt: new Date(now.getTime() - 5 * 60000).toISOString(), revokedAt: null, requests: 1842, tokensIn: 44210, tokensOut: 98211, audioSeconds: 630, jobs: 16 },
  { id: "client-coding", name: "Coding tool", keyPrefix: "mp_code_", allowedRoles: ["chat", "embed"], createdAt: new Date(now.getTime() - 18 * 86400000).toISOString(), lastSeenAt: new Date(now.getTime() - 50 * 60000).toISOString(), revokedAt: null, requests: 421, tokensIn: 18210, tokensOut: 33881, audioSeconds: 0, jobs: 0 },
  { id: "client-notes", name: "Notes app", keyPrefix: "mp_note_", allowedRoles: ["chat"], createdAt: new Date(now.getTime() - 7 * 86400000).toISOString(), lastSeenAt: new Date(now.getTime() - 3 * 86400000).toISOString(), revokedAt: null, requests: 87, tokensIn: 3210, tokensOut: 11200, audioSeconds: 0, jobs: 0 },
];

export const showroomGroups = [
  { id: "group-family", name: "Family chat", parentId: null as string | null, createdAt: new Date(now.getTime() - 8 * 86400000).toISOString(), modelCount: 4, bytesOnDisk: 35_200_000_000, memoryBytes: 28_400_000_000, usage: { requests: 1842, tokens: 142421 }, status: { loaded: 1, ready: 3, onDemand: 0, failed: 0 }, worstHealth: null },
  { id: "group-kids", name: "Kids", parentId: "group-family", createdAt: new Date(now.getTime() - 6 * 86400000).toISOString(), modelCount: 1, bytesOnDisk: 2_600_000_000, memoryBytes: 3_400_000_000, usage: { requests: 390, tokens: 22890 }, status: { loaded: 1, ready: 0, onDemand: 0, failed: 0 }, worstHealth: null },
  { id: "group-voice", name: "Voice and media", parentId: null, createdAt: new Date(now.getTime() - 4 * 86400000).toISOString(), modelCount: 3, bytesOnDisk: 13_095_000_000, memoryBytes: 600_000_000, usage: { requests: 637, tokens: 0 }, status: { loaded: 0, ready: 3, onDemand: 1, failed: 0 }, worstHealth: "warning" },
];
export const showroomDetected = [{ id: "detected-ollama", kind: "folder", name: "Ollama 0.34", version: "0.34", path: "/Users/jess/models", candidateModels: 3, roles: ["chat", "embed"] }, { id: "detected-comfyui", kind: "server", name: "ComfyUI", version: "0.3.7", path: "http://127.0.0.1:8188", candidateModels: 1, roles: ["image"] }];
export function showroomAdoptDetected(id: string): boolean { const index = showroomDetected.findIndex((item) => item.id === id); if (index < 0) return false; showroomDetected.splice(index, 1); return true; }

export const showroomHealth = [
  { code: "managed-host-offline", severity: "warning" as const, title: "ComfyUI is not running", text: "ComfyUI is not running. Start it and this row turns green.", since: new Date(now.getTime() - 3 * 86400000).toISOString(), cause: "The configured ComfyUI host did not answer.", fix: { label: "Check host", action: "check_host" } },
  { code: "memory-pressure", severity: "error" as const, title: "Memory pressure was high", text: "The governor paused one on-demand model yesterday.", since: yesterday, cause: "The Studio briefly crossed its memory warning threshold.", learnMore: "/monitoring" },
];

export const showroomUpdates = { app: { installed: "0.1.0", available: null, notes: null, size: null, lastChecked: new Date(now.getTime() - 2 * 86400000).toISOString(), checksEnabled: true, skipped: false }, engines: { installed: "b10797", available: "b11026", notes: "Metal kernels and faster startup on Apple Silicon.", size: 12_000_000, lastChecked: new Date(now.getTime() - 3600000).toISOString(), checksEnabled: true, skipped: false }, models: { installed: "sha-family-27b", available: "sha-family-27b-new", notes: "A newer revision is available.", size: 17_200_000_000, lastChecked: new Date(now.getTime() - 6 * 86400000).toISOString(), checksEnabled: true, skipped: false } };
export const showroomStorage = { totalBytes: 84_600_000_000, byCategory: { models: 62_100_000_000, engines: 20_400_000_000, logs: 1_000_000_000, backups: 0, other: 1_100_000_000 }, models: { byAbility: { chat: 29_100_000_000, voice: 1_200_000_000, image: 31_800_000_000 }, sharedBytes: 1_100_000_000 }, freeDiskBytes: 2_400_000_000_000, updatedAt: now.toISOString() };
export const showroomBudget = { capBytes: 128 * 1_073_741_824, freeMemoryBytes: 74 * 1_073_741_824, availablePercent: 58, pressure: "normal" as const, loaded: [{ id: "qwen3-27b-instruct", kind: "resident" as const, peakBytes: 21_600_000_000, measured: true, lastUsedAt: now.toISOString(), idleTtlSeconds: 0, pinned: true, pid: 4412 }, { id: "qwen3-4b-kids", kind: "resident" as const, peakBytes: 3_400_000_000, measured: true, lastUsedAt: new Date(now.getTime() - 3600000).toISOString(), idleTtlSeconds: 0, pinned: true, pid: 4414 }], queue: [] };
export const showroomNotifications = Array.from({ length: 8 }, (_, index) => ({ id: `showroom-notification-${index + 1}`, title: ["Engine b11026 is available", "ComfyUI is not running", "A model revision is ready", "Backup target is not configured", "Chat engine restarted", "Memory returned to normal", "Home connected", "Updates checked"][index]!, level: index === 1 ? "immediate" : "passive", at: new Date(now.getTime() - index * 86400000).toISOString(), data: "{}" }));

export function showroomSeries(range: "hour" | "day" | "week") {
  const count = range === "hour" ? 6 : range === "day" ? 12 : 24;
  const step = range === "hour" ? 10 * 60_000 : range === "day" ? 2 * 60 * 60_000 : 6 * 60 * 60_000;
  const usage = Array.from({ length: count }, (_, index) => {
    const at = new Date(now.getTime() - (count - index - 1) * step).toISOString();
    return { at, ability: "chat", clientId: "client-home", modelId: "qwen3-27b-instruct", requests: 12 + index * 3, tokensIn: 420 + index * 38, tokensOut: 690 + index * 51, jobs: index % 4 === 0 ? 1 : 0 };
  });
  const memory = Array.from({ length: count }, (_, index) => ({ at: usage[index]!.at, totalBytes: showroomHardware.totalRamGb * 1_073_741_824, freeBytes: (74 - Math.min(index, 4)) * 1_073_741_824, availablePercent: 58 - Math.min(index, 4) * 2, pressure: index > count - 3 ? "warn" : "normal", loadedBytes: 25_000_000_000 + index * 500_000_000 }));
  const speed = Array.from({ length: Math.min(count, 6) }, (_, index) => ({ at: usage[count - Math.min(count, 6) + index]!.at, ability: "chat", modelId: "qwen3-27b-instruct", engine: "b10797", firstTokenMs: 180 - index * 8, tokensPerSecond: 42 + index * 2 }));
  return { usage, memory, speed };
}

export function showroomResolveHealth(code: string): boolean { const item = showroomHealth.find((entry) => entry.code === code); if (!item) return false; showroomHealth.splice(showroomHealth.indexOf(item), 1); return true; }
