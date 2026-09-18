import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { BudgetResponse, CheckResult, HardwareResponse, HealthItem, NotificationRecord, RoleRecord, SpeedResult } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { osPlain } from "@/lib/plainHardware";
import { getIcon } from "@/kit/icons";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Checkbox } from "@/kit/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/kit/ui/toggle-group";
import { Toaster } from "@/kit/ui/sonner";

type Range = "hour" | "day" | "week" | "month";
type Layout = "desktop" | "tablet" | "phone";
type SeriesSample = SpeedResult & { requests?: number; tokensIn?: number; tokensOut?: number; freeBytes?: number; pressure?: string };
type SeriesResponse = { range: string; usage: SeriesSample[]; memory: SeriesSample[]; speed: SeriesSample[] };
type UpdateState = { installed: string; available: string | null };
type UpdatesResponse = { app: UpdateState; engines: UpdateState; models: UpdateState };
type StorageResponse = { freeDiskBytes: number; byCategory: Record<string, number> };
type CountResponse = { models?: Array<unknown>; clients?: Array<unknown>; engines?: Array<unknown> };

const Cpu = getIcon("Cpu");
const Check = getIcon("Check");
const History = getIcon("History");

function formatBytes(bytes: number): string { if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`; if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`; return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`; }
function labelFor(at: string): string { return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function relativeTime(value: string): string { const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000)); if (minutes < 1) return "Just now"; if (minutes < 60) return `${minutes}m ago`; const hours = Math.round(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.round(hours / 24)}d ago`; }
function formatUptime(seconds: number): string { const hours = Math.floor(seconds / 3600); const days = Math.floor(hours / 24); if (days > 0) return `${days}d ${hours % 24}h`; return `${hours}h ${Math.floor(seconds / 60) % 60}m`; }
function initialRange(): Range { const saved = typeof window === "undefined" ? null : window.localStorage.getItem("maipai-overview-range"); return saved === "hour" || saved === "day" || saved === "week" || saved === "month" ? saved : "day"; }
function layoutFor(width: number): Layout { return width >= 1200 ? "desktop" : width >= 640 ? "tablet" : "phone"; }
function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(() => layoutFor(typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => { const update = () => setLayout(layoutFor(window.innerWidth)); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  return layout;
}
function Widget({ title, description, children, className = "" }: { title: string; description?: string; children: ReactNode; className?: string }) { return <Card className={className}><CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader><CardContent>{children}</CardContent></Card>; }

function FactsColumn({ className = "", desktop = false, hardware, healthz, budget, updates, counts, onSpeedTest, speedTesting }: { className?: string; desktop?: boolean; hardware?: HardwareResponse["hardware"]; healthz?: { version: string; uptimeSeconds: number }; budget?: BudgetResponse; updates?: UpdatesResponse; counts: { engines: number; models: number; clients: number }; onSpeedTest: () => void; onCheckStack: () => void; speedTesting: boolean }) {
  const facts = [{ label: "Uptime", value: healthz ? formatUptime(healthz.uptimeSeconds) : "Loading" }, { label: "Memory budget", value: budget ? formatBytes(budget.capBytes) : "Loading" }, { label: "Free disk", value: hardware ? `${formatBytes(hardware.freeDiskBytes)} free` : "Loading" }, { label: "Operating system", value: hardware ? osPlain(hardware.osVersion) : "Loading" }];
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult>();
  const lastCheck = useApiResource<CheckResult | null>("/stack/v1/check/latest");
  async function runCheckNow(): Promise<void> { setChecking(true); try { const result = await api.post<CheckResult>("/stack/v1/check"); setCheckResult(result); await lastCheck.refetch(); } catch (error) { toast.error(error instanceof Error ? error.message : "The Stack check failed."); } finally { setChecking(false); } }
  const visibleCheck = checkResult && Array.isArray(checkResult.results) ? checkResult : undefined;
  const storedCheck = lastCheck.data && Array.isArray(lastCheck.data.results) ? lastCheck.data : undefined;
  const shownCheck = visibleCheck ?? storedCheck;
  const checkSentence = checking ? "Checking your Stack..." : shownCheck ? `Checked ${relativeTime(shownCheck.at).toLowerCase()}, ${shownCheck.ok ? "all good" : "needs attention"}.` : "Not checked yet.";
  return <aside className={`space-y-4 sm:grid sm:grid-cols-2 sm:items-start sm:gap-4 sm:space-y-0 ${desktop ? "lg:block lg:space-y-4" : ""} ${className}`}><Card><CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="size-5 text-primary" />This computer</CardTitle><CardDescription>Local facts from this Stack.</CardDescription></CardHeader><CardContent><div className="flex flex-wrap items-center gap-2 text-sm"><Link className="text-primary" to="/engines">{counts.engines} engines</Link><span aria-hidden="true" className="text-muted-foreground">·</span><Link className="text-primary" to="/models">{counts.models} models</Link><span aria-hidden="true" className="text-muted-foreground">·</span><Link className="text-primary" to="/access">{counts.clients} clients</Link></div></CardContent></Card><Card><CardContent className="space-y-4 p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">Stack version</p><p className="mt-1 font-medium">{updates?.app?.installed ?? "Loading"}</p><p className="text-sm text-muted-foreground">{updates?.app?.available ? "Update available" : "Up to date"}</p></div><Link aria-label="View updates" title="View updates" className="text-muted-foreground hover:text-foreground" to="/updates"><History className="size-4" /></Link></div>{facts.map((fact) => <div className="flex items-center justify-between gap-4 border-t pt-3 text-sm" key={fact.label}><span className="text-muted-foreground">{fact.label}</span><span className="text-right font-medium tabular-nums">{fact.value}</span></div>)}<div className="space-y-2 border-t pt-4"><Button className="w-full" variant="outline" onClick={onSpeedTest}>{speedTesting ? "Measuring..." : "Speed test"}</Button><Button className="w-full" variant="outline" onClick={() => void runCheckNow()}>{checking ? "Checking..." : "Check my Stack"}</Button><p className="text-sm text-muted-foreground" data-check-summary>{checkSentence}</p>{shownCheck && <div className="flex flex-wrap gap-2 text-xs" aria-label="Stack check results">{shownCheck.results.map((result) => <span className={result.ok ? "text-emerald-700" : "text-destructive"} key={result.role}>{result.ok ? "✓" : "×"} {result.role}</span>)}</div>}</div></CardContent></Card></aside>;
}

function FeedCard({ title, items, empty, more }: { title: string; items: Array<{ id: string; primary: string; meta: string }>; empty: string; more: string }) { return <Card><CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="p-0"><div className="divide-y">{items.length ? items.map((item) => <div className="px-5 py-3" key={item.id}><p className="text-sm font-medium">{item.primary}</p><p className="mt-1 text-xs text-muted-foreground">{item.meta}</p></div>) : <p className="px-5 py-4 text-sm text-muted-foreground">{empty}</p>}</div><div className="border-t px-5 py-3"><Link className="text-sm text-primary hover:underline" to="/alerts">{more}</Link></div></CardContent></Card>; }

const abilityLegend = [{ id: "chat", label: "Chat", color: "bg-orange-500" }, { id: "voice", label: "Voice", color: "bg-cyan-500" }, { id: "image", label: "Images", color: "bg-violet-500" }, { id: "video", label: "Video", color: "bg-blue-500" }, { id: "music", label: "Music", color: "bg-emerald-500" }];

function StorageWidget({ storage }: { storage: StorageResponse | undefined }) {
  const categories = ["models", "engines", "logs", "backups"].map((id) => ({ id, value: storage?.byCategory?.[id] ?? 0 }));
  const total = categories.reduce((sum, category) => sum + category.value, 0);
  return <Widget title="Storage" description="Local disk used by the Stack."><div className="space-y-3">{total > 0 && <div className="flex h-8 overflow-hidden rounded-md" aria-label="Storage usage">{categories.map((category) => { const percentage = category.value / total * 100; return <div className="flex min-w-0 items-center justify-center bg-primary/80 px-1 text-[10px] text-primary-foreground even:bg-primary/40" key={category.id} style={{ width: `${Math.max(3, percentage)}%` }} title={`${category.id}: ${formatBytes(category.value)}`}>{percentage >= 18 ? `${category.id} ${Math.round(percentage)}%` : ""}</div>; })}</div>}<div className="space-y-1 text-xs text-muted-foreground">{categories.map((category) => <div className="flex items-center justify-between gap-3" key={category.id}><span>{category.id}</span><span className="tabular-nums">{formatBytes(category.value)}</span></div>)}</div><p className="text-sm text-muted-foreground">{storage ? `${formatBytes(storage.freeDiskBytes)} free` : "Waiting for storage accounting."}</p></div></Widget>;
}

export function OverviewPage() {
  const layout = useLayout();
  const [range, setRange] = useState<Range>(initialRange);
  const [speedTesting, setSpeedTesting] = useState(false);
  const [visibleAbilities, setVisibleAbilities] = useState<Record<string, boolean>>(() => Object.fromEntries(abilityLegend.map((ability) => [ability.id, true])));
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const hardware = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const healthz = useApiResource<{ version: string; uptimeSeconds: number }>("/healthz");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const engines = useApiResource<CountResponse>("/stack/v1/engines");
  const models = useApiResource<CountResponse>("/stack/v1/models");
  const clients = useApiResource<CountResponse>("/stack/v1/clients");
  const updates = useApiResource<UpdatesResponse>("/stack/v1/updates");
  const storage = useApiResource<StorageResponse>("/stack/v1/storage");
  const apiRange = range === "month" ? "week" : range;
  const series = useApiResource<SeriesResponse>(`/stack/v1/series?range=${apiRange}&window=${range}`);
  useEffect(() => { window.localStorage.setItem("maipai-overview-range", range); }, [range]);
  const roleRows = roles.data?.roles ?? [];
  const ready = roleRows.filter((role) => role.state === "ready").length;
  const attention = (health.data?.health ?? []).length;
  const usage = (series.data?.usage ?? []).filter((item) => { const ability = item.ability === "stt" || item.ability === "tts" ? "voice" : item.ability ?? "chat"; return visibleAbilities[ability] !== false; }).map((item) => ({ ...item, label: labelFor(item.at), tokens: (item.tokensIn ?? 0) + (item.tokensOut ?? 0) }));
  const memory = (series.data?.memory ?? []).map((item) => ({ ...item, label: labelFor(item.at), free: Math.round((item.freeBytes ?? 0) / 1_073_741_824 * 10) / 10 }));
  const speed = (series.data?.speed ?? []).map((item) => ({ ...item, label: labelFor(item.at), tps: item.tokensPerSecond ?? 0 }));
  const latestSpeed = speed.at(-1);
  const previousSpeed = speed.at(-2);
  const speedSentence = latestSpeed?.tokensPerSecond ? `Your Mac: ${latestSpeed.tokensPerSecond} tokens per second on ${latestSpeed.modelId ?? "the resident chat model"}${previousSpeed?.tokensPerSecond ? `, was ${previousSpeed.tokensPerSecond} before ${latestSpeed.engine ?? "the last engine update"}` : ""}.` : "No speed test has been recorded yet.";
  const healthItems = (health.data?.health ?? []).slice(0, 4).map((item) => ({ id: item.code, primary: item.title, meta: `${relativeTime(item.since)} · ${item.text}` }));
  const activityItems = (notifications.data?.notifications ?? []).slice(0, 4).map((item) => ({ id: item.id, primary: item.title, meta: relativeTime(item.at) }));
  const statusLinks = [{ label: "Ready", value: ready, href: "/models", tone: "default" as const }, { label: "Roles", value: roleRows.length, href: "/engines", tone: "secondary" as const }, { label: "Attention", value: attention, href: "/alerts", tone: attention ? "destructive" as const : "secondary" as const }];
  const layoutClass = layout === "desktop" ? "lg:grid-cols-12" : layout === "tablet" ? "sm:grid-cols-1" : "grid-cols-1";
  const desktopColumns = layout === "desktop";
  async function runSpeedTestNow(): Promise<void> { setSpeedTesting(true); try { await api.post<{ result: SpeedResult }>("/stack/v1/speed-test"); await series.refetch(); } catch (error) { toast.error(error instanceof Error ? error.message : "The speed test failed."); } finally { setSpeedTesting(false); } }
  return <><Toaster /><main className="mx-auto w-full max-w-7xl space-y-5 px-4 py-5 sm:px-8 lg:px-10 lg:py-6"><p className="text-sm text-muted-foreground">A measured view of this computer, its abilities, and what the Stack has been doing.</p><div data-layout={layout} className={`grid gap-5 ${layoutClass}`}><FactsColumn desktop={desktopColumns} className={desktopColumns ? "lg:col-span-3 lg:sticky lg:top-5 lg:self-start" : ""} hardware={hardware.data?.hardware} healthz={healthz.data} budget={budget.data} updates={updates.data} counts={{ engines: engines.data?.engines?.length ?? 0, models: models.data?.models?.length ?? 0, clients: clients.data?.clients?.length ?? 0 }} speedTesting={speedTesting} onSpeedTest={() => void runSpeedTestNow()} onCheckStack={() => toast("Coming with the Check my Stack item.")} /><section className={`min-w-0 space-y-5 ${desktopColumns ? "lg:col-span-6" : ""}`}><div className="grid gap-3 sm:grid-cols-3">{statusLinks.map((status) => <Link to={status.href} key={status.label}><Card className="h-full hover:border-primary/50"><CardContent className="flex min-w-0 flex-col items-start gap-2 p-4"><div><p className="text-sm text-muted-foreground">{status.label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{status.value}</p></div><Badge className="max-w-full whitespace-normal text-left leading-tight" variant={status.tone}>{status.label === "Attention" && status.value === 0 ? "All clear" : status.label === "Roles" ? "Serving locally" : "Available now"}</Badge></CardContent></Card></Link>)}</div><div className="grid gap-5 sm:grid-cols-2"><Widget title="Usage" description="Requests and tokens served in the selected range."><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap items-center gap-2">{abilityLegend.map((ability) => <label className="flex items-center gap-1.5 text-xs text-muted-foreground" key={ability.id}><Checkbox aria-label={ability.label} className="size-3.5" checked={visibleAbilities[ability.id] !== false} onCheckedChange={(checked) => setVisibleAbilities((current) => ({ ...current, [ability.id]: checked === true }))} /><span className={`size-2 rounded-full ${ability.color}`} />{ability.label}</label>)}</div><ToggleGroup type="single" value={range} onValueChange={(value) => { if (value) setRange(value as Range); }} variant="outline" size="sm" aria-label="Time range"><ToggleGroupItem value="hour" aria-label="1h">1h</ToggleGroupItem><ToggleGroupItem value="day" aria-label="1D">1D</ToggleGroupItem><ToggleGroupItem value="week" aria-label="1W">1W</ToggleGroupItem><ToggleGroupItem value="month" aria-label="1M">1M</ToggleGroupItem></ToggleGroup></div><div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={usage}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="label" /><YAxis /><Tooltip /><Area type="monotone" dataKey="requests" name="Requests" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .16)" /><Area type="monotone" dataKey="tokens" name="Tokens" stroke="hsl(190 90% 40%)" fill="hsl(190 90% 40% / .10)" /></AreaChart></ResponsiveContainer></div></Widget><Widget title="Memory" description="Free memory and pressure from the kernel ledger."><div className="h-64"><ResponsiveContainer width="100%" height="100%"><AreaChart data={memory}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="label" /><YAxis unit=" GB" /><Tooltip /><Area type="monotone" dataKey="free" name="Free GB" stroke="hsl(190 90% 40%)" fill="hsl(190 90% 40% / .14)" /></AreaChart></ResponsiveContainer></div><p className="mt-3 flex items-center gap-2 text-sm"><Check className="size-4 text-emerald-600" />{budget.data?.pressure === "normal" ? "Memory headroom is good" : budget.data?.pressure === "warn" ? "Memory is getting tight" : "Memory pressure is high"}</p></Widget></div><div className="grid gap-5 sm:grid-cols-2"><Widget title="Speed" description="Latest local chat throughput."><p className="mb-3 text-sm font-medium">{speedSentence}</p><div className="h-44"><ResponsiveContainer width="100%" height="100%"><AreaChart data={speed}><CartesianGrid strokeDasharray="3 3" className="stroke-border" />{hardware.data?.proposed?.speedRange && <ReferenceArea y1={hardware.data.proposed.speedRange.min} y2={hardware.data.proposed.speedRange.max} fill="hsl(190 90% 40% / .12)" strokeOpacity={0} />}<XAxis dataKey="label" /><YAxis unit=" t/s" /><Tooltip /><Area type="monotone" dataKey="tps" name="Tokens/s" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .14)" /></AreaChart></ResponsiveContainer></div>{hardware.data?.proposed?.speedRange && <p className="mt-2 text-xs text-muted-foreground">Expected for {hardware.data.proposed.id}: {hardware.data.proposed.speedRange.min} to {hardware.data.proposed.speedRange.max} tokens per second.</p>}</Widget><StorageWidget storage={storage.data} /></div><Widget title="Loaded now" description="Resident work stays visible and measured."><div className="space-y-3">{(budget.data?.loaded ?? []).slice(0, 4).map((item) => <div className="flex items-center justify-between gap-3" key={item.id}><span className="truncate text-sm">{item.id}</span><span className="text-sm text-muted-foreground">{formatBytes(item.peakBytes)}</span></div>)}{(budget.data?.loaded ?? []).length === 0 && <p className="text-sm text-muted-foreground">Nothing is loaded yet.</p>}</div></Widget></section><aside className={`space-y-5 ${desktopColumns ? "lg:col-span-3" : ""}`}><FeedCard title="Recent activity" items={activityItems} empty="No notifications yet." more="Show more" /><FeedCard title="Health" items={healthItems} empty="No repairs needed." more="Show more" /></aside></div></main></>;
}
