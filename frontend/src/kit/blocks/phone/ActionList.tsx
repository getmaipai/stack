import type { PropertyAction } from "@/kit/blocks/property-panel/PropertyPanel";
export function ActionList({ actions }: { actions: PropertyAction[] }) {
  return <section className="overflow-hidden rounded-xl border bg-card"><h2 className="px-4 pt-4 font-semibold">Actions</h2>{actions.map((action) => <button type="button" key={action.label} className={`flex min-h-11 w-full items-center border-t px-4 py-3 text-left text-sm first:mt-3 ${action.destructive ? "text-destructive" : ""}`} disabled={action.disabled} onClick={() => void action.onClick()}>{action.label}</button>)}</section>;
}
