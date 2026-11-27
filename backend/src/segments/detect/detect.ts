import { findHeuristicCandidates, type HeuristicOptions } from "./heuristics";
import { detectWithLlm, type LlmClient } from "./llm";
import type { TranscriptSegment } from "./transcript";

export interface Detection { startSec: number; endSec: number; kind: string; confidence: number; source: "text-pattern" | "llm" | "text-pattern+llm" }
export async function detectFromTranscript(segments: TranscriptSegment[], opts: { llm?: LlmClient; heuristics?: HeuristicOptions } = {}): Promise<Detection[]> {
  const rules = findHeuristicCandidates(segments, opts.heuristics).map((c) => ({ startSec: c.startSec, endSec: c.endSec, kind: "ad", confidence: c.score, source: "text-pattern" as const }));
  if (!opts.llm) return rules;
  const model = await detectWithLlm(segments, opts.llm);
  const out: Detection[] = rules.map((r) => ({ ...r }));
  for (const ad of model) {
    const match = out.find((r) => Math.min(r.endSec, ad.endSec) > Math.max(r.startSec, ad.startSec) && (Math.min(r.endSec, ad.endSec) - Math.max(r.startSec, ad.startSec)) / Math.min(r.endSec - r.startSec, ad.endSec - ad.startSec) >= 0.25);
    if (match) {
      match.startSec = Math.min(match.startSec, ad.startSec); match.endSec = Math.max(match.endSec, ad.endSec);
      match.confidence = Math.min(0.98, Math.max(match.confidence, ad.confidence) + 0.15); match.source = "text-pattern+llm";
    } else out.push({ startSec: ad.startSec, endSec: ad.endSec, kind: ad.kind, confidence: ad.confidence, source: "llm" });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}
