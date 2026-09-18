import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { type BudgetResponse, type RepairRecord, type RoleRecord } from "@/lib/api";
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

const Copy = getIcon("Copy"); const ExternalLink = getIcon("ExternalLink"); const Gauge = getIcon("Gauge"); const Search = getIcon("Search"); const Server = getIcon("Server");

const sections = ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"];
const sectionPaths: Record<string, string> = { Overview: "/", Abilities: "/abilities", Models: "/models", Engines: "/engines", Monitoring: "/monitoring", Alerts: "/alerts", Updates: "/updates", Backups: "/backups", Access: "/access", "Try it": "/try", Settings: "/settings" };

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-8 text-center"><div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Server className="size-5" /></div><p className="font-medium">{title}</p><p className="max-w-md text-base text-muted-foreground">{detail}</p>{action}</CardContent></Card>;
}

export type SectionFrameComponent = ({ title, description, children }: { title: string; description: string; children: ReactNode }) => ReactNode;

export function SectionFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="mx-auto w-full max-w-7xl space-y-7 px-4 py-7 sm:px-8 lg:px-10 lg:py-10"><div><p className="text-sm font-medium text-primary">MaiPai Stack</p><h2 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h2><p className="mt-2 text-base text-muted-foreground">{description}</p></div>{children}</main>;
}

function MonitoringPage() {
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const groups = useApiResource<{ groups: Array<{ id: string; name: string; usage: { requests: number; tokens: number }; memoryBytes: number }> }>("/stack/v1/groups");
  const underPressure = budget.data?.pressure === "warn" || budget.data?.pressure === "critical";
  const used = budget.data ? Math.max(0, budget.data.capBytes - budget.data.freeMemoryBytes) / 1_073_741_824 : 0;
  const samples = useMemo(() => Array.from({ length: 8 }, (_, index) => ({ time: `${index + 1}m`, memory: Math.max(0, used - (7 - index) * 0.08) })), [used]);
  return <SectionFrame title="Monitoring" description="Memory pressure, queue health, and the governor's current budget."><div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><Card><CardHeader><CardTitle>Memory budget</CardTitle><CardDescription>Recent samples are local to this Stack.</CardDescription></CardHeader><CardContent><div className="h-64 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={samples}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="time" /><YAxis unit=" GB" /><Tooltip /><Area type="monotone" dataKey="memory" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .18)" /></AreaChart></ResponsiveContainer></div></CardContent></Card><Card><CardHeader><CardTitle>Governor</CardTitle><CardDescription>What happens when memory gets tight.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex items-center gap-3"><Gauge className="text-primary" /><span>{underPressure ? "Under pressure" : "Within budget"}</span></div><p className="text-base text-muted-foreground">{budget.data ? `${Math.round(used * 10) / 10} GB in use from a ${Math.round(budget.data.capBytes / 1_073_741_824)} GB cap.` : "Waiting for the memory governor."}</p><Separator /><p className="text-base text-muted-foreground">Jobs yield before the computer becomes unpleasant to use.</p><Separator /><div><p className="font-medium">Utilization by group</p><div className="mt-3 space-y-3">{(groups.data?.groups ?? []).map((group) => <div key={group.id}><div className="flex justify-between text-sm"><span>{group.name}</span><span className="text-muted-foreground">{group.usage.requests} requests</span></div><div className="mt-1 h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(8, group.usage.requests / 20))}%` }} /></div></div>)}</div></div></CardContent></Card></div></SectionFrame>;
}

function SimplePage({ title, description, emptyTitle, emptyDetail, action }: { title: string; description: string; emptyTitle: string; emptyDetail: string; action?: ReactNode }) { return <SectionFrame title={title} description={description}><EmptyState title={emptyTitle} detail={emptyDetail} action={action} /></SectionFrame>; }

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  function go(path: string) { onOpenChange(false); navigate(path); }
  return <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Stack" description="Jump to a Stack section or action."><CommandInput placeholder="Search sections and actions..." /><CommandList><CommandEmpty>No matching section.</CommandEmpty><CommandGroup heading="Sections">{sections.map((section) => <CommandItem key={section} value={section} onSelect={() => go(sectionPaths[section] ?? "/")}><Search />{section}</CommandItem>)}</CommandGroup><CommandGroup heading="Actions"><CommandItem onSelect={() => go("/api/docs")}><ExternalLink />Open API docs</CommandItem><CommandItem onSelect={() => { void navigator.clipboard?.writeText(window.location.href); onOpenChange(false); }}><Copy />Copy board URL</CommandItem></CommandGroup></CommandList></CommandDialog>;
}

export function DashboardShell() {
  const location = useLocation(); const [paletteOpen, setPaletteOpen] = useState(false);
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const refetchRepairs = repairs.refetch; const refetchRoles = roles.refetch;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { const envelope = JSON.parse(event.data) as { id?: string }; if (envelope.id === "repair") void refetchRepairs(); if (envelope.id === "role.state") void refetchRoles(); } catch { /* An invalid event cannot take down the shell. */ } }; return () => stream.close(); }, [refetchRepairs, refetchRoles]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); } if (event.key === "/" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement)?.tagName)) { event.preventDefault(); setPaletteOpen(true); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  const title = sections.find((item) => sectionPaths[item] === location.pathname) ?? "Overview";
  const repairRows = repairs.data?.repairs ?? []; const roleRows = roles.data?.roles ?? [];
  return <SidebarProvider><AppSidebar repairs={repairRows} roles={roleRows} /><SidebarInset><SiteHeader title={title} onSearch={() => setPaletteOpen(true)} /><Routes><Route path="/" element={<BoardPageProxy />} /><Route path="/abilities" element={<AbilitiesProxy />} /><Route path="/models" element={<ModelsPage Frame={SectionFrame} />} /><Route path="/engines" element={<EnginesPage Frame={SectionFrame} />} /><Route path="/monitoring" element={<MonitoringPage />} /><Route path="/alerts" element={<AlertsPage Frame={SectionFrame} />} /><Route path="/updates" element={<SimplePage title="Updates" description="Keep the Stack current without losing control." emptyTitle="Updates are checked on request" emptyDetail="There is nothing to apply yet. The update service will appear here when an update is available." />} /><Route path="/backups" element={<SimplePage title="Backups" description="A quiet place for the data that belongs to your household." emptyTitle="No backup target yet" emptyDetail="Choose where the Stack should keep an encrypted backup before the first backup runs." />} /><Route path="/access" element={<AccessPage Frame={SectionFrame} />} /><Route path="/try" element={<TryItPage />} /><Route path="/settings" element={<SimplePage title="Settings" description="The essentials for this local Stack." emptyTitle="Settings stay intentionally small" emptyDetail="Port, data directory, and service state will appear here as the Stack grows." />} /><Route path="*" element={<BoardPageProxy />} /></Routes></SidebarInset><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} /></SidebarProvider>;
}

function BoardPageProxy() { const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles"); const hasPlan = roles.data?.roles.some((role) => role.state !== "notInstalled"); return hasPlan ? <OverviewPage /> : <BoardPage embedded />; }
function AbilitiesProxy() { return <BoardPage embedded showAbilities />; }
