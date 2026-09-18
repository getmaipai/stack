import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Link, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { api, type BudgetResponse, type EngineRecord, type EngineSetting, type NotificationRecord, type RepairRecord, type RoleRecord } from "@/lib/api";
import { BoardPage } from "@/pages/BoardPage";
import { TryItPage } from "@/pages/TryItPage";
import { useApiResource } from "@/lib/useApiResource";
import { AppSidebar } from "@/kit/blocks/dashboard/components/app-sidebar";
import { SiteHeader } from "@/kit/blocks/dashboard/components/site-header";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/kit/ui/command";
import { Separator } from "@/kit/ui/separator";
import { SidebarInset, SidebarProvider } from "@/kit/ui/sidebar";
import { GenericForm } from "@/kit/settings/GenericForm";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";

const Check = getIcon("Check"); const Copy = getIcon("Copy"); const ExternalLink = getIcon("ExternalLink"); const FileKey2 = getIcon("FileKey2"); const Gauge = getIcon("Gauge"); const LoaderCircle = getIcon("LoaderCircle"); const Search = getIcon("Search"); const Server = getIcon("Server"); const ShieldCheck = getIcon("ShieldCheck");

const sections = ["Overview", "Abilities", "Models", "Engines", "Monitoring", "Alerts", "Updates", "Backups", "Access", "Try it", "Settings"];
const sectionPaths: Record<string, string> = { Overview: "/", Abilities: "/abilities", Models: "/models", Engines: "/engines", Monitoring: "/monitoring", Alerts: "/alerts", Updates: "/updates", Backups: "/backups", Access: "/access", "Try it": "/try", Settings: "/settings" };

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <Card><CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 p-8 text-center"><div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Server className="size-5" /></div><p className="font-medium">{title}</p><p className="max-w-md text-base text-muted-foreground">{detail}</p>{action}</CardContent></Card>;
}

function SectionFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <main className="mx-auto w-full max-w-7xl space-y-7 px-4 py-7 sm:px-8 lg:px-10 lg:py-10"><div><p className="text-sm font-medium text-primary">MaiPai Stack</p><h2 className="mt-1 text-3xl font-semibold tracking-tight">{title}</h2><p className="mt-2 text-base text-muted-foreground">{description}</p></div>{children}</main>;
}

function Table({ children }: { children: ReactNode }) { return <div className="overflow-hidden rounded-xl border"><table className="w-full text-left text-sm"><tbody>{children}</tbody></table></div>; }

function ModelsPage() {
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const installed = roles.data?.roles.filter((role) => ["installed", "loading", "ready", "busy"].includes(role.state)) ?? [];
  return <SectionFrame title="Models" description="Installed models and the abilities they serve.">{roles.loading && <Card><CardContent className="p-6"><LoaderCircle className="animate-spin" /></CardContent></Card>}{!roles.loading && installed.length === 0 && <EmptyState title="No models are installed yet" detail="Choose an ability to bring the first local model to this computer." action={<Button asChild><Link to="/abilities">Add abilities</Link></Button>} />}{installed.length > 0 && <Table>{installed.map((role) => <tr className="border-b last:border-0" key={role.id}><td className="p-4 font-medium">{role.id}</td><td className="p-4 text-muted-foreground">{role.description}</td><td className="p-4 text-right"><Badge variant="secondary">{role.state}</Badge></td></tr>)}</Table>}</SectionFrame>;
}

function EnginesPage() {
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const [confirm, setConfirm] = useState<{ action: "stop" | "remove"; engine: EngineRecord } | null>(null);
  const [configuredName, setConfiguredName] = useState<string | null>(null);
  const config = useApiResource<{ settings: EngineSetting[] }>(configuredName ? `/stack/v1/engines/${configuredName}/config` : null);
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  useEffect(() => { if (config.data) setDraft(Object.fromEntries(config.data.settings.map((setting) => [setting.key, setting.pending ?? setting.inEffect]))); }, [config.data]);
  async function control(path: string, body?: unknown) { await api.post(path, body); await engines.refetch(); }
  async function saveConfig() { if (!configuredName) return; await api.put(`/stack/v1/engines/${configuredName}/config`, draft); await config.refetch(); await engines.refetch(); }
  function engineName(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(0, marker) : engine.id; }
  function engineTag(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(marker + 1).split("-")[0] ?? engine.id : engine.id; }
  return <SectionFrame title="Engines" description="Builds, health, controls, and the settings that shape each runtime.">
    {engines.loading && <LoaderCircle className="animate-spin" />}
    {!engines.loading && engines.data?.engines.length === 0 && <EmptyState title="No engine builds are available" detail="The Stack will show verified local engine builds here when the store has them." />}
    {engines.data && engines.data.engines.length > 0 && <div className="space-y-4"><Table><tr className="border-b text-xs uppercase tracking-wide text-muted-foreground"><th className="p-4 text-left font-medium">Build</th><th className="p-4 text-left font-medium">Platform</th><th className="p-4 text-left font-medium">Version state</th><th className="p-4 text-right font-medium">Controls</th></tr>{engines.data.engines.map((engine) => { const name = engineName(engine); const tag = engineTag(engine); return <tr className="border-b last:border-0" key={engine.id} data-testid={`engine-row-${engine.id}`}><td className="p-4"><p className="font-medium">{engine.label}</p><p className="text-xs text-muted-foreground">{engine.id}</p></td><td className="p-4 text-muted-foreground">{engine.platform} · {engine.arch}</td><td className="p-4"><Badge variant={engine.notCurrent ? "secondary" : "default"}>{engine.state === "current" ? "Current" : "Not current"}</Badge><p className="mt-1 text-xs text-muted-foreground">{engine.stateReason ?? "Ready"}{engine.currentTag && ` · ${engine.currentTag}`}</p>{engine.needsRestart && <p className="mt-1 text-xs font-medium text-primary">Needs restart</p>}</td><td className="p-4"><div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setConfiguredName(name)}>Configure</Button>{engine.installed ? <><Button size="sm" variant="outline" onClick={() => setConfirm({ action: "stop", engine })}>Stop</Button><Button size="sm" variant="outline" onClick={() => void control(`/stack/v1/engines/${name}/restart`)}>Restart</Button><Button size="sm" onClick={() => void control(`/stack/v1/engines/${name}/current`, { tag })}>Make current</Button></> : <Button size="sm" onClick={() => void control(`/stack/v1/engines/${name}/install`, { tag })}>Install</Button>}{engine.installed && !engine.current && <Button size="sm" variant="destructive" onClick={() => setConfirm({ action: "remove", engine })}>Remove</Button>}</div></td></tr>; })}</Table>{confirm && <Card className="border-primary"><CardHeader><CardTitle>{confirm.action === "stop" ? "Stop this engine?" : "Remove this build?"}</CardTitle><CardDescription>{confirm.action === "stop" ? "In-flight work will finish before the engine stops." : "The build stays available from the update manifest and can be installed again."}</CardDescription></CardHeader><CardContent className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="destructive" onClick={async () => { const name = engineName(confirm.engine); const tag = engineTag(confirm.engine); if (confirm.action === "stop") await control(`/stack/v1/engines/${name}/stop`); else await api.delete(`/stack/v1/engines/${name}/builds/${tag}`); setConfirm(null); await engines.refetch(); }}>Confirm {confirm.action}</Button></CardContent></Card>}</div>}
    <Sheet open={configuredName !== null} onOpenChange={(open) => { if (!open) setConfiguredName(null); }}><SheetContent><SheetHeader><SheetTitle>Configure {configuredName}</SheetTitle><SheetDescription>Changes marked restart stay pending until the next engine start.</SheetDescription></SheetHeader><div className="overflow-y-auto px-4 pb-6">{config.loading && <LoaderCircle className="animate-spin" />}{config.data && <><GenericForm settings={config.data.settings} values={draft} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} /><Button className="mt-6 w-full" onClick={() => void saveConfig()}>Save configuration</Button></>}</div></SheetContent></Sheet>
  </SectionFrame>;
}

function MonitoringPage() {
  const budget = useApiResource<BudgetResponse>("/stack/v1/budget");
  const underPressure = budget.data?.pressure === "warn" || budget.data?.pressure === "critical";
  const used = budget.data ? Math.max(0, budget.data.capBytes - budget.data.freeMemoryBytes) / 1_073_741_824 : 0;
  const samples = useMemo(() => Array.from({ length: 8 }, (_, index) => ({ time: `${index + 1}m`, memory: Math.max(0, used - (7 - index) * 0.08) })), [used]);
  return <SectionFrame title="Monitoring" description="Memory pressure, queue health, and the governor's current budget."><div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]"><Card><CardHeader><CardTitle>Memory budget</CardTitle><CardDescription>Recent samples are local to this Stack.</CardDescription></CardHeader><CardContent><div className="h-64 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={samples}><CartesianGrid strokeDasharray="3 3" className="stroke-border" /><XAxis dataKey="time" /><YAxis unit=" GB" /><Tooltip /><Area type="monotone" dataKey="memory" stroke="hsl(22 99% 50%)" fill="hsl(22 99% 50% / .18)" /></AreaChart></ResponsiveContainer></div></CardContent></Card><Card><CardHeader><CardTitle>Governor</CardTitle><CardDescription>What happens when memory gets tight.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex items-center gap-3"><Gauge className="text-primary" /><span>{underPressure ? "Under pressure" : "Within budget"}</span></div><p className="text-base text-muted-foreground">{budget.data ? `${Math.round(used * 10) / 10} GB in use from a ${Math.round(budget.data.capBytes / 1_073_741_824)} GB cap.` : "Waiting for the memory governor."}</p><Separator /><p className="text-base text-muted-foreground">Jobs yield before the computer becomes unpleasant to use.</p></CardContent></Card></div></SectionFrame>;
}

function AlertsPage() {
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  async function clear() { await api.post("/stack/v1/notifications/clear"); await notifications.refetch(); }
  const openRepairs = repairs.data?.repairs.filter((item) => !item.resolvedAt) ?? [];
  return <SectionFrame title="Alerts" description="Notifications and one-action repairs from the Stack."><div className="flex justify-end"><Button variant="outline" onClick={() => void clear()} disabled={!notifications.data?.notifications.length}><Check className="mr-2 size-4" />Clear notifications</Button></div><div className="grid gap-5 lg:grid-cols-2"><Card><CardHeader><CardTitle>Notifications</CardTitle></CardHeader><CardContent className="divide-y p-0">{notifications.data?.notifications.slice(0, 5).map((item) => <div className="p-4" key={item.id}><p>{item.title}</p><p className="mt-1 text-sm text-muted-foreground">{new Date(item.at).toLocaleString()}</p></div>)}{notifications.data && notifications.data.notifications.length === 0 && <p className="p-6 text-muted-foreground">No notifications yet.</p>}</CardContent></Card><Card><CardHeader><CardTitle>Repairs</CardTitle></CardHeader><CardContent className="space-y-4">{openRepairs.map((item) => <div className="rounded-lg border p-4" key={item.id}><p className="font-medium">{item.title}</p><p className="mt-1 text-sm text-muted-foreground">{item.detail}</p></div>)}{repairs.data && openRepairs.length === 0 && <p className="text-muted-foreground">No repairs needed.</p>}</CardContent></Card></div></SectionFrame>;
}

function AccessPage() {
  const clients = useApiResource<{ clients: Array<{ id: string; name: string; keyPrefix: string; allowedRoles: string[] }> }>("/stack/v1/clients");
  const operator = useApiResource<{ state: string; required: boolean }>("/stack/v1/operator");
  return <SectionFrame title="Access" description="Local operator access and role-scoped client keys."><div className="grid gap-5 md:grid-cols-2"><Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" />Operator</CardTitle></CardHeader><CardContent><p>{operator.data?.required ? "Password protection is enabled." : "Password is deferred until the first client key."}</p><p className="mt-2 text-sm text-muted-foreground">The operator session stays on this computer.</p></CardContent></Card><Card><CardHeader><CardTitle className="flex items-center gap-2"><FileKey2 className="size-5 text-primary" />Client keys</CardTitle></CardHeader><CardContent>{clients.data?.clients.length ? <div className="space-y-3">{clients.data.clients.map((client) => <div className="rounded-lg border p-3" key={client.id}><p className="font-medium">{client.name}</p><p className="text-sm text-muted-foreground">{client.keyPrefix} · {client.allowedRoles.join(", ")}</p></div>)}</div> : <p className="text-muted-foreground">No client keys yet.</p>}</CardContent></Card></div></SectionFrame>;
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
  return <SidebarProvider><AppSidebar repairs={repairRows} roles={roleRows} /><SidebarInset><SiteHeader title={title} onSearch={() => setPaletteOpen(true)} /><Routes><Route path="/" element={<BoardPageProxy />} /><Route path="/abilities" element={<AbilitiesProxy />} /><Route path="/models" element={<ModelsPage />} /><Route path="/engines" element={<EnginesPage />} /><Route path="/monitoring" element={<MonitoringPage />} /><Route path="/alerts" element={<AlertsPage />} /><Route path="/updates" element={<SimplePage title="Updates" description="Keep the Stack current without losing control." emptyTitle="Updates are checked on request" emptyDetail="There is nothing to apply yet. The update service will appear here when an update is available." />} /><Route path="/backups" element={<SimplePage title="Backups" description="A quiet place for the data that belongs to your household." emptyTitle="No backup target yet" emptyDetail="Choose where the Stack should keep an encrypted backup before the first backup runs." />} /><Route path="/access" element={<AccessPage />} /><Route path="/try" element={<TryItPage />} /><Route path="/settings" element={<SimplePage title="Settings" description="The essentials for this local Stack." emptyTitle="Settings stay intentionally small" emptyDetail="Port, data directory, and service state will appear here as the Stack grows." />} /><Route path="*" element={<BoardPageProxy />} /></Routes></SidebarInset><CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} /></SidebarProvider>;
}

function BoardPageProxy() { return <BoardPage embedded />; }
function AbilitiesProxy() { return <BoardPage embedded showAbilities />; }
