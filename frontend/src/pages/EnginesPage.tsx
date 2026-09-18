import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import type { EngineRecord, EngineSetting, RoleRecord } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { ThingsTable, linkCell, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { applyFilters, countFilterOptions, type FilterGroup } from "@/kit/blocks/filter-column/FilterColumn";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { PageEmptyState } from "@/pages/PageEmptyState";
import { detectedPanel } from "@/panels/detected";
import { EnginePanel } from "@/panels/engine";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { labelForRole } from "@/lib/modelStates";
import { actionsFor } from "@/lib/actions";
import { AddSheet } from "@/kit/blocks/add-sheet/AddSheet";
import { usePhoneMode } from "@/kit/blocks/phone/PhoneMode";
import { ScanStatus, scanComputer, type DetectedScan } from "@/lib/detectedScan";

type DetectedStore = { id: string; name: string; kind: string; version: string; path?: string; where?: string; candidateModels?: number; roles?: string[]; couldHold?: string[] };
type EngineRow = { kind: "engine"; engine: EngineRecord } | { kind: "detected"; store: DetectedStore };
const LoaderCircle = getIcon("LoaderCircle");

function engineName(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(0, marker) : engine.id; }
function engineTag(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(marker + 1).split("-")[0] ?? engine.id : engine.id; }
function engineStatus(engine: EngineRecord): ThingStatus { return !engine.installed || !engine.running ? "offline" : engine.needsRestart || engine.notCurrent ? "attention" : "ready"; }
function detectedName(store: DetectedStore): string { return store.name.endsWith(` ${store.version}`) ? store.name : `${store.name} ${store.version}`; }

export function EnginesPage({ Frame }: { Frame: SectionFrameComponent }) {
  const navigate = useNavigate();
  const phone = usePhoneMode();
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const detectedStores = useApiResource<{ detected: DetectedStore[] }>("/stack/v1/detected");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const [selected, setSelected] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [detectedOpen, setDetectedOpen] = useState(false);
  const [filterSearch, setFilterSearch] = useState("");
  const [filterSelections, setFilterSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const [configuredName, setConfiguredName] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [scanResult, setScanResult] = useState<DetectedScan | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const config = useApiResource<{ settings: EngineSetting[] }>(configuredName ? `/stack/v1/engines/${configuredName}/config` : null);
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  useEffect(() => { if (config.data) setDraft(Object.fromEntries(config.data.settings.map((setting) => [setting.key, setting.pending ?? setting.inEffect]))); }, [config.data]);
  async function control(path: string, body?: unknown) { await api.post(path, body); await engines.refetch(); }
  async function scanNow() { setScanBusy(true); try { setScanResult(await scanComputer()); await detectedStores.refetch(); await engines.refetch(); } finally { setScanBusy(false); } }
  async function saveConfig() { if (!configuredName) return; await api.put(`/stack/v1/engines/${configuredName}/config`, draft); await config.refetch(); await engines.refetch(); }
  function selectAt(index: number) { if (!engines.data?.engines.length) return; const next = Math.max(0, Math.min(engines.data.engines.length - 1, index)); setSelected(next); setPanelOpen(true); const engine = engines.data.engines[next]; setConfiguredName(engine ? engineName(engine) : null); }
  async function panelAction(action: string) { const engine = engines.data?.engines[selected]; if (!engine) return; const name = engineName(engine); if (action === "logs") return; if (action === "update") return control(`/stack/v1/engines/${name}/current`, { tag: engine.newestTag }); if (action.startsWith("current:")) return control(`/stack/v1/engines/${name}/current`, { tag: action.slice(8) }); if (action === "remove") return api.delete(`/stack/v1/engines/${name}/builds/${engineTag(engine)}`).then(() => engines.refetch()); return control(`/stack/v1/engines/${name}/${action}`); }

  const rows = useMemo<EngineRow[]>(() => [...(detectedStores.data?.detected ?? []).map((store) => ({ kind: "detected" as const, store })), ...(engines.data?.engines ?? []).filter((engine) => engine.matchesThisMachine).map((engine) => ({ kind: "engine" as const, engine }))], [detectedStores.data?.detected, engines.data?.engines]);
  const roleLabel = useCallback((id: string) => labelForRole(id, roles.data?.roles), [roles.data]);
  const filterAccessors = useMemo(() => ({
    status: (row: EngineRow) => row.kind === "detected" ? "Detected" : engineStatus(row.engine) === "attention" ? "Needs attention" : engineStatus(row.engine) === "offline" ? "Offline" : "Ready",
    kind: (row: EngineRow) => row.kind === "detected" ? row.store.kind : "Engine",
    role: (row: EngineRow) => row.kind === "detected" ? (row.store.couldHold ?? row.store.roles ?? []).map(roleLabel) : "Runtime",
    search: (row: EngineRow) => row.kind === "detected" ? [row.store.name, row.store.version, row.store.path ?? row.store.where ?? ""] : [row.engine.label, row.engine.id, row.engine.platform, row.engine.arch],
  }), [roleLabel]);
  const filteredRows = useMemo(() => applyFilters(rows, filterSearch, filterSelections, filterAccessors), [filterAccessors, filterSearch, filterSelections, rows]);
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const group = (id: "status" | "kind" | "role", title: string): FilterGroup => ({ id, title, options: countFilterOptions(rows, filterAccessors[id]), selected: filterSelections[id] ?? new Set<string>(), onChange: (selected) => setFilterSelections((current) => ({ ...current, [id]: selected })) });
    return [group("status", "Status"), group("kind", "Kind"), group("role", "Role")];
  }, [filterAccessors, filterSelections, rows]);
  const selectedEngine = engines.data?.engines[selected];
  const detected = detectedStores.data?.detected?.[0];
  const detectedData = detected ? detectedPanel(`${detected.name} · ${detected.path ?? detected.where ?? "local"}`, (action) => { if (action.startsWith("adopt")) void fetch(`/stack/v1/detected/${detected.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: action.split(":")[1]?.split(",").filter(Boolean) ?? detected.couldHold ?? detected.roles ?? [] }) }).then(() => detectedStores.refetch()); }, detected.couldHold ?? detected.roles) : null;
  function rowActions(row: EngineRow) { if (row.kind === "detected") return actionsFor("detected", {}, (action) => { if (action === "adopt") void fetch(`/stack/v1/detected/${row.store.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: row.store.couldHold ?? row.store.roles ?? ["chat"] }) }).then(() => detectedStores.refetch()); else if (action === "forget") void fetch(`/stack/v1/detected/${row.store.id}/forget`, { method: "POST" }).then(() => detectedStores.refetch()); }, "row"); const index = engines.data?.engines.findIndex((engine) => engine.id === row.engine.id) ?? -1; return actionsFor("engine", row.engine, (action) => { setSelected(index); setConfiguredName(engineName(row.engine)); setPanelOpen(true); if (action === "forget") void api.delete(`/stack/v1/engines/${engineName(row.engine)}/builds/${engineTag(row.engine)}`).then(() => engines.refetch()); else void panelAction(action === "current" ? `current:${engineTag(row.engine)}` : action); }, "row"); }

  if (engines.loading || detectedStores.loading) return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><LoaderCircle className="animate-spin" /></Frame>;
  if (rows.length === 0) return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><PageEmptyState title="No engine builds are available" detail="The Stack will show verified local engine builds here when the store has them." /></Frame>;

  return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><div className={phone ? "hidden" : "flex justify-end"}><Button onClick={() => setAddOpen(true)}><span aria-hidden="true">＋</span>Add</Button></div><ScanStatus scan={scanResult} /><ThingsPage filter={{ search: { value: filterSearch, onChange: setFilterSearch, placeholder: "Search engines" }, groups: filterGroups, onClear: () => { setFilterSearch(""); setFilterSelections({}); } }} table={<ThingsTable<EngineRow>
    columns={[
      { key: "build", header: "Build", render: (row) => row.kind === "detected" ? <div><p className="font-medium">Detected, not adopted · {row.store.name}</p><p className="text-xs text-muted-foreground">{row.store.version} · {row.store.path ?? row.store.where}</p></div> : <div><p className="font-medium">{row.engine.label}</p><p className="text-xs text-muted-foreground">{row.engine.id}</p></div> },
      { key: "platform", header: "Platform", width: "18%", render: (row) => row.kind === "detected" ? `${row.store.kind} · ${row.store.candidateModels ?? 0} candidates` : `${row.engine.platform} · ${row.engine.arch}` },
      { key: "roles", header: "Roles", width: "22%", render: (row) => row.kind === "detected" ? (row.store.couldHold ?? row.store.roles ?? []).map(roleLabel).join(", ") || "Unassigned" : linkCell("/abilities", "View abilities") },
      { key: "state", header: "State", width: "20%", align: "right", render: (row) => row.kind === "detected" ? <Badge variant="outline">Not adopted</Badge> : <div><Badge variant={row.engine.notCurrent ? "secondary" : "default"}>{row.engine.state === "current" ? "Current" : "Not current"}</Badge><p className="mt-1 text-xs text-muted-foreground">{row.engine.stateReason ?? "Ready"}{row.engine.currentTag && ` · ${row.engine.currentTag}`}</p>{row.engine.needsRestart && <p className="mt-1 text-xs font-medium text-primary">Needs restart</p>}</div> },
    ]}
    rows={filteredRows}
    getKey={(row) => row.kind === "detected" ? `detected:${row.store.id}` : `engine:${row.engine.id}`}
    getStatus={(row) => row.kind === "detected" ? "detected" : engineStatus(row.engine)}
    selectedKey={selectedEngine ? `engine:${selectedEngine.id}` : undefined}
    onLink={(target) => navigate(target)}
    onRowClick={(row) => { if (row.kind === "detected") setDetectedOpen(true); else if (phone) navigate(`/engines/${encodeURIComponent(row.engine.id)}`); else selectAt(engines.data?.engines.findIndex((engine) => engine.id === row.engine.id) ?? 0); }}
    actions={[{ label: scanBusy ? "Scanning..." : "Scan this computer", onClick: () => void scanNow(), disabled: scanBusy }]}
    rowActions={rowActions}
    phoneRow={(row) => row.kind === "detected" ? { name: detectedName(row.store), subtitle: `Not adopted · ${(row.store.couldHold ?? row.store.roles ?? []).map(roleLabel).join(", ") || "Unassigned"}`, status: "Not adopted", tone: "detected" } : { name: row.engine.label, subtitle: `${row.engine.platform} · ${row.engine.arch}`, status: row.engine.state === "current" ? "Current" : "Not current", tone: engineStatus(row.engine) }}
    getRowProps={(row) => row.kind === "engine" ? { "data-testid": `engine-row-${row.engine.id}`, tabIndex: 0, onKeyDown: (event) => { if (event.key === "ArrowDown") { event.preventDefault(); selectAt(selected + 1); } if (event.key === "ArrowUp") { event.preventDefault(); selectAt(selected - 1); } } } : { className: "bg-muted/30" }}
    empty="No engine builds are available."
  />} panel={panelOpen || detectedOpen ? <>{selectedEngine && <EnginePanel engine={selectedEngine} open={panelOpen} settings={config.data?.settings} draft={draft} onClose={() => setPanelOpen(false)} onAction={panelAction} onConfigChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} onSave={saveConfig} />}{detected && detectedData && <PropertyPanel kind="Detected" item={{ name: detected.name }} status="Detected" actions={detectedData.actions} facts={detectedData.facts} primaryActions={detectedData.primaryActions} tabs={{ overview: detectedData.overview }} open={detectedOpen} onClose={() => setDetectedOpen(false)} />}</> : null} /><AddSheet kind="engine" open={addOpen} onOpenChange={setAddOpen} onAdded={() => void engines.refetch()} /></Frame>;
}
