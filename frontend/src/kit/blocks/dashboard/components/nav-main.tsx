// Copied by registry from shadcn/ui sidebar-07; reskinned for MaiPai Stack.
import { NavLink } from "react-router-dom";
import type { Icon } from "@/kit/icons";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export function NavMain({ items }: { items: { title: string; url: string; icon?: Icon; isActive?: boolean; badge?: number; dot?: "critical" | "error" | "warning" | null; tooltip?: string }[] }) {
  const DOT: Record<"critical" | "error" | "warning", string> = { critical: "bg-red-500", error: "bg-red-500", warning: "bg-amber-500" };
  return <SidebarGroup><SidebarGroupLabel className="[&>svg]:size-3.5!">Stack</SidebarGroupLabel><SidebarMenu className="gap-1">{items.map((item) => <SidebarMenuItem key={item.title}>
    <SidebarMenuButton asChild isActive={item.isActive} tooltip={item.tooltip ?? item.title} className="h-10 px-3 text-[15px] [&>svg]:size-[18px]!"><NavLink to={item.url}>{item.icon && <item.icon />}<span>{item.title}</span>{item.dot ? <span aria-hidden className={`size-2.5 rounded-full ${DOT[item.dot]}`} /> : null}{item.badge != null && item.badge > 0 && <span className="ml-auto text-xs text-muted-foreground">{item.badge}</span>}</NavLink></SidebarMenuButton>
  </SidebarMenuItem>)}</SidebarMenu></SidebarGroup>;
}
