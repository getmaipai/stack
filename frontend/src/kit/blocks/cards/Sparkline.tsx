export interface SparklinePoint { at: string; value: number | null }

// Thin 1.5 px neon sparkline on navy (spec section 6): null samples are
// gaps, not zeros, so a missing reading never reads as "dropped to zero".
export function Sparkline({ points, hue, width = 96, height = 28 }: { points: SparklinePoint[]; hue: string; width?: number; height?: number }) {
  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const segments: Array<{ x: number; y: number }[]> = [];
  let current: { x: number; y: number }[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: index * step, y: height - ((point.value - min) / range) * height });
  });
  if (current.length > 0) segments.push(current);

  if (segments.length === 0) return <p className="text-xs text-muted-foreground" role="img" aria-label="No samples yet">No samples yet</p>;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Recent trend" className="overflow-visible">
      {segments.map((segment, index) =>
        segment.length === 1
          ? <circle key={index} cx={segment[0]!.x} cy={segment[0]!.y} r={1.5} fill={`var(${hue})`} />
          : <polyline key={index} points={segment.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} fill="none" stroke={`var(${hue})`} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}
