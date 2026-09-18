// Reskinned for MaiPai Stack: the shell header names this computer and keeps the controls quiet.
import { useEffect, useState } from "react";
import type { HealthItem, RepairRecord, RoleRecord } from "@/lib/api";
import { getIcon } from "@/kit/icons";
import { healthSummary } from "@/kit/blocks/dashboard/components/nav-health";
import { NotificationsBell } from "@/kit/blocks/dashboard/components/notifications-popover";
import { ProfileMenu } from "@/kit/blocks/dashboard/components/profile-menu";
import { Button } from "@/kit/ui/button";
import { Separator } from "@/kit/ui/separator";
import { SidebarTrigger } from "@/kit/ui/sidebar";

function initialDark(): boolean {
  if (typeof window === "undefined") return false;
  const saved = window.localStorage.getItem("maipai-stack-theme");
  if (saved === "dark" || saved === "light") return saved === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function ThemeToggle() {
  const [dark, setDark] = useState(initialDark);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
    window.localStorage.setItem("maipai-stack-theme", dark ? "dark" : "light");
  }, [dark]);
  const Icon = getIcon(dark ? "Sun" : "Moon");
  return <Button type="button" variant="ghost" size="icon-sm" aria-label={dark ? "Use light mode" : "Use dark mode"} title={dark ? "Use light mode" : "Use dark mode"} onClick={() => setDark((current) => !current)}><Icon className="size-4" /></Button>;
}

const Cpu = getIcon("Cpu");
const SearchIcon = getIcon("Search");
const DOT = { good: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" } as const;

export function SiteHeader({ title, onSearch, repairs, roles, health }: { title: string; onSearch: () => void; repairs: RepairRecord[]; roles: RoleRecord[]; health: HealthItem[] }) {
  const { tone, sentence } = healthSummary(repairs, roles, health);
  return <header className="sticky top-0 z-20 flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-card"><div className="flex w-full items-center gap-2 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" /><h1 className="min-w-0 truncate text-base font-semibold">{title}</h1><div className="flex min-w-0 items-center gap-2" title={sentence}><Cpu className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-medium">This computer</span><span data-header-health-dot aria-label={sentence} className={`size-2.5 shrink-0 rounded-full ${DOT[tone]}`} /></div><Button className="ml-auto w-full max-w-xs justify-start text-muted-foreground" variant="outline" onClick={onSearch}><SearchIcon className="mr-2 size-4" /><span>Search Stack</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-xs sm:inline">⌘ K</kbd></Button><div className="flex items-center gap-1"><ThemeToggle /><NotificationsBell /><ProfileMenu /></div></div></header>;
}
