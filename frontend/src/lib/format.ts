// Shared formatters (spec: "Implementation reuse standards" > Shared
// functions). Pure string functions; tabular-figure styling is the
// caller's CSS, not this file's job.

const NOT_REPORTED = "Not reported";

function trimmed(value: number, digits: number): string {
  const rounded = Number(value.toFixed(digits));
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(digits);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

function byteMagnitude(bytes: number): { value: number; unit: (typeof BYTE_UNITS)[number] } {
  if (bytes === 0) return { value: 0, unit: "B" };
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  return { value: bytes / 1024 ** exponent, unit: BYTE_UNITS[exponent]! };
}

export function formatBytes(bytes: number | null, digits = 1): string {
  if (bytes === null) return NOT_REPORTED;
  if (bytes === 0) return "0 B";
  const { value, unit } = byteMagnitude(bytes);
  return `${trimmed(value, digits)} ${unit}`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return NOT_REPORTED;
  const clamped = Math.min(100, Math.max(0, value));
  return clamped < 10 ? `${clamped.toFixed(1)}%` : `${Math.round(clamped)}%`;
}

const ONE_DECIMAL_RATE_UNITS = new Set(["Gbps", "Mbps"]);

export function formatRate(value: number | null, unit: "tok/s" | "req/s" | "Gbps" | "Mbps" | "ms"): string {
  if (value === null) return NOT_REPORTED;
  const number = ONE_DECIMAL_RATE_UNITS.has(unit) ? trimmed(value, 1) : String(Math.round(value));
  return `${number} ${unit}`;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return NOT_REPORTED;
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  if (whole < 86400) {
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

export function formatUsedOfTotal(used: number | null, total: number | null): string {
  if (used === null || total === null || total === 0) return NOT_REPORTED;
  const { unit, value: totalValue } = byteMagnitude(total);
  const exponent = BYTE_UNITS.indexOf(unit);
  const usedValue = used / 1024 ** exponent;
  return `${trimmed(usedValue, 1)} / ${trimmed(totalValue, 1)} ${unit}`;
}

export function formatVersion(current: string | null, available: string | null): string {
  if (current === null) return NOT_REPORTED;
  if (available && available !== current) return `v${current} → v${available}`;
  return `v${current}`;
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
