import { useState, type ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
function RolePicker({ roles, onChange }: { roles: string[]; onChange: (roles: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>(roles.slice(0, 1));
  return <div className="space-y-2"><p className="text-sm">Choose roles before adopting.</p>{roles.map((role) => <label className="flex items-center gap-2 text-sm" key={role}><input type="checkbox" checked={chosen.includes(role)} onChange={(event) => { const next = event.target.checked ? [...chosen, role] : chosen.filter((item) => item !== role); setChosen(next); onChange(next); }} />{role}</label>)}</div>;
}
export function detectedPanel(name: string, onAction: (action: string) => void, couldHold?: string[]): { actions: PropertyAction[]; overview: ReactNode } {
  const roles = couldHold ?? ["chat"]; let chosen = roles.slice(0, 1);
  return { actions: [{ label: "Adopt", onClick: () => onAction(couldHold ? `adopt:${chosen.join(",")}` : "adopt") }, { label: "Forget", onClick: () => onAction("forget"), destructive: true }], overview: <div className="space-y-3 text-sm"><p>{name}</p><p>Detected locally. It has not been adopted or changed.</p><RolePicker roles={roles} onChange={(next) => { chosen = next; }} /></div> };
}
