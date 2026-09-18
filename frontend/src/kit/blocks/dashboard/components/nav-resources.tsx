import { useSidebar } from "@/kit/ui/sidebar";
import { formatBytes } from "@/pages/overview/SegmentedBar";

function formatMemory(bytes: number): string { const gigabytes = bytes / 1_000_000_000; return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`; }

export function NavResources({ capBytes, totalMemoryBytes, freeMemoryBytes, freeDiskBytes, pressure, runState }: { capBytes?: number; totalMemoryBytes?: number; freeMemoryBytes?: number; freeDiskBytes?: number; pressure?: string; runState?: string }) {
  const { state } = useSidebar();
  const cap = capBytes ?? 0;
  const used = Math.max(0, (totalMemoryBytes ?? cap) - (freeMemoryBytes ?? 0));
  const percent = cap > 0 ? Math.min(100, used / cap * 100) : 0;
  const physical = totalMemoryBytes ?? cap;
  if (state === "collapsed") return <div className="flex justify-center p-3" title={`${formatMemory(used)} of ${formatMemory(physical)} used`}><span className="relative flex size-8 items-center justify-center rounded-full border-4 border-muted text-[9px]">{Math.round(percent)}%</span></div>;
  return <div className="space-y-3 border-t border-sidebar-border p-3 text-xs text-sidebar-foreground/70"><div><div className="flex justify-between gap-2"><span>Memory</span><span>{formatMemory(used)} used of {formatMemory(physical)}{cap > 0 && ` · ${formatMemory(cap)} budget for models`}</span></div><div className="mt-1 h-1.5 rounded-full bg-sidebar-accent"><div className="h-full rounded-full bg-sidebar-primary" style={{ width: `${percent}%` }} /></div></div><div className="flex justify-between gap-2"><span>Disk</span><span>{freeDiskBytes == null ? "Loading" : `${formatBytes(freeDiskBytes)} free`}</span></div>{(runState === "paused" || pressure === "warn" || pressure === "critical") && <p className="text-amber-600">{runState === "paused" ? "Stack paused" : `Memory pressure: ${pressure}`}</p>}</div>;
}
