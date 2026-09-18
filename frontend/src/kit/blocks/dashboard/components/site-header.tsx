// Reskinned for MaiPai Stack: the shadcn dashboard header with search, Try it, bell, and profile.
import { Link } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { NotificationsBell } from "@/kit/blocks/dashboard/components/notifications-popover";
import { ProfileMenu } from "@/kit/blocks/dashboard/components/profile-menu";
import { Button } from "@/kit/ui/button";
import { Separator } from "@/kit/ui/separator";
import { SidebarTrigger } from "@/kit/ui/sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/kit/ui/tooltip";

export function SiteHeader({ title, onSearch }: { title: string; onSearch: () => void }) {
  const SearchIcon = getIcon("Search");
  const MessageSquare = getIcon("MessageSquare");
  return <TooltipProvider delayDuration={0}><header className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-card"><div className="flex w-full items-center gap-2 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" /><h1 className="text-base font-medium">{title}</h1><Button className="ml-auto w-full max-w-xs justify-start text-muted-foreground" variant="outline" onClick={onSearch}><SearchIcon className="mr-2 size-4" /><span>Search Stack</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-xs sm:inline">⌘ K</kbd></Button><div className="flex items-center gap-2"><Tooltip><TooltipTrigger asChild data-try-trigger><Button asChild size="sm" className="md:w-auto"><Link to="/try" aria-label="Try it"><MessageSquare className="size-4" /><span className="hidden md:inline">Try it</span></Link></Button></TooltipTrigger><TooltipContent>Try it</TooltipContent></Tooltip><NotificationsBell /><ProfileMenu /></div></div></header></TooltipProvider>;
}
