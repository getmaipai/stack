import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getIcon } from "@/kit/icons";
import { FilterColumn, type FilterColumnProps } from "@/kit/blocks/filter-column/FilterColumn";
import { Button } from "@/kit/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";

const Filter = getIcon("Filter");

export interface ThingsPageProps {
  filter: FilterColumnProps;
  table: ReactNode;
  panel?: ReactNode;
}

export function ThingsPage({ filter, table, panel }: ThingsPageProps) {
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.innerWidth >= 1024);
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  useEffect(() => { const update = () => setWide(window.innerWidth >= 1024); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  return <div className={panel ? "pr-0 lg:pr-[29rem]" : undefined} data-testid="things-page"><div className="mb-3 flex items-center justify-between gap-3 lg:hidden"><Button type="button" variant="outline" onClick={() => setMobileFiltersOpen(true)}><Filter className="size-4" />Filter</Button></div><div className="flex min-w-0 items-start gap-5">{wide && <FilterColumn {...filter} collapsed={filterCollapsed} onCollapsedChange={setFilterCollapsed} />}<div className="min-w-0 flex-1">{table}</div></div>{panel}<Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}><SheetContent side="left" className="w-80 max-w-[calc(100vw-1rem)] p-5"><SheetHeader className="sr-only"><SheetTitle>Filters</SheetTitle><SheetDescription>Filter this table.</SheetDescription></SheetHeader><FilterColumn {...filter} collapsed={false} onCollapsedChange={() => setMobileFiltersOpen(false)} /></SheetContent></Sheet></div>;
}
