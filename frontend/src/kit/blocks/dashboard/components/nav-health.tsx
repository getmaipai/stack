import { Link } from "react-router-dom";
import type { RepairRecord, RoleRecord } from "@/lib/api";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

type Tone = "good" | "warn" | "bad";

const DOT: Record<Tone, string> = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };

function tone(repairs: RepairRecord[], roles: RoleRecord[]): Tone {
  const open = repairs.filter((item) => !item.resolvedAt);
  if (open.some((item) => item.level === "immediate") || roles.some((role) => role.state === "stopped")) return "bad";
  if (open.length > 0) return "warn";
  return "good";
}

export function NavHealth({ repairs, roles }: { repairs: RepairRecord[]; roles: RoleRecord[] }) {
  const open = repairs.filter((item) => !item.resolvedAt);
  const toneValue = tone(repairs, roles);
  const sentence = open.length === 0 ? "All good" : open.length === 1 ? "1 thing needs attention" : `${open.length} things need attention`;
  return <SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
    <Link to="/alerts" title={sentence} className="flex items-center gap-2">
      <span aria-hidden className={`size-2.5 rounded-full ${DOT[toneValue]}`} />
      <span className="truncate text-sm">{sentence}</span>
    </Link>
  </SidebarMenuButton></SidebarMenuItem></SidebarMenu>;
}
