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

export function AppSidebar({ repairs, roles, ...props }: React.ComponentProps<typeof Sidebar> & { repairs: RepairRecord[]; roles: RoleRecord[] }) {
  const location = useLocation();
  return <Sidebar collapsible="icon" {...props}>
    <SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
      <Link to="/"><img className="size-7" src="/brand/maipai-stack-icon-light.png" alt="" /><span className="text-base font-semibold">MaiPai Stack</span></Link>
    </SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarHeader>
    <SidebarContent><NavMain items={items.map(([title, url, icon]) => ({ title, url, icon: getIcon(icon), isActive: location.pathname === url }))} /></SidebarContent>
    <SidebarFooter><NavHealth repairs={repairs} roles={roles} /></SidebarFooter>
  </Sidebar>;
}
