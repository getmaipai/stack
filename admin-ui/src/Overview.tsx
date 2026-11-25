import { useEffect, useState } from "react";
import { ChevronDown, Cpu, HardDrive, MemoryStick, Activity } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { Button } from "@maipai/ui/src/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maipai/ui/src/ui/collapsible";
import { ProgressRing } from "@maipai/ui/src/ui/progress-ring";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@maipai/ui/src/ui/sheet";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import type { StatusKind } from "@maipai/ui/src/ui/status";
import type { Role } from "./api";
import type { Snapshot } from "./live";
import { ago, bytes, uptime } from "./format";
import { roleGroup, roleLine } from "./roleWords";
import { EmptyState, IconChip, Meter, Pill, SectionHeader, StatTile } from "./kit";
import type { Tone } from "./kit";
import { roleIcon } from "./roleIcons";
import { useRecent } from "./useHistory";
import type { RoleGroup } from "./roleWords";
import { StatDetails, type StatKind } from "./StatSheet";
import { modelsHint } from "./statDetails";
import { createStackClient } from "./stackClient";
import type { StackDrive, StackDriveFeature } from "@maipai/ui/src/stack/StackClient";

/** The tint behind the big status card, from the status tokens only. */
const HERO_TINT: Record<StatusKind, string> = {
  online: "from-[color-mix(in_oklab,var(--status-ok)_22%,var(--card))]",
  degraded: "from-[color-mix(in_oklab,var(--status-warning)_26%,var(--card))]",
  offline: "from-[color-mix(in_oklab,var(--status-error)_26%,var(--card))]",
  maintenance: "from-[color-mix(in_oklab,var(--primary)_20%,var(--card))]",
};
const HEALTH_HEADLINE = { ok: "Everything is running", degraded: "Something needs attention", down: "The Stack is down", updating: "Updating" } as const;
const PRESSURE_PLAIN = { normal: "Plenty of room", warn: "Getting tight", critical: "Almost full" } as const;

function groupKind(g: RoleGroup, role: Role): StatusKind {
  if (g === "broken") return "offline";
  if (g === "off") return "maintenance";
  return role.state.state === "installed" ? "maintenance" : "online";
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-40 rounded-2xl" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
    </div>
  );
}

function RoleTile({ role, budget, onOpen }: { role: Role; budget: number; onOpen: () => void }) {
  const g = roleGroup(role);
  const kind = groupKind(g, role);
  const tone: Tone = g === "broken" ? "bad" : g === "off" ? "muted" : kind === "online" ? "ok" : "primary";
  const foot = role.model?.measuredFootprintBytes ?? 0;
  return (
    <button type="button" onClick={onOpen} className="glass glass-lift group flex min-h-24 min-w-0 flex-col gap-3 p-4 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="flex items-center gap-3">
        <IconChip Icon={roleIcon(role.id)} tone={tone} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{role.label}</span>
          <span className="block truncate text-sm text-muted-foreground">{roleLine(role)}</span>
        </span>
        {g === "broken" ? <Pill tone="bad">Needs a look</Pill> : g === "off" ? <Pill tone="muted">Off</Pill> : <StatusIndicator status={kind} ping={kind === "online"} />}
      </span>
      {foot > 0 && budget > 0 && (
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex-1"><Meter value={foot / budget} tone={tone} label={`${role.label} memory`} /></span>
          <span className="tabular-nums">{bytes(foot)}</span>
        </span>
      )}
    </button>
  );
}

function useIsPhone(): boolean {
  const q = "(max-width: 639px)";
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

function RoleSheet({ role, onClose, go }: { role: Role | null; onClose: () => void; go: (screen: string) => void }) {
  const phone = useIsPhone();
  const g = role ? roleGroup(role) : "off";
  const why = role ? (role.plain_reason ?? role.reason ?? role.state.reason ?? null) : null;
  return (
    <Sheet open={role !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side={phone ? "bottom" : "right"} className="sm:max-w-md">
        {role && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2"><StatusIndicator status={groupKind(g, role)} ping={false} />{role.label}</SheetTitle>
              <SheetDescription>{roleLine(role, true)}</SheetDescription>
            </SheetHeader>
            <dl className="flex flex-col gap-4 px-4 text-sm">
              {role.model && <div><dt className="text-muted-foreground">Model</dt><dd className="font-medium break-all">{role.model.id}</dd></div>}
              {role.model?.measuredFootprintBytes ? <div><dt className="text-muted-foreground">Memory it uses</dt><dd className="font-medium">About {bytes(role.model.measuredFootprintBytes)}</dd></div> : null}
              <div><dt className="text-muted-foreground">In this state</dt><dd className="font-medium">{ago(role.state.since) || "Just now"}</dd></div>
              {why && <div><dt className="text-muted-foreground">Why</dt><dd>{why}</dd></div>}
            </dl>
            <SheetFooter>
              <Button onClick={() => { onClose(); go("models"); }}>Choose a model or turn it off</Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function Overview({ snap, go }: { snap: Snapshot; go: (screen: string) => void }) {
  const [open, setOpen] = useState<Role | null>(null);
  const [detail, setDetail] = useState<StatKind | null>(null);
  const [disks, setDisks] = useState<StackDrive[] | null>(null);
  const [driveFeatures, setDriveFeatures] = useState<StackDriveFeature[] | null>(null);
  const [showOff, setShowOff] = useState(false);
  const { status, roles, healthz } = snap;
  const recent = useRecent();
  useEffect(() => {
    const client = createStackClient();
    Promise.all([client.drives!.list(), client.drives!.features()]).then(([d, f]) => { setDisks(d.disks); setDriveFeatures(f.features); }).catch(() => { /* old summary hint remains available */ });
  }, []);
  if (!snap.loaded) return <OverviewSkeleton />;
  if (!status || !roles) {
    return <Alert variant="destructive" role="alert"><AlertTitle>The Stack is not answering</AlertTitle><AlertDescription>{snap.error ?? "No answer yet."} This page keeps trying by itself.</AlertDescription></Alert>;
  }
  const used = Math.max(0, status.memory.total_bytes - status.memory.free_bytes);
  const ratio = status.memory.total_bytes > 0 ? used / status.memory.total_bytes : 0;
  const kind: StatusKind = status.health === "ok" ? "online" : status.health === "degraded" ? "degraded" : status.health === "updating" ? "maintenance" : "offline";
  const grouped = { working: roles.filter((r) => roleGroup(r) === "working"), broken: roles.filter((r) => roleGroup(r) === "broken"), off: roles.filter((r) => roleGroup(r) === "off") };
  const active = [...grouped.broken, ...grouped.working];
  const n = status.problems.length;
  return (
    <div className="flex flex-col gap-8">
      {snap.error && <Alert variant="destructive" role="alert"><AlertTitle>The last refresh failed</AlertTitle><AlertDescription>{snap.error} The numbers below may be a little old.</AlertDescription></Alert>}
      <section aria-label="Status" className={`flex flex-col gap-5 rounded-3xl bg-gradient-to-br ${HERO_TINT[kind]} to-card shadow-[inset_0_0_0_1px_var(--fill-2)] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-8`}>
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-3 text-2xl font-semibold tracking-tight sm:text-4xl">
            <StatusIndicator status={kind} ping={kind === "online"} />{HEALTH_HEADLINE[status.health]}
          </p>
          <p className="text-muted-foreground">
            {grouped.working.length > 0 ? `${grouped.working.length} of ${roles.length} features are ready.` : "No feature is running yet."}
            {status.busy.running + status.busy.waiting > 0 ? ` ${status.busy.running} busy now, ${status.busy.waiting} waiting.` : ""}
          </p>
          {n > 0 && <div><Button size="sm" variant="secondary" onClick={() => go("health")}>See {n === 1 ? "the problem" : `all ${n} problems`} and fixes</Button></div>}
        </div>
        <div className="flex items-center gap-4 border-t pt-4 sm:border-t-0 sm:pt-0">
          <ProgressRing value={ratio} size={80} strokeWidth={9} label="Memory in use" tone="primary">
            <span className="text-lg font-semibold">{Math.round(ratio * 100)}%</span>
          </ProgressRing>
          <div className="text-sm">
            <p className="font-semibold">Memory</p>
            <p className="text-muted-foreground">{PRESSURE_PLAIN[status.memory.pressure]}</p>
            <p className="text-muted-foreground">{bytes(used)} of {bytes(status.memory.total_bytes)}</p>
          </div>
        </div>
      </section>

      <section aria-label="Live" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile Icon={MemoryStick} label="Memory" value={`${Math.round(ratio * 100)}%`} series={recent.history?.points.map((p) => (p.total > 0 ? (p.used / p.total) * 100 : 0))} max={100} hint={`${bytes(used)} in use; how much of the computer's memory is occupied.`} onOpen={() => setDetail("memory")} />
        <StatTile Icon={Cpu} label="Processor" tone="ok" value={recent.summary?.current?.cpu == null ? "..." : `${Math.round(recent.summary.current.cpu)}%`} series={recent.history?.points.map((p) => p.cpu ?? 0)} max={100} hint="How busy the computer's processor is right now." onOpen={() => setDetail("processor")} />
        <StatTile Icon={Activity} label="Requests" tone="warn" value={String(status.busy.running + status.busy.waiting)} series={recent.history?.points.map((p) => p.queue)} hint={`${status.busy.running} running, ${status.busy.waiting} waiting`} onOpen={() => setDetail("requests")} />
        <StatTile Icon={HardDrive} label="Models on disk" tone="muted" value={recent.summary?.current?.disk == null ? "..." : bytes(recent.summary.current.disk)} meter={recent.summary?.current?.disk ? Math.min(1, recent.summary.current.disk / (200 * 1024 ** 3)) : 0} hint={modelsHint(disks, driveFeatures) ?? "Space used by installed models and engines."} onOpen={() => setDetail("models")} />
      </section>

      <section aria-labelledby="feat-h" className="flex flex-col gap-3">
        <SectionHeader id="feat-h" eyebrow="Features" title="What is running" count={active.length} />
        {active.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{active.map((r) => <RoleTile key={r.id} role={r} budget={status.memory.budget_bytes} onOpen={() => setOpen(r)} />)}</div>
        ) : (
          <EmptyState Icon={Activity} tone="muted" title="Nothing is running yet" text="Turn a feature on and the Stack sets it up for you." action={<Button size="sm" onClick={() => go("models")}>Choose features</Button>} />
        )}
        {grouped.off.length > 0 && (
          <Collapsible open={showOff} onOpenChange={setShowOff} className="flex flex-col gap-3">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="self-start text-muted-foreground"><ChevronDown aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${showOff ? "rotate-180" : ""}`} />{grouped.off.length} more {grouped.off.length === 1 ? "feature is" : "features are"} off or not set up</Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{grouped.off.map((r) => <RoleTile key={r.id} role={r} budget={status.memory.budget_bytes} onOpen={() => setOpen(r)} />)}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>

      <p className="text-xs text-muted-foreground">MaiPai Stack {healthz ? `${healthz.version}, up ${uptime(healthz.uptimeSeconds)}` : ""}. Budget for engines: {bytes(status.memory.budget_bytes)}.</p>
      <RoleSheet role={open} onClose={() => setOpen(null)} go={go} />
      <StatDetails kind={detail} open={detail !== null} onClose={() => setDetail(null)} go={go} snap={snap} disks={disks} features={driveFeatures} summary={recent.summary} history={recent.history} />
    </div>
  );
}
