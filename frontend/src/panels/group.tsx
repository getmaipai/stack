import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function groupPanel(name: string, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode } { return { actions: ["Load", "Unload", "Pin", "Update", "Rename", "Remove", "Clear"].map((label) => ({ label, onClick: () => onAction(label.toLowerCase()), destructive: label === "Remove" })), overview: <p className="text-sm">{name} · model count, resident count, and storage rollups.</p> }; }
