import { getIcon, type IconName } from "@/kit/icons";
import { cn } from "@/kit/utils";

export interface PhoneTab { label: string; path: string; icon: IconName; }
const tabs: PhoneTab[] = [
  { label: "Overview", path: "/", icon: "LayoutDashboard" },
  { label: "Things", path: "/models", icon: "Box" },
  { label: "Tester", path: "/try", icon: "Bot" },
  { label: "Alerts", path: "/alerts", icon: "Bell" },
  { label: "Settings", path: "/settings", icon: "Settings" },
];

export function TabBar({ activePath, onNavigate }: { activePath: string; onNavigate: (path: string) => void }) {
  return <nav aria-label="Phone navigation" className="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 border-t bg-background/95 backdrop-blur" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
    {tabs.map((tab) => { const Icon = getIcon(tab.icon); const active = tab.label === "Things" ? ["/models", "/engines"].includes(activePath) : activePath === tab.path; return <button key={tab.label} type="button" className={cn("flex min-h-14 min-w-11 flex-col items-center justify-center gap-1 px-1 text-[11px] text-muted-foreground", active && "text-primary")} aria-current={active ? "page" : undefined} onClick={() => onNavigate(tab.path)}><Icon className="size-5" /><span>{tab.label}</span></button>; })}
  </nav>;
}
