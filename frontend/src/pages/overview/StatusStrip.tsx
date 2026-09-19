import { Link } from "react-router-dom";
import { Card, CardContent } from "@/kit/ui/card";
import type { BudgetResponse, HealthItem, RoleRecord } from "@/lib/api";

export function StatusStrip({ roles, budget, health, engineCount }: { roles: RoleRecord[]; budget?: BudgetResponse; health: HealthItem[]; engineCount: number }) {
  const chat = roles.find((role) => role.id === "chat");
  const parts = [
    chat?.state === "ready" ? { text: "Chat ready", href: "/models" } : null,
    (budget?.loaded.length ?? 0) > 0 ? { text: `${budget!.loaded.length} model${budget!.loaded.length === 1 ? "" : "s"} loaded`, href: "/models" } : null,
    engineCount > 0 ? { text: `${engineCount} engine${engineCount === 1 ? "" : "s"} current`, href: "/engines" } : null,
  ].filter((part): part is { text: string; href: string } => Boolean(part));
  const worst = health.find((item) => item.severity === "critical" || item.severity === "error") ? "error" : health.length ? "warning" : "clear";
  return <Card data-status-strip data-widget><CardContent className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm"><div className="flex flex-wrap items-center gap-x-3 gap-y-1">{parts.map((part, index) => <span className="flex items-center gap-3" key={part.text}>{index > 0 && <span aria-hidden="true" className="text-muted-foreground">·</span>}<Link className="font-medium hover:text-primary" to={part.href}>{part.text}</Link></span>)}{parts.length > 0 && <span aria-hidden="true" className="text-muted-foreground">·</span>}<Link className={worst === "clear" ? "text-emerald-700 dark:text-emerald-400" : worst === "warning" ? "text-amber-700 dark:text-amber-400" : "text-destructive"} to="/alerts">{worst === "clear" ? "All clear" : `${health.length} item${health.length === 1 ? "" : "s"} need attention`}</Link></div></CardContent></Card>;
}
