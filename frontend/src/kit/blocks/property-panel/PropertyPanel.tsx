import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Card, CardContent } from "@/kit/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/kit/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";

export interface PropertyAction {
  label: string;
  onClick: () => void | Promise<void>;
  destructive?: boolean;
  disabled?: boolean;
}

export interface PropertyPanelProps {
  kind: string;
  item: Record<string, unknown>;
  status: string;
  actions: PropertyAction[];
  tabs: { overview: ReactNode; settings?: ReactNode; insights?: ReactNode };
  open: boolean;
  onClose: () => void;
}

function panelTitle(item: Record<string, unknown>): string { return String(item.name ?? item.label ?? item.id ?? "Selected item"); }

function PanelBody({ kind, item, status, actions, tabs, onClose }: Omit<PropertyPanelProps, "open">) {
  const [confirm, setConfirm] = useState<PropertyAction | null>(null);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const tabEntries = [{ id: "overview", label: "Overview", content: tabs.overview }, ...(tabs.settings ? [{ id: "settings", label: "Settings", content: tabs.settings }] : []), ...(tabs.insights ? [{ id: "insights", label: "Insights", content: tabs.insights }] : [])];
  return <div className="flex h-full flex-col" data-testid="property-panel"><div className="border-b p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{kind}</p><h2 className="mt-1 text-xl font-semibold">{panelTitle(item)}</h2></div><div className="flex items-center gap-1"><Badge variant={status.toLowerCase().includes("offline") ? "destructive" : "secondary"}>{status}</Badge><Button size="icon" variant="ghost" aria-label="Close panel" onClick={onClose}>×</Button></div></div><TooltipProvider><div className="mt-4 flex flex-wrap gap-2">{actions.map((action) => <Tooltip key={action.label}><TooltipTrigger asChild><Button size="icon" variant={action.destructive ? "destructive" : "outline"} aria-label={action.label} disabled={action.disabled} onClick={() => action.destructive ? setConfirm(action) : void action.onClick()}>{action.label.slice(0, 1)}</Button></TooltipTrigger><TooltipContent>{action.label}</TooltipContent></Tooltip>)}</div></TooltipProvider>{confirm && <Card className="mt-4 border-destructive"><CardContent className="space-y-3 p-3"><p className="text-sm">{confirm.label} {panelTitle(item)}?</p><div className="flex justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setConfirm(null)}>Cancel</Button><Button size="sm" variant="destructive" onClick={async () => { await confirm.onClick(); setConfirm(null); }}>Confirm</Button></div></CardContent></Card>}</div><Tabs defaultValue="overview" className="min-h-0 flex-1 overflow-y-auto"><TabsList variant="line" className="w-full justify-start rounded-none border-b px-4 py-2">{tabEntries.map((tab) => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}</TabsList>{tabEntries.map((tab) => <TabsContent key={tab.id} value={tab.id} className="p-5">{tab.content}</TabsContent>)}</Tabs></div>;
}

export function PropertyPanel(props: PropertyPanelProps) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => { const update = () => setMobile(window.innerWidth < 1024); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  if (!props.open) return null;
  if (mobile) return <Sheet open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}><SheetContent side="right" className="max-w-none p-0" style={{ width: "calc(100vw - 1rem)", maxWidth: "none" }}><SheetHeader className="sr-only"><SheetTitle>{panelTitle(props.item)}</SheetTitle><SheetDescription>{props.kind} details</SheetDescription></SheetHeader><PanelBody {...props} /></SheetContent></Sheet>;
  return <aside className="fixed inset-y-0 right-0 z-40 w-[28rem] border-l bg-background shadow-xl"><PanelBody {...props} /></aside>;
}
