export interface ClipSeries { luma: number[]; diff: number[]; sharpness: number[]; flow?: Array<{ at_s: number; dx: number; dy: number; zoom: number }>; }

function flowPair(a: Uint8Array, b: Uint8Array, w: number, h: number): { dx: number; dy: number; zoom: number } {
  const step = Math.max(1, Math.floor(Math.min(w, h) / 24));
  const points: Array<[number, number]> = [];
  for (let y = 3; y < h - 3; y += step) for (let x = 3; x < w - 3; x += step) points.push([x, y]);
  let sx = 0; let sy = 0; let n = 0; const vectors: Array<[number, number, number, number]> = [];
  for (const [x, y] of points) {
    let best = Infinity; let bx = 0; let by = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      let score = 0; let samples = 0;
      for (let py = -2; py <= 2; py += 2) for (let px = -2; px <= 2; px += 2) { score += Math.abs(a[(y + py) * w + x + px]! - b[(y + dy + py) * w + x + dx + px]!); samples++; }
      score /= samples;
      if (score < best) { best = score; bx = dx; by = dy; }
    }
    if (best < 55) { sx += bx; sy += by; n++; vectors.push([x, y, bx, by]); }
  }
  const dx = n ? sx / n : 0; const dy = n ? sy / n : 0;
  const cx = w / 2; const cy = h / 2;
  const radial = vectors.reduce((sum, [x, y, vx, vy]) => sum + ((x - cx) * (vx - dx) + (y - cy) * (vy - dy)) / Math.max(1, (x - cx) ** 2 + (y - cy) ** 2), 0);
  return { dx, dy, zoom: vectors.length ? radial / vectors.length : 0 };
}

export function seriesFromFrames(frames: Uint8Array[], w: number, h: number, flow = false, fps = 12): ClipSeries {
  const luma: number[] = []; const diff: number[] = []; const sharpness: number[] = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi]!; let sum = 0; let delta = 0; let mean = 0; let sq = 0; let lapSum = 0; let lapSq = 0;
    for (let i = 0; i < frame.length; i++) { const value = frame[i]!; sum += value; if (fi) delta += Math.abs(value - frames[fi - 1]![i]!); }
    mean = sum / frame.length;
    for (let i = 0; i < frame.length; i++) sq += (frame[i]! - mean) ** 2;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; const lap = frame[i - w]! + frame[i - 1]! + frame[i + 1]! + frame[i + w]! - 4 * frame[i]!;
      lapSum += lap; lapSq += lap * lap;
    }
    const count = Math.max(1, (w - 2) * (h - 2)); const lapMean = lapSum / count;
    luma.push(sum / frame.length); diff.push(fi ? delta / frame.length : 0); sharpness.push(lapSq / count - lapMean * lapMean);
    void sq;
  }
  const result: ClipSeries = { luma, diff, sharpness };
  if (flow) result.flow = frames.map((_, i) => i > 0 && i % 2 === 1 ? flowPair(frames[i - 1]!, frames[i]!, w, h) : null).filter((value): value is { dx: number; dy: number; zoom: number } => value !== null).map((value, i) => ({ at_s: (i * 2 + 1) / fps, ...value }));
  return result;
}
