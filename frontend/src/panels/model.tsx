import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";

export interface ModelPanelData { id: string; nickname?: string; group?: string; source?: string; licence?: string; sizeBytes?: number | null; measuredFootprintBytes?: number | null; }
export function modelPanel(model: ModelPanelData, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode; insights: ReactNode } {
  return { actions: ["Load", "Unload", "Pin", "Update", "Remove"].map((label) => ({ label, onClick: () => onAction(label.toLowerCase()), destructive: label === "Remove" })), overview: <div className="space-y-2 text-sm"><p><b>{model.nickname ?? model.id}</b></p><p>{model.group ?? "Ungrouped"} · {model.source ?? "Local"}</p><p>{model.licence ?? "Licence not recorded"}</p><p>Measured footprint: {model.measuredFootprintBytes ?? "Not measured"}</p></div>, insights: <p className="text-sm text-muted-foreground">Usage over time will appear here.</p> };
}
