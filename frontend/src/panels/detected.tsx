import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function detectedPanel(name: string, onAction: (action: string) => void): { actions: PropertyAction[]; overview: ReactNode } { return { actions: [{ label: "Adopt", onClick: () => onAction("adopt") }, { label: "Forget", onClick: () => onAction("forget"), destructive: true }], overview: <div className="space-y-2 text-sm"><p>{name}</p><p>Detected locally. Choose roles before adopting it.</p></div> }; }
