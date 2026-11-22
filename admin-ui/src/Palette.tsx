import { useEffect, useMemo, useState } from "react";
import { Boxes } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { searchModels } from "@maipai/ui/src/stack/stackSearch";
import type { StackChoiceCategory } from "@maipai/ui/src/stack/StackClient";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@maipai/ui/src/ui/command";
import { IconChip } from "./kit";
import type { Tone } from "./kit";

export interface PaletteItem { id: string; label: string; hint?: string; Icon?: LucideIcon; tone?: Tone; keywords?: string[]; run: () => void }

/** One group of the palette: a heading, then rows with an icon chip, the name and a one-line hint. */
function Group({ heading, items, pick }: { heading: string; items: PaletteItem[]; pick: (item: PaletteItem) => void }) {
  if (items.length === 0) return null;
  return (
    <CommandGroup heading={heading}>
      {items.map((item) => (
        <CommandItem key={item.id} value={`${item.label} ${item.id}`} keywords={item.keywords} onSelect={() => pick(item)} className="gap-3 rounded-xl">
          {item.Icon && <IconChip Icon={item.Icon} tone={item.tone ?? "primary"} size="sm" />}
          <span className="min-w-0 flex-1"><span className="block truncate">{item.label}</span>{item.hint && <span className="block truncate text-xs text-muted-foreground">{item.hint}</span>}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** How many models the palette lists at most; the AI and models screen has the full search. */
const MODEL_LIMIT = 8;

/** ⌘K (or Ctrl+K) to jump to a screen, a feature or a model, or to run an action. Models are matched by the page's own search (name, version, precision, licence, description), so both find the same ones. */
export function Palette({ open, onOpenChange, screens, features = [], models = [], onModel, actions }: { open: boolean; onOpenChange: (open: boolean) => void; screens: PaletteItem[]; features?: PaletteItem[]; models?: readonly StackChoiceCategory[]; onModel?: (category: StackChoiceCategory["id"], model: string) => void; actions: PaletteItem[] }) {
  const [query, setQuery] = useState("");
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  const hits = useMemo(() => searchModels(models, query).slice(0, MODEL_LIMIT), [models, query]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onOpenChange(!open); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  const pick = (item: PaletteItem) => { onOpenChange(false); item.run(); };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Jump to a screen or a feature, or run an action">
      <CommandInput placeholder="Search screens, features, models and actions" value={query} onValueChange={setQuery} />
      <CommandList className="max-h-[min(26rem,60dvh)]">
        {hits.length === 0 && <CommandEmpty>Nothing matches. Try a screen name such as Health, a feature such as Chat, or a model name or version such as 3.8.</CommandEmpty>}
        {hits.length > 0 && (
          <CommandGroup heading="Models" forceMount>
            {hits.map(({ category, candidate }) => (
              <CommandItem key={`${category.id}:${candidate.id}`} value={`model ${category.id} ${candidate.id}`} forceMount onSelect={() => { onOpenChange(false); onModel?.(category.id, candidate.id); }} className="gap-3 rounded-xl">
                <IconChip Icon={Boxes} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{candidate.label}{candidate.version ? ` (version ${candidate.version})` : ""}</span>
                  <span className="block truncate text-xs text-muted-foreground">{category.label}, {candidate.summary}</span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <Group heading="Screens" items={screens} pick={pick} />
        {features.length > 0 && <CommandSeparator />}
        <Group heading="Features" items={features} pick={pick} />
        <CommandSeparator />
        <Group heading="Actions" items={actions} pick={pick} />
      </CommandList>
      <p className="hidden items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground sm:flex" aria-hidden="true">
        <span><kbd className="font-sans">↑↓</kbd> move</span><span><kbd className="font-sans">↵</kbd> open</span><span><kbd className="font-sans">esc</kbd> close</span>
      </p>
    </CommandDialog>
  );
}
