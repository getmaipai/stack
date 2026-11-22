// Small shared pieces for every screen: an icon chip, a thin meter, a sparkline and a live stat tile.
// They only compose kit primitives and tokens; there is no library of their own.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { LucideIcon } from "lucide-react";

export type Tone = "primary" | "ok" | "warn" | "bad" | "muted";
const TONE_VAR: Record<Tone, string> = { primary: "var(--primary)", ok: "var(--status-ok)", warn: "var(--status-warning)", bad: "var(--status-error)", muted: "var(--muted-foreground)" };

/** A rounded square holding an icon, tinted by tone. */
export function IconChip({ Icon, tone = "primary", size = "md" }: { Icon: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "size-12 rounded-2xl" : size === "sm" ? "size-8 rounded-lg" : "size-10 rounded-xl";
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center ${box}`} style={{ background: `color-mix(in oklab, ${TONE_VAR[tone]} 16%, transparent)`, color: TONE_VAR[tone] }}>
      <Icon className={size === "lg" ? "size-6" : size === "sm" ? "size-4" : "size-5"} />
    </span>
  );
}

export function Meter({ value, tone = "primary", label }: { value: number; tone?: Tone; label: string }) {
  const p = Math.max(0, Math.min(1, value));
  return <div className="meter" role="progressbar" aria-label={label} aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${p > 0 ? Math.max(1.5, p * 100) : 0}%`, "--meter-c": TONE_VAR[tone] } as React.CSSProperties} /></div>;
}

/** A tiny area chart with no axes: the shape of the last few minutes. */
export function Sparkline({ data, tone = "primary", max, height = 40 }: { data: number[]; tone?: Tone; max?: number; height?: number }) {
  if (data.length < 2) return <div style={{ height }} className="rounded-md bg-[var(--fill-1)]" aria-hidden="true" />;
  const rows = data.map((v, i) => ({ i, v }));
  const id = `sp-${tone}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={TONE_VAR[tone]} stopOpacity={0.45} /><stop offset="100%" stopColor={TONE_VAR[tone]} stopOpacity={0} /></linearGradient></defs>
        <YAxis hide domain={[0, max ?? "auto"]} />
        <Area dataKey="v" type="monotone" stroke={TONE_VAR[tone]} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={false} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** The text flashes softly each time it changes, so a live number is seen to move. */
export function Live({ children }: { children: string }) {
  const [flash, setFlash] = useState(0);
  const prev = useRef(children);
  useEffect(() => { if (prev.current !== children) { prev.current = children; setFlash((n) => n + 1); } }, [children]);
  return <span key={flash} className={flash ? "live-flash" : undefined}>{children}</span>;
}

/** A live number with its label, a short line, and optionally a sparkline. */
export function StatTile({ Icon, label, value, hint, series, tone = "primary", max, meter }: { Icon: LucideIcon; label: string; value: string; hint?: ReactNode; series?: number[]; tone?: Tone; max?: number; meter?: number }) {
  return (
    <div className="glass flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <IconChip Icon={Icon} tone={tone} size="sm" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-3xl font-semibold tracking-tight tabular-nums"><Live>{value}</Live></p>
      {series ? <Sparkline data={series} tone={tone} max={max} /> : meter !== undefined ? <Meter value={meter} tone={tone} label={label} /> : null}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
