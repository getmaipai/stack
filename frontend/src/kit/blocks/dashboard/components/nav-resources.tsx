import { useSidebar } from "@/kit/ui/sidebar";

function formatMemory(bytes: number): string { return `${(bytes / 1_073_741_824).toFixed(1)} GB`; }

export function NavResources({ capBytes, freeMemoryBytes, freeDiskBytes, pressure, runState }: { capBytes?: number; freeMemoryBytes?: number; freeDiskBytes?: number; pressure?: string; runState?: string }) {
  const { state } = useSidebar();
  const cap = capBytes ?? 0;
  const used = Math.max(0, cap - (freeMemoryBytes ?? 0));
  const percent = cap > 0 ? Math.min(100, used / cap * 100) : 0;
  if (state === "collapsed") return <div className="flex justify-center p-3" title={`${formatMemory(used)} of ${formatMemory(cap)} used`}><span className="relative flex size-8 items-center justify-center rounded-full border-4 border-muted text-[9px]">{Math.round(percent)}%</span></div>;
  return <div className="space-y-3 border-t border-sidebar-border p-3 text-xs text-sidebar-foreground/70"><div><div className="flex justify-between gap-2"><span>Memory</span><span>{formatMemory(used)} of {formatMemory(cap)} used</span></div><div className="mt-1 h-1.5 rounded-full bg-sidebar-accent"><div className="h-full rounded-full bg-sidebar-primary" style={{ width: `${percent}%` }} /></div></div><div className="flex justify-between gap-2"><span>Disk</span><span>{freeDiskBytes == null ? "Loading" : `${Math.round(freeDiskBytes / 1_073_741_824)} GB free`}</span></div>{(runState === "paused" || pressure === "warn" || pressure === "critical") && <p className="text-amber-600">{runState === "paused" ? "Stack paused" : `Memory pressure: ${pressure}`}</p>}</div>;
}
