import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import type { EngineSetting, HardwareResponse, LiveDrive, StackSettingSection } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { GenericForm } from "@/kit/settings/GenericForm";
import { getIcon } from "@/kit/icons";
import { Button } from "@/kit/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { Input } from "@/kit/ui/input";
import { ThingsTable } from "@/kit/blocks/things-table/ThingsTable";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { GroupsSection } from "@/pages/settings/GroupsSection";
import { isDesktop, launchAtLoginEnabled, setLaunchAtLogin } from "@/kit/host";
import { sentenceFor } from "@/lib/unavailable";

type SettingValue = string | number | boolean | string[];
type IndexResponse = { sections: StackSettingSection[]; settings: Array<{ key: string; label: string; help: string; level: string; section: string; order: number; path: string }> };

const fallbackSections: StackSettingSection[] = [
  { id: "general", title: "General", icon: "Settings", order: 10 }, { id: "updates", title: "Updates", icon: "RefreshCw", order: 20 }, { id: "backups", title: "Backups", icon: "UploadCloud", order: 30, itemId: "STACK-11" }, { id: "network", title: "Network and access", icon: "ShieldCheck", order: 40 }, { id: "channels", title: "Alert channels", icon: "Bell", order: 50 }, { id: "storage", title: "Storage", icon: "Database", order: 60 }, { id: "groups", title: "Groups", icon: "Folder", order: 65 }, { id: "maintenance", title: "Maintenance", icon: "Wrench", order: 70, itemId: "STACK-22" }, { id: "engines", title: "Engines", icon: "Cpu", order: 80 }, { id: "hardware", title: "Hardware", icon: "Monitor", order: 90, computer: true }, { id: "diagnostics", title: "Diagnostics", icon: "FileText", order: 100, computer: true }, { id: "reset", title: "Reset", icon: "RotateCcw", order: 110, computer: true },
];

const placeholder = (key: string, label: string, help: string, section: string): EngineSetting => ({ key, type: "text", default: "", label, help, disclosure: "basic", needsRestart: false, inEffect: "", pending: null, section });
function sectionIcon(name: string) { return getIcon(name as Parameters<typeof getIcon>[0]); }

function SettingsSection({ section, children }: { section: StackSettingSection; children: ReactNode }) {
  const [open, setOpen] = useState(() => localStorage.getItem(`maipai-settings-collapsed-${section.id}`) !== "1");
  const Icon = sectionIcon(section.icon);
  function toggle(): void { setOpen((current) => { localStorage.setItem(`maipai-settings-collapsed-${section.id}`, current ? "1" : "0"); return !current; }); }
  return <Card data-testid={`settings-section-${section.id}`}><CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><div className="flex items-start gap-3"><Icon className="mt-0.5 size-5 text-primary" /><div><CardTitle className="text-base">{section.title}</CardTitle>{section.itemId && <CardDescription>Arrives with {section.itemId}.</CardDescription>}</div></div><Button type="button" size="icon" variant="ghost" aria-label={`${open ? "Collapse" : "Expand"} ${section.title}`} onClick={toggle}>{open ? "⌄" : "›"}</Button></div></CardHeader>{open && <CardContent>{children}</CardContent>}</Card>;
}

function DisabledRows({ section }: { section: StackSettingSection }) {
  const reason = section.itemId ? `${section.title} arrives with ${section.itemId}.` : "This section is not configured yet.";
  const row = placeholder(`${section.id}-placeholder`, section.title, reason, section.id);
  return <><GenericForm settings={[row]} values={{ [row.key]: "Not available" }} onChange={() => undefined} disabled testId="generic-settings-form" /><p className="mt-4 text-sm text-muted-foreground">{reason} <a className="underline" href={`https://getmaipai.github.io/stack/user/settings/#${section.id}`} target="_blank" rel="noreferrer">Learn more</a></p></>;
}

function selectedDrives(value: SettingValue | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "all") return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; }
}

function DrivesShown({ drives, value, onChange }: { drives: LiveDrive[]; value: SettingValue | undefined; onChange: (value: "all" | string[]) => void }) {
  const chosen = selectedDrives(value); const all = value === "all" || chosen.length === 0;
  const known = new Map(drives.map((drive) => [drive.mount, drive]));
  const choices = [...drives.map((drive) => drive.mount), ...chosen.filter((mount) => !known.has(mount))];
  function toggle(mount: string, checked: boolean) { onChange(checked ? [...new Set([...chosen, mount])] : chosen.filter((item) => item !== mount)); }
  return <fieldset className="space-y-3" data-testid="drives-shown"><legend className="text-sm font-medium">Drives shown</legend><div className="flex gap-4"><label className="flex items-center gap-2"><input type="radio" name="storage-drives" checked={all} onChange={() => onChange("all")} />All drives</label><label className="flex items-center gap-2"><input type="radio" name="storage-drives" checked={!all} onChange={() => onChange(chosen)} />Chosen drives</label></div>{!all && <div className="space-y-2 border-l pl-4">{choices.map((mount) => { const drive = known.get(mount); return <label className="flex items-center justify-between gap-3 text-sm" key={mount}><span className="flex items-center gap-2"><input type="checkbox" checked={chosen.includes(mount)} onChange={(event) => toggle(mount, event.target.checked)} />{drive?.name ?? mount}</span>{!drive?.mounted && <span className="text-muted-foreground">not mounted</span>}</label>; })}{choices.length === 0 && <p className="text-sm text-muted-foreground">No drives are available yet.</p>}</div>}</fieldset>;
}

export function SettingsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const settings = useApiResource<{ settings: EngineSetting[] }>("/stack/v1/settings");
  const index = useApiResource<IndexResponse>("/stack/v1/settings/index");
  const hardware = useApiResource<HardwareResponse>("/stack/v1/hardware");
  const channels = useApiResource<{ channels: Array<{ id: string; name: string; type: string; status: string; lastSentAt: string | null }> }>("/stack/v1/channels");
  const engines = useApiResource<{ engines: Array<{ id: string; label: string; current: boolean; stateReason: string | null }> }>("/stack/v1/engines");
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [maintenanceResult, setMaintenanceResult] = useState<string | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { section: routeSection } = useParams<{ section?: string }>();
  const declaredSections = index.data?.sections ?? fallbackSections;
  const sections = [...declaredSections, ...(declaredSections.some((section) => section.id === "groups") ? [] : [fallbackSections.find((section) => section.id === "groups")!])].slice().sort((left, right) => left.order - right.order);
  const hashSection = location.hash.replace(/^#/, "");
  const active = routeSection && sections.some((section) => section.id === routeSection) ? routeSection : sections.some((section) => section.id === hashSection) ? hashSection : "overview";

  useEffect(() => { if (settings.data?.settings) setDraft(Object.fromEntries(settings.data.settings.map((setting) => [setting.key, setting.pending ?? setting.inEffect]))); }, [settings.data]);
  useEffect(() => { let current = true; void launchAtLoginEnabled().then((enabled) => { if (current) setLaunchAtLoginState(enabled); }); return () => { current = false; }; }, []);
  const visibleSettings = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return (settings.data?.settings ?? []).filter((setting) => query === "@modified" ? setting.pending !== null : !query || setting.label.toLocaleLowerCase().includes(query) || setting.key.toLocaleLowerCase().includes(query) || setting.help.toLocaleLowerCase().includes(query));
  }, [search, settings.data]);
  const pending = (settings.data?.settings ?? []).filter((setting) => setting.needsRestart && setting.pending !== null);
  async function changeSetting(key: string, value: SettingValue): Promise<void> { setDraft((current) => ({ ...current, [key]: value })); setError(null); try { await api.put("/stack/v1/settings", { [key]: value }); await settings.refetch(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The setting could not be saved."); } }
  async function applyPending(): Promise<void> { try { await api.post("/stack/v1/settings/apply"); await settings.refetch(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Pending settings could not be applied."); } }
  async function discardPending(): Promise<void> { const values = Object.fromEntries((settings.data?.settings ?? []).filter((setting) => setting.pending !== null).map((setting) => [setting.key, setting.inEffect])); try { await api.put("/stack/v1/settings", values); await settings.refetch(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Pending settings could not be discarded."); } }
  async function toggleLaunchAtLogin(enabled: boolean): Promise<void> { setLaunchAtLoginState(enabled); try { await setLaunchAtLogin(enabled); } catch (reason) { setLaunchAtLoginState(false); setError(reason instanceof Error ? reason.message : "Launch at login could not be changed."); } }
  async function runMaintenance(): Promise<void> { try { const result = await api.post<{ state: string; ran: string[]; reason?: string }>("/stack/v1/settings/maintenance/run"); setMaintenanceResult(result.ran.length ? `Ran ${result.ran.join(", ")}.` : result.reason ?? "Maintenance is waiting."); } catch (reason) { setError(reason instanceof Error ? reason.message : "Maintenance could not start."); } }
  function showSection(id: string): void { navigate(id === "overview" ? "/settings" : `/settings/${id}`); }

  function sectionBody(section: StackSettingSection): ReactNode {
    const declared = visibleSettings.filter((setting) => setting.section === section.id);
    if (section.id === "maintenance") return <><GenericForm settings={declared} values={draft as Record<string, string | number | boolean>} onChange={(key, value) => void changeSetting(key, value)} testId="generic-settings-form" /><div className="mt-5 border-t pt-4"><Button variant="outline" type="button" onClick={() => void runMaintenance()}>Run maintenance now</Button>{maintenanceResult && <p className="mt-2 text-sm text-muted-foreground">{maintenanceResult}</p>}</div></>;
    if (section.id === "groups") return <GroupsSection />;
    if (["general", "network", "updates", "diagnostics", "storage", "memory"].includes(section.id)) return <>{section.id === "memory" && (() => { const budget = Number(draft.modelBudgetBytes ?? declared.find((setting) => setting.key === "modelBudgetBytes")?.inEffect ?? 0); const total = (hardware.data?.hardware?.totalRamGb ?? 0) * 1_073_741_824; return <div className="mb-6 rounded-lg border p-4"><label className="block text-sm font-medium" htmlFor="model-budget-slider">Memory for models</label><input id="model-budget-slider" aria-label="Memory for models" className="mt-4 w-full" type="range" min="0" max={total || budget} step={1_073_741_824} value={budget} onChange={(event) => void changeSetting("modelBudgetBytes", Number(event.target.value))} /><p className="mt-2 text-sm text-muted-foreground">{(budget / 1_073_741_824).toFixed(0)} GB for models · {Math.max(0, (total - budget) / 1_073_741_824).toFixed(0)} GB kept for your Mac</p></div>; })()}{section.id === "storage" && <div className="mb-6"><DrivesShown drives={hardware.data?.hardware?.drives ?? []} value={draft.storageDrives} onChange={(value) => void changeSetting("storageDrives", value)} /></div>}<GenericForm settings={(section.id === "memory" ? declared.filter((setting) => setting.key !== "modelBudgetBytes") : declared).filter((setting) => setting.key !== "storageDrives")} values={draft as Record<string, string | number | boolean>} onChange={(key, value) => void changeSetting(key, value)} testId={section.id === "general" ? "generic-engine-form" : "generic-settings-form"} />{section.id === "general" && <div className="mt-5 rounded-lg border p-4"><label className="flex items-center gap-3 text-sm font-medium"><input type="checkbox" checked={launchAtLogin} disabled={!isDesktop} onChange={(event) => void toggleLaunchAtLogin(event.target.checked)} />Launch at login</label><p className="mt-2 text-sm text-muted-foreground">Off by default. The desktop app can start with this computer; the browser leaves this setting off.</p></div>}{section.id === "network" && <p className="mt-4 text-sm text-muted-foreground"><Link className="underline" to="/access">Manage operator access and client keys</Link>.</p>}{section.id === "updates" && <p className="mt-4 text-sm text-muted-foreground">Installed builds stay in control of this computer. The update check runs only when requested.</p>}</>;
    if (section.id === "channels") return <><ThingsTable rows={channels.data?.channels ?? []} getKey={(row) => row.id} columns={[{ key: "name", header: "Channel", width: "37%", render: (row) => row.name }, { key: "type", header: "Type", width: "30%", render: (row) => row.type }, { key: "status", header: "Status", width: "29%", align: "right", render: (row) => row.status }]} rowActions={() => [{ label: "Open alerts", onClick: () => navigate("/alerts") }]} actions={[{ label: "Add a channel", onClick: () => navigate("/alerts") }]} empty="No alert channels configured." /><p className="mt-3 text-sm text-muted-foreground"><Link className="underline" to="/alerts">Manage alert channels</Link>.</p></>;
    if (section.id === "engines") return <div className="space-y-3">{(engines.data?.engines ?? []).map((engine) => <Link className="flex items-center justify-between rounded-lg border p-3 text-sm hover:bg-muted" to={`/engines?engine=${encodeURIComponent(engine.id)}`} key={engine.id}><span>{engine.label}</span><span className="text-muted-foreground">{engine.current ? "Current" : engine.stateReason ?? "Settings"}</span></Link>)}{(engines.data?.engines ?? []).length === 0 && <p className="text-sm text-muted-foreground">No engines are installed yet.</p>}</div>;
    if (section.id === "hardware") return <div className="grid gap-3 text-sm sm:grid-cols-2">{[["Platform", hardware.data?.hardware.platform], ["Architecture", hardware.data?.hardware.arch], ["Memory", hardware.data?.hardware.totalRamGb ? `${hardware.data.hardware.totalRamGb} GB` : "Not measured"], ["Operating system", hardware.data?.hardware.osVersion]].map(([label, value]) => <div className="border-t pt-3" key={String(label)}><p className="text-muted-foreground">{label}</p><p className="mt-1 font-medium">{value ?? "Not measured"}</p></div>)}</div>;
    if (section.id === "reset") return <div className="space-y-3 text-sm"><p>Clear local caches or forget detected things from the Stack.</p><Button variant="outline" type="button" disabled aria-disabled="true" title={`Clear caches: ${sentenceFor("settings-clear-caches")!}`} className="cursor-not-allowed">Clear caches</Button><p className="mt-1 text-xs text-muted-foreground">{sentenceFor("settings-clear-caches")!}</p><p className="text-muted-foreground">Destructive reset actions ask for confirmation before they run.</p></div>;
    return <DisabledRows section={section} />;
  }

  return <Frame title="Settings" description="Find the few declared settings for this local Stack."><div className="grid gap-6 lg:grid-cols-[15rem_1fr]"><aside className="space-y-4"><label htmlFor="settings-search" className="block text-sm font-medium">Find a setting<Input id="settings-search" aria-label="Find a setting" className="mt-2" placeholder="Find a setting or @modified" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="Settings section" className="h-9 w-full rounded-md border bg-background px-3 text-sm lg:hidden" value={active} onChange={(event) => showSection(event.target.value)}><option value="overview">Overview</option>{sections.map((section) => <option value={section.id} key={section.id}>{section.title}</option>)}</select><nav className="hidden space-y-1 lg:block"><Link className={`block rounded-md px-3 py-2 text-sm ${active === "overview" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`} to="/settings">Overview</Link>{sections.filter((section) => !section.computer).map((section) => <Link className={`block rounded-md px-3 py-2 text-sm ${active === section.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`} to={`/settings/${section.id}`} key={section.id}>{section.title}</Link>)}<div className="my-3 border-t" /><p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{hardware.data?.hardware.computerName ?? "This computer"}</p>{sections.filter((section) => section.computer).map((section) => <Link className={`block rounded-md px-3 py-2 text-sm ${active === section.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted"}`} to={`/settings/${section.id}`} key={section.id}>{section.title}</Link>)}</nav></aside><div className="min-w-0 space-y-5">{error && <p className="text-sm text-destructive" role="alert">{error}</p>}{settings.loading && <p className="text-sm text-muted-foreground">Loading declared settings...</p>}{active === "overview" ? sections.map((section) => <SettingsSection section={section} key={section.id}>{sectionBody(section)}</SettingsSection>) : sections.filter((section) => section.id === active).map((section) => <SettingsSection section={section} key={section.id}>{sectionBody(section)}</SettingsSection>)}{pending.length > 0 && <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border bg-card p-4 shadow-sm"><span>{pending.length} change{pending.length === 1 ? "" : "s"} need a restart of the chat engine</span><div className="flex gap-2"><Button type="button" variant="outline" onClick={() => void discardPending()}>Discard</Button><Button type="button" onClick={() => void applyPending()}>Apply now</Button></div></div>}</div></div></Frame>;
}
