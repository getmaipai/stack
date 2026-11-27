import type { TranscriptSegment, TranscriptWindow } from "./transcript";
import { formatWindow, windowSegments } from "./transcript";

export type LlmClient = (messages: { role: "system" | "user"; content: string }[]) => Promise<string>;
export interface LlmAd { startSec: number; endSec: number; kind: string; label: string; confidence: number; reason: string }
interface RawAd { startLine: number; endLine: number; kind?: string; label?: string; confidence?: number; reason?: string }

function parseArray(text: string): unknown[] {
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? "", text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)];
  for (const value of candidates) { try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch {} }
  // Repair common model output errors: trailing commas and single quoted JSON strings.
  const body = candidates[2] ?? "";
  for (const value of [body.replace(/,\s*([}\]])/g, "$1"), body.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"')]) {
    try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch {}
  }
  throw new Error("LLM response did not contain a valid JSON ad array");
}

function prompt(window: TranscriptWindow): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: "Identify only advertisements or sponsor reads, including pre-roll and post-roll. Return strict JSON only: {\"ads\":[{\"startLine\":1,\"endLine\":2,\"kind\":\"ad|sponsor|selfpromo\",\"label\":\"short name\",\"confidence\":0.0,\"reason\":\"brief evidence\"}]}. Line numbers refer to the numbered transcript below. Do not label ordinary discussion or infer missing content." },
    { role: "user", content: `Window ${window.index + 1}; timestamps are absolute.\n${formatWindow(window)}` },
  ];
}

export async function detectWithLlm(segments: TranscriptSegment[], llm: LlmClient): Promise<LlmAd[]> {
  const windows = windowSegments(segments);
  const results = await Promise.all(windows.map(async (w) => {
    const raw = await llm(prompt(w));
    const parsed = parseArray(raw);
    const out: LlmAd[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const a = item as RawAd;
      if (!Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine! < 1 || a.endLine! < a.startLine! || a.endLine! > w.segments.length) continue;
      const startSec = w.segments[a.startLine! - 1]!.startSec, endSec = w.segments[a.endLine! - 1]!.endSec;
      if (endSec <= startSec) continue;
      out.push({ startSec, endSec, kind: a.kind ?? "ad", label: a.label ?? "", confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)), reason: a.reason ?? "" });
    }
    return out;
  }));
  const sorted = results.flat().sort((a, b) => a.startSec - b.startSec);
  const merged: LlmAd[] = [];
  for (const ad of sorted) {
    const last = merged[merged.length - 1];
    if (last && ad.startSec <= last.endSec + 5) { last.endSec = Math.max(last.endSec, ad.endSec); last.confidence = Math.max(last.confidence, ad.confidence); if (ad.reason && !last.reason.includes(ad.reason)) last.reason += `; ${ad.reason}`; }
    else merged.push({ ...ad });
  }
  return merged;
}
