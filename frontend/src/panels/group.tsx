import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function groupPanel(name: string, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode };
export function groupPanel(name: string, count: number, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode };
export function groupPanel(name: string, countOrAction: number | ((action: string) => void), maybeAction?: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode } {
  const count = typeof countOrAction === "number" ? countOrAction : 1;
  const onAction = typeof countOrAction === "function" ? countOrAction : maybeAction!;
  const actions: Array<[string, string]> = [["Load", "load"], ["Unload", "unload"], ["Pin", "pin"], ["Unpin", "unpin"], ["Check updates", "checkUpdates"], ["Move", "move"], ["Remove", "remove"]];
  return { actions: actions.map(([label, action]) => ({ label, onClick: () => onAction(action), destructive: true, confirmLabel: `${label} ${count} model${count === 1 ? "" : "s"}?` })), overview: <p className="text-sm">{name} · {count} model{count === 1 ? "" : "s"}, resident count, storage, and utilization rollups.</p> };
}
