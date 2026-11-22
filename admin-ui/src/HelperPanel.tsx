import { useEffect } from "react";
import { Sparkles } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maipai/ui/src/ui/sheet";
import { HelperBody } from "./Helper";
import { isHelperShortcut } from "./helperText";

export const PANEL_INPUT_ID = "helper-panel-input";

/** The Helper as a slide-over from the right, on any screen. The chat state lives in HelperProvider, so closing and reopening keeps it. */
export function HelperPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (isHelperShortcut(event)) { event.preventDefault(); onOpenChange(!open); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md" onOpenAutoFocus={(e) => { e.preventDefault(); document.getElementById(PANEL_INPUT_ID)?.focus(); }}>
        <SheetHeader className="border-b pe-12">
          <SheetTitle className="flex items-center gap-2"><Sparkles aria-hidden="true" className="size-4" />Helper</SheetTitle>
          <SheetDescription>Ask in plain words. A change waits for your Confirm.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"><HelperBody compact inputId={PANEL_INPUT_ID} /></div>
      </SheetContent>
    </Sheet>
  );
}
