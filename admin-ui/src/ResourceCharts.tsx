// The Resources history charts: kit chart container (recharts), tokens only.
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@maipai/ui/src/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@maipai/ui/src/ui/chart";
import type { ChartConfig } from "@maipai/ui/src/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@maipai/ui/src/ui/toggle-group";
import { bytes } from "./format";
import { MARKER_WORDS, hasValues, roleColor, timeLabel, visibleMarkers } from "./resourceData";
import type { Marker, Range } from "./resourceData";

const Y_WIDTH = 52; // the memory chart's axis width; the event strip pads by the same amount so its dots line up with the plot
const GB = 1024 ** 3;

export function Empty({ children }: { children: string }) {
  return <p className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">{children}</p>;
}

export function ChartCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <Card className="glass border-0 shadow-none">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A legend that wraps on a phone and names every series. */
export function Legend({ items }: { items: { id: string; label: string; color: string; note?: string }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground" aria-label="Chart legend">
      {items.map((i) => (
        <li key={i.id} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: i.color }} />
          <span className="text-foreground">{i.label}</span>{i.note && <span>{i.note}</span>}
        </li>
      ))}
    </ul>
  );
}

const tick = (range: Range) => (t: number) => timeLabel(t, range);
const tipLabel = (range: Range) => (_: unknown, p: readonly { payload?: { t?: number } }[] | undefined) => (p?.[0]?.payload?.t ? timeLabel(Number(p[0].payload.t), range) : "");

/** Memory by feature, stacked, with a dashed line for each timeline event. */
export function MemoryStack({ rows, keep, labels, range, markers }: { rows: Record<string, number>[]; keep: string[]; labels: Record<string, string>; range: Range; markers: Marker[] }) {
  const config = useMemo<ChartConfig>(() => {
    const c: ChartConfig = { other: { label: "Other apps and the system", color: "var(--muted-foreground)" } };
    for (const id of keep) c[id] = { label: labels[id] ?? id, color: roleColor(id) };
    return c;
  }, [keep, labels]);
  const [all, setAll] = useState(false);
  const from = rows[0]?.t ?? 0, to = rows[rows.length - 1]?.t ?? 0;
  const shown = visibleMarkers(markers, from, to, 24);
  // Everything else is usually far bigger than any one feature and flattens them, so it is behind a switch.
  const ids = all || keep.length === 0 ? [...keep, "other"] : keep;
  return (
    <>
      {keep.length > 0 && (
        <ToggleGroup type="single" variant="outline" size="sm" value={all ? "all" : "features"} onValueChange={(v) => { if (v) setAll(v === "all"); }} aria-label="What to chart" className="mb-3">
          <ToggleGroupItem value="features">Features only</ToggleGroupItem>
          <ToggleGroupItem value="all">With other apps</ToggleGroupItem>
        </ToggleGroup>
      )}
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <AreaChart data={rows} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" domain={[from, to]} tickFormatter={tick(range)} tickLine={false} axisLine={false} minTickGap={48} />
          <YAxis width={Y_WIDTH} tickCount={4} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${Math.round(v)} GB`} />
          {shown.map((m, i) => <ReferenceLine key={`${m.t}-${i}`} x={m.t} stroke={MARKER_WORDS[m.kind].color} strokeDasharray="3 4" strokeOpacity={0.7} />)}
          <ChartTooltip content={<ChartTooltipContent labelFormatter={tipLabel(range)} formatter={(v, name) => <span className="flex w-full justify-between gap-4"><span>{config[String(name)]?.label ?? name}</span><span className="tabular-nums">{bytes(Number(v) * GB)}</span></span>} />} />
          {ids.map((id) => <Area key={id} dataKey={id} type="monotone" stackId="mem" stroke={`var(--color-${id})`} fill={`var(--color-${id})`} fillOpacity={0.55} isAnimationActive={false} />)}
        </AreaChart>
      </ChartContainer>
      <EventStrip markers={shown} from={from} to={to} range={range} />
      <Legend items={ids.map((id) => ({ id, label: String(config[id]?.label ?? id), color: id === "other" ? "var(--muted-foreground)" : roleColor(id) }))} />
    </>
  );
}

/** One dot per event under the chart, at its time. Hover or tap a dot for the sentence; the list below says the same for a touch screen. */
export function EventStrip({ markers, from, to, range }: { markers: Marker[]; from: number; to: number; range: Range }) {
  const [picked, setPicked] = useState<number | null>(null);
  const span = Math.max(1, to - from);
  const kinds = [...new Set(markers.map((m) => m.kind))];
  if (markers.length === 0) return <p className="mt-2 text-xs text-muted-foreground">No loads, unloads, restarts or mode switches in this range.</p>;
  const pick = picked === null ? null : markers[picked] ?? null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="relative h-6" style={{ marginLeft: Y_WIDTH, marginRight: 8 }}>
        <div aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-border" />
        {markers.map((m, i) => (
          <button key={`${m.t}-${i}`} type="button" onClick={() => setPicked(picked === i ? null : i)} title={`${MARKER_WORDS[m.kind].word}, ${timeLabel(m.t, range)}: ${m.text}`} aria-label={`${MARKER_WORDS[m.kind].word} at ${timeLabel(m.t, range)}: ${m.text}`}
            className="absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ left: `${((m.t - from) / span) * 100}%` }}>
            <span className="block size-2.5 rounded-full ring-2 ring-card" style={{ background: MARKER_WORDS[m.kind].color }} />
          </button>
        ))}
      </div>
      <p className="min-h-5 text-sm" aria-live="polite">{pick ? <><span className="font-medium">{MARKER_WORDS[pick.kind].word}</span> <span className="text-muted-foreground">at {timeLabel(pick.t, range)}.</span> {pick.text}</> : <span className="text-muted-foreground">Tap a dot to see what happened.</span>}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Event key">
        {kinds.map((k) => <li key={k} className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: MARKER_WORDS[k].color }} />{MARKER_WORDS[k].word}</li>)}
      </ul>
    </div>
  );
}

type LoadRow = { t: number; [k: string]: number | null };
/** One or two lines over time. A null reading is a gap, never a zero. */
export function LineCard({ title, description, rows, series, range, format, axisFormat, none, domain, ticks, note }: {
  title: string; description: string; rows: LoadRow[]; series: { key: string; label: string; color: string }[]; range: Range;
  format: (v: number) => string; axisFormat: (v: number) => string; none: string; domain?: [number, number | "auto"]; ticks?: number[]; note?: string;
}) {
  const live = series.filter((s) => hasValues(rows, s.key));
  const config = useMemo<ChartConfig>(() => Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])), [series]);
  const ok = rows.length >= 2 && live.length > 0;
  const from = rows[0]?.t ?? 0, to = rows[rows.length - 1]?.t ?? 0;
  return (
    <ChartCard title={title} description={description}>
      {!ok ? <Empty>{none}</Empty> : (
        <>
          <ChartContainer config={config} className="aspect-auto h-44 w-full">
            <LineChart data={rows} margin={{ left: 0, right: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="t" type="number" domain={[from, to]} tickFormatter={tick(range)} tickLine={false} axisLine={false} minTickGap={48} />
              <YAxis width={40} tickCount={4} ticks={ticks} tickLine={false} axisLine={false} tickFormatter={axisFormat} allowDecimals={false} domain={domain ?? [0, "auto"]} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={tipLabel(range)} formatter={(v, name) => <span className="flex w-full justify-between gap-4"><span>{config[String(name)]?.label ?? name}</span><span className="tabular-nums">{format(Number(v))}</span></span>} />} />
              {live.map((s) => <Line key={s.key} dataKey={s.key} type="monotone" stroke={`var(--color-${s.key})`} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />)}
            </LineChart>
          </ChartContainer>
          <Legend items={series.map((s) => ({ id: s.key, label: s.label, color: s.color, note: hasValues(rows, s.key) ? undefined : "not measured" }))} />
          {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
        </>
      )}
    </ChartCard>
  );
}
