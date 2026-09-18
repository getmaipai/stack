export const MODEL_RUNTIME_STATE_LABELS: Record<string, string> = {
  loaded: "Loaded",
  ready: "Ready",
  onDemand: "On demand",
  failed: "Failed",
};

export const MODEL_SOURCE_LABELS: Record<string, string> = {
  catalog: "Catalog",
  huggingface: "Hugging Face",
  folder: "Folder",
  comfyui: "ComfyUI",
  server: "ComfyUI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export const ROLE_LABELS: Record<string, string> = {
  chat: "Chat",
  coding: "Coding",
  judge: "Judge",
  router: "Router",
  embed: "Embeddings",
  rerank: "Re-rank",
  vision: "Vision",
  stt: "Voice in",
  tts: "Voice out",
  wakeword: "Wake word",
  image: "Images",
  video: "Video",
  music: "Music",
};

export function labelForRole(id: string, declared?: ReadonlyArray<{ id: string; label?: string }>): string {
  return declared?.find((role) => role.id === id)?.label ?? ROLE_LABELS[id] ?? id;
}
