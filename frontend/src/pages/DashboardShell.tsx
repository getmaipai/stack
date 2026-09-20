import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { type BudgetResponse, type EngineRecord, type HealthItem, type RepairRecord, type RoleRecord, type SetupPlanResponse } from "@/lib/api";
import { allDestinations } from "@/lib/taxonomy";
import { BoardPage } from "@/pages/BoardPage";
import { TryItPage } from "@/pages/TryItPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { useApiResource } from "@/lib/useApiResource";
import { AppSidebar } from "@/kit/blocks/dashboard/components/app-sidebar";
import { SiteHeader } from "@/kit/blocks/dashboard/components/site-header";
import { StackFooter } from "@/kit/blocks/dashboard/components/footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Separator } from "@/kit/ui/separator";
import { SidebarInset, SidebarProvider } from "@/kit/ui/sidebar";
import { EnginesPage } from "@/pages/EnginesPage";
import { ModelsPage } from "@/pages/ModelsPage";
import { AccessPage } from "@/pages/AccessPage";
import { AlertsPage } from "@/pages/AlertsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { HelpPage } from "@/pages/HelpPage";
import { PhoneModeContext } from "@/kit/blocks/phone/PhoneMode";
import { isDesktop, listenForTrayAction, notify, setTraySnapshot } from "@/kit/host";
import { api } from "@/lib/api";
import { RelativeTime } from "@/kit/ui/relative-time";
import { Skeleton } from "@/kit/ui/skeleton";

const Gauge = getIcon("Gauge");

const RAIL_KEY = "maipai-stack:rail";
function readRailPreference(): boolean | null { try { const value = localStorage.getItem(RAIL_KEY); return value === "expanded" ? true : value === "collapsed" ? false : null; } catch { return null; } }
function writeRailPreference(open: boolean): void { try { localStorage.setItem(RAIL_KEY, open ? "expanded" : "collapsed"); } catch { /* a private window may refuse storage */ } }
function defaultRailOpen(): boolean { return typeof window === "undefined" || window.innerWidth >= 1280; }

export type SectionFrameComponent = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => ReactNode;

export function SectionFrame({ title: _title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="mx-auto w-full max-w-7xl space-y-5 px-4 py-5 sm:px-8 lg:px-10 lg:py-6">{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}{children}</main>;
}

function ComingSoonPage({ id }: { id: string }) {
  const destination = allDestinations().find((item) => item.id === id);
  return <SectionFrame title={destination?.label ?? ""} description={destination?.subtitle ?? ""}><p className="text-sm text-muted-foreground">Coming in this release.</p></SectionFrame>;
}

function RedirectToDocs() { const { page } = useParams(); return <Navigate to={page ? `/docs/${page}` : "/docs"} replace />; }

function MonitoringPage() {
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const decisions = useApiResource<{ decisions: Array<{ at: string; decision: string; reason: string; model: string }> }>("/stack/v1/budget/decisions");
  const groups = useApiResource<{ groups: Array<{ id: string; name: string; usage: { requests: number; tokens: number }; memoryBytes: number }> }>("/stack/v1/groups");
  const ready = useApiResource<{ warmup: { hour: number; minute: number } | null }>("/stack/v1/ready");
  const underPressure = budget.data?.pressure === "warn" || budget.data?.pressure === "critical";
  const used = budget.data ? Math.max(0, budget.data.capBytes - budget.data.freeMemoryBytes) / 1_073_741_824 : 0;
  const samples = useMemo(() => Array.from({ length: 8 }, (_, index) => ({ time: `${index + 1}m`, memory: Math.max(0, used - (7 - index) * 0.08) })), [used]);
  const warmup = ready.data?.warmup; const hour = warmup ? warmup.hour % 12 || 12 : 0; const suffix = warmup && warmup.hour >= 12 ? "pm" : "am"; const warmupHour = warmup ? Math.floor(warmup.minute / 60) % 12 || 12 : 0; const warmupMinute = warmup ? String(warmup.minute % 60).padStart(2, "0") : ""; const warmupSuffix = warmup && Math.floor(warmup.minute / 60) >= 12 ? "pm" : "am";
  return <SectionFrame title="Monitoring" description="Memory pressure, queue health, and the governor's current budget."><div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><Card><CardHeader><CardTitle>Memory budget</CardTitle><CardDescription>Recent samples are local to this Stack.</CardDescription></CardHeader><CardContent><div className="h-64 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={samples}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="time" /><YAxis unit=" GB" /><Tooltip /><Area type="monotone" dataKey="memory" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .18)" /></AreaChart></ResponsiveContainer></div><div className="mt-5 space-y-3">{(budget.data?.loaded ?? []).map((model) => <div key={model.id}><div className="flex justify-between text-sm"><span>{model.id}</span><span>{(model.peakBytes / 1_073_741_824).toFixed(1)} GB</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, model.peakBytes / Math.max(1, budget.data?.capBytes ?? 1) * 100)}%` }} /></div></div>)}</div></CardContent></Card><Card><CardHeader><CardTitle>Governor</CardTitle><CardDescription>What happens when memory gets tight.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex items-center gap-3"><Gauge className="text-primary" /><span>{underPressure ? `Memory pressure: ${budget.data?.pressure}` : "Memory pressure: normal"}</span></div><p className="text-base text-muted-foreground">{budget.data ? `${Math.round(used * 10) / 10} GB in use from a ${Math.round(budget.data.capBytes / 1_073_741_824)} GB cap.` : "Waiting for the memory governor."}</p>{warmup && <><Separator /><p className="text-sm text-muted-foreground">You usually chat around {hour} {suffix}; the Stack warms up at {warmupHour}:{warmupMinute} {warmupSuffix}.</p></>}<Separator /><div><p className="font-medium">Last decisions</p><div className="mt-3 space-y-3">{(decisions.data?.decisions ?? []).slice(0, 8).map((item) => <p className="text-sm text-muted-foreground" key={`${item.at}-${item.model}`}>{item.decision} {item.model}: {item.reason} <RelativeTime at={item.at} /></p>)}{(decisions.data?.decisions ?? []).length === 0 && <p className="text-sm text-muted-foreground">No governor decisions yet.</p>}</div></div><Separator /><div><p className="font-medium">Utilization by group</p><div className="mt-3 space-y-3">{(groups.data?.groups ?? []).map((group) => <div key={group.id}><div className="flex justify-between text-sm"><span>{group.name}</span><span className="text-muted-foreground">{group.usage.requests} requests</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(8, group.usage.requests / 20))}%` }} /></div></div>)}</div></div></CardContent></Card></div></SectionFrame>;
}

function LogsPage() { const [level, setLevel] = useState("all"); const [follow, setFollow] = useState(true); const logs = useApiResource<{ lines?: string[] }>("/stack/v1/logs"); useEffect(() => { if (!follow) return; const timer = window.setInterval(() => void logs.refetch(), 2_000); return () => window.clearInterval(timer); }, [follow, logs.refetch]); const lines = (logs.data?.lines ?? []).filter((line) => level === "all" || line.toLocaleLowerCase().includes(`[${level}]`)); return <SectionFrame title="Logs" description="Recent lines from the Stack daemon and its engines."><Card><CardHeader><CardTitle>Log viewer</CardTitle><CardDescription>Filter and follow local logs.</CardDescription></CardHeader><CardContent><div className="mb-3 flex items-center gap-4 text-sm"><label>Level <select aria-label="Log level" value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">All levels</option><option value="error">Error</option><option value="warn">Warning</option><option value="info">Info</option></select></label><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow</label></div><pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs">{lines.length ? lines.join("\n") : "No log lines yet"}</pre></CardContent></Card></SectionFrame>; }

export function DashboardShell() {
  const location = useLocation(); const navigate = useNavigate();
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth < 720);
  const [railOpen, setRailOpen] = useState<boolean>(() => readRailPreference() ?? defaultRailOpen());
  useEffect(() => {
    if (readRailPreference() !== null) return;
    const update = () => setRailOpen(defaultRailOpen());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  function handleRailOpenChange(next: boolean): void { setRailOpen(next); writeRailPreference(next); }
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const updates = useApiResource<{ app: { available: string | null }; engines: { available: string | null }; models: { available: string | null } }>("/stack/v1/updates");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");
  const detected = useApiResource<{ detected: Array<{ id: string; name: string; version: string; path?: string; couldHold: string[]; forgotten: boolean; adopted: boolean; target: string | null }> }>("/stack/v1/detected");
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const runState = useApiResource<{ state: "running" | "pausing" | "paused" }>("/stack/v1/run-state");
  const refetchRepairs = repairs.refetch; const refetchRoles = roles.refetch; const refetchEngines = engines.refetch; const refetchUpdates = updates.refetch; const refetchHealth = health.refetch; const refetchDetected = detected.refetch; const refetchBudget = budget.refetch; const refetchRunState = runState.refetch; const currentRunState = runState.data?.state;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { const envelope = JSON.parse(event.data) as { id?: string; data?: { severity?: string } }; if (envelope.id === "repair") void refetchRepairs(); if (envelope.id === "role.state") void refetchRoles(); if (envelope.id === "health.changed") { void refetchHealth(); if (isDesktop() && (envelope.data?.severity === "critical" || envelope.data?.severity === "error")) void notify("MaiPai Stack health", "The Stack has a serious health item."); } if (envelope.id === "engine.state") void refetchEngines(); if (envelope.id === "update.available") { void refetchUpdates(); if (isDesktop()) void notify("MaiPai Stack update", "An update is available."); } if (envelope.id === "model.installed" && isDesktop()) void notify("MaiPai Stack model", "A model was installed."); if (envelope.id === "detected.changed") void refetchDetected(); if (envelope.id === "pressure" || envelope.id === "budget.changed") void refetchBudget(); if (envelope.id === "run.state") void refetchRunState(); } catch { /* An invalid event cannot take down the shell. */ } }; return () => stream.close(); }, [refetchRepairs, refetchRoles, refetchEngines, refetchUpdates, refetchHealth, refetchDetected, refetchBudget, refetchRunState]);
  // The global ⌘K/"/" listener and its modal moved into SiteHeader's own
  // GlobalSearch, which focuses the real header input per spec ("it is
  // not a separate blank modal") instead of opening a dialog.
  useEffect(() => { const update = () => setPhone(window.innerWidth < 720); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  const roleRows = roles.data?.roles ?? [];
  const enginesToCheck = engines.data?.engines?.filter((engine) => engine.matchesThisMachine && engine.state !== "current") ?? [];
  const detectedToAdopt = (detected.data?.detected ?? []).filter((item) => !item.adopted && !item.forgotten).length;
  const engineCount = enginesToCheck.length + detectedToAdopt;
  const updateCount = updates.data ? ((updates.data.app?.available ?? null) != null ? 1 : 0) + ((updates.data.engines?.available ?? null) != null ? 1 : 0) + ((updates.data.models?.available ?? null) != null ? 1 : 0) : 0;
  const alertCount = health.data?.health?.filter((item) => item.severity === "critical" || item.severity === "error").length ?? 0;
  const alertSeverity = roleRows.some((role) => role.state === "stopped") ? "critical" : (health.data?.health ?? []).reduce<"critical" | "error" | "warning" | null>((worst, item) => { const rank: Record<string, number> = { warning: 1, error: 2, critical: 3 }; const itemRank = rank[item.severity] ?? 0; const worstRank = worst ? rank[worst] ?? 0 : 0; return itemRank > worstRank ? item.severity : worst; }, null);
  const engineTooltip = engineCount === 0 ? "Engines" : `${engineCount} ${engineCount === 1 ? "engine needs" : "engines need"} attention`;
  const updateTooltip = updateCount === 0 ? "Updates" : `${updateCount} update${updateCount === 1 ? "" : "s"} available`;
  const alertTooltip = alertCount === 0 ? "Alerts" : `Alerts: ${alertSeverity === "critical" ? "1 critical" : alertSeverity === "error" ? `${alertCount} error${alertCount === 1 ? "" : "s"}` : `${alertCount} warning${alertCount === 1 ? "" : "s"}`}`;
  useEffect(() => {
    const status = currentRunState === "paused" ? "Paused" : currentRunState === "running" ? "Running" : currentRunState === "pausing" ? "Starting" : "Stopped";
    void setTraySnapshot({ signedIn: true, status, severity: alertSeverity ?? "ok" });
  }, [alertSeverity, currentRunState]);
  useEffect(() => {
    let remove: () => void = () => undefined;
    void listenForTrayAction(() => {
      const next = currentRunState === "paused" ? "running" : "paused";
      void api.post("/stack/v1/run-state", { state: next }).then(() => refetchRunState()).catch(() => navigate("/login"));
    }).then((unlisten) => { remove = unlisten; });
    return () => remove();
  }, [currentRunState, navigate, refetchRunState]);
  useEffect(() => { if (location.pathname !== "/abilities") sessionStorage.setItem("maipai-stack:last-route", location.pathname); }, [location.pathname]);
  const routes = <Routes>
    <Route path="/" element={<BoardPageProxy />} />
    <Route path="/abilities" element={<AbilitiesProxy />} />
    <Route path="/models" element={<ModelsPage Frame={SectionFrame} />} />
    <Route path="/models/:id" element={<Navigate to="/models" replace />} />
    <Route path="/adapters" element={<ComingSoonPage id="adapters" />} />
    <Route path="/apps" element={<ComingSoonPage id="apps" />} />
    <Route path="/runtimes" element={<EnginesPage Frame={SectionFrame} />} />
    <Route path="/engines" element={<Navigate to="/runtimes" replace />} />
    <Route path="/engines/:id" element={<Navigate to="/runtimes" replace />} />
    <Route path="/workflows" element={<ComingSoonPage id="workflows" />} />
    <Route path="/extensions" element={<ComingSoonPage id="extensions" />} />
    <Route path="/training" element={<ComingSoonPage id="training" />} />
    <Route path="/system" element={<ComingSoonPage id="system" />} />
    <Route path="/packages" element={<ComingSoonPage id="packages" />} />
    <Route path="/monitoring" element={<MonitoringPage />} />
    <Route path="/docs" element={<HelpPage Frame={SectionFrame} />} />
    <Route path="/docs/:page" element={<HelpPage Frame={SectionFrame} />} />
    <Route path="/help/:page?" element={<RedirectToDocs />} />
    <Route path="/library" element={<Navigate to="/docs" replace />} />
    <Route path="/alerts" element={<AlertsPage Frame={SectionFrame} />} />
    <Route path="/logs" element={<LogsPage />} />
    <Route path="/clients" element={<AccessPage Frame={SectionFrame} />} />
    <Route path="/access" element={<Navigate to="/clients" replace />} />
    <Route path="/try" element={<TryItPage />} />
    <Route path="/updates" element={<Navigate to="/settings/updates" replace />} />
    <Route path="/backups" element={<Navigate to="/settings/backups" replace />} />
    <Route path="/settings/*" element={<SettingsPage Frame={SectionFrame} />} />
    <Route path="*" element={<BoardPageProxy />} />
  </Routes>;
  return <PhoneModeContext.Provider value={phone}><SidebarProvider open={railOpen} onOpenChange={handleRailOpenChange}><AppSidebar engineCount={engineCount} updateCount={updateCount} alertSeverity={alertSeverity} engineTooltip={engineTooltip} updateTooltip={updateTooltip} alertTooltip={alertTooltip} /><SidebarInset className="h-svh overflow-hidden bg-[var(--surface-page)]"><SiteHeader /><div className="flex-1 overflow-y-auto">{routes}</div><StackFooter /></SidebarInset></SidebarProvider></PhoneModeContext.Provider>;
}

function BoardPageProxy() {
  const setup = useApiResource<SetupPlanResponse>("/stack/v1/setup/plan");
  const [destination, setDestination] = useState<"board" | "overview">();
  useEffect(() => {
    if (!setup.loading && !destination) setDestination(setup.data?.plan ? "overview" : "board");
  }, [destination, setup.data?.plan, setup.loading]);
  if (!destination) return <main className="p-6"><Skeleton className="h-64 w-full" /></main>;
  return destination === "overview" ? <OverviewPage /> : <BoardPage embedded />;
}
function AbilitiesProxy() { return <BoardPage embedded showAbilities />; }
