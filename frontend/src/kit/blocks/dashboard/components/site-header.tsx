// Copied by registry from shadcn/ui dashboard-01; reskinned for MaiPai Stack.
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Separator } from "@/kit/ui/separator";
import { SidebarTrigger } from "@/kit/ui/sidebar";

export function SiteHeader({ title, onSearch }: { title: string; onSearch: () => void }) {
  const SearchIcon = getIcon("Search");
  return <header className="flex min-h-(--header-height) shrink-0 items-center gap-2 border-b bg-card"><div className="flex w-full items-center gap-2 px-4 lg:px-6"><SidebarTrigger className="-ml-1" /><Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" /><h1 className="text-base font-medium">{title}</h1><Button className="ml-auto w-full max-w-xs justify-start text-muted-foreground" variant="outline" onClick={onSearch}><SearchIcon className="mr-2 size-4" /><span>Search Stack</span><kbd className="ml-auto hidden rounded border bg-muted px-1.5 text-xs sm:inline">⌘ K</kbd></Button></div></header>;
}
