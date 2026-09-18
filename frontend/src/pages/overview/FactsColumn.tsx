import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { CheckLatest, CheckResult, CheckStarted } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { osPlain } from "@/lib/plainHardware";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { RelativeTime } from "@/kit/ui/relative-time";
import type { FactsProps } from "./types";

const Cpu = getIcon("Cpu");
const History = getIcon("History");
function bytes(value: number): string { if (value < 1_000_000_000) return `${Math.round(value / 1_000_000)} MB`; if (value < 1_000_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} GB`; return `${(value / 1_000_000_000_000).toFixed(1)} TB`; }
function uptime(seconds: number): string { const hours = Math.floor(seconds / 3600); const days = Math.floor(hours / 24); return days > 0 ? `${days}d ${hours % 24}h` : `${hours}h ${Math.floor(seconds / 60) % 60}m`; }

export function FactsColumn({ hardware, healthz, budget, updates, counts, onSpeedTest, speedTesting }: FactsProps) {
  const [checking, setChecking] = useState(false);

  const latest = useApiResource<CheckResult | CheckLatest | null>("/stack/v1/check/latest");
  useEffect(() => { if (!checking) return; const interval = setInterval(() => { void latest.refetch(); }, 5_000); const timeout = setTimeout(() => { setChecking(false); void latest.refetch(); }, 5 * 60_000); return () => { clearInterval(interval); clearTimeout(timeout); }; }, [checking, latest]);
  async function check(): Promise<void> { setChecking(true); try { await api.post<CheckStarted>("/stack/v1/check"); await latest.refetch(); } catch (error) { setChecking(false); toast.error(error instanceof Error ? error.message : "The Stack check failed."); } }
  const latestComplete = latest.data && Array.isArray((latest.data as CheckResult).results) ? (latest.data as CheckResult) : null;
  const shown = latestComplete;
  const running = latest.data && (latest.data as { state?: string }).state === "running";
  const sentence = running ? "Checking your Stack..." : shown ? <><span>Checked </span><RelativeTime at={shown.at} /><span>, {shown.ok ? "all good" : "needs attention"}.</span></> : "Not checked yet.";
  const facts = [["Uptime", healthz ? uptime(healthz.uptimeSeconds) : "Loading"], ["Memory budget", budget ? bytes(budget.capBytes) : "Loading"], ["Free disk", hardware ? `${bytes(hardware.freeDiskBytes)} free` : "Loading"], ["Next maintenance", "Tonight at 2:00"], ["Operating system", hardware ? osPlain(hardware.osVersion) : "Loading"]];
  return <Card data-widget><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><Cpu className="size-5 text-primary" />This computer</CardTitle><div className="flex flex-wrap items-center gap-2 text-sm"><Link className="text-primary" to="/engines">{counts.engines} engines</Link><span aria-hidden="true" className="text-muted-foreground">·</span><Link className="text-primary" to="/models">{counts.models} models</Link><span aria-hidden="true" className="text-muted-foreground">·</span><Link className="text-primary" to="/access">{counts.clients} clients</Link></div></CardHeader><CardContent className="space-y-3">{facts.map(([label, value]) => <div className="flex items-center justify-between gap-3 border-t pt-3 text-sm" key={label}><span className="text-muted-foreground">{label}</span><span className="text-right font-medium tabular-nums">{value}</span></div>)}<div className="flex items-center justify-between gap-3 border-t pt-3 text-sm"><span>{updates?.app?.available ? "Update available" : "Up to date"}</span><Link aria-label="View updates" title="View updates" className="text-muted-foreground hover:text-foreground" to="/updates"><History className="size-4" /></Link></div><div className="space-y-2 border-t pt-4"><Button className="w-full" variant="outline" onClick={onSpeedTest}>{speedTesting ? "Measuring..." : "Speed test"}</Button><Button className="w-full" variant="outline" onClick={() => void check()}>{checking ? "Checking..." : "Check my Stack"}</Button><div data-status-sentence className="text-sm text-muted-foreground">{sentence}</div>{shown && <div className="flex flex-wrap gap-2 text-xs" aria-label="Stack check results">{shown.results.map((result) => <span className={result.ok ? "text-emerald-700" : "text-destructive"} key={result.role}>{result.ok ? "✓" : "×"} {result.role}</span>)}</div>}</div></CardContent></Card>;
}
