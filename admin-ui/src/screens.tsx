import { useEffect, useMemo, useState } from "react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Progress } from "@maipai/ui/src/ui/progress";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import type { StatusKind } from "@maipai/ui/src/ui/status";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { ApiError, api } from "./api";
import type { Engine, HealthItem, Role } from "./api";
import type { Snapshot } from "./live";
import { ago, bytes, uptime } from "./format";

export type Notify = (message: string) => void;

export function roleKind(role: Role): StatusKind {
  if (role.enabled === false) return "maintenance";
  switch (role.state.state) {
    case "ready": case "loaded": return "online";
    case "installed": return "maintenance";
    default: return "offline";
  }
}
const ROLE_WORDS: Record<Role["state"]["state"], string> = {
  ready: "Ready", loaded: "Loaded", installed: "Installed, not running", notInstalled: "Not installed", offline: "Offline",
};
export function roleWord(role: Role): string {
  return role.enabled === false ? "Turned off" : ROLE_WORDS[role.state.state];
}
const HEALTH_WORDS = { ok: "Everything is running", degraded: "Needs attention", down: "Down", updating: "Updating" } as const;
export function healthWord(h: keyof typeof HEALTH_WORDS): string { return HEALTH_WORDS[h]; }
export function healthKind(h: keyof typeof HEALTH_WORDS): StatusKind {
  return h === "ok" ? "online" : h === "degraded" ? "degraded" : h === "updating" ? "maintenance" : "offline";
}
const PRESSURE_WORDS = { normal: "Comfortable", warn: "Getting tight", critical: "Critical" } as const;

function Loading() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
}
function Problem({ message }: { message: string }) {
  return <Alert variant="destructive" role="alert"><AlertTitle>Could not reach the Stack</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl">{value}</CardTitle></CardHeader>
      {hint && <CardContent className="text-sm text-muted-foreground">{hint}</CardContent>}
    </Card>
  );
}

export function Overview({ snap }: { snap: Snapshot }) {
  const { status, roles, healthz } = snap;
  if (!snap.loaded) return <Loading />;
  if (!status || !roles) return <Problem message={snap.error ?? "No answer yet."} />;
  const used = Math.max(0, status.memory.total_bytes - status.memory.free_bytes);
  const percent = status.memory.total_bytes > 0 ? Math.round((used / status.memory.total_bytes) * 100) : 0;
  return (
    <div className="flex flex-col gap-6">
      {snap.error && <Problem message={snap.error} />}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Card className="col-span-2 xl:col-span-1">
          <CardHeader>
            <CardDescription>Status</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl"><StatusIndicator status={healthKind(status.health)} ping={status.health === "ok"} />{healthWord(status.health)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {status.problems.length === 0 ? "No open problems." : `${status.problems.length} open ${status.problems.length === 1 ? "problem" : "problems"}.`}
            {" "}{status.busy.running} running, {status.busy.waiting} waiting.
          </CardContent>
        </Card>
        <Tile label="Version" value={healthz ? healthz.version : "unknown"} hint={healthz ? `Wire contract ${healthz.contract}` : undefined} />
        <Tile label="Up for" value={healthz ? uptime(healthz.uptimeSeconds) : "unknown"} hint="Since the Stack last started." />
        <Card className="col-span-2 xl:col-span-1">
          <CardHeader><CardDescription>Memory</CardDescription><CardTitle className="text-2xl">{PRESSURE_WORDS[status.memory.pressure]}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Progress value={percent} aria-label="Memory in use" />
            <p className="text-sm text-muted-foreground">{bytes(used)} of {bytes(status.memory.total_bytes)} in use. Budget for engines: {bytes(status.memory.budget_bytes)}.</p>
          </CardContent>
        </Card>
      </div>
      <section aria-labelledby="roles-h" className="flex flex-col gap-3">
        <h2 id="roles-h" className="text-lg font-semibold">Features</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {roles.map((role) => <RoleCard key={role.id} role={role} />)}
        </div>
      </section>
    </div>
  );
}

function RoleCard({ role }: { role: Role }) {
  const why = role.plain_reason ?? role.reason ?? role.state.reason ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><StatusIndicator status={roleKind(role)} ping={roleKind(role) === "online"} />{role.label}</CardTitle>
        <CardAction><Badge variant="secondary">{roleWord(role)}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>{role.model ? `Answering with ${role.model.id}` : "No model chosen yet."}</p>
        {role.model?.measuredFootprintBytes ? <p>Uses about {bytes(role.model.measuredFootprintBytes)} of memory.</p> : null}
        {why && <p>{why}</p>}
        <p className="text-xs">Since {ago(role.state.since)}</p>
      </CardContent>
    </Card>
  );
}

const SEVERITY: Record<HealthItem["severity"], { word: string; variant: "destructive" | "secondary" | "outline" }> = {
  critical: { word: "Critical", variant: "destructive" }, error: { word: "Error", variant: "destructive" }, warning: { word: "Warning", variant: "secondary" },
};

export function Health({ snap, refresh, notify }: { snap: Snapshot; refresh: () => void; notify: Notify }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!snap.loaded) return <Loading />;
  if (!snap.health) return <Problem message={snap.error ?? "No answer yet."} />;
  async function fix(item: HealthItem) {
    setBusy(item.code);
    try {
      const result = await api.fix(item.code);
      notify(result.result || (result.ok ? "Fixed." : "That fix did not work."));
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "The fix could not run. Try again.");
    } finally {
      setBusy(null);
      refresh();
    }
  }
  if (snap.health.length === 0) {
    return <Card><CardHeader><CardTitle className="flex items-center gap-2"><StatusIndicator status="online" ping={false} />No problems</CardTitle><CardDescription>Nothing needs your attention. This list updates by itself.</CardDescription></CardHeader></Card>;
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Problems">
      {snap.health.map((item) => (
        <li key={item.code}>
          <Card>
            <CardHeader className="max-sm:flex max-sm:flex-col max-sm:items-start max-sm:gap-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <Badge variant={SEVERITY[item.severity].variant}>{SEVERITY[item.severity].word}</Badge>{item.title}
              </CardTitle>
              <CardDescription>{item.text}</CardDescription>
              {item.fix && (
                <CardAction className="max-sm:order-last max-sm:self-start">
                  <Button size="sm" disabled={busy === item.code} onClick={() => { void fix(item); }}>{busy === item.code ? "Working" : item.fix.label}</Button>
                </CardAction>
              )}
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{item.cause} Open since {ago(item.since)}.</CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function engineKind(e: Engine): StatusKind {
  if (!e.installed) return "offline";
  if (e.running) return "online";
  return "maintenance";
}
function engineWord(e: Engine): string {
  if (!e.installed) return "Not installed";
  return e.running ? "Running" : "Installed, not running";
}

export function Engines({ snap, refresh, notify }: { snap: Snapshot; refresh: () => void; notify: Notify }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.logs(300).then((r) => { if (live) { setLogs(r.lines); setLogError(null); } }).catch((e: unknown) => { if (live) setLogError(e instanceof ApiError ? e.message : "The log could not be read."); });
    return () => { live = false; };
  }, [snap.engines]);
  const shown = useMemo(() => {
    const lines = logs ?? [];
    const picked = filter ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : lines;
    return picked.slice(-40);
  }, [logs, filter]);
  if (!snap.loaded) return <Loading />;
  if (!snap.engines) return <Problem message={snap.error ?? "No answer yet."} />;
  async function restart(engine: Engine) {
    setBusy(engine.name);
    try {
      const r = await api.restartEngine(engine.name);
      notify(r.ok ? `${engine.label} restarted.` : r.reason ?? `${engine.label} did not restart.`);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : `${engine.label} could not be restarted. Try again.`);
    } finally {
      setBusy(null);
      refresh();
    }
  }
  // Only builds for this computer: the pins for other platforms are not this machine's engines.
  const mine = snap.engines.filter((e) => e.matchesThisMachine);
  const installed = mine.filter((e) => e.installed);
  const others = mine.filter((e) => !e.installed);
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {installed.map((e) => (
          <Card key={e.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><StatusIndicator status={engineKind(e)} ping={engineKind(e) === "online"} />{e.label}</CardTitle>
              <CardAction><Badge variant="secondary">{engineWord(e)}</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
              <p>Version {e.currentTag ?? "unknown"}{e.update ? `, ${e.update.newest} is available` : ""}.</p>
              {e.needsRestart && <p>A newer build is installed. Restart to use it.</p>}
              {e.roleReason && <p>{e.roleReason}</p>}
              <div className="flex flex-wrap gap-2">
                {e.running && <Button size="sm" variant="outline" disabled={busy === e.name} onClick={() => { void restart(e); }}>{busy === e.name ? "Restarting" : "Restart"}</Button>}
                <Button size="sm" variant="ghost" onClick={() => setFilter(filter === e.name ? null : e.name)}>{filter === e.name ? "Show all log lines" : "Show its log lines"}</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {installed.length === 0 && <Card><CardHeader><CardTitle>No engines installed yet</CardTitle><CardDescription>Engines install when a feature that needs one is turned on.</CardDescription></CardHeader></Card>}
      {others.length > 0 && <p className="text-sm text-muted-foreground">{others.length} more {others.length === 1 ? "engine build is" : "engine builds are"} pinned for this computer and not installed yet. They install when a feature needs them.</p>}
      <section aria-labelledby="log-h" className="flex flex-col gap-2">
        <h2 id="log-h" className="text-lg font-semibold">Recent log lines{filter ? ` for ${filter}` : ""}</h2>
        {logError ? <Problem message={logError} /> : (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-card p-3 text-xs leading-5 text-card-foreground" tabIndex={0} aria-label="Stack log">{shown.length ? shown.join("\n") : "No log lines yet."}</pre>
        )}
      </section>
    </div>
  );
}
