import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getIcon, type IconName } from "@/kit/icons";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/kit/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";

export interface PropertyAction {
  label: string;
  icon?: IconName;
  confirmLabel?: string;
  onClick: () => void | Promise<void>;
  destructive?: boolean;
  disabled?: boolean;
}

export interface PropertyFact {
  label: string;
  value: ReactNode;
}

export interface UsedByItem {
  name: string;
  count?: number;
}

export interface PropertyPanelProps {
  kind: string;
  item: Record<string, unknown>;
  status: string;
  actions: PropertyAction[];
  primaryActions?: [PropertyAction, PropertyAction];
  facts?: PropertyFact[];
  usedBy?: UsedByItem[];
  tabs: { overview: ReactNode; settings?: ReactNode; insights?: ReactNode };
  open: boolean;
  onClose: () => void;
}

function panelTitle(item: Record<string, unknown>): string { return String(item.name ?? item.label ?? item.id ?? "Selected item"); }

function ActionIcon({ name }: { name?: IconName }) {
  const Icon = getIcon(name ?? "Box");
  return <Icon className="size-4" />;
}

function UsedBy({ items }: { items: UsedByItem[] }) {
  if (items.length === 0) return null;
  return <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Used by</p><div className="flex flex-wrap gap-3">{items.map((item) => <Tooltip key={item.name}><TooltipTrigger asChild><div className="w-14 text-center"><div className="mx-auto flex size-9 items-center justify-center rounded-lg bg-muted text-sm font-medium">{item.name.slice(0, 1).toUpperCase()}</div><p className="mt-1 truncate text-xs">{item.name}</p></div></TooltipTrigger><TooltipContent>{item.count === undefined ? item.name : `${item.name}: ${item.count} uses`}</TooltipContent></Tooltip>)}</div></div>;
}

function PanelSection({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  const Icon = getIcon(icon);
  return <Card className="gap-0 py-0 shadow-none"><CardHeader className="flex flex-row items-center gap-2 px-4 py-3"><Icon className="size-4 text-primary" /><CardTitle className="text-sm">{title}</CardTitle></CardHeader><CardContent className="divide-y px-4 pb-4">{children}</CardContent></Card>;
}

function PanelBody({ kind, item, status, actions, primaryActions, facts = [], usedBy = [], tabs, onClose }: Omit<PropertyPanelProps, "open">) {
  const [confirm, setConfirm] = useState<PropertyAction | null>(null);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const tabEntries = [{ id: "overview", label: "Overview", icon: "LayoutList" as const, content: tabs.overview }, ...(tabs.insights ? [{ id: "insights", label: "Insights", icon: "Activity" as const, content: tabs.insights }] : []), ...(tabs.settings ? [{ id: "settings", label: "Settings", icon: "Settings2" as const, content: tabs.settings }] : [])];
  function runAction(action: PropertyAction) { if (action.destructive) setConfirm(action); else void action.onClick(); }
  return <TooltipProvider><div className="flex h-full flex-col" data-testid="property-panel"><div className="p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kind}</p><h2 className="mt-1 line-clamp-2 text-xl font-semibold leading-tight">{panelTitle(item)}</h2></div><div className="flex shrink-0 items-center gap-1"><Badge variant={status.toLowerCase().includes("offline") ? "destructive" : "secondary"}>{status}</Badge><Button size="icon" variant="ghost" aria-label="Close panel" onClick={onClose}>×</Button></div></div><div className="mt-3 flex flex-wrap gap-1">{actions.map((action) => <Tooltip key={action.label}><TooltipTrigger asChild><Button size="icon" variant="ghost" className="size-9" aria-label={action.label} disabled={action.disabled} onClick={() => runAction(action)}><ActionIcon name={action.icon} /></Button></TooltipTrigger><TooltipContent>{action.label}</TooltipContent></Tooltip>)}</div>{facts.length > 0 && <div className="mt-3"><PanelSection title="State" icon="Activity"><div className="grid gap-2 text-sm sm:grid-cols-3">{facts.slice(0, 3).map((fact) => <div key={fact.label}><p className="text-xs text-muted-foreground">{fact.label}</p><p className="mt-1 font-medium tabular-nums">{fact.value}</p></div>)}</div></PanelSection></div>}{primaryActions && <div className="mt-3 grid grid-cols-2 gap-2">{primaryActions.map((action) => <Button key={action.label} variant="outline" disabled={action.disabled} onClick={() => runAction(action)}>{action.label}</Button>)}</div>}{confirm && <Card className="mt-3 border-destructive"><CardContent className="space-y-3 p-3"><p className="text-sm">{confirm.confirmLabel ?? `${confirm.label} ${panelTitle(item)}?`}</p><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button size="sm" variant="destructive" onClick={async () => { await confirm.onClick(); setConfirm(null); }}>Confirm</Button></div></CardContent></Card>}</div><Tabs defaultValue="overview" className="min-h-0 flex-1 overflow-y-auto"><TabsList variant="line" className="w-full justify-start rounded-none border-y px-4 py-2">{tabEntries.map((tab) => { const Icon = getIcon(tab.icon); return <Tooltip key={tab.id}><TooltipTrigger asChild><TabsTrigger value={tab.id} aria-label={tab.label}><Icon className="size-4" /></TabsTrigger></TooltipTrigger><TooltipContent>{tab.label}</TooltipContent></Tooltip>; })}</TabsList>{tabEntries.map((tab) => <TabsContent key={tab.id} value={tab.id} className="p-3"><PanelSection title={tab.id === "overview" ? "Configuration" : tab.id === "insights" ? "Usage" : "Settings"} icon={tab.id === "insights" ? "Activity" : tab.id === "settings" ? "Settings2" : "SlidersHorizontal"}>{tab.content}</PanelSection></TabsContent>)}</Tabs>{usedBy.length > 0 && <div className="p-3"><PanelSection title="Usage" icon="Server"><UsedBy items={usedBy} /></PanelSection></div>}</div></TooltipProvider>;
}

export function PropertyPanel(props: PropertyPanelProps) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => { const update = () => setMobile(window.innerWidth < 1024); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  if (!props.open) return null;
  if (mobile) return <Sheet open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}><SheetContent side="right" className="max-w-none p-0" style={{ width: "calc(100vw - 1rem)", maxWidth: "none" }}><SheetHeader className="sr-only"><SheetTitle>{panelTitle(props.item)}</SheetTitle><SheetDescription>{props.kind} details</SheetDescription></SheetHeader><PanelBody {...props} /></SheetContent></Sheet>;
  return <div className="fixed inset-0 z-40" data-testid="property-panel-overlay"><button type="button" className="absolute inset-0 cursor-default" aria-label="Close panel by clicking outside" onClick={props.onClose} /><aside className="fixed inset-y-0 right-0 w-[420px] max-w-full bg-[var(--surface-pane)] shadow-xl"><PanelBody {...props} /></aside></div>;
}
