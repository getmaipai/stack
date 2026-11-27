import { useEffect, useMemo, useState } from "react";
import { EmptyState, List, ListRow, ListSkeleton, Pill, SectionHeader } from "./kit";
import type { Tone } from "./kit";
import { Cpu, OctagonAlert, TriangleAlert, CircleAlert, PartyPopper } from "lucide-react";
import { Button } from "@maipai/ui/src/ui/button";
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

function Loading() { return <ListSkeleton rows={4} />; }
function Problem({ message }: { message: string }) {
  return <Alert variant="destructive" role="alert"><AlertTitle>The Stack is not answering</AlertTitle><AlertDescription>{message} This page keeps trying by itself.</AlertDescription></Alert>;
}
const SEVERITY: Record<HealthItem["severity"], { word: string; tone: Tone }> = {
  critical: { word: "Critical", tone: "bad" }, error: { word: "Error", tone: "bad" }, warning: { word: "Warning", tone: "warn" },
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
    return <EmptyState Icon={PartyPopper} tone="ok" title="All clear" text="Nothing needs you right now. This updates by itself." />;
  }
  return (
    <section aria-labelledby="problems-h" className="flex flex-col gap-3">
      <SectionHeader id="problems-h" title="Problems" count={snap.health.length} description="Each one says what is wrong and offers one fix." />
      <List label="Problems">
        {snap.health.map((item) => (
          <ListRow key={item.code}
            Icon={item.severity === "critical" ? OctagonAlert : item.severity === "error" ? CircleAlert : TriangleAlert} tone={item.severity === "warning" ? "warn" : "bad"}
            title={item.title} pills={<Pill tone={SEVERITY[item.severity].tone}>{SEVERITY[item.severity].word}</Pill>}
            detail={item.text}
            extra={<span className="mt-1 block text-xs text-muted-foreground">{item.cause} Open since {ago(item.since)}.</span>}
            actions={item.fix ? <Button size="sm" disabled={busy === item.code} onClick={() => { void fix(item); }}>{busy === item.code ? "Working" : item.fix.label}</Button> : undefined} />
        ))}
      </List>
    </section>
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

/** Live engine output, redacted by the Stack before it is stored (secrets and prompt text never reach this page); refreshed every few seconds while open. */
function EngineOutput() {
  const [roles, setRoles] = useState<Array<{ role: string; lines: Array<{ seq: number; at: string; line: string }> }>>([]);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.engineLogs(100).then((r) => { if (live) { setRoles(r.roles); setError(null); } }).catch((e: unknown) => { if (live) setError(e instanceof ApiError ? e.message : "Engine output could not be read."); });
    void load();
    const timer = setInterval(() => { void load(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const current = roles.find((r) => r.role === pick) ?? roles[0];
  return (
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group self-start text-muted-foreground"><ChevronDown aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />Live engine output</Button></CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        {error ? <Problem message={error} /> : roles.length === 0 ? <p className="text-sm text-muted-foreground">No engine has printed anything since the Stack started.</p> : (
          <>
            <div className="flex flex-wrap gap-2">{roles.map((r) => <Button key={r.role} size="sm" variant={r.role === current?.role ? "default" : "outline"} onClick={() => setPick(r.role)}>{r.role}</Button>)}</div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-card p-4 text-xs leading-5 text-card-foreground" tabIndex={0} aria-label="Engine output">{current?.lines.map((l) => l.line).join("\n") || "No output yet."}</pre>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
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
      {installed.length > 0 ? (
        <section aria-labelledby="eng-set-h" className="flex flex-col gap-3">
          <SectionHeader id="eng-set-h" title="Installed engines" count={installed.length} description={`${installed.filter((e) => e.running).length} running now.`} />
          <List label="Engines">
            {installed.map((e) => (
              <ListRow key={e.id} Icon={Cpu} tone={engineKind(e) === "online" ? "ok" : "muted"}
                title={e.label}
                pills={<>
                  <Pill tone={engineKind(e) === "online" ? "ok" : "muted"}>{engineWord(e)}</Pill>
                  {e.update && <Pill tone="primary">Update available</Pill>}
                  {e.needsRestart && <Pill tone="warn">Restart to use the new build</Pill>}
                </>}
                detail={<>Version {e.currentTag ?? "unknown"}{e.update ? `, ${e.update.newest} is available` : ""}.{e.roleReason ? ` ${e.roleReason}` : ""}</>}
                actions={<>
                  {e.running && <Button size="sm" variant="outline" disabled={busy === e.name} onClick={() => { void restart(e); }}>{busy === e.name ? "Restarting" : "Restart"}</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setFilter(filter === e.name ? null : e.name)}>{filter === e.name ? "Show all log lines" : "Show its log lines"}</Button>
                </>} />
            ))}
          </List>
        </section>
      ) : <EmptyState Icon={Cpu} tone="muted" title="No engines yet" text="Turn on a feature and the Stack sets up the engine it needs." />}
      {others.length > 0 && <p className="text-sm text-muted-foreground">{others.length} more {others.length === 1 ? "engine is" : "engines are"} ready to download when a feature needs {others.length === 1 ? "it" : "them"}.</p>}
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group self-start text-muted-foreground"><ChevronDown aria-hidden="true" className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />{filter ? `Log lines for ${filter}` : "Show recent log lines"}</Button></CollapsibleTrigger>
        <CollapsibleContent>
          {logError ? <Problem message={logError} /> : (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-card p-4 text-xs leading-5 text-card-foreground" tabIndex={0} aria-label="Stack log">{shown.length ? shown.join("\n") : "No log lines yet."}</pre>
          )}
        </CollapsibleContent>
      </Collapsible>
      <EngineOutput />
    </div>
  );
}
