// Copied by registry from shadcn/ui dashboard-01; reskinned for MaiPai Stack.
import * as React from "react";
import { getIcon } from "@/kit/icons";
import { Link, useLocation } from "react-router-dom";
import type { RepairRecord, RoleRecord } from "@/lib/api";
import { NavMain } from "@/kit/blocks/dashboard/components/nav-main";
import { NavHealth } from "@/kit/blocks/dashboard/components/nav-health";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

const items = [
  ["Overview", "/", "LayoutDashboard"], ["Abilities", "/abilities", "SlidersHorizontal"], ["Models", "/models", "Box"],
  ["Engines", "/engines", "Cpu"], ["Monitoring", "/monitoring", "Gauge"], ["Alerts", "/alerts", "Bell"],
  ["Updates", "/updates", "RefreshCw"], ["Backups", "/backups", "UploadCloud"], ["Access", "/access", "KeyRound"],
  ["Try it", "/try", "Bot"], ["Settings", "/settings", "Settings"],
] as const;

export function AppSidebar({ repairs, roles, engineCount = 0, updateCount = 0, alertCount = 0, detectedCount = 0, ...props }: React.ComponentProps<typeof Sidebar> & { repairs: RepairRecord[]; roles: RoleRecord[]; engineCount?: number; updateCount?: number; alertCount?: number; detectedCount?: number }) {
  const location = useLocation();
  const badges: Record<string, number> = { Engines: engineCount, Updates: updateCount, Alerts: alertCount, Models: detectedCount };
  return <Sidebar collapsible="icon" {...props}>
    <SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
      <Link to="/"><img className="size-7" src="/brand/maipai-stack-icon-light.png" alt="" /><span className="text-base font-semibold">MaiPai Stack</span></Link>
    </SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader>
    <SidebarContent><NavMain items={items.map(([title, url, icon]) => ({ title, url, icon: getIcon(icon), isActive: location.pathname === url, badge: badges[title] ?? 0 }))} /></SidebarContent>
    <SidebarFooter><NavHealth repairs={repairs} roles={roles} /></SidebarFooter>
  </Sidebar>;
}
