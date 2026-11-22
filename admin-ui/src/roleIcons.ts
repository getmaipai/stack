import { AudioLines, Boxes, Brain, Code2, Compass, Ear, Eye, Image, Layers, Mic, Music, ScanSearch, Scale, Search, Sparkles, Video, Volume2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** One icon per feature, chosen by the role id; anything new falls back to a plain one. */
const ICONS: Record<string, LucideIcon> = {
  chat: Sparkles, coding: Code2, code: Code2, judge: Scale, router: Compass, embed: Layers, embeddings: Layers, rerank: ScanSearch,
  vision: Eye, stt: Mic, tts: Volume2, wakeword: Ear, image: Image, video: Video, music: Music, search: Search, think: Brain, voice: AudioLines,
};
export function roleIcon(id: string): LucideIcon {
  const key = id.toLowerCase();
  if (ICONS[key]) return ICONS[key];
  const hit = Object.keys(ICONS).find((k) => key.includes(k));
  return hit ? ICONS[hit]! : Boxes;
}
