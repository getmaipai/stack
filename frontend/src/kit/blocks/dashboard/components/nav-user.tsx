// Copied by registry from shadcn/ui sidebar-07; reskinned for MaiPai Stack.
import { Avatar, AvatarFallback, AvatarImage } from "@/kit/ui/avatar";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export function NavUser({ user }: { user: { name: string; email: string; avatar: string } }) {
  return <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg"><Avatar className="h-8 w-8 rounded-lg"><AvatarImage src={user.avatar} alt="" /><AvatarFallback className="rounded-lg">S</AvatarFallback></Avatar><div className="grid flex-1 text-left text-sm leading-tight"><span className="truncate font-medium">{user.name}</span><span className="truncate text-xs text-muted-foreground">{user.email}</span></div></SidebarMenuButton></SidebarMenuItem></SidebarMenu>;
}
