import { getIcon, type IconName } from "@/kit/icons";
import { cn } from "@/kit/utils";

export function ListRow({ icon = "Box", name, subtitle, status, subStatus, tone = "ready", onClick }: { icon?: IconName; name: string; subtitle?: string; status?: string; subStatus?: string; tone?: "ready" | "attention" | "offline" | "detected"; onClick?: () => void }) {
  const Icon = getIcon(icon);
  const color = { ready: "text-emerald-600", attention: "text-amber-600", offline: "text-destructive", detected: "text-muted-foreground" }[tone];
  return <button type="button" className="flex min-h-11 w-full items-center gap-3 border-b px-1 py-2 text-left" style={{ minHeight: subtitle ? 64 : 48 }} onClick={onClick}><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"><Icon className="size-4" /></span><span className="min-w-0 flex-1"><span className="line-clamp-2 font-medium">{name}</span>{subtitle && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}</span><span className="flex min-w-16 items-center justify-end gap-2"><span className="text-right"><span className={cn("block text-sm font-medium", color)}>{status}</span>{subStatus && <span className="block max-w-28 truncate text-xs text-muted-foreground">{subStatus}</span>}</span><span className={cn("size-2 shrink-0 rounded-full", tone === "ready" ? "bg-emerald-500" : tone === "attention" ? "bg-amber-500" : tone === "offline" ? "bg-destructive" : "bg-muted-foreground")} /><span aria-hidden className="text-lg text-muted-foreground">›</span></span></button>;
}
