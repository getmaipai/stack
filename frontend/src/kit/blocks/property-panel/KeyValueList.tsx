import { useState } from "react";
import type { ReactNode } from "react";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";

const Check = getIcon("Check");
const Copy = getIcon("Copy");

export interface KeyValueAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface KeyValueItem {
  label: string;
  value: ReactNode;
  copy?: boolean | string;
  action?: KeyValueAction;
}

function valueText(value: ReactNode): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }

export function KeyValueList({ items }: { items: KeyValueItem[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copyValue(item: KeyValueItem) {
    const text = typeof item.copy === "string" ? item.copy : valueText(item.value);
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    setCopied(item.label);
    window.setTimeout(() => setCopied((current) => current === item.label ? null : current), 2000);
  }
  return <TooltipProvider><dl className="divide-y divide-border/70 text-sm">{items.map((item) => <div className="flex items-start justify-between gap-6 py-2.5" key={item.label}><dt className="shrink-0 text-muted-foreground">{item.label}</dt><dd className="flex min-w-0 items-center justify-end gap-2 text-right tabular-nums">{item.value}<span className="inline-flex items-center gap-1">{item.copy && <Tooltip><TooltipTrigger asChild><Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`${copied === item.label ? "Copied" : "Copy"} ${item.label}`} onClick={() => void copyValue(item)}>{copied === item.label ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</Button></TooltipTrigger><TooltipContent>{copied === item.label ? "Copied" : "Copy"}</TooltipContent></Tooltip>}{item.action && <button type="button" className="text-primary underline-offset-4 focus-visible:underline" onClick={() => void item.action?.onClick()}>{item.action.label}</button>}</span></dd></div>)}</dl></TooltipProvider>;
}
