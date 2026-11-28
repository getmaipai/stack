/** Lowercase text and retain Unicode letters and digits as words. */
export function normalizeText(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** Word-level Levenshtein distance divided by the reference word count. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeText(reference).split(" ").filter(Boolean);
  const hyp = normalizeText(hypothesis).split(" ").filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  let previous = Array.from({ length: hyp.length + 1 }, (_, i) => i);
  for (let i = 1; i <= ref.length; i++) {
    const current = [i];
    for (let j = 1; j <= hyp.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[hyp.length]! / ref.length;
}
