import { useRef, type ReactNode } from "react";
import { getIcon, type IconName } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Sheet, SheetContent } from "@/kit/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/kit/ui/tabs";
import { StatusPill } from "@/kit/blocks/cards/StatusPill";
import type { StatusKind } from "@/lib/status";
import { cn } from "@/kit/utils";

const CloseIcon = getIcon("X");

export interface DetailsPaneAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
  destructive?: boolean;
  disabledReason?: string;
}

export interface DetailsPaneTab {
  id: string;
  label: string;
  content: ReactNode;
}

export interface DetailsPaneProps {
  open: boolean;
  onClose: () => void;
  icon: IconName;
  hue: string;
  name: string;
  identifier: string;
  status: StatusKind;
  tabs?: DetailsPaneTab[];
  actions?: DetailsPaneAction[];
}

// 560/480/640, 16-20 inset, 16 radius, thin blue border, the shadow
// token; open 200ms/24px translate, close 160ms, none under reduced
// motion (spec: "Component browser and details pane reference"). Built
// on the kit's Sheet (Radix Dialog under it) for the overlay, Escape
// and focus trap it already gives for free; this file adds the pane's
// own geometry, header, tabs and action rail on top.
export function DetailsPane({ open, onClose, icon, hue, name, identifier, status, tabs = [], actions = [] }: DetailsPaneProps) {
  const Icon = getIcon(icon);
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        showCloseButton={false}
        side="right"
        role="complementary"
        aria-label={`${name} details`}
        onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}
        className={cn(
          "inset-y-4 right-4 h-auto w-[560px] min-w-[480px] max-w-[640px] rounded-2xl border border-[var(--primary)]/40 bg-[var(--surface-card)] shadow-[var(--shadow-panel)]",
          "duration-200 data-[state=closed]:duration-150 data-[state=closed]:slide-out-to-right-6 data-[state=open]:slide-in-from-right-6",
          "motion-reduce:transition-none motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none",
          "max-[959px]:inset-4 max-[959px]:w-auto max-[959px]:max-w-none",
          "max-[719px]:inset-0 max-[719px]:h-svh max-[719px]:w-full max-[719px]:min-w-0 max-[719px]:rounded-none max-[719px]:border-0",
        )}
      >
        <div className="flex items-center gap-3 border-b p-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in srgb, var(${hue}) 16%, transparent)`, color: `var(${hue})` }}>
            <Icon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold outline-none">{name}</h2>
            <p className="truncate text-xs text-muted-foreground">{identifier}</p>
          </div>
          <StatusPill status={status} />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose} className="max-[719px]:order-first"><CloseIcon className="size-4" aria-hidden="true" /></Button>
        </div>

        {tabs.length > 0 && (
          <Tabs defaultValue={tabs[0]!.id} className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-4 mt-2 w-fit">
              {tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id}>{tab.label}</TabsTrigger>)}
            </TabsList>
            {tabs.map((tab) => <TabsContent key={tab.id} value={tab.id} className="min-h-0 flex-1 overflow-y-auto p-4">{tab.content}</TabsContent>)}
          </Tabs>
        )}

        {actions.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-2 border-t p-4 max-[719px]:sticky max-[719px]:bottom-0 max-[719px]:bg-[var(--surface-card)]">
            {actions.map((action) => {
              const ActionIcon = action.icon ? getIcon(action.icon) : null;
              return (
                <Button key={action.label} type="button" variant={action.destructive ? "destructive" : "outline"} size="sm" disabled={!!action.disabledReason} title={action.disabledReason} onClick={action.onClick} className={cn(action.destructive && "ml-auto")}>
                  {ActionIcon && <ActionIcon className="size-4" aria-hidden="true" />}
                  {action.label}
                </Button>
              );
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
