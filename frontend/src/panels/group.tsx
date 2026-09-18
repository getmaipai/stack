import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
import { actionsFor } from "@/lib/actions";
export interface GroupPanelResult { actions: PropertyAction[]; primaryActions: [PropertyAction, PropertyAction]; facts: Array<{ label: string; value: ReactNode }>; overview: ReactNode }
export function groupPanel(name: string, onAction: (action: string) => void): GroupPanelResult;
export function groupPanel(name: string, count: number, onAction: (action: string) => void): GroupPanelResult;
export function groupPanel(name: string, countOrAction: number | ((action: string) => void), maybeAction?: (action: string) => void): GroupPanelResult {
  const count = typeof countOrAction === "number" ? countOrAction : 1;
  const onAction = typeof countOrAction === "function" ? countOrAction : maybeAction!;
  const built = actionsFor("group", { count }, onAction).map((action) => ({ ...action, confirmLabel: action.confirmLabel ?? `${action.label} ${count} model${count === 1 ? "" : "s"}?` }));
  return { actions: built, primaryActions: [built[0]!, built[1]!], facts: [{ label: "Models", value: count }, { label: "Storage", value: "Rollup" }, { label: "Usage", value: "Local" }], overview: <KeyValueList items={[{ label: "Kind", value: "Model group" }, { label: "Name", value: name }, { label: "Models", value: count }, { label: "Storage", value: "Resident and on demand" }, { label: "Utilization", value: "Local rollup" }]} /> };
}
