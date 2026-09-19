import { DetailCard } from "@/kit/blocks/phone/DetailCard";
import { ListRow } from "@/kit/blocks/phone/ListRow";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { RelativeTime } from "@/kit/ui/relative-time";
import { formatRelative } from "@/lib/relativeTime";
import type { LiveClient, LiveComputer, LiveDrive, LiveEngine, LiveGpu, LiveResponse } from "@/lib/api";
import { formatBytes } from "./SegmentedBar";

function measured(value: number | null, suffix = ""): string { return value === null ? "not measured" : `${Math.round(value)}${suffix}`; }
function memory(used: number | null, total: number | null): string { return used === null || total === null ? "not measured" : `${formatBytes(used)} of ${formatBytes(total)}`; }
function engineName(engine: LiveEngine): string { return engine.build ? `${engine.engine} ${engine.build}` : engine.engine; }

function EngineRows({ engines }: { engines: LiveEngine[] }) {
  if (!engines.length) return <p className="text-sm text-muted-foreground">No engine is running</p>;
  return <div className="divide-y">{engines.map((engine) => <div className="grid gap-2 py-3 text-sm sm:grid-cols-[minmax(10rem,1fr)_repeat(5,minmax(0,1fr))]" key={engine.id}><span className="font-medium">{engineName(engine)}</span><span>{engine.model ?? "No model"}</span><span>Port {engine.port ?? "not measured"}</span><span>{engine.footprintBytes === null ? "not measured" : formatBytes(engine.footprintBytes)}</span><span>{measured(engine.cpuPercent, "% CPU")}</span><span>Up <RelativeTime at={engine.startedAt} /></span></div>)}</div>;
}

function GpuCards({ gpus }: { gpus: LiveGpu[] }) {
  return <div className="grid gap-3 sm:grid-cols-2">{gpus.map((gpu) => <Card className="shadow-none" key={gpu.name}><CardHeader className="pb-2"><CardTitle className="text-sm">{gpu.name}</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p>{memory(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}</p>{gpu.utilizationPercent === null ? <p className="text-muted-foreground">not measured</p> : <><div aria-label={`${gpu.name} utilization ${Math.round(gpu.utilizationPercent)}%`} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, gpu.utilizationPercent))}%` }} /></div><p className="text-xs text-muted-foreground">{Math.round(gpu.utilizationPercent)}% utilization</p></>}</CardContent></Card>)}</div>;
}

function DriveRows({ drives }: { drives: LiveDrive[] }) { return <div className="divide-y border-y" data-drive-list>{drives.map((drive) => { const percent = drive.totalBytes > 0 ? Math.min(100, Math.max(0, drive.usedBytes / drive.totalBytes * 100)) : 0; return <div className="py-3 text-sm" key={drive.mount}><div className="flex flex-wrap justify-between gap-x-5 gap-y-1"><span className="font-medium">{drive.name}</span><span>{drive.mounted ? `${formatBytes(drive.usedBytes)} of ${formatBytes(drive.totalBytes)}` : "not mounted"}</span></div>{drive.mounted && <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div>}</div>; })}</div>; }
function ComputerLine({ computer, drives }: { computer: LiveComputer; drives: LiveDrive[] }) { return <div className="space-y-3"><div className="flex flex-wrap gap-x-5 gap-y-1 border-y py-3 text-sm"><span>CPU {measured(computer.cpuPercent, "%")}</span>{!drives.length && <span>Disk {memory(computer.diskUsedBytes, computer.diskTotalBytes)}</span>}</div>{drives.length > 0 && <DriveRows drives={drives} />}</div>; }

function ClientRows({ clients }: { clients: LiveClient[] }) {
  if (!clients.length) return <p className="text-sm text-muted-foreground">No client in the last five minutes</p>;
  return <div className="divide-y">{clients.map((client) => <div className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(9rem,1fr)_repeat(4,minmax(0,1fr))]" key={client.id}><span className="font-medium">{client.name}</span><span>{client.roles.join(", ") || "No roles"}</span><span>{client.requests} requests</span><span><RelativeTime at={client.lastRequestAt} /></span><span>{client.inFlight} in flight</span></div>)}</div>;
}

export function LiveSection({ live }: { live?: LiveResponse }) {
  const engines = live?.engines ?? []; const gpus = live?.gpus ?? []; const drives = live?.drives ?? []; const computer = live?.computer;
  return <section className="space-y-3" data-live-section><div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Live</h2>{live && <span className="text-xs text-muted-foreground">Updated <RelativeTime at={live.sampledAt} /></span>}</div><Card data-widget><CardHeader className="pb-2"><CardTitle className="text-base">Engines</CardTitle></CardHeader><CardContent><EngineRows engines={engines} /></CardContent></Card>{gpus.length > 0 && <GpuCards gpus={gpus} />}{computer && <ComputerLine computer={computer} drives={drives} />}<Card data-widget><CardHeader className="pb-2"><CardTitle className="text-base">Connected now</CardTitle></CardHeader><CardContent><ClientRows clients={live?.clients ?? []} /></CardContent></Card></section>;
}

export function PhoneLiveSection({ live }: { live?: LiveResponse }) {
  const engines = live?.engines ?? []; const clients = live?.clients ?? []; const drives = live?.drives ?? [];
  return <section className="space-y-4" data-live-section><h2 className="font-semibold">Live</h2><div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Engines</p>{engines.length ? engines.map((engine) => <ListRow icon="Gauge" key={engine.id} name={engineName(engine)} subtitle={`${engine.model ?? "No model"} · port ${engine.port ?? "not measured"}`} status={engine.cpuPercent === null ? "not measured" : `${Math.round(engine.cpuPercent)}% CPU`} tone="ready" />) : <p className="py-3 text-sm text-muted-foreground">No engine is running</p>}</div>{(live?.gpus ?? []).map((gpu) => <DetailCard key={gpu.name} title={gpu.name} rows={[{ label: "Memory", value: memory(gpu.memoryUsedBytes, gpu.memoryTotalBytes) }, { label: "Utilization", value: measured(gpu.utilizationPercent, "%") }]} />)}{live?.computer && <DetailCard title="This computer" rows={[{ label: "CPU", value: measured(live.computer.cpuPercent, "%") }, ...drives.map((drive) => ({ label: drive.name, value: drive.mounted ? `${formatBytes(drive.usedBytes)} of ${formatBytes(drive.totalBytes)}` : "not mounted" })), ...(drives.length ? [] : [{ label: "Disk", value: memory(live.computer.diskUsedBytes, live.computer.diskTotalBytes) }])]} />}<div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Connected now</p>{clients.length ? clients.map((client) => <ListRow icon="Activity" key={client.id} name={client.name} subtitle={`${client.roles.join(", ")} · ${client.requests} requests`} status={`${client.inFlight} in flight`} subStatus={formatRelative(client.lastRequestAt)} tone="ready" />) : <p className="py-3 text-sm text-muted-foreground">No client in the last five minutes</p>}</div></section>;
}
