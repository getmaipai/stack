import { useState } from "react";
import type { ChangeEvent } from "react";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Checkbox } from "@/kit/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/kit/ui/collapsible";
import { Input } from "@/kit/ui/input";

const ChevronDown = getIcon("ChevronDown");
const ChevronRight = getIcon("ChevronRight");
const ChevronLeft = getIcon("ChevronLeft");
const Search = getIcon("Search");

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

export interface FilterGroup {
  id: string;
  title: string;
  options: FilterOption[];
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
}

export interface FilterColumnProps {
  search: { value: string; onChange: (value: string) => void; placeholder?: string };
  groups: FilterGroup[];
  onClear: () => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export type FilterAccessor<Row> = (row: Row) => string | string[];
export type FilterSelections = Readonly<Record<string, ReadonlySet<string>>>;

function valuesOf<Row>(row: Row, accessor: FilterAccessor<Row>): string[] {
  const value = accessor(row);
  return Array.isArray(value) ? value : [value];
}

export function applyFilters<Row>(rows: readonly Row[], search: string, selections: FilterSelections, accessors: Readonly<Record<string, FilterAccessor<Row>>>): Row[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const searchMatches = !query || Object.values(accessors).some((accessor) => valuesOf(row, accessor).some((value) => value.toLocaleLowerCase().includes(query)));
    const groupsMatch = Object.entries(selections).every(([group, selected]) => selected.size === 0 || valuesOf(row, accessors[group] ?? (() => "")).some((value) => selected.has(value)));
    return searchMatches && groupsMatch;
  });
}

export function countFilterOptions<Row>(rows: readonly Row[], accessor: FilterAccessor<Row>): FilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) for (const value of new Set(valuesOf(row, accessor))) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" })).map(([id, count]) => ({ id, label: id, count }));
}

function handleSearch(event: ChangeEvent<HTMLInputElement>, onChange: (value: string) => void) {
  onChange(event.target.value);
}

export function FilterColumn({ search, groups, onClear, collapsed = false, onCollapsedChange }: FilterColumnProps) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(groups.map((group) => group.id)));
  if (collapsed) return <div className="flex min-h-72 w-9 flex-col items-center border-r pr-2" data-testid="filter-column"><Button type="button" size="icon" variant="ghost" aria-label="Show filters" title="Show filters" onClick={() => onCollapsedChange?.(false)}><ChevronRight className="size-4" /></Button></div>;
  return <aside className="w-60 shrink-0 border-r pr-4" data-testid="filter-column"><div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">Filters</p>{onCollapsedChange && <Button type="button" size="icon" variant="ghost" aria-label="Collapse filters" title="Collapse filters" onClick={() => onCollapsedChange(true)}><ChevronLeft className="size-4" /></Button>}</div><div className="relative mt-3"><Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" /><Input aria-label="Search filters" value={search.value} placeholder={search.placeholder ?? "Search"} onChange={(event) => handleSearch(event, search.onChange)} className="pl-9" /></div><div className="mt-4 space-y-3">{groups.map((group) => { const open = openGroups.has(group.id); return <Collapsible key={group.id} open={open} onOpenChange={(next) => setOpenGroups((current) => { const updated = new Set(current); if (next) updated.add(group.id); else updated.delete(group.id); return updated; })}><div className="border-t pt-3"><CollapsibleTrigger asChild><button type="button" className="flex w-full items-center justify-between text-left text-sm font-medium" aria-label={`${open ? "Collapse" : "Expand"} ${group.title}`}><span>{group.title}</span>{open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}</button></CollapsibleTrigger><CollapsibleContent className="mt-2 space-y-1">{group.options.map((option) => <label key={option.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"><Checkbox aria-label={option.label} checked={group.selected.has(option.id)} onCheckedChange={(checked) => { const selected = new Set(group.selected); if (checked === true) selected.add(option.id); else selected.delete(option.id); group.onChange(selected); }} /><span className="min-w-0 flex-1 truncate">{option.label}</span><span className="tabular-nums text-xs text-muted-foreground">{option.count}</span></label>)}</CollapsibleContent></div></Collapsible>; })}</div><Button type="button" variant="link" className="mt-4 h-auto px-1 text-sm" onClick={onClear}>Clear filters</Button></aside>;
}
