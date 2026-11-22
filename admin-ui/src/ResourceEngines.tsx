// Per-engine table (a card list on a phone) and the detail sheet behind each row.
import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMediaQuery } from "usehooks-ts";
import { Button } from "@maipai/ui/src/ui/button";
import { Card, CardContent } from "@maipai/ui/src/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maipai/ui/src/ui/sheet";
import { StatusIndicator } from "@maipai/ui/src/ui/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maipai/ui/src/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@maipai/ui/src/ui/toggle-group";
import { IconChip } from "./kit";
import { ago, bytes, uptime } from "./format";
import { roleIcon } from "./roleIcons";
import { SORTS, roleColor, shortWhy, sortEngines, stateKind, stateWord, whyLine } from "./resourceData";
import type { EngineRow, SortKey } from "./resourceData";

const NOT_RUNNING = "Not running";
const share = (n: number, total: number) => (total > 0 ? `${n / total >= 0.1 ? Math.round((n / total) * 100) : ((n / total) * 100).toFixed(1)}%` : "");

export function EngineDetail({ row, total, modelName, onClose }: { row: EngineRow | null; total: number; modelName: (id: string | null) => string | null; onClose: () => void }) {
  const phone = useMediaQuery("(max-width: 639px)");
  return (
    <Sheet open={row !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side={phone ? "bottom" : "right"} className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        {row && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2"><StatusIndicator status={stateKind(row.state)} ping={false} />{row.label}</SheetTitle>
              <SheetDescription>{stateWord(row.state)}{row.last_used_at ? `, last used ${ago(row.last_used_at)}` : ""}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4 pb-6 text-sm">
              <p className="rounded-xl bg-[var(--fill-1)] p-3 leading-relaxed">{whyLine(row, modelName(row.model_id), bytes)}</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Fact label="Memory now" value={row.memory_bytes > 0 ? `${bytes(row.memory_bytes)} (${share(row.memory_bytes, total)} of the computer)` : NOT_RUNNING} />
                <Fact label="Peak, last 24 hours" value={row.peak_bytes_24h ? bytes(row.peak_bytes_24h) : "No reading yet"} />
                <Fact label="Average, last 24 hours" value={row.mean_bytes_24h ? bytes(row.mean_bytes_24h) : "No reading yet"} />
                <Fact label="Uptime" value={row.uptime_seconds === null ? NOT_RUNNING : uptime(row.uptime_seconds)} />
                <Fact label="Restarts" value={`${row.restarts_24h} in 24 hours, ${row.restarts_7d} in 7 days`} />
                <Fact label="Model" value={modelName(row.model_id) ?? row.model_id ?? "None loaded"} sub={row.model_bytes ? `${bytes(row.model_bytes)} file` : undefined} />
                <Fact label="Process" value={row.engine ?? NOT_RUNNING} sub={row.pid ? `process ${row.pid}` : undefined} />
                <Fact label="Requests open" value={String(row.active_requests)} />
                <Fact label="Speed" value={row.tokens_per_second === null ? "Not measured" : `${row.tokens_per_second.toFixed(1)} tokens per second`} />
                <Fact label="Kept in memory" value={row.pinned ? "Pinned" : row.residency === "resident" ? "Always loaded" : "On demand"} sub={row.queue_position ? `Waiting, place ${row.queue_position}` : undefined} />
              </dl>
              <Button variant="outline" onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-medium">{value}</dd>{sub && <dd className="text-xs text-muted-foreground">{sub}</dd>}</div>;
}

function Head({ id, label, sort, desc, onSort, right }: { id: SortKey; label: string; sort: SortKey; desc: boolean; onSort: (k: SortKey) => void; right?: boolean }) {
  const on = sort === id;
  return (
    <TableHead aria-sort={on ? (desc ? "descending" : "ascending") : "none"} className={right ? "text-end" : undefined}>
      <button type="button" onClick={() => onSort(id)} className={`inline-flex items-center gap-1 rounded-md px-1 py-1 font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${on ? "text-foreground" : ""}`}>
        {label}{on && (desc ? <ArrowDown className="size-3.5" aria-hidden="true" /> : <ArrowUp className="size-3.5" aria-hidden="true" />)}
      </button>
    </TableHead>
  );
}

export function EngineTable({ rows, total, modelName }: { rows: EngineRow[]; total: number; modelName: (id: string | null) => string | null }) {
  const [sort, setSort] = useState<SortKey>("memory");
  const [desc, setDesc] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const sorted = sortEngines(rows, sort, desc);
  const onSort = (k: SortKey) => { if (k === sort) setDesc(!desc); else { setSort(k); setDesc(k !== "name"); } };
  const selected = rows.find((r) => r.role === open) ?? null;
  if (rows.length === 0) return <Card><CardContent className="text-sm text-muted-foreground">No engine is loaded right now. A row appears here when a feature starts its engine.</CardContent></Card>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 lg:hidden">
        <span className="text-sm text-muted-foreground">Sort by</span>
        <ToggleGroup type="single" variant="outline" size="sm" value={sort} onValueChange={(v) => { if (v) { setSort(v as SortKey); setDesc(v !== "name"); } }} aria-label="Sort engines" className="flex-wrap">
          {SORTS.map((s) => <ToggleGroupItem key={s.id} value={s.id}>{s.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>

      <ul className="flex flex-col gap-2 lg:hidden" aria-label="Engines">
        {sorted.map((r) => (
          <li key={r.role}>
            <button type="button" onClick={() => setOpen(r.role)} className="glass glass-lift flex w-full flex-col gap-2 p-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex items-center gap-3">
                <IconChip Icon={roleIcon(r.role)} size="sm" />
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{r.label}</span><span className="block truncate text-xs text-muted-foreground">{modelName(r.model_id) ?? r.model_id ?? "No model loaded"}</span></span>
                <span className="text-end"><span className="block font-semibold tabular-nums">{r.memory_bytes > 0 ? bytes(r.memory_bytes) : "none"}</span><span className="block text-xs text-muted-foreground">{stateWord(r.state)}</span></span>
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">{shortWhy(r)}</span>
              <span className="flex flex-wrap gap-x-4 text-xs text-muted-foreground tabular-nums">
                <span>Peak {r.peak_bytes_24h ? bytes(r.peak_bytes_24h) : "none"}</span><span>Up {r.uptime_seconds === null ? "no" : uptime(r.uptime_seconds)}</span><span>{r.restarts_24h} {r.restarts_24h === 1 ? "restart" : "restarts"}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="glass hidden overflow-hidden lg:block">
        <Table aria-label="Engines">
          <TableHeader>
            <TableRow>
              <Head id="name" label="Feature" sort={sort} desc={desc} onSort={onSort} />
              <TableHead>Process</TableHead>
              <Head id="memory" label="Memory now" sort={sort} desc={desc} onSort={onSort} right />
              <Head id="peak" label="Peak, 24 h" sort={sort} desc={desc} onSort={onSort} right />
              <Head id="uptime" label="Uptime" sort={sort} desc={desc} onSort={onSort} right />
              <Head id="restarts" label="Restarts, 24 h" sort={sort} desc={desc} onSort={onSort} right />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((r) => (
              <TableRow key={r.role} onClick={() => setOpen(r.role)} className="cursor-pointer align-top">
                <TableCell className="max-w-72 whitespace-normal">
                  <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(r.role); }} className="flex w-full items-start gap-2 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span aria-hidden="true" className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: roleColor(r.role) }} />
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 font-medium">{r.label}<span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground"><StatusIndicator status={stateKind(r.state)} ping={false} />{stateWord(r.state)}</span></span>
                      <span className="block text-xs text-muted-foreground">{modelName(r.model_id) ?? r.model_id ?? "No model loaded"}</span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{shortWhy(r)}</span>
                    </span>
                  </button>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.engine ?? NOT_RUNNING}{r.pid ? <span className="block text-xs">process {r.pid}</span> : null}</TableCell>
                <TableCell className="text-end tabular-nums">{r.memory_bytes > 0 ? <><span className="font-medium">{bytes(r.memory_bytes)}</span><span className="block text-xs text-muted-foreground">{share(r.memory_bytes, total)}</span></> : <span className="text-muted-foreground">none</span>}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.peak_bytes_24h ? bytes(r.peak_bytes_24h) : "none"}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.uptime_seconds === null ? "none" : uptime(r.uptime_seconds)}</TableCell>
                <TableCell className="text-end tabular-nums text-muted-foreground">{r.restarts_24h}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <EngineDetail row={selected} total={total} modelName={modelName} onClose={() => setOpen(null)} />
    </div>
  );
}
