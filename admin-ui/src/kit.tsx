// Small shared pieces for every screen: an icon chip, a thin meter, a sparkline and a live stat tile.
// They only compose kit primitives and tokens; there is no library of their own.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";

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
export function StatTile({ Icon, label, value, hint, series, tone = "primary", max, meter, onOpen }: { Icon: LucideIcon; label: string; value: string; hint?: ReactNode; series?: number[]; tone?: Tone; max?: number; meter?: number; onOpen?: () => void }) {
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": `${label}: ${value}. Show details` } : {})} className={`glass flex flex-col gap-3 p-4 text-start${onOpen ? " glass-lift focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" : ""}`}>
      <div className="flex items-center gap-3">
        <IconChip Icon={Icon} tone={tone} size="sm" />
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <p className="text-3xl font-semibold tracking-tight tabular-nums"><Live>{value}</Live></p>
      {series ? <Sparkline data={series} tone={tone} max={max} /> : meter !== undefined ? <Meter value={meter} tone={tone} label={label} /> : null}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </Tag>
  );
}

/** A small rounded label tinted by tone: a status, a kind, a count. Color is never the only signal, the words say it too. */
export function Pill({ tone = "muted", Icon, children, className }: { tone?: Tone; Icon?: LucideIcon; children: ReactNode; className?: string }) {
  return <span className={`pill${className ? ` ${className}` : ""}`} style={{ "--pill-c": TONE_VAR[tone] } as React.CSSProperties}>{Icon && <Icon aria-hidden="true" className="size-3" />}{children}</span>;
}

/** Small uppercase label above a title: where you are, or what a group is. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`eyebrow${className ? ` ${className}` : ""}`}>{children}</p>;
}

/** A section title with an eyebrow, an optional count pill and a line of help. */
export function SectionHeader({ id, eyebrow, title, count, description, action }: { id?: string; eyebrow?: string; title: string; count?: number | string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2 id={id} className="flex items-center gap-2 text-lg font-semibold tracking-tight">{title}{count !== undefined && <Pill>{count}</Pill>}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** The frame of a scannable list: one rounded surface, rows divided by hairlines. */
export function List({ children, label }: { children: ReactNode; label: string }) {
  return <ul className="glass list" aria-label={label}>{children}</ul>;
}

/**
 * One row of a list: an icon chip, a title with pills, one line of detail, and what you can do on the right.
 * With onClick the whole row is one button (no buttons inside it); with actions it is a plain row.
 */
export function ListRow({ Icon, tone = "primary", title, pills, detail, aside, actions, onClick, extra }: {
  Icon: LucideIcon; tone?: Tone; title: ReactNode; pills?: ReactNode; detail?: ReactNode; aside?: ReactNode; actions?: ReactNode; onClick?: () => void; extra?: ReactNode;
}) {
  const body = (
    <>
      <IconChip Icon={Icon} tone={tone} />
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="min-w-0 font-medium leading-snug [overflow-wrap:anywhere]">{title}</span>{pills}</span>
        {detail && <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{detail}</span>}
        {extra}
      </span>
      {aside && <span className="list-aside shrink-0 text-end text-sm tabular-nums text-muted-foreground">{aside}</span>}
      {actions && <span className="list-actions flex shrink-0 flex-wrap items-center gap-2 max-sm:basis-full max-sm:self-start max-sm:ps-[3.25rem]">{actions}</span>}
    </>
  );
  return (
    <li className="list-item">
      {onClick ? <button type="button" onClick={onClick} className="list-row list-row-click">{body}</button> : <div className="list-row">{body}</div>}
    </li>
  );
}

/** Nothing here yet: says what it is and what to do, in plain words. */
export function EmptyState({ Icon, title, text, action, tone = "primary" }: { Icon: LucideIcon; title: string; text: string; action?: ReactNode; tone?: Tone }) {
  return (
    <div className="empty flex flex-col items-center gap-3 px-6 py-10 text-center" role="status">
      <IconChip Icon={Icon} tone={tone} size="lg" />
      <div className="flex max-w-md flex-col gap-1"><p className="font-semibold">{title}</p><p className="text-sm text-muted-foreground">{text}</p></div>
      {action}
    </div>
  );
}

/** Loading rows shaped like the rows that will replace them, so nothing jumps. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="glass list" aria-busy="true" aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="list-item"><div className="list-row"><Skeleton className="size-10 shrink-0 rounded-xl" /><div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-1/3 rounded-full" /><Skeleton className="h-3 w-2/3 rounded-full" /></div></div></div>
      ))}
    </div>
  );
}
