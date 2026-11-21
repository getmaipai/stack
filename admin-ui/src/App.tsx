import { useCallback, useEffect, useMemo, useState } from "react";
import { Moon, Sun, LayoutDashboard, HeartPulse, Cpu, Gauge, Search, LogOut, RotateCw } from "lucide-react";
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
import { Engines, Health, Overview, healthKind, healthWord } from "./screens";

type Screen = "overview" | "resources" | "health" | "engines";
const NAV: { id: Screen; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", Icon: LayoutDashboard },
  { id: "resources", label: "Resources", Icon: Gauge },
  { id: "health", label: "Health", Icon: HeartPulse },
  { id: "engines", label: "Engines", Icon: Cpu },
];

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
    { id: "refresh", label: "Refresh now", run: refresh },
    { id: "theme", label: dark ? "Switch to light" : "Switch to dark", run: toggle },
    { id: "restart", label: "Restart the Stack", run: () => { void restartStack(); } },
    { id: "signout", label: "Sign out", run: () => { void signOut(); } },
  ], [refresh, dark, toggle, restartStack, signOut]);

  const health = snap.status?.health;
  const problems = snap.health?.length ?? 0;
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav aria-label="Main" className="hidden w-56 shrink-0 flex-col gap-1 border-e bg-sidebar p-3 text-sidebar-foreground md:flex">
        <p className="px-3 py-2 text-base font-semibold">MaiPai Stack</p>
        {NAV.map(({ id, label, Icon }) => (
          <Button key={id} variant={screen === id ? "secondary" : "ghost"} className="justify-start" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon aria-hidden="true" />{label}
            {id === "health" && problems > 0 && <span className="ms-auto text-xs text-muted-foreground">{problems}</span>}
          </Button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col pb-20 md:pb-0">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/90 px-4 py-2 backdrop-blur">
          <h1 className="me-auto flex items-center gap-2 text-base font-semibold" aria-live="polite">
            {health ? <><StatusIndicator status={healthKind(health)} ping={health === "ok"} />{healthWord(health)}</> : "MaiPai Stack"}
          </h1>
          <Status status={snap.live ? "online" : "maintenance"} className="hidden sm:flex" aria-label={snap.live ? "Live updates connected" : "Live updates reconnecting"}>
            <StatusIndicator status={snap.live ? "online" : "maintenance"} ping={false} />{snap.live ? "Live" : "Reconnecting"}
          </Status>
          <Button variant="outline" size="sm" onClick={() => setPalette(true)} aria-label="Open the command palette"><Search aria-hidden="true" /><span className="hidden sm:inline">Jump to</span><kbd className="hidden text-xs text-muted-foreground sm:inline">⌘K</kbd></Button>
          <Button variant="ghost" size="icon-sm" onClick={refresh} aria-label="Refresh"><RotateCw aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={dark ? "Switch to light" : "Switch to dark"}>{dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
          <Button variant="ghost" size="icon-sm" onClick={() => { void signOut(); }} aria-label="Sign out"><LogOut aria-hidden="true" /></Button>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-4 md:p-6">
          <h2 className="mb-4 text-2xl font-semibold">{NAV.find((n) => n.id === screen)?.label}</h2>
          {screen === "overview" && <Overview snap={snap} />}
          {screen === "resources" && <Resources changed={snap.status} />}
          {screen === "health" && <Health snap={snap} refresh={refresh} notify={notify} />}
          {screen === "engines" && <Engines snap={snap} refresh={refresh} notify={notify} />}
        </main>
      </div>
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.map(({ id, label, Icon }) => (
          <Button key={id} variant="ghost" className="h-14 flex-col gap-0.5 rounded-none text-xs" aria-current={screen === id ? "page" : undefined} onClick={() => go(id)}>
            <Icon aria-hidden="true" className={screen === id ? "text-primary" : "text-muted-foreground"} />{label}
          </Button>
        ))}
      </nav>
      <Palette open={palette} onOpenChange={setPalette} screens={screens} actions={actions} />
      <Toaster />
    </div>
  );
}
