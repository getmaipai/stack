// Reskinned for MaiPai Stack: the shell header names this computer and keeps the controls quiet.
import type { HealthItem, RepairRecord, RoleRecord } from "@/lib/api";
import { getIcon } from "@/kit/icons";
import { healthSummary } from "@/kit/blocks/dashboard/components/nav-health";
import { NotificationsBell } from "@/kit/blocks/dashboard/components/notifications-popover";
import { ProfileMenu } from "@/kit/blocks/dashboard/components/profile-menu";
import { ThemeToggle } from "@/kit/blocks/dashboard/components/theme-toggle";
import { Button } from "@/kit/ui/button";
import { Separator } from "@/kit/ui/separator";
import { SidebarTrigger } from "@/kit/ui/sidebar";

const Cpu = getIcon("Cpu");
const SearchIcon = getIcon("Search");
const DOT = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" } as const;

export function SiteHeader({ title, onSearch, repairs, roles, health }: { title: string; onSearch: () => void; repairs: RepairRecord[]; roles: RoleRecord[]; health: HealthItem[] }) {
  const { tone, sentence } = healthSummary(repairs, roles, health);
  return <header className="sticky top-0 z-20 flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-card"><div className="flex w-full items-center gap-2 px-2 sm:px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" /><h1 className="min-w-0 truncate text-base font-semibold">{title}</h1><div className="hidden min-w-0 items-center gap-2 sm:flex" title={sentence}><Cpu className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-medium">This computer</span><span data-header-health-dot aria-label={sentence} className={`size-2.5 shrink-0 rounded-full ${DOT[tone]}`} /></div><Button aria-label="Search Stack" className="ml-auto size-9 shrink-0 justify-center p-0 text-muted-foreground sm:h-9 sm:w-full sm:max-w-xs sm:justify-start sm:px-3" variant="outline" onClick={onSearch}><SearchIcon className="size-4 sm:mr-2" /><span className="hidden sm:inline">Search Stack</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-xs lg:inline">⌘ K</kbd></Button><div className="flex items-center gap-1"><ThemeToggle /><NotificationsBell /><ProfileMenu /></div></div></header>;
}
