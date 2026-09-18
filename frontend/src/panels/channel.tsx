import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function channelPanel(type: string, verified: string, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode } { return { actions: [{ label: "Send a test", onClick: () => onAction("test") }, { label: "Remove", onClick: () => onAction("remove"), destructive: true }], overview: <div className="space-y-2 text-sm"><p>Type: {type}</p><p>Verified: {verified}</p></div> }; }
