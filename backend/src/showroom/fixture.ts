type EngineRecord = { id: string; label: string; platform: string; arch: string; verified: boolean; installed: boolean; matchesThisMachine: boolean; running: string | null; currentTag: string | null; newestTag: string | null; current: boolean; notCurrent: boolean; needsRestart: boolean; state: "current" | "notCurrent"; stateReason: "newer installed" | "newer available" | null; directory: string };

export function showroom(): boolean { return process.env.STACK_SHOWROOM === "1" && process.env.NODE_ENV !== "production"; }
export function assertShowroomAllowed(): void { if (process.env.STACK_SHOWROOM === "1" && process.env.NODE_ENV === "production") throw new Error("STACK_SHOWROOM is disabled in production."); }

const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

export const showroomHardware = { computerName: "marlow", platform: "darwin", arch: "arm64", totalRamGb: 128, cpuCount: 16, isAppleSilicon: true, unifiedMemoryGb: 128, cudaDevices: [], freeDiskBytes: 2_400_000_000_000, totalDiskBytes: 4_000_000_000_000, osVersion: "15.6", drives: [{ name: "Macintosh HD", mount: "/", usedBytes: 1_600_000_000_000, totalBytes: 4_000_000_000_000, mounted: true }] };
export const showroomProfile = { id: "p128" as const, label: "This Studio can run every ability, with the heaviest work on demand.", minUnifiedGb: 128, minVramGb: 0, resident: ["chat", "coding", "judge", "router", "embed", "rerank", "stt", "tts"], onDemand: ["vision", "image", "video", "music"], installedOnly: [], notAvailable: [], speedRange: { min: 45, max: 320 } };

export const showroomModels = [
  { id: "qwen3-27b-instruct", roles: ["chat", "coding", "judge"], state: "installed" as const, sizeBytes: 17_200_000_000, measuredFootprintBytes: 21_600_000_000, estimated: false, source: "catalog", groupId: "group-family", nickname: null, modelPath: "/Users/marlow/Stack/data/models/qwen3-27b-instruct.gguf", provenance: { source: "getmaipai/catalog", licence: "Apache-2.0" } },
  { id: "qwen3-8b-instruct", roles: ["chat"], state: "installed" as const, sizeBytes: 5_100_000_000, measuredFootprintBytes: 6_800_000_000, estimated: false, source: "huggingface", groupId: "group-family", nickname: null, provenance: { repo: "Qwen/Qwen3-8B", licence: "Apache-2.0" } },
  { id: "qwen3-4b-kids", roles: ["chat"], state: "installed" as const, sizeBytes: 2_600_000_000, measuredFootprintBytes: 3_400_000_000, estimated: false, source: "catalog", groupId: "group-kids", nickname: "Kids", provenance: { source: "getmaipai/catalog", licence: "Apache-2.0", nickname: "Kids" } },
  { id: "moonshine-base", roles: ["stt"], state: "installed" as const, sizeBytes: 230_000_000, measuredFootprintBytes: 420_000_000, estimated: false, source: "catalog", groupId: "group-voice", nickname: "Voice", provenance: { source: "getmaipai/catalog", licence: "MIT", nickname: "Voice" } },
  { id: "piper-en-us", roles: ["tts"], state: "installed" as const, sizeBytes: 65_000_000, measuredFootprintBytes: 180_000_000, estimated: false, source: "catalog", groupId: "group-voice", nickname: "Voice", provenance: { source: "getmaipai/catalog", licence: "MIT", nickname: "Voice" } },
  { id: "flux2-klein", roles: ["image"], state: "installed" as const, sizeBytes: 12_800_000_000, measuredFootprintBytes: 19_100_000_000, estimated: false, source: "huggingface", groupId: "group-voice", nickname: "Images", provenance: { repo: "black-forest-labs/FLUX.2-klein", licence: "Apache-2.0", nickname: "Images" } },
  { id: "llama-3-8b-experiment", roles: ["chat"], state: "installed" as const, sizeBytes: 4_800_000_000, measuredFootprintBytes: null, estimated: true, source: "huggingface", groupId: "group-family", nickname: "Experiments", provenance: { repo: "meta-llama/Llama-3-8B", licence: "Llama 3", nickname: "Experiments" } },
  { id: "mistral-small-experiment", roles: ["chat"], state: "installed" as const, sizeBytes: 8_100_000_000, measuredFootprintBytes: null, estimated: true, source: "huggingface", groupId: "group-family", nickname: "Experiments", provenance: { repo: "mistralai/Mistral-Small", licence: "Apache-2.0", nickname: "Experiments" } },
];

export const showroomEngines: EngineRecord[] = [
  { id: "llama-server-b10797", label: "llama-server · Family chat", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "b10797", currentTag: "b10797", newestTag: "b11026", current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer available", directory: "/Users/marlow/Stack/data/engines/llama-server/b10797" },
  { id: "mlx-serve-managed", label: "mlx-serve · Images", platform: "darwin", arch: "arm64", verified: true, installed: true, matchesThisMachine: true, running: "0.8.4", currentTag: "0.8.4", newestTag: "0.8.4", current: true, notCurrent: false, needsRestart: false, state: "current", stateReason: null, directory: "/Users/marlow/Stack/data/engines/mlx-serve/0.8.4" },
  { id: "comfyui-managed", label: "ComfyUI · Images", platform: "darwin", arch: "arm64", verified: true, installed: false, matchesThisMachine: false, running: null, currentTag: null, newestTag: null, current: false, notCurrent: true, needsRestart: false, state: "notCurrent", stateReason: "newer installed", directory: "/Users/marlow/Stack/data/engines/comfyui" },
];

const readyStamp = { state: { state: "ready" as const, since: new Date(now.getTime() - 60 * 60_000).toISOString(), checkedAt: new Date(now.getTime() - 5 * 60_000).toISOString() } };

export const showroomRoles = [
  ...[{ id: "chat", label: "Chat" }, { id: "coding", label: "Coding" }, { id: "judge", label: "Judge" }].map(({ id, label }) => ({ id, label, wire: id, residency: "resident", description: `${label} runs on Family chat.`, ...readyStamp, reason: null, model: { id: "qwen3-27b-instruct", sizeBytes: 17_200_000_000, measuredFootprintBytes: 21_600_000_000, measuredContextLength: 8192, estimated: false } })),
  { id: "embed", label: "Embeddings", wire: "embeddings", residency: "resident", description: "Find related things locally.", ...readyStamp, reason: null, model: null },
  { id: "image", label: "Images", wire: "job", residency: "jit", description: "Make images locally.", ...readyStamp, reason: null, model: { id: "flux2-klein", sizeBytes: 12_800_000_000, measuredFootprintBytes: 19_100_000_000, measuredContextLength: null, estimated: false } },
  { id: "video", label: "Video", wire: "job", residency: "jit", description: "Make short videos locally.", ...readyStamp, reason: null, model: null },
  { id: "music", label: "Music", wire: "job", residency: "jit", description: "Make music locally.", ...readyStamp, reason: null, model: null },
  { id: "stt", label: "Voice in", wire: "transcription", residency: "resident", description: "Listen locally.", ...readyStamp, reason: null, model: { id: "moonshine-base", sizeBytes: 230_000_000, measuredFootprintBytes: 420_000_000, measuredContextLength: null, estimated: false } },
  { id: "tts", label: "Voice out", wire: "speech", residency: "resident", description: "Speak locally.", ...readyStamp, reason: null, model: { id: "piper-en-us", sizeBytes: 65_000_000, measuredFootprintBytes: 180_000_000, measuredContextLength: null, estimated: false } },
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
export const showroomBudget = { totalMemoryBytes: 160 * 1_073_741_824, capBytes: 128 * 1_073_741_824, freeMemoryBytes: 74 * 1_073_741_824, availablePercent: 58, pressure: "normal" as const, loaded: [{ id: "qwen3-27b-instruct", kind: "resident" as const, peakBytes: 21_600_000_000, measured: true, lastUsedAt: now.toISOString(), idleTtlSeconds: 0, pinned: true, pid: 4412 }, { id: "qwen3-4b-kids", kind: "resident" as const, peakBytes: 3_400_000_000, measured: true, lastUsedAt: new Date(now.getTime() - 3600000).toISOString(), idleTtlSeconds: 0, pinned: true, pid: 4414 }], queue: [] };
export const showroomLive = { processes: [{ engine: "chat", build: "b10797", model: "qwen3-27b-instruct", port: 8080, memoryFootprintBytes: 21_600_000_000, cpuPercent: 42, pid: 4412, startedAt: new Date(now.getTime() - 3_600_000).toISOString() }], gpus: [{ name: "NVIDIA RTX 5090", memoryUsedBytes: 12_000_000_000, memoryTotalBytes: 32_000_000_000, utilization: 73 }, { name: "Apple M4 Pro", memoryUsedBytes: null, memoryTotalBytes: null, utilization: null }], cpu: { percent: 31 }, drives: [{ name: "Macintosh HD", usedBytes: 600_000_000_000, totalBytes: 1_000_000_000_000 }, { name: "Models", usedBytes: 400_000_000_000, totalBytes: 2_000_000_000_000 }], clients: [{ name: "atlas", roles: ["chat", "coding"], requestCount: 12, lastRequestAt: new Date(now.getTime() - 120_000).toISOString() }, { name: "clover", roles: ["chat"], requestCount: 4, lastRequestAt: new Date(now.getTime() - 240_000).toISOString() }], at: now.toISOString() };
export const showroomNotifications = Array.from({ length: 8 }, (_, index) => ({ id: `showroom-notification-${index + 1}`, eventId: index === 1 ? "health.changed" : "update.applied", title: ["Engine b11026 is available", "ComfyUI is not running", "A model revision is ready", "Backup target is not configured", "Chat engine restarted", "Memory returned to normal", "Home connected", "Updates checked"][index]!, level: index === 1 ? "immediate" : "passive", durable: index !== 0 && index !== 2, at: new Date(now.getTime() - index * 86400000).toISOString(), data: "{}" }));
export const showroomChannels = [
  { id: "showroom-telegram", type: "telegram" as const, name: "Family Telegram", verifiedAt: new Date(now.getTime() - 2 * 86400000).toISOString(), createdAt: new Date(now.getTime() - 15 * 86400000).toISOString(), lastError: null, lastSentAt: new Date(now.getTime() - 3600000).toISOString(), status: "verified" as const, configPresent: true as const },
  { id: "showroom-ntfy", type: "ntfy" as const, name: "Phone alerts", serverUrl: "https://ntfy.sh", topic: "maipai-home-demo", verifiedAt: null, createdAt: new Date(now.getTime() - 3 * 86400000).toISOString(), lastError: null, lastSentAt: null, status: "unverified" as const, configPresent: true as const },
];
export const showroomLibrary = [
  { id: "model-qwen3-8b-instruct", kind: "model" as const, title: "Family chat", source: "https://huggingface.co/Qwen/Qwen3-8B", licence: "Apache-2.0", fetchedAt: new Date(now.getTime() - 2 * 86400000).toISOString(), revision: "main", size: 18_200, etag: null, location: "/Users/marlow/Stack/data/library/model-qwen3-8b-instruct", markdown: "# Qwen3 8B\n\nA local family chat model.", files: ["README.md", "meta.json"], numbers: { footprintBytes: 6_800_000_000, speedTokensPerSecond: 52, lastUsedAt: new Date(now.getTime() - 3600000).toISOString() } },
  { id: "engine-llama-server-b10797-macos-arm64", kind: "engine" as const, title: "llama-server build b10797", source: "https://github.com/ggml-org/llama.cpp/tree/b10797/docs", licence: "MIT", fetchedAt: new Date(now.getTime() - 86400000).toISOString(), revision: "b10797", size: 9_400, etag: null, location: "/Users/marlow/Stack/data/library/engine-llama-server-b10797-macos-arm64", markdown: "# llama-server\n\nThe local chat engine documentation.", files: ["README.md", "meta.json"], numbers: { footprintBytes: null, speedTokensPerSecond: 113, lastUsedAt: null } },
];
export const showroomCheck = { at: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), ok: true, results: ["chat", "coding", "judge", "image", "stt", "tts"].map((role, index) => ({ role, ok: true, ms: 28 + index * 9, reason: null, loadMs: null })), fitTogether: { ok: true, reason: null }, reason: null };

export function showroomSeries(range: "hour" | "day" | "week") {
  const count = range === "hour" ? 13 : range === "day" ? 25 : 29;
  const step = range === "hour" ? 5 * 60_000 : range === "day" ? 60 * 60_000 : 6 * 60 * 60_000;
  const usage = Array.from({ length: count }, (_, index) => {
    const at = new Date(now.getTime() - (count - index - 1) * step).toISOString();
    return { at, ability: "chat", clientId: "client-home", modelId: "qwen3-27b-instruct", requests: 12 + index * 3, tokensIn: 420 + index * 38, tokensOut: 690 + index * 51, jobs: index % 4 === 0 ? 1 : 0 };
  });
  const memory = Array.from({ length: count }, (_, index) => ({ at: usage[index]!.at, totalBytes: showroomHardware.totalRamGb * 1_073_741_824, freeBytes: (74 - Math.min(index, 4)) * 1_073_741_824, availablePercent: 58 - Math.min(index, 4) * 2, pressure: index > count - 3 ? "warn" : "normal", loadedBytes: 25_000_000_000 + index * 500_000_000 }));
  const speed = Array.from({ length: Math.min(count, 6) }, (_, index) => ({ at: usage[count - Math.min(count, 6) + index]!.at, ability: "chat", modelId: "qwen3-27b-instruct", engine: "b10797", firstTokenMs: 180 - index * 8, tokensPerSecond: 42 + index * 2 }));
  return { usage, memory, speed };
}

const resourceBucketCounts = { hour: 60, day: 96, week: 168, month: 120 } as const;
const resourceStepMs = { hour: 60_000, day: 15 * 60_000, week: 60 * 60_000, month: 6 * 60 * 60_000 } as const;

export function showroomResourceSeries(range: "hour" | "day" | "week" | "month") {
  const count = resourceBucketCounts[range];
  const step = resourceStepMs[range];
  const at = (index: number) => new Date(now.getTime() - (count - index - 1) * step).toISOString();
  const wave = (index: number, base: number, amplitude: number) => Math.round(base + amplitude * Math.sin((index / count) * Math.PI * 2));
  const cpu = Array.from({ length: count }, (_, index) => ({ at: at(index), percent: wave(index, 28, 18), usedBytes: null, totalBytes: null }));
  const memory = Array.from({ length: count }, (_, index) => ({ at: at(index), percent: wave(index, 55, 8), usedBytes: Math.round(showroomHardware.totalRamGb * 1_073_741_824 * (0.5 + wave(index, 0, 8) / 100)), totalBytes: showroomHardware.totalRamGb * 1_073_741_824 }));
  const gpu = Array.from({ length: count }, (_, index) => ({ at: at(index), percent: wave(index, 20, 20), usedBytes: null, totalBytes: null }));
  const driveTotal = showroomHardware.drives[0]!.totalBytes;
  const storage = Array.from({ length: count }, (_, index) => ({ at: at(index), percent: Math.round((showroomHardware.drives[0]!.usedBytes / driveTotal) * 100), usedBytes: showroomHardware.drives[0]!.usedBytes, totalBytes: driveTotal }));
  return {
    cpu,
    memory,
    gpu,
    storage,
    devices: {
      gpus: [{ index: 0, name: "Apple M4 Pro", utilization: gpu[gpu.length - 1]!.percent, memoryUsedBytes: null, memoryTotalBytes: null }],
      drives: [{ name: showroomHardware.drives[0]!.name, usedBytes: showroomHardware.drives[0]!.usedBytes, totalBytes: driveTotal }],
    },
  };
}

export function showroomResolveHealth(code: string): boolean { const item = showroomHealth.find((entry) => entry.code === code); if (!item) return false; showroomHealth.splice(showroomHealth.indexOf(item), 1); return true; }

type ShowroomComponentRow = { id: string; category: "models" | "runtimes" | "apps" | "extensions" | "system" | "adapters" | "workflows" | "training"; subtype: string | null; name: string; identifier: string | null; version: string | null; sizeBytes: number | null; status: "running" | "stopped" | "detected" | "update" | "warning" | "error" | "ready"; statusText: string | null; runtime: string | null; resources: { memoryBytes: number | null; gpuPercent: number | null; cpuPercent: number | null }; uptimeSeconds: number | null; lastUsedAt: string | null; notes: string | null };

const showroomComponentRows: ShowroomComponentRow[] = [
  { id: "model:qwen3-27b-instruct", category: "models", subtype: "LLMs", name: "Family chat", identifier: "qwen3-27b-instruct", version: "main", sizeBytes: 17_200_000_000, status: "running", statusText: "Loaded and serving requests", runtime: "llama-server", resources: { memoryBytes: 21_600_000_000, gpuPercent: null, cpuPercent: null }, uptimeSeconds: 3_600, lastUsedAt: new Date(now.getTime() - 120_000).toISOString(), notes: "Q4_K_M" },
  { id: "model:qwen3-4b-kids", category: "models", subtype: "LLMs", name: "Kids", identifier: "qwen3-4b-kids", version: "main", sizeBytes: 2_600_000_000, status: "stopped", statusText: "Installed, not loaded", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(), notes: "Q4_K_M" },
  { id: "model:flux2-klein", category: "models", subtype: "Image", name: "Images", identifier: "flux2-klein", version: "main", sizeBytes: 12_800_000_000, status: "stopped", statusText: "Installed, not loaded", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "runtime:llama-server-b10797", category: "runtimes", subtype: "Engines", name: "llama-server · Family chat", identifier: "llama-server-b10797", version: "b10797", sizeBytes: 380_000_000, status: "update", statusText: "A newer build is newer available.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "runtime:mlx-serve-managed", category: "runtimes", subtype: "Engines", name: "mlx-serve · Images", identifier: "mlx-serve-managed", version: "0.8.4", sizeBytes: 210_000_000, status: "running", statusText: "Running", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: 5_400, lastUsedAt: null, notes: null },
  { id: "runtime:detected:ollama", category: "runtimes", subtype: "Detected", name: "Ollama", identifier: "http://127.0.0.1:11434", version: "0.6.1", sizeBytes: null, status: "detected", statusText: "Detected at http://127.0.0.1:11434, not adopted.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: new Date(now.getTime() - 3_600_000).toISOString(), notes: "Minimum supported version: 0.5.0." },
  { id: "app:client-coding", category: "apps", subtype: "Coding", name: "Coding tool", identifier: "client-coding", version: null, sizeBytes: null, status: "running", statusText: "421 requests", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: new Date(now.getTime() - 50 * 60000).toISOString(), notes: null },
  { id: "app:tester:chat", category: "apps", subtype: "Tester", name: "Chat", identifier: null, version: null, sizeBytes: null, status: "running", statusText: "Family chat serves this role.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "app:tester:image", category: "apps", subtype: "Tester", name: "Image", identifier: null, version: null, sizeBytes: null, status: "ready", statusText: "Images serves this role.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "app:library", category: "apps", subtype: "Knowledge", name: "Library", identifier: null, version: null, sizeBytes: null, status: "ready", statusText: null, runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "extension:channel:showroom-telegram", category: "extensions", subtype: "Integrations", name: "Family Telegram", identifier: "telegram", version: null, sizeBytes: null, status: "ready", statusText: null, runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: new Date(now.getTime() - 3600000).toISOString(), notes: null },
  { id: "extension:channel:showroom-ntfy", category: "extensions", subtype: "Integrations", name: "Phone alerts", identifier: "ntfy", version: null, sizeBytes: null, status: "warning", statusText: "Not yet verified.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "extension:hf-mirror", category: "extensions", subtype: "Integrations", name: "Hugging Face mirror", identifier: "https://huggingface.co", version: null, sizeBytes: null, status: "ready", statusText: "Using the default Hugging Face endpoint.", runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "system:accelerator:apple", category: "system", subtype: "Accelerators", name: "Apple silicon GPU", identifier: null, version: null, sizeBytes: null, status: "ready", statusText: null, runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "system:driver:metal", category: "system", subtype: "Drivers", name: "Metal", identifier: null, version: null, sizeBytes: null, status: "ready", statusText: null, runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
  { id: "system:dependency:llama-server-b10797", category: "system", subtype: "Dependencies", name: "llama-server (macOS, Apple Silicon, Metal), build b10797", identifier: "llama-server-b10797", version: null, sizeBytes: 380_000_000, status: "ready", statusText: null, runtime: null, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null }, uptimeSeconds: null, lastUsedAt: null, notes: null },
];

const showroomManaged = { models: true, runtimes: true, apps: true, extensions: true, system: true, adapters: false, workflows: false, training: false } as const;

export function showroomComponents(): { components: ShowroomComponentRow[]; managed: typeof showroomManaged } {
  return { components: showroomComponentRows, managed: showroomManaged };
}

export function showroomComponentsSummary() {
  const dayAgo = now.getTime() - 24 * 60 * 60_000;
  const recentClients = showroomClients.filter((client) => new Date(client.lastSeenAt).getTime() >= dayAgo);
  const perCategory = Object.fromEntries((Object.keys(showroomManaged) as (keyof typeof showroomManaged)[]).map((category) => [category, showroomComponentRows.filter((row) => row.category === category).length])) as Record<keyof typeof showroomManaged, number>;
  return {
    installed: showroomComponentRows.filter((row) => row.status !== "detected").length,
    running: showroomComponentRows.filter((row) => row.status === "running").length,
    clientsConnected: { local: recentClients.length, remote: 0 },
    updatesAvailable: showroomComponentRows.filter((row) => row.status === "update").length,
    perCategory,
  };
}
