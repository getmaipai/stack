import { getIcon } from "@/kit/icons";

const ChevronRight = getIcon("ChevronRight");
export interface DetailRow { label: string; value?: string; placeholder?: string; editable?: boolean; onChange?: (value: string) => void; onClick?: () => void; }
export function DetailCard({ title, rows }: { title?: string; rows: DetailRow[] }) {
  return <section className="rounded-xl border bg-card p-4"><>{title && <h2 className="mb-2 font-semibold">{title}</h2>}</>{rows.map((row) => <div key={row.label} className="flex min-h-11 items-center justify-between gap-4 border-t py-2 first:border-t-0"><span className="text-sm text-muted-foreground">{row.label}</span>{row.editable ? <input className="min-h-11 min-w-0 flex-1 bg-transparent text-right outline-none placeholder:text-muted-foreground" placeholder={row.placeholder ?? "Enter a value"} value={row.value ?? ""} onChange={(event) => row.onChange?.(event.target.value)} /> : <button type="button" className={`flex min-h-11 min-w-0 flex-1 items-center justify-end gap-1 text-right text-sm ${row.onClick ? "text-primary" : ""}`} onClick={row.onClick}><span className="truncate">{row.value ?? row.placeholder ?? "Not set"}</span>{row.onClick && <ChevronRight className="size-4 shrink-0" />}</button>}</div>)}</section>;
}
