// The rail's bottom-left five-icon health row. Spec: "Bottom-left system
// pulse reference" (system-pulse.png). Lane A wires this into the rail's
// footer slot in kit/blocks/dashboard/components/app-sidebar.tsx.
import { Link } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import type { BudgetResponse, HardwareResponse, HealthItem } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";

const ActivityIcon = getIcon("Activity");
const CpuIcon = getIcon("Cpu");
const DatabaseIcon = getIcon("Database");
const CircuitBoardIcon = getIcon("CircuitBoard");
const GaugeIcon = getIcon("Gauge");

type Dot = "green" | "amber" | "red" | "muted";
const DOT_CLASS: Record<Dot, string> = { green: "bg-[var(--hue-teal)]", amber: "bg-[var(--hue-orange)]", red: "bg-[var(--hue-red)]", muted: "bg-muted-foreground/50" };

interface StorageResponse { totalBytes: number; freeDiskBytes: number }
interface LiveGpu { name: string; utilization: number | null }
interface LiveResponse { live: { gpus: LiveGpu[] } }
interface NetworkResponse { interface: string | null; linkMbps: number | null; gatewayMs: number | null }

interface Signal { key: string; label: string; icon: typeof ActivityIcon; dot: Dot; tooltip: string; badge?: { count: number; tone: "red" | "blue" }; to: string }

function Pulse({ signal }: { signal: Signal }) {
  const Icon = signal.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link to={signal.to} aria-label={signal.label} className="relative flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
          <Icon className="size-5" />
          <span aria-hidden="true" className={`absolute bottom-1 right-1 size-1.5 rounded-full ${DOT_CLASS[signal.dot]}`} />
          {signal.badge && signal.badge.count > 0 && (
            <Badge className={`absolute -right-1 -top-1 size-4 min-w-4 rounded-full px-1 py-0 text-[10px] ${signal.badge.tone === "blue" ? "bg-[var(--primary)]" : "bg-[var(--hue-red)]"}`}>
              {signal.badge.count}
            </Badge>
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent>{signal.tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function SystemPulse() {
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const storage = useApiResource<StorageResponse>("/stack/v1/storage");
  const live = useApiResource<LiveResponse>("/stack/v1/live");
  const hardware = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const network = useApiResource<NetworkResponse>("/stack/v1/network");

  const healthItems = health.data?.health ?? [];
  const affected = healthItems.filter((item) => item.severity === "error" || item.severity === "critical").length;
  const healthDot: Dot = affected > 0 ? "red" : healthItems.length > 0 ? "amber" : "green";
  const healthTooltip = healthItems.length === 0 ? "Stack health · All good" : `Stack health · ${healthItems.length} component${healthItems.length === 1 ? "" : "s"} need attention`;

  const memoryDot: Dot = !budget.data ? "muted" : budget.data.pressure === "critical" ? "red" : budget.data.pressure === "warn" ? "amber" : "green";
  const memoryTooltip = budget.data ? `Memory · ${Math.round((1 - budget.data.freeMemoryBytes / Math.max(1, budget.data.totalMemoryBytes)) * 100)}% used` : "Memory · Not reported";

  const freeShare = storage.data && storage.data.totalBytes > 0 ? storage.data.freeDiskBytes / storage.data.totalBytes : null;
  const storageDot: Dot = freeShare === null ? "muted" : freeShare < 0.05 ? "red" : freeShare < 0.15 ? "amber" : "green";
  const storageTooltip = freeShare === null ? "Storage · Not reported" : `Storage · ${Math.round(freeShare * 100)}% free`;

  // The live sampler's own count wins whenever it has reported anything;
  // an Apple Silicon machine falls back to its known integrated GPU only
  // while live hasn't reported one yet (fresh boot, or a sampling gap),
  // not just when the request itself hasn't resolved (0 is not nullish,
  // so `??` alone would never reach the fallback once live.data loads).
  const liveGpuCount = live.data?.live.gpus.length ?? 0;
  const gpuCount = liveGpuCount > 0 ? liveGpuCount : hardware.data?.hardware.isAppleSilicon ? 1 : 0;
  const gpuDot: Dot = gpuCount > 0 ? "green" : "muted";
  const gpuTooltip = gpuCount === 0 ? "GPU · Not reported" : gpuCount === 1 ? `GPU · ${live.data?.live.gpus[0]?.name ?? "1 device"}` : `GPU · ${gpuCount} devices`;

  const netData = network.data;
  const networkDot: Dot = !netData || netData.interface === null ? "muted" : netData.gatewayMs === null ? "red" : netData.gatewayMs > 50 ? "amber" : "green";
  const networkTooltip = !netData || netData.interface === null
    ? "Network · Not reported"
    : netData.gatewayMs === null
      ? "Network · Your router is not answering"
      : `Network · ${netData.linkMbps ? `${(netData.linkMbps / 1000).toFixed(1)} Gbps · ` : ""}${netData.gatewayMs} ms`;

  const signals: Signal[] = [
    { key: "health", label: "Stack health", icon: ActivityIcon, dot: healthDot, tooltip: healthTooltip, badge: { count: affected, tone: "red" }, to: "/alerts?severity=error" },
    { key: "memory", label: "Memory", icon: CpuIcon, dot: memoryDot, tooltip: memoryTooltip, to: "/monitoring#memory" },
    { key: "storage", label: "Storage", icon: DatabaseIcon, dot: storageDot, tooltip: storageTooltip, to: "/monitoring#storage" },
    { key: "gpu", label: "GPU", icon: CircuitBoardIcon, dot: gpuDot, tooltip: gpuTooltip, badge: { count: gpuCount, tone: "blue" }, to: "/monitoring#gpu" },
    { key: "network", label: "Network", icon: GaugeIcon, dot: networkDot, tooltip: networkTooltip, to: "/monitoring#network" },
  ];

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between px-1">
        {signals.map((signal) => <Pulse key={signal.key} signal={signal} />)}
      </div>
    </TooltipProvider>
  );
}
