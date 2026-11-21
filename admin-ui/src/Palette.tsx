import { useEffect } from "react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@maipai/ui/src/ui/command";

export interface PaletteItem { id: string; label: string; hint?: string; run: () => void }

/** ⌘K (or Ctrl+K) to jump to a screen or run an action. */
export function Palette({ open, onOpenChange, screens, actions }: { open: boolean; onOpenChange: (open: boolean) => void; screens: PaletteItem[]; actions: PaletteItem[] }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  const pick = (item: PaletteItem) => { onOpenChange(false); item.run(); };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to a screen or run an action">
      <CommandInput placeholder="Jump to a screen or run an action" />
      <CommandList>
        <CommandEmpty>Nothing matches. Try a screen name such as Health.</CommandEmpty>
        <CommandGroup heading="Go to">
          {screens.map((item) => <CommandItem key={item.id} value={item.label} onSelect={() => pick(item)}>{item.label}{item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}</CommandItem>)}
        </CommandGroup>
        <CommandGroup heading="Actions">
          {actions.map((item) => <CommandItem key={item.id} value={item.label} onSelect={() => pick(item)}>{item.label}</CommandItem>)}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
