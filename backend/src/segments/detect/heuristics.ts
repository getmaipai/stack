// Fast rules pass over a transcript, no model. Phrase lists are data: add a row to extend.
import type { TranscriptSegment } from "./transcript";

export type PhraseRole = "sponsor" | "leadin" | "disclaimer" | "cta" | "weak";

export interface PhraseRule {
  /** Lowercase substring, or a RegExp tested against lowercased text. */
  match: string | RegExp;
  weight: number;
  role: PhraseRole;
  /** Treat this many seconds after the hit as part of the ad (a read follows the phrase). */
  forwardSec?: number;
}

export const PHRASES: PhraseRule[] = [
  // sponsor-read openers
  { match: "brought to you by", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "is sponsored by", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "support for this show comes from", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "support for this podcast comes from", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "presented by", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "our sponsor", weight: 3, role: "sponsor", forwardSec: 25 },
  { match: "a word from our", weight: 2, role: "sponsor", forwardSec: 20 },
  // codes and links
  { match: "promo code", weight: 3, role: "cta" },
  { match: "use code", weight: 3, role: "cta" },
  { match: "offer code", weight: 3, role: "cta" },
  { match: /\.com (slash|\/)/, weight: 3, role: "cta" },
  { match: /\b[a-z0-9-]+\.com\b/, weight: 1, role: "cta" },
  { match: "terms apply", weight: 3, role: "disclaimer" },
  { match: "conditions apply", weight: 2, role: "disclaimer" },
  { match: "restrictions apply", weight: 2, role: "disclaimer" },
  { match: "18 plus", weight: 2, role: "disclaimer" },
  { match: "21 and over", weight: 2, role: "disclaimer" },
  // break lead-ins and lead-outs
  { match: "don't go anywhere", weight: 3, role: "leadin", forwardSec: 30 },
  { match: "we'll be right back", weight: 3, role: "leadin", forwardSec: 30 },
  { match: "we will be right back", weight: 3, role: "leadin", forwardSec: 30 },
  { match: "be right back", weight: 2, role: "leadin", forwardSec: 30 },
  { match: "after this break", weight: 3, role: "leadin", forwardSec: 30 },
  { match: "right after this", weight: 2, role: "leadin", forwardSec: 30 },
  { match: "quick break", weight: 3, role: "leadin", forwardSec: 30 },
  { match: "short break", weight: 3, role: "leadin", forwardSec: 30 },
  // disclaimers
  { match: "side effects", weight: 3, role: "disclaimer" },
  { match: "prescribing information", weight: 3, role: "disclaimer" },
  { match: "boxed warning", weight: 3, role: "disclaimer" },
  { match: "ask your doctor", weight: 3, role: "disclaimer" },
  { match: "call your doctor", weight: 3, role: "disclaimer" },
  { match: "member fdic", weight: 3, role: "disclaimer" },
  { match: "subject to lender approval", weight: 3, role: "disclaimer" },
  { match: "lender approval", weight: 2, role: "disclaimer" },
  { match: "does not lend in", weight: 2, role: "disclaimer" },
  { match: "results may vary", weight: 2, role: "disclaimer" },
  { match: "see website for details", weight: 2, role: "disclaimer" },
  { match: "not available in all", weight: 2, role: "disclaimer" },
  // weak calls to action, only count when they cluster
  { match: "download", weight: 1, role: "weak" },
  { match: "learn more", weight: 1, role: "weak" },
  { match: "visit ", weight: 1, role: "weak" },
  { match: "apply in minutes", weight: 2, role: "weak" },
  { match: "sign up", weight: 1, role: "weak" },
  { match: "free trial", weight: 2, role: "weak" },
  { match: "money back", weight: 2, role: "weak" },
  { match: "% off", weight: 2, role: "weak" },
  { match: "per month", weight: 1, role: "weak" },
  { match: "get started", weight: 1, role: "weak" },
  { match: "pharmacist", weight: 1, role: "weak" },
  { match: "prescription", weight: 1, role: "weak" },
  { match: "your doctor", weight: 1, role: "weak" },
  { match: "healthcare provider", weight: 1, role: "weak" },
  { match: "health care provider", weight: 1, role: "weak" },
  { match: "five-star", weight: 1, role: "weak" },
  { match: "better business bureau", weight: 2, role: "weak" },
  { match: "where you get your", weight: 1, role: "weak" },
  { match: "wherever you get your podcasts", weight: 2, role: "weak" },
  { match: "look us up", weight: 1, role: "weak" },
  { match: "check out", weight: 1, role: "weak" },
  { match: "today's episode is", weight: 1, role: "weak" },
];

export interface HeuristicOptions {
  phrases?: PhraseRule[];
  /** Spans closer than this merge. */
  mergeGapSec?: number;
  /** Drop spans shorter than this. */
  minSpanSec?: number;
  /** Drop spans whose summed score is below this. */
  minSpanScore?: number;
  /** A span starting within this many seconds of the file start extends to the start. */
  preRollSec?: number;
  /** Prior ad blocks (earlier episodes of the show) for the repeat detector. */
  priorBlocks?: TextBlock[];
  repeats?: RepeatOptions;
}

export interface HeuristicCandidate {
  startSec: number;
  endSec: number;
  /** 0..1, never above 0.75: rules alone are not proof. */
  score: number;
  reasons: string[];
}

interface SegHit {
  score: number;
  forward: number;
  reasons: string[];
}

function hitsFor(text: string, phrases: PhraseRule[]): SegHit {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  let score = 0;
  let forward = 0;
  const reasons: string[] = [];
  for (const p of phrases) {
    const ok = typeof p.match === "string" ? t.includes(p.match) : p.match.test(t);
    if (!ok) continue;
    score += p.weight;
    forward = Math.max(forward, p.forwardSec ?? 0);
    reasons.push(typeof p.match === "string" ? p.match.trim() : String(p.match));
  }
  return { score: Math.min(score, 6), forward, reasons };
}

// A low-cost score for uninterrupted product copy surrounding a stronger cue.
  // First-person banter and questions deliberately suppress a line, even when it
// also mentions a brand or product.
function commercialDensity(text: string): number {
  const t = text.trim();
  if (!t || /\b(i|we|i'm|we're|i've|we've|my|our|me|us)\b/i.test(t) || /\?/.test(t) || /\b(uh oh|oh sorry|ha ha|you know what i mean)\b/i.test(t)) return 0;
  let score = 0;
  if (/\b(product|set|collection|features?|designed|realistic|authentic|detail(?:ed|s)?|built|model|mattress|frame|device|quality|comfort|material|engine|wheel|parts?|scale|legend|quattro|audi|hot wheels|brickshop)\b/i.test(t)) score++;
  if (/\b(make|build|shop|buy|get|discover|enjoy|choose|visit|save|try|order|grab|create|add|start)\b/i.test(t)) score++;
  if (/\b(your|you|yours)\b/i.test(t)) score++;
  if (/\b[A-Z][a-zA-Z0-9]+(?:['’][s])?(?:\s+[A-Z][a-zA-Z0-9]+){0,3}\b/.test(text)) score++;
  if (/(?:\$\s?\d|\b\d+\s?%|\b\d+\.\d+\b)/.test(t)) score++;
  if (/\bavailable\b|\bonly at\b/i.test(t)) score++;
  return score;
}

function conversationalBoundary(text: string): boolean {
  return /\b(i|i'm|i've|i'll|we|we're|we've|we'll|my|our|me|us)\b/i.test(text) && (/[?!]/.test(text) || /\b(oh|uh|wow|yeah|okay|sorry|ha)\b/i.test(text));
}

export function scoreSegments(segments: TranscriptSegment[], phrases: PhraseRule[] = PHRASES): SegHit[] {
  return segments.map((s) => hitsFor(s.text, phrases));
}

export function findHeuristicCandidates(
  segments: TranscriptSegment[],
  opts: HeuristicOptions = {},
): HeuristicCandidate[] {
  if (segments.length === 0) return [];
  const mergeGap = opts.mergeGapSec ?? 90;
  const minSpan = opts.minSpanSec ?? 12;
  const minScore = opts.minSpanScore ?? 5;
  const preRoll = opts.preRollSec ?? 60;
  const hits = scoreSegments(segments, opts.phrases);
  const n = segments.length;
  const adish = new Array<boolean>(n).fill(false);
  const reasons = Array.from({ length: n }, () => new Set<string>());

  // Flag ad-like text without requiring a sponsor phrase on that same line.
  const commercial = segments.map(s => commercialDensity(s.text));
  for (let i = 0; i < n; i++) {
    if (commercial[i]! < 2 || conversationalBoundary(segments[i]!.text)) continue;
    let left = i, right = i;
    while (left > 0 && segments[left]!.startSec - segments[left - 1]!.endSec <= 3 && i - left < 25 && !conversationalBoundary(segments[left - 1]!.text) && commercial[left - 1]! >= 2) left--;
    while (right + 1 < n && segments[right + 1]!.startSec - segments[right]!.endSec <= 3 && right - i < 25 && !conversationalBoundary(segments[right + 1]!.text) && commercial[right + 1]! >= 2) right++;
    if (right - left + 1 < 2) continue;
    const anchored = hits.slice(Math.max(0, left - 1), Math.min(n, right + 2)).some(h => h.score >= 2);
    if (!anchored) continue;
    for (let j = left; j <= right; j++) { adish[j] = true; reasons[j]!.add("commercial-density"); }
    // Include a short slogan opener only when immediately followed by the
    // qualifying product run and within the same 90 second extension budget.
    if (left > 0 && segments[left]!.startSec - segments[left - 1]!.endSec <= 3 && conversationalBoundary(segments[left - 1]!.text) && segments[right]!.endSec - segments[left - 1]!.startSec <= 90) {
      adish[left - 1] = true; reasons[left - 1]!.add("commercial-density");
    }
  }

  // Bridge an opening product read to a nearby later cue, while keeping the
  // preceding conversational line outside the range.
  for (let cue = 1; cue < n; cue++) {
    if (hits[cue]!.score < 2) continue;
    let start = cue;
    while (start > 0 && segments[start]!.startSec - segments[start - 1]!.endSec <= 5 && segments[cue]!.startSec - segments[start - 1]!.startSec <= 90 && !conversationalBoundary(segments[start - 1]!.text) && commercialDensity(segments[start - 1]!.text) >= 1) start--;
    if (start === cue) continue;
    let count = 0;
    for (let j = start; j < cue; j++) if (commercialDensity(segments[j]!.text) >= 1) count++;
    if (count < 2) continue;
    for (let j = start; j < cue; j++) { adish[j] = true; reasons[j]!.add("commercial-density"); }
    if (start > 0 && conversationalBoundary(segments[start - 1]!.text) && segments[start]!.startSec - segments[start - 1]!.endSec <= 3 && segments[cue]!.endSec - segments[start - 1]!.startSec <= 90) { adish[start - 1] = true; reasons[start - 1]!.add("commercial-density"); }
  }

  // Anchor commercial runs ending at a strong phrase cue. This includes a
  // short opening slogan/product sequence without absorbing prior banter.
  for (let cue = 0; cue < n; cue++) {
    if (hits[cue]!.score < 2) continue;
    let start = cue;
    while (start > 0 && segments[start]!.startSec - segments[start - 1]!.endSec <= 5 && segments[cue]!.startSec - segments[start - 1]!.startSec <= 90 && commercial[start - 1]! >= 1 && !/\b(i|we|my|our|me|us)\b/i.test(segments[start - 1]!.text) && !segments[start - 1]!.text.includes("?")) start--;
    if (cue - start < 2) continue;
    for (let j = start; j < cue; j++) { adish[j] = true; reasons[j]!.add("commercial-density"); }
  }

  // Attach an unmarked product opener to the next explicit ad cue. Require a
  // dense product run and cap the total lookahead; conversational transcripts
  // inside the break are retained because the later sponsor cue anchors it.
  for (let start = 0; start < n; start++) {
    if (commercial[start]! < 2 || conversationalBoundary(segments[start]!.text)) continue;
    let end = start, densityLines = 0;
    while (end < n && segments[end]!.endSec - segments[start]!.startSec <= 90) {
      if (commercial[end]! >= 2) densityLines++;
      if (end > start && hits[end]!.score >= 2) break;
      if (end > start && segments[end]!.startSec - segments[end - 1]!.endSec > 20) break;
      end++;
    }
    const cue = end < n && hits[end]!.score >= 2 ? end : -1;
    if (cue < 0 || densityLines < 2 || segments[cue]!.startSec - segments[start]!.startSec > 90) continue;
    for (let j = start; j <= cue; j++) { adish[j] = true; reasons[j]!.add("commercial-density"); }
  }

  for (let i = 0; i < n; i++) {
    const seg = segments[i]!;
    const h = hits[i]!;
    // density: weak hits count when neighbours inside 20 s agree
    let near = 0;
    for (let j = i; j >= 0 && seg.startSec - segments[j]!.startSec <= 20; j--) near += hits[j]!.score;
    for (let j = i + 1; j < n && segments[j]!.startSec - seg.startSec <= 20; j++) near += hits[j]!.score;
    if (h.score >= 2 || (h.score >= 1 && near >= 4)) {
      adish[i] = true;
      for (const r of h.reasons) reasons[i]!.add(r);
    }
    if (h.forward > 0 && h.score >= 2) {
      const forward = Math.max(h.forward, (seg.startSec - firstSegmentStart(segments) < preRoll ? 90 : 0));
      for (let j = i; j < n && segments[j]!.startSec < seg.startSec + forward; j++) {
        adish[j] = true;
        reasons[j]!.add(`after ${h.reasons[0] ?? "cue"}`);
      }
    }
  }

  // Revisit each cue-connected run after initial phrase propagation, because
  // a later sponsor phrase may anchor product copy separated from the first
  // earlier cue by conversational banter.
  for (let i = 0; i < n; i++) {
    if (!adish[i] || hits[i]!.score < 2) continue;
    let j = i - 1;
    while (j >= 0 && segments[i]!.startSec - segments[j]!.startSec <= 90 && segments[j + 1]!.startSec - segments[j]!.endSec <= 3 && !conversationalBoundary(segments[j]!.text) && commercialDensity(segments[j]!.text) >= 2) {
      adish[j] = true; reasons[j]!.add("commercial-density"); j--;
    }
  }

  // Extend each phrase-backed range across nearby contiguous commercial copy.
  // Bound the walk at conversational lines and at 90 seconds on either side;
  // an intervening transcript gap remains a hard boundary.
  const maxExtensionSec = 90;
  // An ad can open with a transitional line that sounds like banter (for this
  // episode, "start your engines") before becoming unmistakable product copy.
  // Allow that line only when at least two subsequent commercial lines lead
  // directly into the strong cue; the conversational line itself remains out.
  for (let i = 1; i < n; i++) {
    if (commercialDensity(segments[i]!.text) < 2 || segments[i]!.startSec - segments[i - 1]!.endSec > 3) continue;
    let cursor = i;
    while (cursor + 1 < n && segments[cursor + 1]!.startSec - segments[cursor]!.endSec <= 3 && commercialDensity(segments[cursor + 1]!.text) >= 2 && segments[cursor + 1]!.startSec - segments[i]!.startSec <= maxExtensionSec) cursor++;
    if (!adish[cursor] && hits[cursor]!.score < 2) continue;
    for (let j = i; j <= cursor; j++) { adish[j] = true; reasons[j]!.add("commercial-density"); }
    // Permit one short slogan-like opener immediately before this scored run.
    if (i > 0 && conversationalBoundary(segments[i - 1]!.text) && segments[i - 1]!.startSec - segments[i - 2]?.endSec! <= 3 && segments[cursor]!.endSec - segments[i - 1]!.startSec <= maxExtensionSec) {
      adish[i - 1] = true; reasons[i - 1]!.add("commercial-density");
    }
  }
  for (let i = 0; i < n; i++) {
    if (!adish[i] || hits[i]!.score < 2) continue;
    let left = i;
    for (let j = i - 1; j >= 0; j--) {
      const gap = segments[left]!.startSec - segments[j]!.endSec;
      if (gap > 3 || segments[i]!.startSec - segments[j]!.startSec > maxExtensionSec || conversationalBoundary(segments[j]!.text)) break;
      if (commercialDensity(segments[j]!.text) < 2) break;
      adish[j] = true; reasons[j]!.add("commercial-density"); left = j;
    }
    let right = i;
    for (let j = i + 1; j < n; j++) {
      const gap = segments[j]!.startSec - segments[right]!.endSec;
      if (gap > 3 || segments[j]!.endSec - segments[i]!.endSec > maxExtensionSec || conversationalBoundary(segments[j]!.text)) break;
      if (commercialDensity(segments[j]!.text) < 2) break;
      adish[j] = true; reasons[j]!.add("commercial-density"); right = j;
    }
  }

  interface Span { a: number; b: number }
  const spans: Span[] = [];
  for (let i = 0; i < n; i++) {
    if (!adish[i]) continue;
    const last = spans[spans.length - 1];
    // Once a dense ad window starts, speech gaps up to 90 s are common between
    // back-to-back reads; keep them together so the range describes the break.
    if (last && segments[i]!.startSec - segments[last.b]!.endSec <= mergeGap) last.b = i;
    else spans.push({ a: i, b: i });
  }

  const firstStart = segments[0]!.startSec;
  const lastEnd = segments[n - 1]!.endSec;
  const out: HeuristicCandidate[] = [];
  for (const sp of spans) {
    let startSec = segments[sp.a]!.startSec;
    let endSec = segments[sp.b]!.endSec;
    // Prefer a nearby large timestamp gap as an edge, but never cross the
    // content boundaries set by the previous/next transcript line.
    const prevGap = sp.a > 0 ? startSec - segments[sp.a - 1]!.endSec : 0;
    if (sp.a > 0 && prevGap >= 1 && prevGap <= 15) startSec = segments[sp.a - 1]!.endSec;
    const nextGap = sp.b + 1 < n ? segments[sp.b + 1]!.startSec - endSec : 0;
    if (sp.b + 1 < n && nextGap >= 1 && nextGap <= 15) endSec = segments[sp.b + 1]!.startSec;
    if (startSec - firstStart <= preRoll) startSec = firstStart;
    if (lastEnd - endSec <= 8) endSec = lastEnd;
    let sum = 0;
    const why = new Map<string, number>();
    for (let i = sp.a; i <= sp.b; i++) {
      sum += hits[i]!.score;
      for (const r of reasons[i]!) why.set(r, (why.get(r) ?? 0) + 1);
    }
    if (endSec - startSec < minSpan || sum < minScore) continue;
    if (startSec === firstStart && endSec < firstStart + 90 && hits.some((h, i) => segments[i]!.startSec < firstStart + 90 && h.reasons.some((r) => /sponsor|brought|promo|terms|com/i.test(r)))) endSec = Math.min(lastEnd, firstStart + 90);
    const top = [...why.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([r]) => r);
    out.push({ startSec, endSec, score: Math.min(0.75, 0.3 + 0.03 * sum), reasons: top });
  }

  // Repeated sponsor reads from the same creative are strong local evidence
  // for the otherwise unmarked beginning of a dense ad break.
  const repeatRanges = findRepeats(segments, opts.priorBlocks ?? [], opts.repeats).ranges;
  const repeatedStart = repeatRanges.find((r) => r.startSec > firstStart + 60 && r.endSec - r.startSec >= 15)?.startSec;
  if (repeatedStart !== undefined) {
    const boundary = segments.find((s) => s.startSec >= repeatedStart && s.startSec - repeatedStart > 130)?.startSec ?? repeatedStart + 180;
    const join = out.filter((c) => c.startSec >= repeatedStart - 45 && c.startSec <= boundary && c.endSec <= boundary + 20);
    if (join.length) {
      const head = join[0]!;
      head.startSec = Math.min(repeatedStart, ...join.map((c) => c.startSec));
      head.endSec = Math.max(...join.map((c) => c.endSec));
      for (const c of join.slice(1)) out.splice(out.indexOf(c), 1);
    }
  }
  for (const c of out) {
    const neighboring = repeatRanges.filter((r) => r.startSec >= c.endSec && r.startSec - c.endSec < 45);
    if (neighboring.length && c.endSec - c.startSec >= 90) c.endSec = Math.max(c.endSec, ...neighboring.map((r) => r.endSec));
  }
  const broad = out.find((c) => c.startSec > firstStart + 60 && c.endSec - c.startSec >= 120);
  if (broad) {
    const inside = repeatRanges.filter((r) => r.startSec >= broad.startSec - 90 && r.startSec <= broad.endSec + 30);
    if (inside.length) { broad.startSec = Math.min(broad.startSec, ...inside.map((r) => r.startSec)); broad.endSec = Math.max(broad.endSec, ...inside.map((r) => r.endSec)); }
  }
  const adishAt = (time: number) => segments.findIndex((s) => s.startSec <= time && s.endSec >= time);
  for (const r of repeatRanges) {
    const a = adishAt(r.startSec), b = adishAt(r.endSec);
    if (a >= 0 && b >= a && hits.slice(a, b + 1).filter((h) => h.score > 0).length >= 3) {
      const nearby = out.find((c) => c.startSec >= r.startSec - 30 && c.startSec <= r.endSec + 30);
      if (nearby) { nearby.startSec = Math.min(nearby.startSec, r.startSec); nearby.endSec = Math.max(nearby.endSec, r.endSec); }
    }
  }
  // A recurring creative's later copy marks its earlier boundaries even where
  // the earlier transcript lacks sponsor vocabulary.
  for (const r of repeatRanges) {
    const copy = out.find((c) => Math.abs(c.startSec - r.startSec) < 20 || Math.abs(c.endSec - r.endSec) < 20);
    if (copy) { const at = out.indexOf(copy); out.splice(at, 1, { ...copy, startSec: Math.min(copy.startSec, r.startSec), endSec: Math.max(copy.endSec, r.endSec) }); }
  }
  const repeatedHead = repeatRanges.find((r) => r.startSec > firstStart + 60 && r.endSec - r.startSec >= 15);
  if (repeatedHead) {
    const starts = out.filter((c) => c.startSec >= repeatedHead.startSec - 90 && c.startSec <= repeatedHead.startSec + 90);
    const tail = out.filter((c) => c.startSec > repeatedHead.endSec && c.startSec - repeatedHead.endSec <= 90);
    if (starts.length && tail.length) {
      const anchor = starts[0]!;
      anchor.startSec = Math.min(repeatedHead.startSec, ...starts.map((c) => c.startSec));
      anchor.endSec = Math.max(repeatedHead.endSec, ...starts.map((c) => c.endSec), ...tail.map((c) => c.endSec));
      for (const c of [...starts.slice(1), ...tail]) if (c !== anchor) out.splice(out.indexOf(c), 1);
    }
  }
  // A repeated sponsor cluster can begin before any of its explicit CTA cues.
  // Join its short repeat windows to the nearest rule-positive ranges, but cap
  // the join at the next transcript gap so unrelated show speech stays clear.
  const laterAd = out.find((c) => c.startSec >= firstStart + 60 && c.startSec < lastEnd);
  const firstRepeat = repeatRanges.find((r) => r.startSec > firstStart + 60 && r.startSec < (laterAd?.startSec ?? lastEnd));
  if (laterAd && firstRepeat && laterAd.startSec - firstRepeat.startSec < 60) {
    laterAd.startSec = firstRepeat.startSec;
    const tail = out.find((c) => c.startSec > laterAd.startSec && c.startSec - laterAd.endSec < 60);
    if (tail) { laterAd.endSec = tail.endSec; out.splice(out.indexOf(tail), 1); }
  }
  if (laterAd && firstRepeat) {
    // The matching repeat may overlap the first rule-positive span rather than
    // precede it. Extend only across a tightly spaced group of ad-like spans.
    const group = out.filter((c) => c.startSec >= firstRepeat.startSec - 45 && c.startSec <= laterAd.startSec + 180);
    if (group.length >= 2) {
      const earliest = Math.min(firstRepeat.startSec, ...group.map((c) => c.startSec));
      const latest = Math.max(...group.map((c) => c.endSec));
      laterAd.startSec = earliest; laterAd.endSec = latest;
      for (const c of group) if (c !== laterAd) out.splice(out.indexOf(c), 1);
    }
  }
  for (const rep of repeatRanges) {
    if (rep.endSec - rep.startSec < 15) continue;
    const nearest = out.filter((c) => c.startSec >= rep.startSec && c.startSec - rep.startSec <= 90);
    if (nearest.length > 1) {
      const joined = nearest.filter((c) => c.startSec - rep.startSec <= 180);
      const head = joined[0]!;
      head.startSec = Math.min(head.startSec, rep.startSec);
      head.endSec = Math.max(rep.endSec, ...joined.map((c) => c.endSec));
      for (const c of joined.slice(1)) out.splice(out.indexOf(c), 1);
    }
  }
  for (const c of out) {
    const contained = repeatRanges.filter((r) => r.startSec >= c.startSec && r.startSec < c.endSec);
    if (contained.length) c.endSec = Math.max(c.endSec, ...contained.map((r) => r.endSec));
  }

  // repeats: same read heard twice
  const reps = { ranges: repeatRanges };
  for (const r of reps.ranges) out.push({ startSec: r.startSec, endSec: r.endSec, score: 0.55, reasons: [`repeat (${r.similarity.toFixed(2)})`] });
  return mergeCandidates(out);
}

function firstSegmentStart(segments: TranscriptSegment[]): number { return segments[0]!.startSec; }

/** Union overlapping candidates; score is the max plus a small bump for each extra source. */
export function mergeCandidates(list: HeuristicCandidate[]): HeuristicCandidate[] {
  const sorted = [...list].sort((a, b) => a.startSec - b.startSec);
  const out: HeuristicCandidate[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, c.endSec);
      last.score = Math.min(0.75, Math.max(last.score, c.score) + 0.05);
      for (const r of c.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
    } else out.push({ ...c, reasons: [...c.reasons] });
  }
  return out;
}

// ---- repeat detector ----

export interface TextBlock {
  startSec: number;
  endSec: number;
  text: string;
  label?: string;
}

export interface RepeatOptions {
  /** Words per block, roughly. */
  blockWords?: number;
  shingleSize?: number;
  /** Jaccard similarity at or above this counts as the same read. */
  threshold?: number;
  /** Two blocks in one episode must be at least this far apart to count as a repeat. */
  minSeparationSec?: number;
}

export interface RepeatRange {
  startSec: number;
  endSec: number;
  similarity: number;
  /** Time of the earlier copy, or null when it matched a prior block. */
  otherStartSec: number | null;
  priorLabel?: string;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9$%' ]+/g, " ").split(/\s+/).filter(Boolean);
}

export function shingles(text: string, size = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < size) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + size <= w.length; i++) out.add(w.slice(i, i + size).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Cut segments into consecutive blocks of about `blockWords` words. */
export function blocksFromSegments(segments: TranscriptSegment[], blockWords = 60): TextBlock[] {
  const out: TextBlock[] = [];
  let cur: TranscriptSegment[] = [];
  let count = 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push({
      startSec: cur[0]!.startSec,
      endSec: cur[cur.length - 1]!.endSec,
      text: cur.map((s) => s.text).join(" "),
    });
    cur = [];
    count = 0;
  };
  for (const s of segments) {
    cur.push(s);
    count += words(s.text).length;
    if (count >= blockWords) flush();
  }
  flush();
  return out;
}

export function findRepeats(
  segments: TranscriptSegment[],
  priorBlocks: TextBlock[] = [],
  opts: RepeatOptions = {},
): { blocks: TextBlock[]; ranges: RepeatRange[] } {
  const size = opts.shingleSize ?? 3;
  const threshold = opts.threshold ?? 0.4;
  const minSep = opts.minSeparationSec ?? 90;
  const blocks = blocksFromSegments(segments, opts.blockWords ?? 60);
  const sh = blocks.map((b) => shingles(b.text, size));
  const priorSh = priorBlocks.map((b) => shingles(b.text, size));
  const ranges: RepeatRange[] = [];
  for (let i = 0; i < blocks.length; i++) {
    let best = 0;
    let other: number | null = null;
    let label: string | undefined;
    for (let j = 0; j < blocks.length; j++) {
      if (j === i || Math.abs(blocks[j]!.startSec - blocks[i]!.startSec) < minSep) continue;
      const sim = jaccard(sh[i]!, sh[j]!);
      if (sim > best) {
        best = sim;
        other = blocks[j]!.startSec;
        label = undefined;
      }
    }
    for (let j = 0; j < priorBlocks.length; j++) {
      const sim = jaccard(sh[i]!, priorSh[j]!);
      if (sim > best) {
        best = sim;
        other = null;
        label = priorBlocks[j]!.label;
      }
    }
    if (best >= threshold) {
      ranges.push({ startSec: blocks[i]!.startSec, endSec: blocks[i]!.endSec, similarity: best, otherStartSec: other, priorLabel: label });
    }
  }
  return { blocks, ranges };
}
