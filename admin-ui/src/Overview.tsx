import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
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
import type { RoleGroup } from "./roleWords";

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
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
    </div>
  );
}

function RoleTile({ role, onOpen }: { role: Role; onOpen: () => void }) {
  const g = roleGroup(role);
  const kind = groupKind(g, role);
  return (
    <button type="button" onClick={onOpen} className="group flex min-h-16 items-center gap-3 rounded-xl border bg-card p-4 text-start transition-[transform,box-shadow,background-color] duration-200 hover:bg-accent/40 hover:shadow-sm active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <StatusIndicator status={kind} ping={kind === "online"} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{role.label}</span>
        <span className="block truncate text-sm text-muted-foreground">{roleLine(role)}</span>
      </span>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
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
              <Button onClick={() => { onClose(); go("models"); }}>Choose a model</Button>
              <Button variant="outline" onClick={() => { onClose(); go("features"); }}>Turn on or off</Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function Overview({ snap, go }: { snap: Snapshot; go: (screen: string) => void }) {
  const [open, setOpen] = useState<Role | null>(null);
  const [showOff, setShowOff] = useState(false);
  const { status, roles, healthz } = snap;
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
      <section aria-label="Status" className={`flex flex-col gap-5 rounded-2xl border bg-gradient-to-br ${HERO_TINT[kind]} to-card p-5 sm:flex-row sm:items-center sm:justify-between sm:p-8`}>
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

      <section aria-labelledby="feat-h" className="flex flex-col gap-3">
        <h2 id="feat-h" className="text-sm font-medium text-muted-foreground">What is running</h2>
        {active.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{active.map((r) => <RoleTile key={r.id} role={r} onOpen={() => setOpen(r)} />)}</div>
        ) : (
          <div className="rounded-xl border border-dashed p-6 text-center">
            <p className="font-medium">Nothing is running yet</p>
            <p className="mb-3 text-sm text-muted-foreground">Turn a feature on and the Stack sets it up for you.</p>
            <Button size="sm" onClick={() => go("features")}>Choose features</Button>
          </div>
        )}
        {grouped.off.length > 0 && (
          <Collapsible open={showOff} onOpenChange={setShowOff} className="flex flex-col gap-3">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="self-start text-muted-foreground"><ChevronDown aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${showOff ? "rotate-180" : ""}`} />{grouped.off.length} more {grouped.off.length === 1 ? "feature is" : "features are"} off or not set up</Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{grouped.off.map((r) => <RoleTile key={r.id} role={r} onOpen={() => setOpen(r)} />)}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>

      <p className="text-xs text-muted-foreground">MaiPai Stack {healthz ? `${healthz.version}, up ${uptime(healthz.uptimeSeconds)}` : ""}. Budget for engines: {bytes(status.memory.budget_bytes)}.</p>
      <RoleSheet role={open} onClose={() => setOpen(null)} go={go} />
    </div>
  );
}
