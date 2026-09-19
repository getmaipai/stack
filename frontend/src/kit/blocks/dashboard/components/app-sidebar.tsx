import * as React from "react";
import { getIcon } from "@/kit/icons";
import { Link, useLocation } from "react-router-dom";
import type { BudgetResponse, HardwareInfo, HealthItem, LiveDrive, RepairRecord, RoleRecord } from "@/lib/api";
import { NavMain, type NavGroup } from "@/kit/blocks/dashboard/components/nav-main";
import { NavResources } from "@/kit/blocks/dashboard/components/nav-resources";
import { healthSummary } from "@/kit/blocks/dashboard/components/nav-health";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

const iconMap = { Overview: "LayoutDashboard", Engines: "Cpu", Models: "Box", Library: "Folder", Clients: "KeyRound", Tester: "Bot", Monitoring: "Gauge", Settings: "Settings", Logs: "FileText", Alerts: "Bell" } as const;
const DOT = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" } as const;

export function AppSidebar({ repairs, roles, health = [], engineCount = 0, updateCount = 0, alertSeverity = null, engineTooltip = "Engines", updateTooltip = "Updates", alertTooltip = "Alerts", hardware, budget, drives, runState, ...props }: React.ComponentProps<typeof Sidebar> & { repairs: RepairRecord[]; roles: RoleRecord[]; health?: HealthItem[]; engineCount?: number; updateCount?: number; alertSeverity?: "critical" | "error" | "warning" | null; engineTooltip?: string; updateTooltip?: string; alertTooltip?: string; hardware?: HardwareInfo; budget?: BudgetResponse; drives?: LiveDrive[]; runState?: string }) {
  const location = useLocation();
  const [categorized, setCategorized] = React.useState(false);
  React.useEffect(() => {
    const update = () => setCategorized(window.innerHeight < 700);
    update();
    const target = document.querySelector('[data-sidebar="sidebar"]');
    if (typeof ResizeObserver === "undefined" || !target) return;
    const observer = new ResizeObserver(() => update()); observer.observe(target); return () => observer.disconnect();
  }, []);
  const { tone, sentence } = healthSummary(repairs, roles, health);
  const common = ["Overview", "Engines", "Models", "Library", "Clients", "Tester", "Monitoring"].map((title) => ({ title, url: { Overview: "/", Engines: "/engines", Models: "/models", Library: "/library", Clients: "/clients", Tester: "/try", Monitoring: "/monitoring" }[title]!, icon: getIcon(iconMap[title as keyof typeof iconMap]), isActive: location.pathname === ({ Overview: "/", Engines: "/engines", Models: "/models", Library: "/library", Clients: "/clients", Tester: "/try", Monitoring: "/monitoring" }[title]!), badge: title === "Engines" ? engineCount : 0, tooltip: title === "Engines" ? engineTooltip : undefined }));
  const admin = ["Settings", "Logs", "Alerts"].map((title) => ({ title, url: { Settings: "/settings", Logs: "/logs", Alerts: "/alerts" }[title]!, icon: getIcon(iconMap[title as keyof typeof iconMap]), isActive: location.pathname.startsWith({ Settings: "/settings", Logs: "/logs", Alerts: "/alerts" }[title]!), badge: title === "Settings" ? updateCount : 0, dot: title === "Alerts" ? alertSeverity : null, tooltip: title === "Settings" ? updateTooltip : title === "Alerts" ? alertTooltip : undefined }));
  const groups: NavGroup[] = [{ label: "Manage", items: common }, { label: "Administer", items: admin }];
  return <Sidebar collapsible="icon" className="bg-[var(--surface-sidebar)] p-3 pb-4" {...props}>
    <SidebarHeader className="p-0"><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!"><Link to="/"><img className="size-7" src="/brand/maipai-stack-icon-light.png" alt="" /><span className="text-base font-semibold">MaiPai Stack</span></Link></SidebarMenuButton></SidebarMenuItem></SidebarMenu><div className="px-3 pt-2"><p className="flex items-center gap-2 text-xs text-muted-foreground"><span aria-hidden className={`size-2 rounded-full ${DOT[tone]}`} />{hardware?.computerName ?? "This computer"}</p><p className="sr-only" title={sentence}>{sentence}</p></div></SidebarHeader>
    <SidebarContent className="flex flex-col"><NavMain groups={groups} categorized={categorized} /></SidebarContent>
    <SidebarFooter className="p-0"><NavResources capBytes={budget?.capBytes} totalMemoryBytes={budget?.totalMemoryBytes} freeMemoryBytes={budget?.freeMemoryBytes} freeDiskBytes={hardware?.freeDiskBytes} drives={drives ?? hardware?.drives} pressure={budget?.pressure} runState={runState} /></SidebarFooter>
  </Sidebar>;
}
