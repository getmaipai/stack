import type { ReactNode } from "react";
import { useRef } from "react";
import { Button } from "@/kit/ui/button";
import { Input } from "@/kit/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/kit/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/kit/ui/toggle-group";
import { getIcon } from "@/kit/icons";
import { useBreakpoint } from "@/kit/hooks/useBreakpoint";
import { useSearchFocus } from "@/kit/hooks/useSearchFocus";
import type { BrowserMode, BrowserView, FacetSortActions, FacetSortState } from "@/kit/hooks/useFacetSort";
import { cn } from "@/kit/utils";

const FilterIcon = getIcon("Filter");
const ListIcon = getIcon("LayoutList");
const GridIcon = getIcon("LayoutGrid");

export interface CategoryBrowserFacet { id: string; label: string; count?: number }
export interface CategoryBrowserSort { id: string; label: string }
export interface CategoryBrowserPrimaryAction { label: string; onClick: () => void }

export interface CategoryBrowserProps {
  facets: CategoryBrowserFacet[];
  sorts: CategoryBrowserSort[];
  primaryAction?: CategoryBrowserPrimaryAction;
  state: FacetSortState;
  actions: FacetSortActions;
  children: ReactNode;
}

const MODE_TABS: { id: BrowserMode; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
  { id: "updates", label: "Updates" },
  { id: "recommended", label: "Recommended" },
];

// The sticky controls dock (spec: mode tabs, subtype facets with
// counts, filter, sort, list/grid, a primary action) plus the list or
// grid it's docked above. State lives in useFacetSort (URL search
// params), lifted by the caller so its own data fetch can react to it.
export function CategoryBrowser({ facets, sorts, primaryAction, state, actions, children }: CategoryBrowserProps) {
  const { under } = useBreakpoint();
  const filterRef = useRef<HTMLInputElement>(null);
  // "/" only: ⌘K is the persistent shell's global search shortcut
  // (site-header.tsx's GlobalSearch), not this page-local filter.
  useSearchFocus(filterRef, { enableCmdK: false });

  return (
    <div>
      <div data-category-dock className="sticky top-0 z-10 space-y-3 border-b bg-[var(--surface-page)] py-3">
        <div className="flex flex-wrap items-center gap-2 px-1" role="tablist" aria-label="Browser mode">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={state.mode === tab.id}
              onClick={() => actions.setMode(tab.id)}
              className={cn("rounded-full px-3 py-1.5 text-sm font-medium", state.mode === tab.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-[var(--surface-pane)]")}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={cn("flex gap-2 px-1", under(960) ? "overflow-x-auto" : "flex-wrap")}>
          {facets.map((facet) => (
            <button
              key={facet.id}
              type="button"
              aria-pressed={state.facet === facet.id}
              onClick={() => actions.setFacet(facet.id)}
              className={cn("shrink-0 rounded-full border px-3 py-1 text-xs font-medium", state.facet === facet.id ? "border-primary text-primary" : "text-muted-foreground hover:bg-[var(--surface-pane)]")}
            >
              {facet.label}{facet.count != null && ` (${facet.count})`}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-1">
          <div className="relative flex-1">
            <FilterIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input ref={filterRef} value={state.filter} onChange={(event) => actions.setFilter(event.target.value)} placeholder="Filter…" aria-label="Filter" className="pl-9" />
          </div>
          <Select value={state.sort} onValueChange={actions.setSort}>
            <SelectTrigger aria-label="Sort by" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{sorts.map((sort) => <SelectItem key={sort.id} value={sort.id}>{sort.label}</SelectItem>)}</SelectContent>
          </Select>
          <ToggleGroup type="single" value={state.view} onValueChange={(value) => value && actions.setView(value as BrowserView)} aria-label="List or grid view">
            <ToggleGroupItem value="list" aria-label="List view"><ListIcon className="size-4" /></ToggleGroupItem>
            <ToggleGroupItem value="grid" aria-label="Grid view"><GridIcon className="size-4" /></ToggleGroupItem>
          </ToggleGroup>
          {primaryAction && <Button type="button" onClick={primaryAction.onClick}>{primaryAction.label}</Button>}
        </div>
      </div>

      <div className="pt-3">{children}</div>
    </div>
  );
}
