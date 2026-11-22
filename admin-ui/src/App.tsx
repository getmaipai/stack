import { useCallback, useEffect, useMemo, useState } from "react";
import { Moon, Sun, LayoutDashboard, HeartPulse, Cpu, Gauge, Search, LogOut, RotateCw, ToggleRight, Boxes, SlidersHorizontal, CircleArrowUp, Wrench, Sparkles, Ellipsis } from "lucide-react";
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
import { Features } from "./Features";
import { Models } from "./Models";
import { SettingsScreen } from "./SettingsScreen";
import { Updates } from "./Updates";
import { Tools } from "./Tools";
import { Helper } from "./Helper";
import { HelperProvider } from "./helperChat";
import { HelperPanel } from "./HelperPanel";
import { HELPER_SHORTCUT } from "./helperText";
import { Engines, Health, healthKind, healthWord } from "./screens";
import { Overview } from "./Overview";

type Screen = "overview" | "features" | "models" | "engines" | "resources" | "health" | "updates" | "settings" | "tools" | "helper";
interface NavItem { id: Screen; label: string; question: string; Icon: typeof LayoutDashboard; more?: boolean }
const NAV: NavItem[] = [
  { id: "overview", label: "Overview", question: "Is everything working?", Icon: LayoutDashboard },
  { id: "features", label: "Features", question: "What should this computer be able to do?", Icon: ToggleRight },
  { id: "models", label: "Models", question: "Which AI model does each feature use?", Icon: Boxes },
  { id: "health", label: "Health", question: "Does anything need fixing?", Icon: HeartPulse },
  { id: "helper", label: "Helper", question: "Ask in plain words. Nothing changes until you approve.", Icon: Sparkles },
  { id: "resources", label: "Resources", question: "Is there enough memory?", Icon: Gauge, more: true },
  { id: "engines", label: "Engines", question: "What is doing the work behind the scenes?", Icon: Cpu, more: true },
  { id: "updates", label: "Updates", question: "Is anything out of date?", Icon: CircleArrowUp, more: true },
  { id: "settings", label: "Settings", question: "Fine tuning. The defaults are fine for most people.", Icon: SlidersHorizontal, more: true },
  { id: "tools", label: "Tools", question: "Restart, check, and repair.", Icon: Wrench, more: true },
];
const PRIMARY = NAV.filter((n) => !n.more);
const MORE = NAV.filter((n) => n.more);

function screenFromHash(): Screen {
  const id = window.location.hash.replace(/^#\/?/, "");
  return NAV.some((n) => n.id === id) ? (id as Screen) : "overview";
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "out" | "in">("checking");
  useEffect(() => {
    api.session().then(() => setAuth("in")).catch(() => setAuth("out"));
  }, []);
  if (auth === "checking") return <div className="flex min-h-dvh items-center justify-center text-muted-foreground" role="status">Loading</div>;
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

  const screens: PaletteItem[] = useMemo(() => NAV.map((n) => ({ id: n.id, label: n.label, run: () => go(n.id) })), [go]);
  const actions: PaletteItem[] = useMemo(() => [
    { id: "helper", label: "Ask the Helper", run: () => setHelperOpen(true) },
    { id: "refresh", label: "Refresh now", run: refresh },
    { id: "theme", label: dark ? "Switch to light" : "Switch to dark", run: toggle },
    { id: "restart", label: "Restart the Stack", run: () => { void restartStack(); } },
    { id: "signout", label: "Sign out", run: () => { void signOut(); } },
  ], [refresh, dark, toggle, restartStack, signOut]);

  const roleLabels = useMemo(() => Object.fromEntries((snap.roles ?? []).map((r) => [r.id, r.label])), [snap.roles]);
  const health = snap.status?.health;
  const problems = snap.health?.length ?? 0;
  const current = NAV.find((n) => n.id === screen) ?? NAV[0]!;
  const navButton = ({ id, label, Icon }: NavItem) => (
    <Button key={id} variant={screen === id ? "secondary" : "ghost"} className="h-10 justify-start gap-3 rounded-xl px-3" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
      <Icon aria-hidden="true" />{label}
      {id === "health" && problems > 0 && <span className="ms-auto rounded-full bg-[var(--status-warning)] px-2 text-xs font-medium text-background">{problems}</span>}
    </Button>
  );
  return (
    <HelperProvider notify={notify} refresh={refresh}>
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav aria-label="Main" className="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-e bg-sidebar p-4 text-sidebar-foreground md:sticky md:top-0 md:flex md:h-dvh md:self-start">
        <p className="px-3 pb-4 pt-2 text-lg font-semibold tracking-tight">MaiPai Stack</p>
        {PRIMARY.map(navButton)}
        <p className="mt-6 px-3 pb-1 text-xs font-medium text-muted-foreground">More</p>
        {MORE.map(navButton)}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col pb-24 md:pb-0">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/75 px-4 py-3 backdrop-blur-xl md:px-8">
          <h1 className="me-auto flex items-center gap-2 text-sm font-medium" aria-live="polite">
            {health ? <><StatusIndicator status={healthKind(health)} ping={health === "ok"} />{healthWord(health)}</> : "MaiPai Stack"}
          </h1>
          <Status status={snap.live ? "online" : "maintenance"} className="hidden sm:flex" aria-label={snap.live ? "Live updates connected" : "Live updates reconnecting"}>
            <StatusIndicator status={snap.live ? "online" : "maintenance"} ping={false} />{snap.live ? "Live" : "Reconnecting"}
          </Status>
          <Button variant="ghost" size="sm" onClick={() => setPalette(true)} aria-label="Search and jump to a screen"><Search aria-hidden="true" /><kbd className="hidden text-xs text-muted-foreground sm:inline">⌘K</kbd></Button>
          <Button variant="ghost" size="sm" onClick={() => setHelperOpen(true)} aria-label={`Ask the Helper (${isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other})`} aria-keyshortcuts="Control+/ Meta+/" title={`Ask the Helper (${isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other})`}><Sparkles aria-hidden="true" /><kbd className="hidden text-xs text-muted-foreground sm:inline">{isMac ? HELPER_SHORTCUT.mac : HELPER_SHORTCUT.other}</kbd></Button>
          <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh"><RotateCw aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={dark ? "Switch to light" : "Switch to dark"}>{dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
          <Button variant="ghost" size="icon-sm" onClick={() => { void signOut(); }} aria-label="Sign out"><LogOut aria-hidden="true" /></Button>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
          <div className="mb-8 flex flex-col gap-1">
            <h2 className="text-3xl font-semibold tracking-tight">{current.label}</h2>
            <p className="text-muted-foreground">{current.question}</p>
          </div>
          <div key={screen} className="animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
            {screen === "overview" && <Overview snap={snap} go={(id) => go(id as Screen)} />}
            {screen === "resources" && <Resources changed={snap.status} />}
            {screen === "health" && <Health snap={snap} refresh={refresh} notify={notify} />}
            {screen === "engines" && <Engines snap={snap} refresh={refresh} notify={notify} />}
            {screen === "features" && <Features snap={snap} refresh={refresh} notify={notify} />}
            {screen === "models" && <Models snap={snap} refresh={refresh} notify={notify} />}
            {screen === "updates" && <Updates refresh={refresh} notify={notify} />}
            {screen === "settings" && <SettingsScreen refresh={refresh} notify={notify} />}
            {screen === "helper" && <Helper />}
            {screen === "tools" && <Tools roleLabels={roleLabels} notify={notify} />}
          </div>
        </main>
      </div>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 flex border-t bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        {PRIMARY.map(({ id, label, Icon }) => (
          <Button key={id} variant="ghost" className="h-14 min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-xs" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon aria-hidden="true" className={screen === id ? "text-primary" : "text-muted-foreground"} />{label}
          </Button>
        ))}
        <Button variant="ghost" className="h-14 min-w-0 flex-1 flex-col gap-0.5 rounded-none px-1 text-xs" aria-label="More screens" aria-current={current.more ? "page" : undefined} onClick={() => setMoreOpen(true)}>
          <Ellipsis aria-hidden="true" className={current.more ? "text-primary" : "text-muted-foreground"} />More
        </Button>
      </nav>
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader><SheetTitle>More</SheetTitle><SheetDescription>Less common screens.</SheetDescription></SheetHeader>
          <div className="flex flex-col gap-1 px-4 pb-4">
            {MORE.map(({ id, label, Icon }) => (
              <Button key={id} variant={screen === id ? "secondary" : "ghost"} className="h-12 justify-start gap-3 rounded-xl" onClick={() => { setMoreOpen(false); go(id); }}><Icon aria-hidden="true" />{label}</Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
      <Palette open={palette} onOpenChange={setPalette} screens={screens} actions={actions} />
      <HelperPanel open={helperOpen} onOpenChange={setHelperOpen} />
      <Toaster />
    </div>
    </HelperProvider>
  );
}
