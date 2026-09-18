import { Link } from "react-router-dom";
import type { HealthItem, RepairRecord, RoleRecord } from "@/lib/api";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/kit/ui/sidebar";

export type Tone = "good" | "warn" | "bad";

const DOT: Record<Tone, string> = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };

export function healthSummary(repairs: RepairRecord[], roles: RoleRecord[], health: HealthItem[] = []): { tone: Tone; sentence: string } {
  const open = repairs.filter((item) => !item.resolvedAt);
  const worstSeverity = health.reduce<HealthItem["severity"] | null>((worst, item) => { const rank = { warning: 1, error: 2, critical: 3 }; return !worst || rank[item.severity] > rank[worst] ? item.severity : worst; }, null);
  const issueCount = open.length + health.length;
  const tone = open.some((item) => item.level === "immediate") || roles.some((role) => role.state === "stopped") || worstSeverity === "critical" || worstSeverity === "error" ? "bad" : issueCount > 0 ? "warn" : "good";
  const sentence = issueCount === 0 ? "All good" : issueCount === 1 ? "1 thing needs attention" : `${issueCount} things need attention`;
  return { tone, sentence };
}

export function NavHealth({ repairs, roles, health }: { repairs: RepairRecord[]; roles: RoleRecord[]; health?: HealthItem[] }) {
  const { tone: toneValue, sentence } = healthSummary(repairs, roles, health);
  return <SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild className="data-[slot=sidebar-menu-button]:p-1.5!">
    <Link to="/alerts" title={sentence} className="flex items-center gap-2">
      <span aria-hidden className={`size-2.5 rounded-full ${DOT[toneValue]}`} />
      <span className="truncate text-sm">{sentence}</span>
    </Link>
  </SidebarMenuButton></SidebarMenuItem></SidebarMenu>;
}
