export function ChipRow({ chips, active, onSelect }: { chips: string[]; active?: string; onSelect?: (chip: string) => void }) {
  return <div className="flex min-h-11 gap-2 overflow-x-auto py-1" aria-label="Filters">{chips.map((chip) => <button type="button" key={chip} className={`min-h-11 shrink-0 rounded-full border px-4 text-sm ${active === chip ? "border-primary bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => onSelect?.(chip)}>{chip}</button>)}</div>;
}
