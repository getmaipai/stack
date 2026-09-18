import { Fragment, useMemo, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { getIcon } from "@/kit/icons";
import { Checkbox } from "@/kit/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/kit/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";
import { cn } from "@/kit/utils";

const ArrowDown = getIcon("ArrowDown"); const ArrowUp = getIcon("ArrowUp"); const ChevronDown = getIcon("ChevronDown"); const ChevronRight = getIcon("ChevronRight");

export type ThingStatus = "ready" | "attention" | "offline" | "detected";
export type ThingAlign = "left" | "right";
export type ThingSortDirection = "asc" | "desc";

export interface ThingLinkCell {
  type: "link";
  target: string;
  label: ReactNode;
}

export function linkCell(target: string, label: ReactNode): ThingLinkCell {
  return { type: "link", target, label };
}

export interface ThingsTableColumn<Row> {
  key: string;
  header: ReactNode;
  align?: ThingAlign;
  width?: string;
  render: (row: Row) => ReactNode | ThingLinkCell;
}

export interface ThingsTableGroup<Row> {
  key: string;
  label: ReactNode;
  ariaLabel?: string;
  rows?: Row[];
  groups?: ThingsTableGroup<Row>[];
  summary?: ReactNode;
  status?: ThingStatus;
  defaultExpanded?: boolean;
  onClick?: () => void;
}

export interface ThingsTableSort<Row> {
  key: string;
  direction?: ThingSortDirection;
  compare?: (left: Row, right: Row) => number;
}

export interface ThingsTableAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface ThingsTableProps<Row> {
  columns: ThingsTableColumn<Row>[];
  rows: Row[];
  getStatus?: (row: Row) => ThingStatus;
  getKey: (row: Row) => string;
  groups?: ThingsTableGroup<Row>[];
  selectable?: boolean | { rowSelectable?: (row: Row) => boolean; selectedKeys?: string[] };
  onSelectionChange?: (rows: Row[]) => void;
  onRowClick?: (row: Row) => void;
  selectedKey?: string;
  getRowProps?: (row: Row) => HTMLAttributes<HTMLTableRowElement>;
  sort?: ThingsTableSort<Row> | false;
  onSortChange?: (sort: ThingsTableSort<Row>) => void;
  onLink?: (target: string) => void;
  actions?: ThingsTableAction[];
  empty: string;
}

const statusLabels: Record<ThingStatus, string> = { ready: "Ready", attention: "Needs attention", offline: "Offline", detected: "Detected" };
const statusClasses: Record<ThingStatus, string> = { ready: "bg-emerald-500", attention: "bg-amber-500", offline: "bg-destructive", detected: "bg-muted-foreground" };

function isLinkCell(value: ReactNode | ThingLinkCell): value is ThingLinkCell {
  return typeof value === "object" && value !== null && "type" in value && value.type === "link";
}

function textContent(value: ReactNode | ThingLinkCell): string {
  if (isLinkCell(value)) return textContent(value.label);
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((part) => textContent(part)).join(" ");
  return "";
}

function StatusDot({ status }: { status: ThingStatus }) {
  const label = statusLabels[status];
  return <Tooltip><TooltipTrigger asChild><span className={cn("inline-block size-2 shrink-0 rounded-full", statusClasses[status])} role="img" aria-label={label} title={label} /></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>;
}

function renderCell(value: ReactNode | ThingLinkCell, onLink?: (target: string) => void): ReactNode {
  if (!isLinkCell(value)) return value;
  return <a className="text-primary underline-offset-4 focus-visible:underline" href={value.target} onClick={(event) => { if (onLink) { event.preventDefault(); onLink(value.target); } event.stopPropagation(); }}>{value.label}</a>;
}

function sortRows<Row>(rows: Row[], columns: ThingsTableColumn<Row>[], activeSort: ThingsTableSort<Row> | null): Row[] {
  if (!activeSort) return rows;
  const column = columns.find((item) => item.key === activeSort.key);
  if (!column) return rows;
  const direction = activeSort.direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const result = activeSort.compare ? activeSort.compare(left, right) : textContent(column.render(left)).localeCompare(textContent(column.render(right)), undefined, { numeric: true, sensitivity: "base" });
    return result * direction;
  });
}

export function ThingsTable<Row>({ columns, rows, getStatus = () => "ready", getKey, groups = [], selectable = false, onSelectionChange, onRowClick, selectedKey, getRowProps, sort, onSortChange, onLink, actions = [], empty }: ThingsTableProps<Row>) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(groups.filter((group) => group.defaultExpanded).map((group) => group.key)));
  const [activeSort, setActiveSort] = useState<ThingsTableSort<Row> | null>(() => sort || null);
  const initialSelected = typeof selectable === "object" ? selectable.selectedKeys ?? [] : [];
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set(initialSelected));
  const [clickedKey, setClickedKey] = useState<string | null>(null);
  const rowSelectable = (row: Row) => (typeof selectable === "object" ? selectable.rowSelectable?.(row) : undefined) ?? true;
  const selectableRows = rows.filter(rowSelectable);
  const visibleRows = useMemo(() => sortRows(rows, columns, activeSort), [activeSort, columns, rows]);
  const allSelected = selectableRows.length > 0 && selectableRows.every((row) => selectedKeys.has(getKey(row)));

  function changeSelection(next: Set<string>) {
    setSelectedKeys(next);
    onSelectionChange?.(rows.filter((row) => next.has(getKey(row))));
  }

  function toggleSort(key: string) {
    if (sort === false) return;
    const next: ThingsTableSort<Row> = activeSort?.key === key && activeSort.direction !== "desc" ? { key, direction: "desc" } : { key, direction: "asc" };
    setActiveSort(next);
    onSortChange?.(next);
  }

  function toggleRow(row: Row, checked: boolean) {
    const next = new Set(selectedKeys);
    const key = getKey(row);
    if (checked) next.add(key); else next.delete(key);
    changeSelection(next);
  }

  function toggleAll(checked: boolean) {
    const next = new Set(selectedKeys);
    for (const row of selectableRows) { const key = getKey(row); if (checked) next.add(key); else next.delete(key); }
    changeSelection(next);
  }

  const renderRow = (row: Row, depth = 0) => {
    const props = getRowProps?.(row);
    const selected = (selectedKey ?? clickedKey) === getKey(row);
    const rowStatus = getStatus(row);
    return <TableRow key={getKey(row)} {...props} data-selected={selected || props?.["aria-selected"] === true ? "true" : undefined} className={cn("group/thing cursor-pointer focus-visible:bg-muted/50", selected && "bg-muted/50", props?.className)} tabIndex={props?.tabIndex ?? (onRowClick ? 0 : undefined)} onClick={(event) => { props?.onClick?.(event); if (!event.defaultPrevented) { setClickedKey(getKey(row)); onRowClick?.(row); } }}>
      {columns.map((column, index) => {
        const value = column.render(row);
        const content = renderCell(value, onLink);
        return <TableCell key={column.key} className={cn(column.align === "right" && "text-right tabular-nums", index === 0 && "min-w-0")} style={{ width: column.width, paddingLeft: index === 0 ? `${depth * 1.5 + 0.75}rem` : undefined }}>
          {index === 0 ? <div className="flex min-w-0 items-center gap-3"><StatusDot status={rowStatus} />{selectable && rowSelectable(row) && <Checkbox aria-label={`Select ${textContent(value) || getKey(row)}`} checked={selectedKeys.has(getKey(row))} onCheckedChange={(checked) => toggleRow(row, checked === true)} onClick={(event) => event.stopPropagation()} />}{textContent(value) ? <Tooltip><TooltipTrigger asChild><div className="min-w-0 max-w-full" title={textContent(value)}>{content}</div></TooltipTrigger><TooltipContent>{textContent(value)}</TooltipContent></Tooltip> : content}</div> : content}
        </TableCell>;
      })}
    </TableRow>;
  };

  const renderGroup = (group: ThingsTableGroup<Row>, depth = 0): ReactNode => {
    const isExpanded = expanded.has(group.key);
    const groupStatus = group.status ?? "ready";
    const childRows = sortRows(group.rows ?? [], columns, activeSort);
    const childGroups = group.groups ?? [];
    return <Fragment key={`group-${group.key}`}><TableRow className="cursor-pointer focus-visible:bg-muted/50" onClick={() => group.onClick?.()} tabIndex={group.onClick ? 0 : undefined}>
      <TableCell style={{ paddingLeft: `${depth * 1.5 + 0.75}rem` }} colSpan={1}><div className="flex min-w-0 items-center gap-3"><button type="button" className="inline-flex size-6 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${group.ariaLabel ?? textContent(group.label)}`} onClick={(event) => { event.stopPropagation(); setExpanded((current) => { const next = new Set(current); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; }); }}>{isExpanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button><StatusDot status={groupStatus} /><div className="min-w-0">{group.label}</div></div></TableCell>
      {columns.length > 1 && <TableCell colSpan={columns.length - 1} className="text-right text-sm text-muted-foreground">{group.summary}</TableCell>}
    </TableRow>{isExpanded && childRows.map((row) => renderRow(row, depth + 1))}{isExpanded && childGroups.map((child) => renderGroup(child, depth + 1))}</Fragment>;
  };

  const hasContent = rows.length > 0 || groups.length > 0;
  const headerCheckbox = selectable && <Checkbox aria-label="Select all rows" checked={allSelected ? true : selectedKeys.size > 0 ? "indeterminate" : false} onCheckedChange={(checked) => toggleAll(checked === true)} />;
  return <TooltipProvider><div className="w-full overflow-x-auto"><Table><TableHeader><TableRow>{columns.map((column, index) => <TableHead key={column.key} className={cn("h-11 text-xs uppercase tracking-wide text-muted-foreground", column.align === "right" && "text-right", index === 0 && "min-w-56")} style={{ width: column.width }}><div className={cn("flex items-center gap-2", column.align === "right" && "justify-end")}>{index === 0 && headerCheckbox}{sort !== false ? <button type="button" aria-label={typeof column.header === "string" ? column.header : column.key} className="inline-flex items-center gap-1 text-left font-medium focus-visible:underline" onClick={() => toggleSort(column.key)}>{column.header}{activeSort?.key === column.key && (activeSort.direction === "desc" ? <ArrowDown className="size-3.5" aria-label="sorted descending" /> : <ArrowUp className="size-3.5" aria-label="sorted ascending" />)}</button> : column.header}</div></TableHead>)}</TableRow></TableHeader>{hasContent ? <TableBody>{visibleRows.map((row) => renderRow(row))}{groups.map((group) => renderGroup(group))}</TableBody> : <TableBody><TableRow><TableCell colSpan={columns.length} className="py-12 text-center text-muted-foreground">{empty}</TableCell></TableRow></TableBody>}</Table></div>{actions.length > 0 && <div className="flex flex-wrap items-center gap-x-4 border-t py-3 text-sm text-muted-foreground">{actions.map((action, index) => <span className="inline-flex items-center gap-4" key={action.label}>{index > 0 && <span className="h-4 w-px bg-border" aria-hidden="true" />}<button type="button" className="text-primary underline-offset-4 focus-visible:underline disabled:cursor-not-allowed disabled:text-muted-foreground" disabled={action.disabled} onClick={action.onClick}>{action.label}</button></span>)}</div>}</TooltipProvider>;
}
