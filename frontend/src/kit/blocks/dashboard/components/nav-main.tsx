import { NavLink } from "react-router-dom";
import type { Icon } from "@/kit/icons";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export type NavItem = { title: string; url: string; icon?: Icon; isActive?: boolean; badge?: number; dot?: "critical" | "error" | "warning" | null; tooltip?: string };
export type NavGroup = { label: string; items: NavItem[] };

export function NavMain({ groups }: { groups: NavGroup[] }) {
  const DOT: Record<"critical" | "error" | "warning", string> = { critical: "bg-red-500", error: "bg-red-500", warning: "bg-amber-500" };
  // The rail's own overflow-auto scroller (kit/ui/sidebar.tsx's
  // SidebarContent) sits one level up; this list just needs to be able to
  // shrink below its content size (min-h-0) so that scroller, not the
  // whole rail, is what scrolls. Group padding and label height are kept
  // tight so all 17 destinations plus their 4 group labels fit inside an
  // 900px-tall viewport without needing to scroll at all.
  return (
    <div data-nav-mode="pinned" className="flex min-h-0 flex-1 flex-col gap-1">
      {groups.map((group) => (
        <SidebarGroup key={group.label} className="group/nav p-0">
          <SidebarGroupLabel className="h-4 px-2 text-xs font-semibold tracking-wide text-sidebar-foreground/60 uppercase group-data-[collapsible=icon]:hidden">{group.label}</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {group.items.map((item) => (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton asChild isActive={item.isActive} tooltip={item.tooltip ?? item.title} className="h-10 px-3 text-[15px] [&>svg]:size-[18px]! data-[active=true]:bg-[var(--hue-violet)] data-[active=true]:text-white data-[active=true]:hover:bg-[var(--hue-violet)] data-[active=true]:hover:text-white">
                  <NavLink to={item.url}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                    {item.dot ? <span aria-hidden className={`size-2.5 rounded-full ${DOT[item.dot]}`} /> : null}
                    {item.badge != null && item.badge > 0 && <span className="ml-auto text-xs text-muted-foreground">{item.badge}</span>}
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </div>
  );
}
