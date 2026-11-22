import { useEffect, useMemo, useState } from "react";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import type { StatusKind } from "@maipai/ui/src/ui/status";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maipai/ui/src/ui/collapsible";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { ApiError, api } from "./api";
import type { Engine, HealthItem, Role } from "./api";
import type { Snapshot } from "./live";
import { ago } from "./format";

export type Notify = (message: string) => void;

export function roleKind(role: Role): StatusKind {
  if (role.enabled === false) return "maintenance";
  switch (role.state.state) {
    case "ready": case "loaded": return "online";
    case "installed": case "notInstalled": return "maintenance";
    default: return "offline";
  }
}
const ROLE_WORDS: Record<Role["state"]["state"], string> = {
  ready: "Ready", loaded: "Loaded", installed: "Ready, not started", notInstalled: "Not set up yet", offline: "Not answering",
};
export function roleWord(role: Role): string {
  return role.enabled === false ? "Turned off" : ROLE_WORDS[role.state.state];
}
const HEALTH_WORDS = { ok: "Everything is running", degraded: "Needs attention", down: "Down", updating: "Updating" } as const;
export function healthWord(h: keyof typeof HEALTH_WORDS): string { return HEALTH_WORDS[h]; }
export function healthKind(h: keyof typeof HEALTH_WORDS): StatusKind {
  return h === "ok" ? "online" : h === "degraded" ? "degraded" : h === "updating" ? "maintenance" : "offline";
}

function Loading() {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div>;
}
function Problem({ message }: { message: string }) {
  return <Alert variant="destructive" role="alert"><AlertTitle>The Stack is not answering</AlertTitle><AlertDescription>{message} This page keeps trying by itself.</AlertDescription></Alert>;
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
    return <Card><CardHeader><CardTitle className="flex items-center gap-2"><StatusIndicator status="online" ping={false} />All clear</CardTitle><CardDescription>Nothing needs you right now. This updates by itself.</CardDescription></CardHeader></Card>;
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
  if (!e.installed) return "Not set up yet";
  return e.running ? "Running" : "Ready, not started";
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
      {installed.length === 0 && <Card><CardHeader><CardTitle>No engines yet</CardTitle><CardDescription>Turn on a feature and the Stack sets up the engine it needs.</CardDescription></CardHeader></Card>}
      {others.length > 0 && <p className="text-sm text-muted-foreground">{others.length} more {others.length === 1 ? "engine is" : "engines are"} ready to download when a feature needs {others.length === 1 ? "it" : "them"}.</p>}
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group self-start text-muted-foreground"><ChevronDown aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />{filter ? `Log lines for ${filter}` : "Show recent log lines"}</Button></CollapsibleTrigger>
        <CollapsibleContent>
          {logError ? <Problem message={logError} /> : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-card p-4 text-xs leading-5 text-card-foreground" tabIndex={0} aria-label="Stack log">{shown.length ? shown.join("\n") : "No log lines yet."}</pre>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
