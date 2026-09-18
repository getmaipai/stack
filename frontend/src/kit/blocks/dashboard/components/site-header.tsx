// Reskinned for MaiPai Stack: the shell header names this computer and keeps the controls quiet.
import * as React from "react";
import { getIcon } from "@/kit/icons";
import { NotificationsBell } from "@/kit/blocks/dashboard/components/notifications-popover";
import { ProfileMenu } from "@/kit/blocks/dashboard/components/profile-menu";
import { api } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import { Separator } from "@/kit/ui/separator";
import { SidebarTrigger } from "@/kit/ui/sidebar";

const SearchIcon = getIcon("Sparkles");
const Pause = getIcon("Square");
const Play = getIcon("Play");

export function SiteHeader({ title, onSearch, runState = "running", onRunStateChange }: { title: string; onSearch: () => void; runState?: "running" | "pausing" | "paused"; onRunStateChange?: () => void }) {
  const [confirm, setConfirm] = React.useState(false);
  async function toggleRunState(): Promise<void> { const next = runState === "paused" ? "running" : "paused"; await api.post("/stack/v1/run-state", { state: next }); setConfirm(false); onRunStateChange?.(); }
  return <header className="sticky top-0 z-20 flex min-h-(--header-height) shrink-0 items-center overflow-visible border-b bg-card"><div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 sm:px-4 lg:px-6"><div className="flex min-w-0 items-center gap-2"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" /><h1 className="min-w-0 truncate text-base font-semibold">{title}</h1></div><div className="hidden items-center justify-self-center sm:flex">{confirm ? <div className="flex items-center gap-2 text-sm"><span>Pause anyway?</span><Button size="sm" onClick={() => void toggleRunState()}>Pause</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button></div> : <Button variant="outline" size="sm" className={runState === "paused" ? "border-amber-500 text-amber-700" : ""} onClick={() => runState === "running" ? setConfirm(true) : void toggleRunState()} aria-label={runState === "paused" ? "Resume Stack" : "Pause Stack"}>{runState === "pausing" ? "Pausing…" : runState === "paused" ? <><Play className="mr-1 size-3" />Paused</> : <><Pause className="mr-1 size-3" />Running</>}</Button>}</div><div className="flex items-center justify-self-end overflow-visible"><Button aria-label="Ask" title="Ask (⌘K)" className="size-9 shrink-0 justify-center p-0 text-muted-foreground" variant="outline" onClick={onSearch}><SearchIcon className="size-4" /><span className="sr-only">Ask</span></Button><div className="flex items-center gap-1 overflow-visible"><NotificationsBell /><ProfileMenu /></div></div></div></header>;
}
