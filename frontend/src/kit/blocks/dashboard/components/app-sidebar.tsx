import * as React from "react";
import { getIcon } from "@/kit/icons";
import { Link, useLocation } from "react-router-dom";
import { groups as taxonomyGroups } from "@/lib/taxonomy";
import { NavMain, type NavGroup } from "@/kit/blocks/dashboard/components/nav-main";
import { SystemPulse } from "@/kit/blocks/dashboard/components/system-pulse";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/kit/ui/sidebar";

const ChevronsLeft = getIcon("ChevronsLeft");
const ChevronsRight = getIcon("ChevronsRight");

function RailToggle(): React.ReactElement {
  const { state, toggleSidebar } = useSidebar();
  const expanded = state === "expanded";
  return <button type="button" onClick={toggleSidebar} aria-expanded={expanded} aria-label={expanded ? "Collapse navigation" : "Expand navigation"} className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
    {expanded ? <ChevronsLeft className="size-4" /> : <ChevronsRight className="size-4" />}
  </button>;
}

export function AppSidebar({ engineCount = 0, updateCount = 0, alertSeverity = null, engineTooltip = "Runtimes", updateTooltip = "Updates", alertTooltip = "Alerts", ...props }: React.ComponentProps<typeof Sidebar> & { engineCount?: number; updateCount?: number; alertSeverity?: "critical" | "error" | "warning" | null; engineTooltip?: string; updateTooltip?: string; alertTooltip?: string }) {
  const location = useLocation();
  const badges: Record<string, number> = { runtimes: engineCount, settings: updateCount };
  const dots: Record<string, "critical" | "error" | "warning" | null> = { alerts: alertSeverity };
  const tooltips: Record<string, string> = { runtimes: engineTooltip, settings: updateTooltip, alerts: alertTooltip };
  const groups: NavGroup[] = taxonomyGroups.map((group) => ({
    label: group.label,
    items: group.destinations.map((destination) => ({
      title: destination.label,
      url: destination.path,
      icon: getIcon(destination.icon),
      isActive: location.pathname === destination.path || (destination.path !== "/" && location.pathname.startsWith(`${destination.path}/`)),
      badge: badges[destination.id] ?? 0,
      dot: dots[destination.id] ?? null,
      tooltip: tooltips[destination.id],
    })),
  }));
  return <Sidebar collapsible="icon" className="bg-[var(--surface-sidebar)] p-1.5 pb-2" {...props}>
    <SidebarHeader className="p-0">
      <SidebarMenu><SidebarMenuItem>
        <div className="flex items-center justify-between gap-2 px-1.5 py-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-2">
          <SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1! flex-1 gap-1 group-data-[collapsible=icon]:flex-none"><Link to="/"><img className="size-6" src="/brand/maipai-stack-icon-light.png" alt="" /><div className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden"><span className="truncate text-base font-semibold">MaiPai Stack</span><span className="truncate text-xs text-sidebar-foreground/60">Your AI. On Your Terms.</span></div></Link></SidebarMenuButton>
          <RailToggle />
        </div>
      </SidebarMenuItem></SidebarMenu>
    </SidebarHeader>
    <SidebarContent className="flex flex-col"><NavMain groups={groups} /></SidebarContent>
    <SidebarFooter className="p-0"><SystemPulse /></SidebarFooter>
  </Sidebar>;
}
