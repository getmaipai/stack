import { useEffect, useState } from "react";
import { Button } from "@maipai/ui/src/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@maipai/ui/src/ui/sheet";
import type { StackDrive, StackDriveFeature } from "@maipai/ui/src/stack/StackClient";
import type { Snapshot } from "./live";
import type { Summary, History, EngineRow } from "./resourceData";
import { bytes } from "./format";
import { Meter } from "./kit";
import { driveDetails } from "./statDetails";

/** Opens the AI and models page, then scrolls to its Drives section once it has drawn (it loads after the page). */
function showDrives(go: (screen: string) => void) {
  go("models");
  let tries = 0;
  const look = () => {
    const el = document.getElementById("drives-heading");
    if (el) { el.scrollIntoView({ block: "start" }); return; }
    if (++tries < 40) setTimeout(look, 100);
  };
  setTimeout(look, 100);
}

export type StatKind = "models" | "requests" | "memory" | "processor" | "graphics" | "speed" | "swap" | "waiting";
export function StatDetails({ kind, open, onClose, go, snap, disks, features, summary, history, engines }: {
  kind: StatKind | null; open: boolean; onClose: () => void; go: (screen: string) => void; snap?: Snapshot;
  disks?: StackDrive[] | null; features?: StackDriveFeature[] | null; summary?: Summary | null; history?: History | null; engines?: EngineRow[];
}) {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(media.matches);
    update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  const title = ({ models: "Models on disk", requests: "Requests", memory: "Memory", processor: "Processor", graphics: "Graphics", speed: "Speed", swap: "Swap", waiting: "Waiting requests" } as const)[kind ?? "models"];
  const current = summary?.current;
  const drives = driveDetails(disks ?? [], features ?? []);
  const destination = kind === "models" ? "models" : kind === "requests" ? "health" : kind ? "resources" : null;
  const link = kind === "models" ? "AI and models" : kind === "requests" ? "Health" : "Resources";
  return <Sheet open={open && kind !== null} onOpenChange={(v) => { if (!v) onClose(); }}>
    <SheetContent side={phone ? "bottom" : "right"} className="sm:max-w-md overflow-y-auto">
      <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>Current readings and recent details.</SheetDescription></SheetHeader>
      <div className="flex flex-col gap-4 px-4 text-sm">
        {kind === "models" && <>
          {(drives.length ? drives : []).map(({ drive, usedBytes, features: rows }) => <section key={drive.id} className="flex flex-col gap-2 rounded-xl bg-[var(--fill-1)] p-3">
            <h3 className="font-semibold">{drive.label}{drive.connected ? "" : " · disconnected"}</h3>
            <Meter value={drive.total_bytes ? usedBytes / drive.total_bytes : 0} label={`${drive.label} used`} />
            <p>{bytes(drive.free_bytes)} free of {bytes(drive.total_bytes)}</p>
            {rows.length ? <ul className="flex flex-col gap-1">{rows.map((row) => <li key={row.id} className="flex justify-between gap-2"><span>{row.label}</span><span>{bytes(row.bytes)}</span></li>)}</ul> : <p className="text-muted-foreground">No model files listed on this drive.</p>}
          </section>)}
          {!drives.length && <p>Drive details are not available.</p>}
          <p>{(features ?? []).length} models listed. {(features ?? []).reduce((n, f) => n + f.bytes, 0) ? bytes((features ?? []).reduce((n, f) => n + f.bytes, 0)) : "No model size data"} total.</p>
        </>}
        {kind === "requests" && <>
          <p>{snap?.status?.busy.running ?? 0} running and {snap?.status?.busy.waiting ?? 0} waiting.</p>
          {history?.points.length ? <p>Recent queue peak: {Math.max(...history.points.map((p) => p.queue))}; average: {(history.points.reduce((n, p) => n + p.queue, 0) / history.points.length).toFixed(1)} waiting.</p> : <p>Recent request history is not available yet.</p>}
          {engines?.length ? <ul>{engines.filter((e) => e.active_requests > 0 || e.state === "queued" || e.state === "running").map((e) => <li key={e.role}>{e.label}: {e.active_requests} running{e.state === "queued" ? ", waiting" : ""}</li>)}</ul> : <p>Per feature request counts are not available.</p>}
        </>}
        {kind === "memory" && <><p>{current ? `${bytes(current.used)} used of ${bytes(current.total)}.` : "No current memory reading."}</p><p>{current ? `Pressure is ${current.pressure >= 4 ? "critical" : current.pressure >= 2 ? "getting tight" : "comfortable"}.` : "Pressure is not available."}</p><p>Engine budget: {bytes(snap?.status?.memory.budget_bytes ?? 0)}.</p><p>Last hour: {bytes(summary?.last_hour.memory_used_mean_bytes ?? 0)} average, {bytes(summary?.last_hour.memory_used_peak_bytes ?? 0)} peak.</p></>}
        {kind === "processor" && <><p>Current use: {current?.cpu == null ? "No reading." : `${Math.round(current.cpu)}%.`}</p><p>Last hour peak: {summary?.last_hour.cpu_peak == null ? "No reading." : `${Math.round(summary.last_hour.cpu_peak)}%.`}</p></>}
        {kind === "graphics" && <><p>Current use: {current?.gpu == null ? "Not measured." : `${Math.round(current.gpu)}%.`}</p><p>Last hour peak: {history?.points.some((p) => p.gpu !== null) ? `${Math.round(Math.max(...history.points.map((p) => p.gpu ?? 0)))}%.` : "Not measured."}</p><p>How much of the graphics chip is in use.</p></>}
        {kind === "speed" && <><p>Current speed: {current?.tps ? `${Object.values(current.tps).reduce((a, b) => a + b, 0).toFixed(1)} tokens per second.` : "Not measured."}</p><p>Recent speed is the combined writing rate of the engines.</p></>}
        {kind === "swap" && <><p>Current: {current ? bytes(current.swap) : "No reading."}</p><p>Last hour peak: {history?.points.length ? bytes(Math.max(...history.points.map((p) => p.swap))) : "No reading."}</p><p>Memory the system has moved to disk. Lower is better.</p></>}
        {kind === "waiting" && <><p>Now: {current?.queue ?? snap?.status?.busy.waiting ?? 0} waiting.</p><p>Last hour peak: {summary?.last_hour.queue_peak ?? 0} waiting.</p><p>Requests waiting for memory or an engine.</p></>}
      </div>
      {destination && <SheetFooter>
        <Button onClick={() => { onClose(); go(destination); }}>See more: {link}</Button>
        {kind === "models" && <Button variant="secondary" onClick={() => { onClose(); showDrives(go); }}>Go to Drives</Button>}
      </SheetFooter>}
    </SheetContent>
  </Sheet>;
}
