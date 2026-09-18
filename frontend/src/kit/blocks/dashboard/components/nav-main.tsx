import { NavLink } from "react-router-dom";
import type { Icon } from "@/kit/icons";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export type NavItem = { title: string; url: string; icon?: Icon; isActive?: boolean; badge?: number; dot?: "critical" | "error" | "warning" | null; tooltip?: string };
export type NavGroup = { label: string; items: NavItem[] };

export function NavMain({ groups, categorized = false }: { groups: NavGroup[]; categorized?: boolean }) {
  const DOT: Record<"critical" | "error" | "warning", string> = { critical: "bg-red-500", error: "bg-red-500", warning: "bg-amber-500" };
  return <div data-nav-mode={categorized ? "categorized" : "pinned"} className="flex min-h-0 flex-1 flex-col"><div className="flex min-h-0 flex-1 flex-col justify-between"><div>{groups.map((group) => <SidebarGroup key={group.label} className="group/nav"><SidebarGroupLabel className={categorized ? "" : "sr-only"}>{group.label}</SidebarGroupLabel><SidebarMenu className="gap-1">{group.items.map((item) => <SidebarMenuItem key={item.title}><SidebarMenuButton asChild isActive={item.isActive} tooltip={item.tooltip ?? item.title} className="h-10 px-3 text-[15px] [&>svg]:size-[18px]!"><NavLink to={item.url}>{item.icon && <item.icon />}<span>{item.title}</span>{item.dot ? <span aria-hidden className={`size-2.5 rounded-full ${DOT[item.dot]}`} /> : null}{item.badge != null && item.badge > 0 && <span className="ml-auto text-xs text-muted-foreground">{item.badge}</span>}</NavLink></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>)}</div></div></div>;
}
