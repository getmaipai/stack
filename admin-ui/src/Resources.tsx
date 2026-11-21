import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@maipai/ui/src/ui/alert";
import { Badge } from "@maipai/ui/src/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@maipai/ui/src/ui/chart";
import type { ChartConfig } from "@maipai/ui/src/ui/chart";
import { Skeleton } from "@maipai/ui/src/ui/skeleton";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { ToggleGroup, ToggleGroupItem } from "@maipai/ui/src/ui/toggle-group";
import { ApiError, api } from "./api";
import { bytes } from "./format";
import { RANGES, budgetSegments, chartRoles, hasValues, lineRows, memoryRows, pressureWord, seriesColor, timeLabel } from "./resourceData";
import type { History, Range, Summary } from "./resourceData";

const REFRESH_MS = 5000; // the Stack samples every 5 s, so this is as live as the data gets

function Empty({ children }: { children: string }) {
  return <p className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">{children}</p>;
}

function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Resources({ changed }: { changed: unknown }) {
  const [range, setRange] = useState<Range>("1h");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, h] = await Promise.all([api.resourcesSummary(), api.resourcesHistory(range)]);
        if (alive) { setSummary(s); setHistory(h); setError(null); }
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : "The Stack did not answer. It may be restarting; this page keeps trying.");
      }
    };
    void load();
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [range, changed]);

  const kept = useMemo(() => (history ? chartRoles(history) : []), [history]);
  const memory = useMemo(() => (history ? memoryRows(history, kept) : []), [history, kept]);
  const lines = useMemo(() => (history ? lineRows(history) : []), [history]);
  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = { other: { label: "Everything else", color: "var(--muted-foreground)" }, cpu: { label: "CPU", color: "var(--chart-1)" }, swap: { label: "Swap", color: "var(--chart-2)" }, queue: { label: "Waiting requests", color: "var(--chart-1)" }, tps: { label: "Tokens per second", color: "var(--chart-1)" } };
    for (const r of kept) c[r.id] = { label: r.id, color: seriesColor(r.color_key) };
    return c;
  }, [kept]);

  if (!summary || !history) {
    if (error) return <Alert variant="destructive" role="alert"><AlertTitle>Could not reach the Stack</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>;
    return <div className="grid gap-4" aria-busy="true" aria-label="Loading"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  }

  const cur = summary.current;
  const pressure = pressureWord(cur?.pressure);
  const segments = budgetSegments(summary);
  const xTick = (t: number) => timeLabel(t, range);
  const axis = <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={xTick} tickLine={false} axisLine={false} minTickGap={48} />;

  return (
    <div className="flex flex-col gap-6">
      {error && <Alert variant="destructive" role="alert"><AlertTitle>Could not reach the Stack</AlertTitle><AlertDescription>{error} Showing the last numbers it gave.</AlertDescription></Alert>}

      <Card>
        <CardHeader>
          <CardDescription>Memory budget</CardDescription>
          <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
            {cur ? `${bytes(cur.used)} of ${bytes(cur.total)}` : "No reading yet"}
            <Badge variant="secondary" className="gap-1.5"><StatusIndicator status={pressure.kind} ping={false} />{pressure.word}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {cur ? (
            <>
              <div className="flex h-4 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`Memory split: ${segments.map((s) => `${s.label} ${bytes(s.bytes)}`).join(", ")}`}>
                {segments.map((s) => <div key={s.id} title={`${s.label}: ${bytes(s.bytes)}`} className="h-full border-e border-card last:border-e-0 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${s.percent}%`, background: s.color }} />)}
              </div>
              <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 xl:grid-cols-3" aria-label="Memory by owner">
                {segments.map((s) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                    <span className="text-muted-foreground tabular-nums">{bytes(s.bytes)}</span>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">Last hour: used {bytes(summary.last_hour.memory_used_mean_bytes)} on average, {bytes(summary.last_hour.memory_used_peak_bytes)} at most.</p>
            </>
          ) : <p className="text-sm text-muted-foreground">The Stack has not taken its first memory reading yet. It samples every 5 seconds, so this fills in on its own.</p>}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label="CPU" value={cur?.cpu == null ? "No reading" : `${Math.round(cur.cpu)}%`} hint={summary.last_hour.cpu_peak == null ? "Needs a second sample." : `Peak ${Math.round(summary.last_hour.cpu_peak)}% in the last hour.`} />
        <Stat label="Swap" value={cur ? bytes(cur.swap) : "No reading"} hint="Memory pushed to disk. Lower is better." />
        <Stat label="Waiting requests" value={cur ? String(cur.queue) : "No reading"} hint={`Most at once in the last hour: ${summary.last_hour.queue_peak}.`} />
        <Stat label="Models on disk" value={cur?.disk == null ? "No reading" : bytes(cur.disk)} hint="Space used by installed models and engines." />
      </div>

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">History</h2>
        <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => { if (v) setRange(v as Range); }} aria-label="Time range">
          {RANGES.map((r) => <ToggleGroupItem key={r.id} value={r.id}>{r.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <ChartCard title="Memory by engine" description="Gigabytes held by the biggest processes, and by everything else.">
            {memory.length < 2 ? <Empty>Not enough history yet. This chart fills in as the Stack keeps sampling.</Empty> : (
              <ChartContainer config={config} className="aspect-auto h-64 w-full">
                <AreaChart data={memory} margin={{ left: 0, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  {axis}
                  <YAxis width={52} tickCount={4} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v)} GB`} />
                  <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => (p?.[0] ? timeLabel(Number(p[0].payload.t), range) : "")} formatter={(v, name) => <span className="flex w-full justify-between gap-4"><span>{config[String(name)]?.label ?? name}</span><span className="tabular-nums">{bytes(Number(v) * 1024 ** 3)}</span></span>} />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  {[...kept.map((r) => r.id), "other"].map((id) => <Area key={id} dataKey={id} type="monotone" stackId="mem" stroke={`var(--color-${id})`} fill={`var(--color-${id})`} fillOpacity={0.55} isAnimationActive={false} />)}
                </AreaChart>
              </ChartContainer>
            )}
          </ChartCard>
        </div>
        <LineCard title="CPU" description="Percent of the whole computer in use." rows={lines} k="cpu" range={range} config={config} format={(v) => `${Math.round(v)}%`} axisFormat={(v) => `${Math.round(v)}%`} none="No CPU readings in this range yet." />
        <LineCard title="Tokens per second" description="How fast chat engines are writing, added up." rows={lines} k="tps" range={range} config={config} format={(v) => `${v.toFixed(1)} tokens/s`} axisFormat={(v) => `${Math.round(v)}`} none="No engine reports a speed yet. It appears once an engine keeps a counter and answers a request." />
        <LineCard title="Swap" description="Memory the system pushed out to disk, in gigabytes." rows={lines} k="swap" range={range} config={config} format={(v) => bytes(v * 1024 ** 3)} axisFormat={(v) => `${v.toFixed(1)}`} none="No swap readings in this range yet." />
        <LineCard title="Waiting requests" description="How many requests are queued for memory or an engine." rows={lines} k="queue" range={range} config={config} format={(v) => String(Math.round(v))} axisFormat={(v) => `${Math.round(v)}`} none="No queue readings in this range yet." />
      </div>

      <section aria-labelledby="engines-h" className="flex flex-col gap-3">
        <h2 id="engines-h" className="text-lg font-semibold">Engine memory, last hour</h2>
        {summary.roles.length === 0 ? <Card><CardContent className="text-sm text-muted-foreground">No engine process has run yet. Rows appear here when a feature starts one.</CardContent></Card> : (
          <Card>
            <CardContent>
              <ul className="divide-y" aria-label="Engine memory">
                {[...summary.roles].sort((a, b) => b.peak_bytes - a.peak_bytes).slice(0, 8).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0">
                    <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(r.color_key) }} />
                    <span className="min-w-0 flex-1 truncate font-medium">{r.id}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">{r.current_bytes > 0 ? `${bytes(r.current_bytes)} now` : "Not running"}</span>
                    <span className="text-sm text-muted-foreground tabular-nums">peak {bytes(r.peak_bytes)}, average {bytes(r.mean_bytes)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{value}</CardTitle></CardHeader>
      <CardContent className="text-sm text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

function LineCard({ title, description, rows, k, range, config, format, axisFormat, none }: {
  title: string; description: string; rows: ReturnType<typeof lineRows>; k: "cpu" | "tps" | "swap" | "queue"; range: Range; config: ChartConfig;
  format: (v: number) => string; axisFormat: (v: number) => string; none: string;
}) {
  const ok = rows.length >= 2 && hasValues(rows, k);
  return (
    <ChartCard title={title} description={description}>
      {!ok ? <Empty>{none}</Empty> : (
        <ChartContainer config={config} className="aspect-auto h-44 w-full">
          <LineChart data={rows} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t: number) => timeLabel(t, range)} tickLine={false} axisLine={false} minTickGap={48} />
            <YAxis width={40} tickCount={4} tickLine={false} axisLine={false} tickFormatter={axisFormat} allowDecimals={false} domain={k === "cpu" ? [0, 100] : [0, "auto"]} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => (p?.[0] ? timeLabel(Number(p[0].payload.t), range) : "")} formatter={(v) => <span className="tabular-nums">{format(Number(v))}</span>} />} />
            <Line dataKey={k} type="monotone" stroke={`var(--color-${k})`} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ChartContainer>
      )}
    </ChartCard>
  );
}
