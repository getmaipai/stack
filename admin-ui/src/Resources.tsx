import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Cpu, Gauge, HardDrive, MemoryStick, Zap } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@maipai/ui/src/ui/collapsible";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { ToggleGroup, ToggleGroupItem } from "@maipai/ui/src/ui/toggle-group";
import { ApiError, api } from "./api";
import { bytes } from "./format";
import { Live, Meter, Pill, SectionHeader, StatTile } from "./kit";
import type { Tone } from "./kit";
import { EngineDetail, EngineTable } from "./ResourceEngines";
import { LineCard, MemoryStack, Empty, ChartCard } from "./ResourceCharts";
import { resourceApi } from "./resourceApi";
import { RANGES, hasRoleHistory, historyRoles, loadRows, memoryRows, chartRoles, nowSegments, pressureWord, roleHistoryRows, stateWord } from "./resourceData";
import type { Engines, History, Marker, Range, Summary } from "./resourceData";
import { StatDetails, type StatKind } from "./StatSheet";

const REFRESH_MS = 5000; // the Stack samples every 5 s, so this is as live as the data gets
const GB = 1024 ** 3;
const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
const shareText = (n: number, total: number) => (total > 0 && n / total < 0.1 ? `${((n / total) * 100).toFixed(1)}%` : `${pct(n, total)}%`);
const NOT_MEASURED = "Not measured";

export function Resources({ changed, go = () => {} }: { changed: unknown; go?: (screen: string) => void }) {
  const [range, setRange] = useState<Range>("1h");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [engines, setEngines] = useState<Engines | null>(null);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [detail, setDetail] = useState<StatKind | null>(null);

  useEffect(() => { void resourceApi.modelNames().then(setNames).catch(() => { /* ids are shown as they are */ }); }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, h, e, m] = await Promise.all([api.resourcesSummary(), api.resourcesHistory(range), resourceApi.engines().catch(() => null), resourceApi.events(range).catch(() => null)]);
        if (!alive) return;
        setSummary(s); setHistory(h); setError(null);
        if (e) setEngines(e);
        if (m) setMarkers(m.events);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : "The Stack did not answer. It may be restarting; this page keeps trying.");
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [range, changed]);

  const modelName = useCallback((id: string | null) => (id ? names[id] ?? null : null), [names]);
  const rows = engines?.engines ?? [];
  const perRole = useMemo(() => (history ? hasRoleHistory(history) : false), [history]);
  const keepRoles = useMemo(() => (history ? historyRoles(history) : []), [history]);
  const labels = useMemo(() => Object.fromEntries(rows.map((r) => [r.role, r.label])), [rows]);
  const stack = useMemo(() => {
    if (!history) return { rows: [] as Record<string, number>[], keep: [] as string[], labels: {} as Record<string, string> };
    if (perRole) return { rows: roleHistoryRows(history, keepRoles), keep: keepRoles, labels };
    // Points recorded before the per-feature figure existed carry process names only.
    const procs = chartRoles(history).map((r) => r.id);
    return { rows: memoryRows(history, procs.map((id) => ({ id }))), keep: procs, labels: {} as Record<string, string> };
  }, [history, perRole, keepRoles, labels]);
  const load = useMemo(() => (history ? loadRows(history) : []), [history]);
  const speed = useMemo(() => (history ? history.points.map((p) => ({ t: p.t, tps: p.tps ? Object.values(p.tps).reduce((a, b) => a + b, 0) : null })) : []), [history]);
  const memPct = useMemo(() => (history ? history.points.map((p) => (p.total > 0 ? (p.used / p.total) * 100 : 0)) : []), [history]);
  const swap = useMemo(() => (history ? history.points.map((p) => ({ t: p.t, swap: p.swap / GB })) : []), [history]);
  const queue = useMemo(() => (history ? history.points.map((p) => ({ t: p.t, queue: p.queue })) : []), [history]);

  if (!summary || !history) {
    if (error) return <Alert variant="destructive" role="alert"><AlertTitle>The Stack is not answering</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
    return <div className="grid gap-4" aria-busy="true" aria-label="Loading"><Skeleton className="h-56" /><Skeleton className="h-32" /><Skeleton className="h-64" /></div>;
  }

  const cur = summary.current;
  const pressure = pressureWord(cur?.pressure);
  const segments = nowSegments(cur, rows, modelName);
  const total = cur?.total ?? 0;
  const used = cur?.used ?? 0;
  const heldByStack = rows.reduce((n, r) => n + r.memory_bytes, 0);
  const cap = engines?.budget.cap_bytes ?? 0;
  const selected = rows.find((r) => r.role === open) ?? null;

  return (
    <div className="flex flex-col gap-8">
      {error && <Alert variant="destructive" role="alert"><AlertTitle>The Stack is not answering</AlertTitle><AlertDescription>{error} Showing the last numbers it gave.</AlertDescription></Alert>}

      <section aria-labelledby="now-h" className="flex flex-col gap-4">
        <h2 id="now-h" className="sr-only">Right now</h2>
        <div className="glass flex flex-col gap-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <p className="text-sm text-muted-foreground">Memory in use right now</p>
              <p className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">{cur ? <Live>{`${bytes(used)} of ${bytes(total)}`}</Live> : "No reading yet"}</p>
            </div>
            <Pill tone={pressure.kind === "online" ? "ok" : pressure.kind === "degraded" ? "warn" : "bad" as Tone}><StatusIndicator status={pressure.kind} ping={false} />{pressure.word}</Pill>
          </div>
          {cur ? (
            <>
              <div className="flex h-5 w-full overflow-hidden rounded-full bg-[var(--fill-2)]" role="img" aria-label={`Memory split: ${segments.map((s) => `${s.label} ${bytes(s.bytes)}`).join(", ")}`}>
                {segments.map((s) => (
                  <button key={s.id} type="button" disabled={s.kind !== "role"} onClick={() => setOpen(s.id)} title={`${s.label}: ${bytes(s.bytes)}, ${shareText(s.bytes, total)}`} aria-label={`${s.label}, ${bytes(s.bytes)}`}
                    className="h-full cursor-default border-e border-card outline-none transition-[width] duration-500 last:border-e-0 enabled:cursor-pointer focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none" style={{ width: `${s.percent}%`, background: s.color }} />
                ))}
              </div>
              <ul className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm lg:grid-cols-2" aria-label="Where memory is going">
                {segments.filter((s) => s.bytes > 0).map((s) => {
                  const row = rows.find((r) => r.role === s.id);
                  const inner = (
                    <>
                      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                      <span className="min-w-0 flex-1 truncate">{s.label}{s.detail && <span className="text-muted-foreground"> · {s.detail}</span>}{row && <span className="text-muted-foreground"> · {stateWord(row.state).toLowerCase()}</span>}</span>
                      <span className="tabular-nums">{bytes(s.bytes)}</span>
                      <span className="w-12 text-end text-muted-foreground tabular-nums">{shareText(s.bytes, total)}</span>
                    </>
                  );
                  return <li key={s.id}>{row ? <button type="button" onClick={() => setOpen(s.id)} className="flex min-h-9 w-full items-center gap-2 rounded-md text-start outline-none hover:bg-[var(--fill-1)] focus-visible:ring-2 focus-visible:ring-ring">{inner}</button> : <div className="flex min-h-9 items-center gap-2">{inner}</div>}</li>;
                })}
              </ul>
              {cap > 0 && (
                <div className="flex flex-col gap-2">
                  <Meter value={heldByStack / cap} tone={heldByStack / cap > 0.9 ? "warn" : "primary"} label="Share of the AI budget in use" />
                  <p className="text-xs text-muted-foreground">The Stack's engines hold {bytes(heldByStack)} of their {bytes(cap)} budget. The budget is the most memory the Stack lets itself use, so there is always room left for everything else.</p>
                </div>
              )}
              {rows.length === 0 && engines && <p className="text-sm text-muted-foreground">No engine is loaded right now, so the Stack itself holds almost nothing. A feature loads its engine the first time it is used.</p>}
            </>
          ) : <p className="text-sm text-muted-foreground">The Stack has not taken its first memory reading yet. It samples every 5 seconds, so this fills in on its own.</p>}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile Icon={MemoryStick} tone={pressure.kind === "online" ? "ok" : pressure.kind === "degraded" ? "warn" : "bad"} label="Memory" value={cur ? `${pct(used, total)}%` : "No reading"} series={memPct} max={100} hint={cur ? `${pressure.word}. Last hour: ${bytes(summary.last_hour.memory_used_mean_bytes)} on average, ${bytes(summary.last_hour.memory_used_peak_bytes)} at most.` : undefined} onOpen={() => setDetail("memory")} />
          <StatTile Icon={Cpu} tone="primary" label="Processor" value={cur?.cpu == null ? "No reading" : `${Math.round(cur.cpu)}%`} series={load.map((r) => r.cpu ?? 0)} max={100} hint={summary.last_hour.cpu_peak == null ? "Needs a second sample." : `Peak ${Math.round(summary.last_hour.cpu_peak)}% in the last hour.`} onOpen={() => setDetail("processor")} />
          <StatTile Icon={HardDrive} tone="muted" label="Models on disk" value={cur?.disk == null ? "No reading" : bytes(cur.disk)} meter={cur?.disk ? Math.min(1, cur.disk / (200 * GB)) : 0} hint="Space used by installed models and engines." onOpen={() => setDetail("models")} />
        </div>

        <Collapsible open={more} onOpenChange={setMore}>
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-xl px-1 py-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <span>More measurements: graphics, speed, swap and waiting requests</span>
            <ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${more ? "rotate-180" : ""}`} aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid grid-cols-2 gap-3 pt-2 xl:grid-cols-4">
              <StatTile Icon={Gauge} tone="primary" label="Graphics" value={cur?.gpu == null ? NOT_MEASURED : `${Math.round(cur.gpu)}%`} hint={cur?.gpu == null ? "This computer gives no cheap graphics reading, so none is shown." : "Share of the graphics chip in use."} onOpen={() => setDetail("graphics")} />
              <StatTile Icon={Zap} tone="primary" label="Speed" value={speedNow(cur?.tps) ?? NOT_MEASURED} hint={cur?.tps ? "Tokens per second, all engines added up." : "Appears once an engine keeps a counter and answers a request."} onOpen={() => setDetail("speed")} />
              <StatTile Icon={MemoryStick} tone="warn" label="Swap" value={cur ? bytes(cur.swap) : "No reading"} hint="Memory pushed to disk. Lower is better." onOpen={() => setDetail("swap")} />
              <StatTile Icon={Cpu} tone="muted" label="Waiting requests" value={cur ? String(cur.queue) : "No reading"} hint={`Most at once in the last hour: ${summary.last_hour.queue_peak}.`} onOpen={() => setDetail("waiting")} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section aria-labelledby="hist-h" className="flex flex-col gap-4">
        <SectionHeader id="hist-h" eyebrow="History" title="Over time" action={
          <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => { if (v) setRange(v as Range); }} aria-label="Time range">
            {RANGES.map((r) => <ToggleGroupItem key={r.id} value={r.id}>{r.label}</ToggleGroupItem>)}
          </ToggleGroup>} />
        <ChartCard title="Memory by feature" description={perRole ? "What each feature's engine holds, with loads, unloads, restarts and mode switches marked." : "Memory by process. Per-feature figures appear as the Stack keeps sampling."}>
          {stack.rows.length < 2 ? <Empty>Not enough history yet. This chart fills in as the Stack keeps sampling.</Empty> : <MemoryStack rows={stack.rows} keep={stack.keep} labels={stack.labels} range={range} markers={markers} />}
        </ChartCard>
        <div className="grid gap-4 lg:grid-cols-2">
          <LineCard title="Processor and graphics" description="Percent of the whole computer in use." rows={load} series={[{ key: "cpu", label: "Processor", color: "var(--chart-1)" }, { key: "gpu", label: "Graphics", color: "var(--chart-4)" }]} range={range} format={(v) => `${Math.round(v)}%`} axisFormat={(v) => `${Math.round(v)}%`} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} none="No processor readings in this range yet." />
          <LineCard title="Speed" description="Tokens per second the engines are writing, added up." rows={speed} series={[{ key: "tps", label: "Tokens per second", color: "var(--chart-1)" }]} range={range} format={(v) => `${v.toFixed(1)} tokens/s`} axisFormat={(v) => `${Math.round(v)}`} none="Not measured yet. It appears once an engine keeps a counter and answers a request." />
          <LineCard title="Swap" description="Memory the system pushed out to disk, in gigabytes." rows={swap} series={[{ key: "swap", label: "Swap", color: "var(--chart-2)" }]} range={range} format={(v) => bytes(v * GB)} axisFormat={(v) => `${v.toFixed(1)}`} none="No swap readings in this range yet." />
          <LineCard title="Waiting requests" description="Requests queued for memory or an engine." rows={queue} series={[{ key: "queue", label: "Waiting", color: "var(--chart-1)" }]} range={range} format={(v) => String(Math.round(v))} axisFormat={(v) => `${Math.round(v)}`} none="No queue readings in this range yet." />
        </div>
      </section>

      <section aria-labelledby="eng-h" className="flex flex-col gap-3">
        <SectionHeader id="eng-h" eyebrow="Per feature" title="Engines" count={rows.length} description="Every engine the Stack runs, what it holds and why. Tap a row for detail." />
        <EngineTable rows={rows} total={total} modelName={modelName} />
      </section>

      <EngineDetail row={selected} total={total} modelName={modelName} onClose={() => setOpen(null)} />
      <StatDetails kind={detail} open={detail !== null} onClose={() => setDetail(null)} go={go} summary={summary} history={history} engines={rows} />
    </div>
  );
}

function speedNow(tps: Record<string, number> | null | undefined): string | null {
  if (!tps) return null;
  const total = Object.values(tps).reduce((a, b) => a + b, 0);
  return `${total.toFixed(1)} tokens/s`;
}
