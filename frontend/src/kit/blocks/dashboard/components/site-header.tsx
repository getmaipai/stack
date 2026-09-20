// MaiPai Stack fixed header: destination title, global search, appearance,
// notifications, and the machine selector slot. Spec: "Fixed top header",
// "Current destination header rule".
import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";
import { getIcon } from "@/kit/icons";
import { allDestinations, type TaxonomyDestination } from "@/lib/taxonomy";
import { api } from "@/lib/api";
import { Button } from "@/kit/ui/button";
import { Input } from "@/kit/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/kit/ui/popover";
import { SidebarTrigger } from "@/kit/ui/sidebar";
import { NotificationsBell } from "@/kit/blocks/dashboard/components/notifications-popover";
import { MachineSelector } from "@/kit/blocks/dashboard/components/machine-selector";

const SearchIcon = getIcon("Search");
const MonitorIcon = getIcon("Monitor");
const SunIcon = getIcon("Sun");
const MoonIcon = getIcon("Moon");

// Every taxonomy.ts destination has a real route now (DashboardShell.tsx's
// <Routes>): a built page, or Lane A's ComingSoonPage placeholder for a
// category whose CategoryBrowser configuration hasn't landed yet (UI-12
// through UI-19). Nothing here dead-ends. /abilities is the one extra:
// a real page that isn't a taxonomy destination.
const EXTRA_DESTINATIONS: TaxonomyDestination[] = [
  { id: "abilities", label: "Add abilities", path: "/abilities", subtitle: "Install a model, a runtime, or another component.", icon: "Plus" },
];

function liveDestinations(): TaxonomyDestination[] {
  return [...allDestinations(), ...EXTRA_DESTINATIONS];
}

// Longest matching path wins so "/settings/updates" still reads as
// Settings and "/models/:id" still reads as Models.
function destinationForPath(pathname: string): TaxonomyDestination {
  const destinations = liveDestinations();
  const overview = destinations.find((d) => d.id === "overview")!;
  let best: TaxonomyDestination | null = null;
  for (const destination of destinations) {
    if (destination.path === "/") continue;
    if (pathname === destination.path || pathname.startsWith(`${destination.path}/`)) {
      if (!best || destination.path.length > best.path.length) best = destination;
    }
  }
  return best ?? overview;
}

function DestinationHeader() {
  const location = useLocation();
  const destination = destinationForPath(location.pathname);
  const Icon = getIcon(destination.icon);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <h1 className="truncate text-lg font-semibold sm:text-xl">{destination.label}</h1>
        <p className="hidden truncate text-xs text-muted-foreground sm:block">{destination.subtitle}</p>
      </div>
    </div>
  );
}

interface SearchResult { label: string; path: string; destructive?: boolean; arm?: boolean; onSelect?: () => void }

// Pausing stops every loaded engine on this machine, the same
// consequential action the old header's "Pause anyway?" row confirmed
// before posting. Selecting it once arms a "Click again to confirm" row
// (the popover stays open, nothing posts yet) instead of posting
// immediately; selecting anything else disarms it.
function useSearchResults(query: string, confirmingPause: boolean): SearchResult[] {
  const trimmed = query.trim().toLowerCase();
  const destinations = liveDestinations();
  const pages: SearchResult[] = trimmed
    ? destinations.filter((d) => d.label.toLowerCase().includes(trimmed) || d.subtitle.toLowerCase().includes(trimmed)).map((d) => ({ label: d.label, path: d.path }))
    : destinations.slice(0, 8).map((d) => ({ label: d.label, path: d.path }));
  const commands: SearchResult[] = [];
  if (!trimmed || "pause everything".includes(trimmed) || "resume".includes(trimmed)) {
    commands.push(
      confirmingPause
        ? { label: "Click again to confirm pausing everything", path: "", destructive: true, onSelect: () => { void api.post("/stack/v1/run-state", { state: "paused" }); } }
        : { label: "Pause everything", path: "", arm: true },
    );
    commands.push({ label: "Resume", path: "", onSelect: () => { void api.post("/stack/v1/run-state", { state: "running" }); } });
  }
  return [...pages, ...commands];
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [confirmingPause, setConfirmingPause] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const results = useSearchResults(query, confirmingPause);

  function closeUnlessMovingIntoResults(relatedTarget: EventTarget | null): void {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (relatedTarget instanceof Node && contentRef.current?.contains(relatedTarget)) return;
    closeTimer.current = setTimeout(() => { setOpen(false); setConfirmingPause(false); }, 100);
  }

  function cancelScheduledClose(): void {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }

  React.useEffect(() => cancelScheduledClose, []);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.key === "k" && (event.metaKey || event.ctrlKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
      if (event.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function select(result: SearchResult) {
    if (result.arm) {
      setConfirmingPause(true);
      return;
    }
    setOpen(false);
    setQuery("");
    setConfirmingPause(false);
    if (result.onSelect) result.onSelect();
    else navigate(result.path);
  }

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <div className="relative w-full max-w-md">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setConfirmingPause(false); }}
            onFocus={() => { cancelScheduledClose(); setOpen(true); }}
            onBlur={(event) => closeUnlessMovingIntoResults(event.relatedTarget)}
            placeholder="Search models, apps, drivers, anything…"
            aria-label="Search models, apps, drivers, anything"
            className="pl-9 pr-14"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline-block">⌘K</kbd>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        align="start"
        sideOffset={6}
        className="w-(--radix-popover-trigger-width) max-w-md p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {results.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No matches.</p>
        ) : (
          <ul role="listbox">
            {results.map((result) => (
              <li key={`${result.label}-${result.path}`}>
                <button
                  type="button"
                  className={`flex w-full items-center rounded-sm px-3 py-2 text-left text-sm hover:bg-accent ${result.destructive ? "text-destructive hover:text-destructive" : "hover:text-accent-foreground"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => select(result)}
                  onFocus={cancelScheduledClose}
                  onBlur={(event) => closeUnlessMovingIntoResults(event.relatedTarget)}
                >
                  {result.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AppearanceControl() {
  const { theme, setTheme } = useTheme();
  const options: { value: "system" | "light" | "dark"; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  return (
    <div className="hidden items-center gap-0.5 rounded-md border bg-muted/40 p-0.5 sm:flex">
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="icon-sm"
          variant={theme === option.value ? "secondary" : "ghost"}
          aria-label={`Use ${option.label.toLowerCase()} appearance`}
          aria-pressed={theme === option.value}
          title={option.label}
          onClick={() => setTheme(option.value)}
        >
          {option.value === "dark" ? <MoonIcon className="size-4" /> : option.value === "light" ? <SunIcon className="size-4" /> : <MonitorIcon className="size-4" />}
        </Button>
      ))}
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center border-b bg-[var(--surface-sidebar)] px-3 sm:px-4 lg:px-6">
      <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 shrink-0" />
          <DestinationHeader />
        </div>
        <div className="hidden justify-self-center sm:block">
          <GlobalSearch />
        </div>
        <div className="flex items-center justify-self-end gap-1">
          <AppearanceControl />
          <NotificationsBell />
          <MachineSelector />
        </div>
      </div>
    </header>
  );
}
