export interface Gauge {
  name: string;
  help: string;
  samples: Array<{ labels?: Record<string, string>; value: number | null }>;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** Render Prometheus text exposition format 0.0.4 gauges in input order. */
export function renderGauges(gauges: Gauge[]): string {
  const lines: string[] = [];
  for (const gauge of gauges) {
    lines.push(`# HELP ${gauge.name} ${gauge.help}`, `# TYPE ${gauge.name} gauge`);
    for (const sample of gauge.samples) {
      if (sample.value === null || !Number.isFinite(sample.value)) continue;
      const labels = sample.labels ? Object.entries(sample.labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",") : "";
      lines.push(`${gauge.name}${labels ? `{${labels}}` : ""} ${sample.value}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}
