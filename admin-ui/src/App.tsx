import { useCallback, useEffect, useMemo, useState } from "react";
import type { StackChoiceCategory } from "@maipai/ui/src/stack/StackClient";
import { Moon, Sun, LayoutDashboard, HeartPulse, Cpu, Gauge, Search, LogOut, RotateCw, Boxes, SlidersHorizontal, CircleArrowUp, Wrench, Sparkles, Ellipsis, Layers, ToggleRight, Palette as PaletteIcon } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@maipai/ui/src/ui/sheet";
import { Button } from "@maipai/ui/src/ui/button";
import { Status, StatusIndicator } from "@maipai/ui/src/ui/status";
import { Toaster } from "@maipai/ui/src/ui/sonner";
import { toast } from "sonner";
import { ApiError, api } from "./api";
import { useLive } from "./live";
import { useTheme } from "./theme";
import { Login } from "./Login";
import { Palette } from "./Palette";
import type { PaletteItem } from "./Palette";
import { Resources } from "./Resources";
import { ModelsScreen, useStackClient } from "./ModelsScreen";
import { StylesScreen } from "./StylesScreen";
import { SettingsScreen } from "./SettingsScreen";
import { Updates } from "./Updates";
import { Tools } from "./Tools";
import { Modes } from "./Modes";
import { Helper } from "./Helper";
import { HelperProvider } from "./helperChat";
import { HelperPanel } from "./HelperPanel";
import { HELPER_SHORTCUT } from "./helperText";
import { Engines, Health, healthKind, healthWord, roleWord } from "./screens";
import { IconChip, Pill } from "./kit";
import { roleIcon } from "./roleIcons";
import { setFeatureRows, useFeatureRows } from "./featureRows";
import { Overview } from "./Overview";
import { MENU, NOT_YET } from "./menu";
import type { MenuScreen } from "./menu";

type Screen = string;
interface NavItem extends MenuScreen { Icon: typeof LayoutDashboard; group: string; more: boolean }
/** Icons and the phone bar's four main places are presentation only; labels, questions and grouping come from the shared spec (`./menu`). */
const ICONS: Record<string, typeof LayoutDashboard> = { overview: LayoutDashboard, models: Boxes, styles: PaletteIcon, modes: ToggleRight, health: HeartPulse, helper: Sparkles, resources: Gauge, engines: Cpu, updates: CircleArrowUp, settings: SlidersHorizontal, tools: Wrench };
const PRIMARY_IDS = ["overview", "models", "health", "helper"];
const GROUPS = MENU.map((g) => ({ ...g, order: g.screens.map((s) => s.id) }));
const NAV: NavItem[] = MENU.flatMap((g) => g.screens.map((s) => ({ ...s, Icon: ICONS[s.id] ?? LayoutDashboard, group: g.id, more: !PRIMARY_IDS.includes(s.id) })));
const groupLabel = (g: string) => GROUPS.find((x) => x.id === g)?.label ?? g;
const PRIMARY = PRIMARY_IDS.map((id) => NAV.find((n) => n.id === id)).filter((n): n is NavItem => !!n);
const MORE = NAV.filter((n) => n.more);

/** The Features and Models screens became one (AI and models); their old addresses still open it. */
const RENAMED: Record<string, Screen> = { features: "models", ...Object.fromEntries(Object.entries(NOT_YET).filter((e): e is [string, string] => !!e[1])) };

function screenFromHash(): Screen {
  const id = window.location.hash.replace(/^#\/?/, "");
  const renamed = RENAMED[id];
  if (renamed) { window.history.replaceState(null, "", `#/${renamed}`); return renamed; }
  return NAV.some((n) => n.id === id) ? (id as Screen) : "overview";
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");
  useEffect(() => {
    api.session().then(() => setAuth("in")).catch(() => setAuth("out"));
  }, []);
  if (auth === "checking") return <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-sm text-muted-foreground" role="status"><span className="animate-pulse"><IconChip Icon={Layers} size="lg" /></span>Connecting to the Stack</div>;
  if (auth === "out") return <><Login onSignedIn={() => setAuth("in")} /><Toaster /></>;
  return <Signed onSignedOut={() => setAuth("out")} />;
}

function Signed({ onSignedOut }: { onSignedOut: () => void }) {
  const { snap, refresh } = useLive(onSignedOut);
  const { dark, toggle } = useTheme();
  const [screen, setScreen] = useState<Screen>(screenFromHash);
  const [palette, setPalette] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [helperOpen, setHelperOpen] = useState(false);
  const stackClient = useStackClient(refresh);
  // Each feature's icon and place come from the Stack's own rows (the same GET /stack/v1/choices read), loaded once; before then the small fallback table answers.
  useFeatureRows();
  useEffect(() => {
    let live = true;
    stackClient.readChoices().then((view) => { if (live) setFeatureRows(view.categories.map((c) => ({ role: c.role, icon: c.icon }))); }).catch(() => { /* the fallback icons stay */ });
    return () => { live = false; };
  }, [stackClient]);
  // The palette finds models with the same `GET /stack/v1/choices` read the AI and models screen uses; it asks again each time it opens.
  const [modelIndex, setModelIndex] = useState<readonly StackChoiceCategory[]>([]);
  useEffect(() => {
    if (!palette) return;
    let live = true;
    stackClient.readChoices().then((view) => { if (live) setModelIndex(view.categories); }).catch(() => { /* the palette still finds screens, features and actions */ });
    return () => { live = false; };
  }, [palette, stackClient]);
  const isMac = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
  useEffect(() => {
    const onHash = () => setScreen(screenFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((id: Screen) => { window.location.hash = `/${id}`; }, []);
  const notify = useCallback((message: string) => { toast(message); }, []);
  const signOut = useCallback(async () => { try { await api.logout(); } finally { onSignedOut(); } }, [onSignedOut]);
  const restartStack = useCallback(async () => {
    try { await api.restartStack(); notify("The Stack is restarting. This page reconnects by itself."); }
    catch (e) { notify(e instanceof ApiError ? e.message : "The Stack could not be restarted."); }
  }, [notify]);

  const screens: PaletteItem[] = useMemo(() => NAV.map((n) => ({ id: n.id, label: n.label, hint: n.question, Icon: n.Icon, keywords: [groupLabel(n.group)], run: () => go(n.id) })), [go]);
  const features: PaletteItem[] = useMemo(() => (snap.roles ?? []).map((r) => ({ id: `role-${r.id}`, label: r.label, hint: roleWord(r), Icon: roleIcon(r.id), tone: r.enabled === false ? "muted" as const : "primary" as const, keywords: ["feature", "role"], run: () => go("models") })), [snap.roles, go]);
  const actions: PaletteItem[] = useMemo(() => [
    { id: "helper", label: "Ask the Helper", hint: "Plain words. Nothing changes until you approve.", Icon: Sparkles, run: () => setHelperOpen(true) },
    { id: "refresh", label: "Refresh now", hint: "Read the latest numbers.", Icon: RotateCw, run: refresh },
    { id: "theme", label: dark ? "Switch to light" : "Switch to dark", hint: "This browser only.", Icon: dark ? Sun : Moon, run: toggle },
    { id: "restart", label: "Restart the Stack", hint: "Engines stop and start again.", Icon: Wrench, tone: "warn" as const, run: () => { void restartStack(); } },
    { id: "signout", label: "Sign out", Icon: LogOut, tone: "muted" as const, run: () => { void signOut(); } },
  ], [refresh, dark, toggle, restartStack, signOut]);

  const roleLabels = useMemo(() => Object.fromEntries((snap.roles ?? []).map((r) => [r.id, r.label])), [snap.roles]);
  const health = snap.status?.health;
  const problems = snap.health?.length ?? 0;
  const current = NAV.find((n) => n.id === screen) ?? NAV[0]!;
  const navButton = ({ id, label, Icon }: NavItem) => (
    <Button key={id} variant={screen === id ? "secondary" : "ghost"} className="nav-item h-10 justify-start gap-3 rounded-xl px-3" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
      <Icon aria-hidden="true" />{label}
      {id === "health" && problems > 0 && <Pill tone="warn" className="ms-auto"><span className="sr-only">Problems: </span>{problems}</Pill>}
    </Button>
  );
  return (
    <HelperProvider notify={notify} refresh={refresh}>
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <nav aria-label="Main" className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e bg-sidebar p-4 text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:self-start">
        <div className="flex items-center gap-3 px-2 pb-2 pt-1">
          <IconChip Icon={Layers} size="md" />
          <div className="min-w-0 leading-tight"><p className="font-semibold tracking-tight">MaiPai Stack</p><p className="text-xs text-muted-foreground">Admin</p></div>
        </div>
        {GROUPS.map((g) => (
          <div key={g.id} role="group" aria-label={g.label} className="flex flex-col gap-0.5">
            <p className="nav-label" aria-hidden="true">{g.label}</p>
            {NAV.filter((n) => n.group === g.id).map(navButton)}
          </div>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col pb-24 md:pb-0">
        <header className="z-10 flex shrink-0 items-center gap-2 border-b bg-background/75 px-4 py-3 backdrop-blur-xl md:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="flex items-center gap-2 text-sm font-medium" aria-live="polite">
              {health ? <><StatusIndicator status={healthKind(health)} ping={health === "ok"} />{healthWord(health)}</> : "MaiPai Stack"}
            </h1>
            <Status status={snap.live ? "online" : "maintenance"} className="hidden sm:flex" aria-label={snap.live ? "Live updates connected" : "Live updates reconnecting"}>
              <StatusIndicator status={snap.live ? "online" : "maintenance"} ping={false} />{snap.live ? "Live" : "Reconnecting"}
            </Status>
          </div>
          <button type="button" onClick={() => setPalette(true)} aria-label="Search and jump to a screen or feature" aria-keyshortcuts="Control+K Meta+K" className="search-field hidden h-9 w-56 items-center gap-2 rounded-xl px-3 text-sm text-muted-foreground md:flex lg:w-72">
            <Search aria-hidden="true" className="size-4 shrink-0" /><span className="me-auto truncate">Search screens and features</span><kbd className="rounded-md px-1.5 py-0.5 text-xs shadow-[inset_0_0_0_1px_var(--fill-2)]">{isMac ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <div className="flex flex-1 items-center justify-end gap-2">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setPalette(true)} aria-label="Search and jump to a screen or feature"><Search aria-hidden="true" /></Button>
            <Button variant="ghost" size="sm" onClick={() => setHelperOpen(true)} aria-label={`Ask the Helper (${isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other})`} aria-keyshortcuts="Control+/ Meta+/" title={`Ask the Helper (${isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other})`}><Sparkles aria-hidden="true" /><kbd className="hidden text-xs text-muted-foreground sm:inline">{isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other}</kbd></Button>
            <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh"><RotateCw aria-hidden="true" /></Button>
            <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={dark ? "Switch to light" : "Switch to dark"}>{dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
            <Button variant="ghost" size="icon-sm" onClick={() => { void signOut(); }} aria-label="Sign out"><LogOut aria-hidden="true" /></Button>
          </div>
        </header>
        <main id="main-scroll" className="mx-auto min-h-0 w-full max-w-5xl flex-1 overflow-y-auto overscroll-contain px-4 py-8 md:px-8 md:py-10">
          {/* The AI and models and Styles pages (@maipai/ui) write their own titles, so the shell does not repeat them. */}
          {screen !== "models" && screen !== "styles" && (
            <div className="mb-8 flex flex-col gap-2">
              <p className="eyebrow">{groupLabel(current.group)}</p>
              <h2 className="page-title">{current.label}</h2>
              <p className="text-muted-foreground">{current.question}</p>
            </div>
          )}
          <div key={screen} className="animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
            {screen === "overview" && <Overview snap={snap} go={(id) => go(id)} />}
            {screen === "resources" && <Resources changed={snap.status} go={(id) => go(id)} />}
            {screen === "health" && <Health snap={snap} refresh={refresh} notify={notify} />}
            {screen === "engines" && <Engines snap={snap} refresh={refresh} notify={notify} />}
            {screen === "models" && <ModelsScreen client={stackClient} snap={snap} refresh={refresh} notify={notify} go={go} />}
            {screen === "styles" && <StylesScreen client={stackClient} />}
            {screen === "updates" && <Updates refresh={refresh} notify={notify} />}
            {screen === "settings" && <SettingsScreen refresh={refresh} notify={notify} />}
            {screen === "helper" && <Helper />}
            {screen === "modes" && <Modes notify={notify} />}
            {screen === "tools" && <Tools roleLabels={roleLabels} notify={notify} />}
          </div>
        </main>
      </div>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 flex border-t bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        {PRIMARY.map(({ id, label, Icon }) => (
          <Button key={id} variant="ghost" className="tab-item h-14 min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-xs" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon aria-hidden="true" className={screen === id ? "text-primary" : "text-muted-foreground"} />{label}
          </Button>
        ))}
        <Button variant="ghost" className="tab-item h-14 min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-xs" aria-label="More screens" aria-current={current.more ? "page" : undefined} onClick={() => setMoreOpen(true)}>
          <Ellipsis aria-hidden="true" className={current.more ? "text-primary" : "text-muted-foreground"} />More
        </Button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader><SheetTitle>More</SheetTitle><SheetDescription>Less common screens.</SheetDescription></SheetHeader>
          <div className="flex flex-col gap-1 px-4 pb-4">
            {MORE.map(({ id, label, question, Icon, group }) => (
              <Button key={id} variant={screen === id ? "secondary" : "ghost"} className="nav-item h-auto min-h-12 justify-start gap-3 rounded-xl py-2" aria-current={screen === id ? "page" : undefined} onClick={() => { setMoreOpen(false); go(id); }}>
                <Icon aria-hidden="true" /><span className="flex min-w-0 flex-col items-start text-start"><span>{label}</span><span className="truncate text-xs font-normal text-muted-foreground">{groupLabel(group)} · {question}</span></span>
              </Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
      <Palette open={palette} onOpenChange={setPalette} screens={screens} features={features} models={modelIndex} onModel={() => go("models")} actions={actions} />
      <HelperPanel open={helperOpen} onOpenChange={setHelperOpen} />
      <Toaster />
    </div>
    </HelperProvider>
  );
}
