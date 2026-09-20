import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { getIcon, type IconName } from "@/kit/icons";
import { cn } from "@/kit/utils";

export interface MetricCardProps {
  icon: IconName;
  hue: string;
  count: number | string;
  label: string;
  state?: ReactNode;
  stateHref?: string;
  className?: string;
}

// Top metric cards (spec section 3): outlined neon icon tile, bold
// count in tabular figures, descriptive label, a state line or link.
export function MetricCard({ icon, hue, count, label, state, stateHref, className }: MetricCardProps) {
  const Icon = getIcon(icon);
  const stateLine = state && (stateHref ? <Link to={stateHref} className="text-sm hover:underline" style={{ color: `var(${hue})` }}>{state}</Link> : <span className="text-sm text-muted-foreground">{state}</span>);
  return (
    <div className={cn("rounded-2xl border bg-[var(--surface-card)] p-4", className)}>
      <div className="flex items-center gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border" style={{ borderColor: `var(${hue})`, color: `var(${hue})`, backgroundColor: `color-mix(in srgb, var(${hue}) 14%, transparent)` }}>
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-metric font-metric tabular-nums leading-none">{count}</p>
          <p className="mt-1 truncate text-sm text-muted-foreground">{label}</p>
        </div>
      </div>
      {stateLine && <div className="mt-2">{stateLine}</div>}
    </div>
  );
}
