import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";
import { useState } from "react";

const Plus = getIcon("Plus");
const Search = getIcon("Search");

export function PhoneHeader({ computerName, health, action, onAction }: { computerName: string; health: string; action: "Add" | "Search"; onAction: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2"><img src="/brand/maipai-stack-icon-light.png" alt="" className="size-7" /><button type="button" className="flex min-h-11 min-w-0 items-center gap-2 rounded-full border px-3 text-sm" onClick={() => setOpen(true)}><span className="size-2 shrink-0 rounded-full bg-emerald-500" /> <span className="truncate">{computerName}</span></button></div>
      <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={action} onClick={onAction}>{action === "Add" ? <Plus className="size-5" /> : <Search className="size-5" />}</Button>
    </header>
    <Sheet open={open} onOpenChange={setOpen}><SheetContent side="top" className="p-5"><SheetHeader><SheetTitle>{computerName}</SheetTitle><SheetDescription>{health}</SheetDescription></SheetHeader></SheetContent></Sheet>
  </>;
}
