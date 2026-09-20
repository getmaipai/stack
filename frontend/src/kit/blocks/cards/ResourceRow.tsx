import { getIcon, type IconName } from "@/kit/icons";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";
import { absoluteTime, formatPercent } from "@/lib/format";
import { Sparkline, type SparklinePoint } from "@/kit/blocks/cards/Sparkline";

export interface ResourceRowProps {
  icon: IconName;
  hue: string;
  label: string;
  percent: number | null;
  series: SparklinePoint[];
  capacityLabel?: string;
  device?: string;
}

// System Resources rows (spec section 3 and 6): icon tile, percentage,
// bar, sparkline, supporting capacity/device label, tooltip with the
// latest sample's timestamp, value and device.
export function ResourceRow({ icon, hue, label, percent, series, capacityLabel, device }: ResourceRowProps) {
  const Icon = getIcon(icon);
  const latest = [...series].reverse().find((point) => point.value !== null);
  const tooltip = latest ? `${absoluteTime(latest.at)} · ${formatPercent(latest.value)}${device ? ` · ${device}` : ""}` : "No samples yet";
  return (
    <div className="flex items-center gap-4 py-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in srgb, var(${hue}) 16%, transparent)`, color: `var(${hue})` }}>
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="w-16 shrink-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-sm tabular-nums text-muted-foreground">{formatPercent(percent)}</p>
      </div>
      <div className="min-w-0 flex-1">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%`, backgroundColor: `var(${hue})` }} />
        </div>
        {capacityLabel && <p className="mt-1 text-xs text-muted-foreground">{capacityLabel}</p>}
      </div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="shrink-0"><Sparkline points={series} hue={hue} /></div>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
