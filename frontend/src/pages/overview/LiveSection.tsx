import { DetailCard } from "@/kit/blocks/phone/DetailCard";
import { ListRow } from "@/kit/blocks/phone/ListRow";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { RelativeTime } from "@/kit/ui/relative-time";
import { formatRelative } from "@/lib/relativeTime";
import type { LiveClient, LiveDrive, LiveGpu, LiveProcess, LiveResponse } from "@/lib/api";
import { formatBytes } from "./SegmentedBar";

function measured(value: number | null, suffix = ""): string { return value === null ? "not measured" : `${Math.round(value)}${suffix}`; }
function memory(used: number | null, total: number | null): string { return used === null || total === null ? "not measured" : `${formatBytes(used)} of ${formatBytes(total)}`; }
function engineName(process: LiveProcess): string { return `${process.engine} ${process.build}`; }

function EngineRows({ processes }: { processes: LiveProcess[] }) {
  if (!processes.length) return <p className="text-sm text-muted-foreground">No engine is running</p>;
  return <div className="divide-y">{processes.map((process) => <div className="grid gap-2 py-3 text-sm sm:grid-cols-[minmax(10rem,1fr)_repeat(5,minmax(0,1fr))]" key={process.pid}><span className="font-medium">{engineName(process)}</span><span>{process.model ?? "No model"}</span><span>Port {process.port ?? "not measured"}</span><span>{process.memoryFootprintBytes === null ? "not measured" : formatBytes(process.memoryFootprintBytes)}</span><span>{measured(process.cpuPercent, "% CPU")}</span><span>Up {process.startedAt ? <RelativeTime at={process.startedAt} /> : "not measured"}</span></div>)}</div>;
}

function GpuCards({ gpus }: { gpus: LiveGpu[] }) {
  return <div className="grid gap-3 sm:grid-cols-2">{gpus.map((gpu) => <Card className="shadow-none" key={gpu.name}><CardHeader className="pb-2"><CardTitle className="text-sm">{gpu.name}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>{memory(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}</p>{gpu.utilization === null ? <p className="text-muted-foreground">not measured</p> : <><div aria-label={`${gpu.name} utilization ${Math.round(gpu.utilization)}%`} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, gpu.utilization))}%` }} /></div><p className="text-xs text-muted-foreground">{Math.round(gpu.utilization)}% utilization</p></>}</CardContent></Card>)}</div>;
}

function DriveRows({ drives }: { drives: LiveDrive[] }) { return <div className="divide-y border-y" data-drive-list>{drives.map((drive) => { const mounted = drive.mounted !== false; const percent = drive.totalBytes > 0 ? Math.min(100, Math.max(0, drive.usedBytes / drive.totalBytes * 100)) : 0; return <div className="py-3 text-sm" key={drive.mount ?? drive.name}><div className="flex flex-wrap justify-between gap-x-5 gap-y-1"><span className="font-medium">{drive.name}</span><span>{mounted ? `${formatBytes(drive.usedBytes)} of ${formatBytes(drive.totalBytes)}` : "not mounted"}</span></div>{mounted && <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>}</div>; })}</div>; }

function ClientRows({ clients }: { clients: LiveClient[] }) {
  if (!clients.length) return <p className="text-sm text-muted-foreground">No client in the last five minutes</p>;
  return <div className="divide-y">{clients.map((client) => <div className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(9rem,1fr)_repeat(3,minmax(0,1fr))]" key={client.name}><span className="font-medium">{client.name}</span><span>{client.roles.join(", ") || "No roles"}</span><span>{client.requestCount} requests</span><span><RelativeTime at={client.lastRequestAt} /></span></div>)}</div>;
}

export function LiveSection({ live }: { live?: LiveResponse }) {
  const sample = live?.live; const processes = sample?.processes ?? []; const gpus = sample?.gpus ?? []; const drives = sample?.drives ?? [];
  return <section className="space-y-3" data-live-section><div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Live</h2>{sample && <span className="text-xs text-muted-foreground">Updated <RelativeTime at={sample.at} /></span>}</div><Card data-widget><CardHeader className="pb-2"><CardTitle className="text-base">Engines</CardTitle></CardHeader><CardContent><EngineRows processes={processes} /></CardContent></Card>{gpus.length > 0 && <GpuCards gpus={gpus} />}{sample && <div className="space-y-3"><div className="flex flex-wrap gap-x-5 gap-y-1 border-y py-3 text-sm"><span>CPU {measured(sample.cpu.percent, "%")}</span></div>{drives.length > 0 && <DriveRows drives={drives} />}</div>}<Card data-widget><CardHeader className="pb-2"><CardTitle className="text-base">Connected now</CardTitle></CardHeader><CardContent><ClientRows clients={sample?.clients ?? []} /></CardContent></Card></section>;
}

export function PhoneLiveSection({ live }: { live?: LiveResponse }) {
  const sample = live?.live; const processes = sample?.processes ?? []; const clients = sample?.clients ?? []; const drives = sample?.drives ?? [];
  return <section className="space-y-4" data-live-section><h2 className="font-semibold">Live</h2><div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Engines</p>{processes.length ? processes.map((process) => <ListRow icon="Gauge" key={process.pid} name={engineName(process)} subtitle={`${process.model ?? "No model"} · port ${process.port ?? "not measured"}`} status={process.cpuPercent === null ? "not measured" : `${Math.round(process.cpuPercent)}% CPU`} tone="ready" />) : <p className="py-3 text-sm text-muted-foreground">No engine is running</p>}</div>{(sample?.gpus ?? []).map((gpu) => <DetailCard key={gpu.name} title={gpu.name} rows={[{ label: "Memory", value: memory(gpu.memoryUsedBytes, gpu.memoryTotalBytes) }, { label: "Utilization", value: measured(gpu.utilization, "%") }]} />)}{sample && <DetailCard title="This computer" rows={[{ label: "CPU", value: measured(sample.cpu.percent, "%") }, ...drives.map((drive) => ({ label: drive.name, value: drive.mounted !== false ? `${formatBytes(drive.usedBytes)} of ${formatBytes(drive.totalBytes)}` : "not mounted" }))]} />}<div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Connected now</p>{clients.length ? clients.map((client) => <ListRow icon="Activity" key={client.name} name={client.name} subtitle={`${client.roles.join(", ")} · ${client.requestCount} requests`} status="connected" subStatus={formatRelative(client.lastRequestAt)} tone="ready" />) : <p className="py-3 text-sm text-muted-foreground">No client in the last five minutes</p>}</div></section>;
}
