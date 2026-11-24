import { AudioLines, Boxes, Brain, Code2, Compass, Ear, Eye, Image, Layers, Mic, Music, ScanSearch, Scale, Scissors, Search, Sparkles, Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { featureIconName } from "./featureRows";

/** Icons by the kit icon NAME the Stack's feature rows carry. Rendering table only: the Stack decides which feature uses which name. */
const ICONS_BY_NAME: Record<string, LucideIcon> = {
  sparkles: Sparkles, code: Code2, image: Image, film: Video, music: Music, "mic-vocal": AudioLines, mic: Mic, layers: Layers, eye: Eye, ear: Ear, scissors: Scissors, box: Boxes,
};
/** Roles that are not features (no row to ask), and the fallback before the rows load. */
const FALLBACK: Record<string, LucideIcon> = {
  chat: Sparkles, coding: Code2, code: Code2, judge: Scale, router: Compass, embed: Layers, rerank: ScanSearch, vision: Eye, stt: Mic, tts: AudioLines, wakeword: Ear,
  image: Image, video: Video, music: Music, search: Search, think: Brain, voice: AudioLines,
};
export function roleIcon(id: string): LucideIcon {
  const key = id.toLowerCase();
  const named = featureIconName(key);
  if (named && ICONS_BY_NAME[named]) return ICONS_BY_NAME[named]!;
  if (FALLBACK[key]) return FALLBACK[key]!;
  const hit = Object.keys(FALLBACK).find((k) => key.includes(k));
  return hit ? FALLBACK[hit]! : Boxes;
}
