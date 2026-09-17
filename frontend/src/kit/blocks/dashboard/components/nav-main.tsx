// Copied by registry from shadcn/ui sidebar-07; reskinned for MaiPai Stack.
import { NavLink } from "react-router-dom";
import type { Icon } from "@/kit/icons";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export function NavMain({ items }: { items: { title: string; url: string; icon?: Icon; isActive?: boolean }[] }) {
  return <SidebarGroup><SidebarGroupLabel>Stack</SidebarGroupLabel><SidebarMenu>{items.map((item) => <SidebarMenuItem key={item.title}>
    <SidebarMenuButton asChild isActive={item.isActive} tooltip={item.title}><NavLink to={item.url}>{item.icon && <item.icon />}<span>{item.title}</span></NavLink></SidebarMenuButton>
  </SidebarMenuItem>)}</SidebarMenu></SidebarGroup>;
}
