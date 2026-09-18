import { useState, type ReactNode } from "react";
import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
import { KeyValueList } from "@/kit/blocks/property-panel/KeyValueList";
function RolePicker({ roles, onChange }: { roles: string[]; onChange: (roles: string[]) => void }) {
  const [chosen, setChosen] = useState<string[]>(roles.slice(0, 1));
  return <div className="space-y-2"><p className="text-sm">Choose roles before adopting.</p>{roles.map((role) => <label className="flex items-center gap-2 text-sm" key={role}><input type="checkbox" checked={chosen.includes(role)} onChange={(event) => { const next = event.target.checked ? [...chosen, role] : chosen.filter((item) => item !== role); setChosen(next); onChange(next); }} />{role}</label>)}</div>;
}
export interface DetectedPanelResult { actions: PropertyAction[]; primaryActions: [PropertyAction, PropertyAction]; facts: Array<{ label: string; value: ReactNode }>; overview: ReactNode }
export function detectedPanel(name: string, onAction: (action: string) => void, couldHold?: string[]): DetectedPanelResult {
  const roles = couldHold ?? ["chat"]; let chosen = roles.slice(0, 1);
  const adopt: PropertyAction = { label: "Adopt", icon: "Check", onClick: () => onAction(couldHold ? `adopt:${chosen.join(",")}` : "adopt") };
  const forget: PropertyAction = { label: "Forget", icon: "Square", onClick: () => onAction("forget"), destructive: true };
  return { actions: [adopt, forget], primaryActions: [adopt, forget], facts: [{ label: "State", value: "Detected" }, { label: "Roles", value: roles.join(", ") }, { label: "Changes", value: "None" }], overview: <div className="space-y-4"><KeyValueList items={[{ label: "Kind", value: "Detected" }, { label: "Name", value: name }, { label: "Roles", value: roles.join(", ") }, { label: "Source", value: "Local" }]} /><RolePicker roles={roles} onChange={(next) => { chosen = next; }} /></div> };
}
