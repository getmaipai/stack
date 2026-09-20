// One reading of a health-item list's worst severity and the tone it
// maps to, shared by everything that shows a health dot (the rail's
// system pulse, the machine selector, the footer's counts) so the
// ranking and the color can't drift apart between them.
import type { HealthItem } from "@/lib/api";

const SEVERITY_RANK: Record<HealthItem["severity"], number> = { warning: 1, error: 2, critical: 3 };

export function worstHealthItem(items: HealthItem[]): HealthItem | null {
  return items.reduce<HealthItem | null>((worst, item) => (!worst || SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst.severity]) ? item : worst, null);
}

export function worstSeverity(items: HealthItem[]): HealthItem["severity"] | null {
  return worstHealthItem(items)?.severity ?? null;
}

export function severityDotClass(items: HealthItem[]): string {
  const worst = worstSeverity(items);
  if (worst === "critical" || worst === "error") return "bg-[var(--hue-red)]";
  if (worst === "warning") return "bg-[var(--hue-orange)]";
  return "bg-[var(--hue-teal)]";
}
