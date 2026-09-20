import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getIcon } from "@/kit/icons";
import { FilterColumn, type FilterColumnProps } from "@/kit/blocks/filter-column/FilterColumn";
import { Button } from "@/kit/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/kit/ui/sheet";
import { usePhoneMode } from "@/kit/blocks/phone/PhoneMode";
import { ChipRow } from "@/kit/blocks/phone/ChipRow";

const Filter = getIcon("Filter");

export interface ThingsPageProps {
  filter: FilterColumnProps;
  table: ReactNode;
  panel?: ReactNode;
}

export function ThingsPage({ filter, table, panel }: ThingsPageProps) {
  const phone = usePhoneMode();
  const [wide, setWide] = useState(() => typeof window === "undefined" || window.innerWidth >= 960);
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  useEffect(() => { const update = () => setWide(window.innerWidth >= 960); update(); window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, []);
  const phoneChips = ["All", ...filter.groups.map((group) => group.title)];
  return <div data-testid="things-page">{phone ? <ChipRow chips={phoneChips} active="All" /> : <div className="mb-3 flex items-center justify-between gap-3 lg:hidden"><Button type="button" variant="outline" onClick={() => setMobileFiltersOpen(true)}><Filter className="size-4" />Filter</Button></div>}<div className="flex min-w-0 items-start gap-5">{wide && !phone && <FilterColumn {...filter} collapsed={filterCollapsed} onCollapsedChange={setFilterCollapsed} />}<div className="min-w-0 flex-1" data-testid="things-table-region">{table}</div></div>{panel && !phone ? panel : null}<Sheet open={mobileFiltersOpen} onOpenChange={setMobileFiltersOpen}><SheetContent side="left" className="w-80 max-w-[calc(100vw-1rem)] p-5"><SheetHeader className="sr-only"><SheetTitle>Filters</SheetTitle><SheetDescription>Filter this table.</SheetDescription></SheetHeader><FilterColumn {...filter} collapsed={false} onCollapsedChange={() => setMobileFiltersOpen(false)} /></SheetContent></Sheet></div>;
}
