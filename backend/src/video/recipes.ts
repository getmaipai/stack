import type { StackCapabilityOperation, StackLevelRecipe } from "@maipai/spec/stack/ts/stack-model-pack.js";
import { packFor } from "@/packs/loader";
import { VIDEO_SPECS, type VideoQuality } from "@/video/videoGen";
import { STACK_VIDEO_H3_MODEL_ID } from "@/lib/modelCatalog";
import type { VideoEngine } from "@/video/caps";

export type VideoLevel = "standard" | "boost" | "max";
export interface SelectedVideoRecipe { recipe: StackLevelRecipe; quality: VideoQuality }

const levelFallback: Record<VideoQuality, VideoLevel> = { quick: "standard", ltx25: "standard", ltx25max: "max", h3: "standard", h3stream: "standard" };
function recipesFor(engine: VideoEngine): StackLevelRecipe[] {
  const part = engine === "h3" ? STACK_VIDEO_H3_MODEL_ID : VIDEO_SPECS[engine].modelId;
  return packFor(part)?.pack.jobs.find((job) => job.job === "clip")?.profiles ?? [];
}

/** Selects solely from pack declarations: among a level's recipes whose operations match (absent means all) and whose memory floor `admittedBytes` holds, the largest floor wins. An omitted `size` means any size, so the Stack, not the caller, picks the native one. When `isInstalled` is given, a recipe whose required adapter is not installed is skipped, so a level with a declared no-adapter recipe still runs (H3 Standard: 7 steps with the turbo adapter, else the 12-step recipe). */
export function videoRecipe(engine: VideoEngine, level: VideoLevel, operation: StackCapabilityOperation, size?: string, admittedBytes = Number.MAX_SAFE_INTEGER, build: "h3" | "h3stream" = "h3", isInstalled?: (id: string) => boolean): SelectedVideoRecipe | null {
  const candidates = recipesFor(engine).filter((item) => item.level === level && (!item.operations || item.operations.includes(operation)) && (!item.size || size === undefined || `${item.size.width}x${item.size.height}` === size) && (item.memory_floor_bytes ?? 0) <= admittedBytes && !(isInstalled && item.adapter?.required && !isInstalled(item.adapter.id)));
  const selected = candidates.sort((a, b) => (b.memory_floor_bytes ?? 0) - (a.memory_floor_bytes ?? 0))[0];
  if (!selected) return null;
  const quality: VideoQuality = engine === "h3" ? build : engine;
  return { recipe: selected, quality };
}

export function maxVideoRecipe(engine: VideoEngine, operation: StackCapabilityOperation, size: string, admittedBytes: number): SelectedVideoRecipe | null {
  const candidates = recipesFor(engine).filter((item) => item.level === "max" && item.operations?.includes(operation) && item.size && `${item.size.width}x${item.size.height}` === size && (item.memory_floor_bytes ?? 0) <= admittedBytes);
  const recipe = candidates.sort((a, b) => (b.memory_floor_bytes ?? 0) - (a.memory_floor_bytes ?? 0))[0];
  return recipe ? { recipe, quality: engine } : null;
}

export function videoRecipeAdapterReady(engine: VideoEngine, level: VideoLevel, operation: StackCapabilityOperation, size: string | undefined, admittedBytes: number, modelDir: string, exists: (path: string) => boolean): boolean {
  const selected = videoRecipe(engine, level, operation, size, admittedBytes);
  const adapter = selected?.recipe.adapter;
  return !adapter?.required || exists(`${modelDir}/loras/${adapter.id}.safetensors`);
}

export function adapterInstalled(id: string, modelDir: string, exists: (path: string) => boolean): boolean {
  return exists(`${modelDir}/loras/${id}.safetensors`);
}

export function defaultVideoLevel(quality: VideoQuality): VideoLevel { return levelFallback[quality]; }
