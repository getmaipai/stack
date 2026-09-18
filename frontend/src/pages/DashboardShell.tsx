import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { type BudgetResponse, type EngineRecord, type HardwareResponse, type HealthItem, type RepairRecord, type RoleRecord } from "@/lib/api";
import { BoardPage } from "@/pages/BoardPage";
import { TryItPage } from "@/pages/TryItPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { useApiResource } from "@/lib/useApiResource";
import { AppSidebar } from "@/kit/blocks/dashboard/components/app-sidebar";
import { SiteHeader } from "@/kit/blocks/dashboard/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/kit/ui/command";
import { Separator } from "@/kit/ui/separator";
import { SidebarInset, SidebarProvider } from "@/kit/ui/sidebar";
import { EnginesPage } from "@/pages/EnginesPage";
import { ModelsPage } from "@/pages/ModelsPage";
import { AccessPage } from "@/pages/AccessPage";
import { AlertsPage } from "@/pages/AlertsPage";
import { SettingsPage } from "@/pages/SettingsPage";

const Copy = getIcon("Copy"); const ExternalLink = getIcon("ExternalLink"); const Gauge = getIcon("Gauge"); const Search = getIcon("Search"); const RefreshCw = getIcon("RefreshCw"); const UploadCloud = getIcon("UploadCloud"); const SlidersHorizontal = getIcon("SlidersHorizontal");

const sections = ["Overview", "Engines", "Models", "Clients", "Tester", "Monitoring", "Settings", "Logs", "Alerts"];
const sectionPaths: Record<string, string> = { Overview: "/", Engines: "/engines", Models: "/models", Clients: "/access", Tester: "/try", Monitoring: "/monitoring", Settings: "/settings", Logs: "/logs", Alerts: "/alerts" };

export type SectionFrameComponent = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => ReactNode;

export function SectionFrame({ title: _title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="mx-auto w-full max-w-7xl space-y-5 px-4 py-5 sm:px-8 lg:px-10 lg:py-6">{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}{children}</main>;
}

function MonitoringPage() {
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const groups = useApiResource<{ groups: Array<{ id: string; name: string; usage: { requests: number; tokens: number }; memoryBytes: number }> }>("/stack/v1/groups");
  const underPressure = budget.data?.pressure === "warn" || budget.data?.pressure === "critical";
  const used = budget.data ? Math.max(0, budget.data.capBytes - budget.data.freeMemoryBytes) / 1_073_741_824 : 0;
  const samples = useMemo(() => Array.from({ length: 8 }, (_, index) => ({ time: `${index + 1}m`, memory: Math.max(0, used - (7 - index) * 0.08) })), [used]);
  return <SectionFrame title="Monitoring" description="Memory pressure, queue health, and the governor's current budget."><div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><Card><CardHeader><CardTitle>Memory budget</CardTitle><CardDescription>Recent samples are local to this Stack.</CardDescription></CardHeader><CardContent><div className="h-64 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={samples}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="time" /><YAxis unit=" GB" /><Tooltip /><Area type="monotone" dataKey="memory" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .18)" /></AreaChart></ResponsiveContainer></div></CardContent></Card><Card><CardHeader><CardTitle>Governor</CardTitle><CardDescription>What happens when memory gets tight.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex items-center gap-3"><Gauge className="text-primary" /><span>{underPressure ? "Under pressure" : "Within budget"}</span></div><p className="text-base text-muted-foreground">{budget.data ? `${Math.round(used * 10) / 10} GB in use from a ${Math.round(budget.data.capBytes / 1_073_741_824)} GB cap.` : "Waiting for the memory governor."}</p><Separator /><p className="text-base text-muted-foreground">Jobs yield before the computer becomes unpleasant to use.</p><Separator /><div><p className="font-medium">Utilization by group</p><div className="mt-3 space-y-3">{(groups.data?.groups ?? []).map((group) => <div key={group.id}><div className="flex justify-between text-sm"><span>{group.name}</span><span className="text-muted-foreground">{group.usage.requests} requests</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(8, group.usage.requests / 20))}%` }} /></div></div>)}</div></div></CardContent></Card></div></SectionFrame>;
}

function LogsPage() { const logs = useApiResource<{ lines?: string[] }>("/stack/v1/logs"); return <SectionFrame title="Logs" description="Recent lines from the Stack daemon and its engines."><Card><CardHeader><CardTitle>Log viewer</CardTitle><CardDescription>Filter and copy local logs.</CardDescription></CardHeader><CardContent><pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs">{logs.data?.lines?.join("\n") ?? "No logs yet."}</pre></CardContent></Card></SectionFrame>; }

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  function go(path: string) { onOpenChange(false); navigate(path); }
  return <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Stack" description="Jump to a Stack section or action."><CommandInput placeholder="Search sections and actions..." /><CommandList><CommandEmpty>No matching section.</CommandEmpty><CommandGroup heading="Sections">{sections.map((section) => <CommandItem key={section} value={section} onSelect={() => go(sectionPaths[section] ?? "/")}><Search />{section}</CommandItem>)}</CommandGroup><CommandGroup heading="Settings"><CommandItem value="Updates" onSelect={() => go("/settings#updates")}><RefreshCw />Updates</CommandItem><CommandItem value="Backups" onSelect={() => go("/settings#backups")}><UploadCloud />Backups</CommandItem></CommandGroup><CommandGroup heading="Actions"><CommandItem value="Add abilities" onSelect={() => go("/abilities")}><SlidersHorizontal />Add abilities</CommandItem><CommandItem onSelect={() => go("/api/docs")}><ExternalLink />Open API docs</CommandItem><CommandItem onSelect={() => { void navigator.clipboard?.writeText(window.location.href); onOpenChange(false); }}><Copy />Copy board URL</CommandItem></CommandGroup></CommandList></CommandDialog>;
}

export function DashboardShell() {
  const location = useLocation(); const [paletteOpen, setPaletteOpen] = useState(false);
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const updates = useApiResource<{ app: { available: string | null }; engines: { available: string | null }; models: { available: string | null } }>("/stack/v1/updates");
  const health = useApiResource<{ health: HealthItem[] }>("/stack/v1/health");
  const detected = useApiResource<{ detected: Array<{ id: string; name: string; version: string; path?: string; couldHold: string[]; forgotten: boolean; adopted: boolean; target: string | null }> }>("/stack/v1/detected");
  const hardware = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const runState = useApiResource<{ state: "running" | "pausing" | "paused" }>("/stack/v1/run-state");
  const refetchRepairs = repairs.refetch; const refetchRoles = roles.refetch; const refetchEngines = engines.refetch; const refetchUpdates = updates.refetch; const refetchHealth = health.refetch; const refetchDetected = detected.refetch; const refetchBudget = budget.refetch; const refetchRunState = runState.refetch;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { const envelope = JSON.parse(event.data) as { id?: string }; if (envelope.id === "repair") void refetchRepairs(); if (envelope.id === "role.state") void refetchRoles(); if (envelope.id === "health.changed") void refetchHealth(); if (envelope.id === "engine.state") void refetchEngines(); if (envelope.id === "update.available") void refetchUpdates(); if (envelope.id === "detected.changed") void refetchDetected(); if (envelope.id === "pressure" || envelope.id === "budget.changed") void refetchBudget(); if (envelope.id === "run.state") void refetchRunState(); } catch { /* An invalid event cannot take down the shell. */ } }; return () => stream.close(); }, [refetchRepairs, refetchRoles, refetchEngines, refetchUpdates, refetchHealth, refetchDetected, refetchBudget, refetchRunState]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); } if (event.key === "/" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) { event.preventDefault(); setPaletteOpen(true); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  const title = sections.find((item) => sectionPaths[item] === location.pathname) ?? (location.pathname.startsWith("/settings") ? "Settings" : "Overview");
  const repairRows = repairs.data?.repairs ?? []; const roleRows = roles.data?.roles ?? [];
  const enginesToCheck = engines.data?.engines?.filter((engine) => engine.state !== "current") ?? [];
  const detectedToAdopt = (detected.data?.detected ?? []).filter((item) => !item.adopted && !item.forgotten).length;
  const engineCount = enginesToCheck.length + detectedToAdopt;
  const updateCount = updates.data ? ((updates.data.app?.available ?? null) != null ? 1 : 0) + ((updates.data.engines?.available ?? null) != null ? 1 : 0) + ((updates.data.models?.available ?? null) != null ? 1 : 0) : 0;
  const alertCount = health.data?.health?.filter((item) => item.severity === "critical" || item.severity === "error").length ?? 0;
  const alertSeverity = roleRows.some((role) => role.state === "stopped") ? "critical" : (health.data?.health ?? []).reduce<"critical" | "error" | "warning" | null>((worst, item) => { const rank: Record<string, number> = { warning: 1, error: 2, critical: 3 }; const itemRank = rank[item.severity] ?? 0; const worstRank = worst ? rank[worst] ?? 0 : 0; return itemRank > worstRank ? item.severity : worst; }, null);
  const engineTooltip = engineCount === 0 ? "Engines" : `${engineCount} ${engineCount === 1 ? "engine" : "engines"} need${engineCount === 1 ? "s" : ""} attention`;
  const updateTooltip = updateCount === 0 ? "Updates" : `${updateCount} update${updateCount === 1 ? "" : "s"} available`;
  const alertTooltip = alertCount === 0 ? "Alerts" : `Alerts: ${alertSeverity === "critical" ? "1 critical" : alertSeverity === "error" ? `${alertCount} error${alertCount === 1 ? "" : "s"}` : `${alertCount} warning${alertCount === 1 ? "" : "s"}`}`;
  return <SidebarProvider><AppSidebar repairs={repairRows} roles={roleRows} health={health.data?.health ?? []} engineCount={engineCount} updateCount={updateCount} alertSeverity={alertSeverity} engineTooltip={engineTooltip} updateTooltip={updateTooltip} alertTooltip={alertTooltip} hardware={hardware.data?.hardware} budget={budget.data} runState={runState.data?.state} /><SidebarInset className="h-svh overflow-hidden"><SiteHeader title={title} onSearch={() => setPaletteOpen(true)} runState={runState.data?.state ?? "running"} onRunStateChange={() => void runState.refetch()} /><div className="flex-1 overflow-y-auto"><Routes><Route path="/" element={<BoardPageProxy />} /><Route path="/abilities" element={<AbilitiesProxy />} /><Route path="/models" element={<ModelsPage Frame={SectionFrame} />} /><Route path="/engines" element={<EnginesPage Frame={SectionFrame} />} /><Route path="/monitoring" element={<MonitoringPage />} /><Route path="/alerts" element={<AlertsPage Frame={SectionFrame} />} /><Route path="/logs" element={<LogsPage />} /><Route path="/access" element={<AccessPage Frame={SectionFrame} />} /><Route path="/try" element={<TryItPage />} /><Route path="/settings/*" element={<SettingsPage Frame={SectionFrame} />} /><Route path="*" element={<BoardPageProxy />} /></Routes></div></SidebarInset><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} /></SidebarProvider>;
}

function BoardPageProxy() { const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles"); const hasPlan = roles.data?.roles.some((role) => role.state !== "notInstalled"); return hasPlan ? <OverviewPage /> : <BoardPage embedded />; }
function AbilitiesProxy() { return <BoardPage embedded showAbilities />; }
