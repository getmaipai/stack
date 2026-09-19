import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
import { MODEL_RUNTIME_STATE_LABELS } from "@/lib/modelStates";
import { actionsFor } from "@/lib/actions";
import type { LiveDrive } from "@/lib/api";
import { driveForPath } from "@/lib/drives";

export interface ModelPanelData { id: string; nickname?: string; group?: string; source?: string; licence?: string; licenceSentence?: string; licenceUrl?: string | null; modelPath?: string | null; sizeBytes?: number | null; measuredFootprintBytes?: number | null; runtimeState?: string; drives?: LiveDrive[]; }
export interface ModelPanelResult { actions: PropertyAction[]; primaryActions: [PropertyAction, PropertyAction]; facts: Array<{ label: string; value: ReactNode }>; overview: ReactNode; insights: ReactNode }
export function modelPanel(model: ModelPanelData, onAction: (action: string) => void): ModelPanelResult {
  const loaded = model.runtimeState === "loaded";
  const actions = actionsFor("model", { loaded }, onAction);
  const primaryActions: [PropertyAction, PropertyAction] = [loaded ? actions[1]! : actions[0]!, actions[2]!];
  const licence = model.licenceSentence ?? "Read it before you rely on it.";
  const drive = driveForPath(model.modelPath, model.drives);
  return { actions, primaryActions, facts: [{ label: "State", value: MODEL_RUNTIME_STATE_LABELS[model.runtimeState ?? ""] ?? model.runtimeState ?? "Ready" }, { label: "Source", value: model.source ?? "Local" }, { label: "Size", value: model.sizeBytes ?? "Unknown" }], overview: <KeyValueList items={[{ label: "Kind", value: "Model" }, { label: "Model id", value: model.id, copy: true }, { label: "Where", value: model.modelPath ?? "Not installed", copy: model.modelPath ?? false }, { label: "Drive", value: drive ? `${drive.name}${drive.mounted ? "" : " (not mounted)"}` : "Not measured" }, { label: "Group", value: model.group ?? "Ungrouped" }, { label: "Source", value: model.source ?? "Local" }, { label: "Licence", value: <span title={model.licence}>{licence}{model.licenceUrl && <a className="ml-1 underline" href={model.licenceUrl} target="_blank" rel="noreferrer">Read terms</a>}</span> }, { label: "Size on disk", value: model.sizeBytes ?? "Unknown" }, { label: "Measured footprint", value: model.measuredFootprintBytes ?? "Not measured" }]} />, insights: <p className="text-sm text-muted-foreground">Usage over time will appear here.</p> };
}
