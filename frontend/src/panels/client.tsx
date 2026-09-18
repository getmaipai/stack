import type { ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function clientPanel(name: string, roles: string[], onRevoke: () => void): { actions: PropertyAction[]; overview: ReactNode } { return { actions: [{ label: "Revoke", onClick: onRevoke, destructive: true }], overview: <div className="space-y-2 text-sm"><p>{name}</p><p>Roles: {roles.join(", ")}</p><p>Counters and last seen stay local to this Stack.</p></div> }; }
