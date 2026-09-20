import { useRef, type ReactNode } from "react";
import { Checkbox } from "@/kit/ui/checkbox";
import { Button } from "@/kit/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/kit/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/kit/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";
import { getIcon } from "@/kit/icons";
import { useBreakpoint } from "@/kit/hooks/useBreakpoint";
import { cn } from "@/kit/utils";

const MoreHorizontal = getIcon("MoreHorizontal");

export interface DataTableColumn<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Secondary columns (priority > 0) hide first, under 1280px. */
  priority?: number;
  className?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  activeRowId?: string | null;
  onRowClick?: (row: T) => void;
  rowMenu?: (row: T) => ReactNode;
}

// A plain array-driven table over the kit's Table primitives. The
// installed @tanstack/react-table (v9) ships a headless-factory API
// built for faceting, grouping and pinning; a sortable/selectable list
// with none of those needs it only through a "legacy" compatibility
// shim whose generics don't infer cleanly for an arbitrary row type.
// This browser has no such needs, so it drives its own array directly
// (the reuse-decision rule: extend or compose a primitive when it fits,
// build fresh only for a demonstrably different behavior).
export function DataTable<T>({ data, columns, getRowId, selectedIds = [], onSelectionChange, activeRowId, onRowClick, rowMenu }: DataTableProps<T>) {
  const { under } = useBreakpoint();
  const hideSecondary = under(1280);
  const visibleColumns = hideSecondary ? columns.filter((column) => !column.priority) : columns;
  const containerRef = useRef<HTMLDivElement>(null);

  const visibleIds = data.map((row) => getRowId(row));
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const someSelected = !allSelected && visibleIds.some((id) => selectedIds.includes(id));

  function toggleAll(): void {
    onSelectionChange?.(allSelected ? selectedIds.filter((id) => !visibleIds.includes(id)) : [...new Set([...selectedIds, ...visibleIds])]);
  }
  function toggleRow(id: string): void {
    onSelectionChange?.(selectedIds.includes(id) ? selectedIds.filter((existing) => existing !== id) : [...selectedIds, id]);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTableSectionElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(containerRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? []);
    const currentIndex = rows.findIndex((row) => row === document.activeElement || row.contains(document.activeElement));
    const nextIndex = event.key === "ArrowDown" ? Math.min(rows.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
    rows[nextIndex]?.focus();
  }

  return (
    <div ref={containerRef} className="min-w-0 overflow-x-auto">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-[var(--surface-page)]">
          <TableRow>
            {onSelectionChange && (
              <TableHead className="w-10">
                <Checkbox checked={allSelected ? true : someSelected ? "indeterminate" : false} onCheckedChange={toggleAll} aria-label="Select all rows" />
              </TableHead>
            )}
            {visibleColumns.map((column) => <TableHead key={column.id}>{column.header}</TableHead>)}
            {rowMenu && <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody onKeyDown={onKeyDown}>
          {data.map((row) => {
            const id = getRowId(row);
            return (
              <TableRow key={id} tabIndex={0} data-active={activeRowId === id} className={cn("cursor-pointer", activeRowId === id && "bg-[var(--surface-pane)]")} onClick={() => onRowClick?.(row)} onKeyDown={(event) => { if (event.key === "Enter") onRowClick?.(row); }}>
                {onSelectionChange && (
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <Checkbox checked={selectedIds.includes(id)} onCheckedChange={() => toggleRow(id)} aria-label={`Select row ${id}`} />
                  </TableCell>
                )}
                {visibleColumns.map((column) => (
                  <TableCell key={column.id} className={cn("max-w-0 truncate", column.className)}>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild><span className="block truncate">{column.cell(row)}</span></TooltipTrigger>
                        <TooltipContent>{column.cell(row)}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </TableCell>
                ))}
                {rowMenu && (
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end">{rowMenu(row)}</DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
