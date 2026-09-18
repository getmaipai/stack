import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";

export interface ModelPanelData { id: string; nickname?: string; group?: string; source?: string; licence?: string; sizeBytes?: number | null; measuredFootprintBytes?: number | null; runtimeState?: string; }
export interface ModelPanelResult { actions: PropertyAction[]; primaryActions: [PropertyAction, PropertyAction]; facts: Array<{ label: string; value: ReactNode }>; overview: ReactNode; insights: ReactNode }
export function modelPanel(model: ModelPanelData, onAction: (action: string) => void): ModelPanelResult {
  const loaded = model.runtimeState === "loaded";
  const actions: PropertyAction[] = [
    { label: "Load", icon: "Download", onClick: () => onAction("load") },
    { label: "Unload", icon: "UploadCloud", onClick: () => onAction("unload") },
    { label: "Pin", icon: "KeyRound", onClick: () => onAction("pin") },
    { label: "Update", icon: "RefreshCw", onClick: () => onAction("update") },
    { label: "Remove", icon: "Square", onClick: () => onAction("remove"), destructive: true },
  ];
  const primaryActions: [PropertyAction, PropertyAction] = [loaded ? actions[1]! : actions[0]!, actions[2]!];
  return { actions, primaryActions, facts: [{ label: "State", value: model.runtimeState ?? "Ready" }, { label: "Source", value: model.source ?? "Local" }, { label: "Size", value: model.sizeBytes ?? "Unknown" }], overview: <KeyValueList items={[{ label: "Kind", value: "Model" }, { label: "Model id", value: model.id, copy: true }, { label: "Group", value: model.group ?? "Ungrouped" }, { label: "Source", value: model.source ?? "Local" }, { label: "Licence", value: model.licence ?? "Licence not recorded" }, { label: "Size on disk", value: model.sizeBytes ?? "Unknown" }, { label: "Measured footprint", value: model.measuredFootprintBytes ?? "Not measured" }]} />, insights: <p className="text-sm text-muted-foreground">Usage over time will appear here.</p> };
}
