import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import type { EngineRecord, EngineSetting } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { ThingsTable, linkCell, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { PageEmptyState } from "@/pages/PageEmptyState";
import { detectedPanel } from "@/panels/detected";
import { EnginePanel } from "@/panels/engine";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";

type DetectedStore = { id: string; name: string; kind: string; version: string; path?: string; where?: string; candidateModels?: number; roles?: string[]; couldHold?: string[] };
type EngineRow = { kind: "engine"; engine: EngineRecord } | { kind: "detected"; store: DetectedStore };
const LoaderCircle = getIcon("LoaderCircle");

function engineName(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(0, marker) : engine.id; }
function engineTag(engine: EngineRecord): string { const marker = engine.id.indexOf("-b"); return marker > 0 ? engine.id.slice(marker + 1).split("-")[0] ?? engine.id : engine.id; }
function engineStatus(engine: EngineRecord): ThingStatus { return !engine.installed || !engine.running ? "offline" : engine.needsRestart || engine.notCurrent ? "attention" : "ready"; }

export function EnginesPage({ Frame }: { Frame: SectionFrameComponent }) {
  const navigate = useNavigate();
  const engines = useApiResource<{ engines: EngineRecord[] }>("/stack/v1/engines");
  const detectedStores = useApiResource<{ detected: DetectedStore[] }>("/stack/v1/detected");
  const [selected, setSelected] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [detectedOpen, setDetectedOpen] = useState(false);
  const [configuredName, setConfiguredName] = useState<string | null>(null);
  const config = useApiResource<{ settings: EngineSetting[] }>(configuredName ? `/stack/v1/engines/${configuredName}/config` : null);
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});
  useEffect(() => { if (config.data) setDraft(Object.fromEntries(config.data.settings.map((setting) => [setting.key, setting.pending ?? setting.inEffect]))); }, [config.data]);
  async function control(path: string, body?: unknown) { await api.post(path, body); await engines.refetch(); }
  async function saveConfig() { if (!configuredName) return; await api.put(`/stack/v1/engines/${configuredName}/config`, draft); await config.refetch(); await engines.refetch(); }
  function selectAt(index: number) { if (!engines.data?.engines.length) return; const next = Math.max(0, Math.min(engines.data.engines.length - 1, index)); setSelected(next); setPanelOpen(true); const engine = engines.data.engines[next]; setConfiguredName(engine ? engineName(engine) : null); }
  async function panelAction(action: string) { const engine = engines.data?.engines[selected]; if (!engine) return; const name = engineName(engine); if (action === "logs") return; if (action === "update") return control(`/stack/v1/engines/${name}/current`, { tag: engine.newestTag }); if (action.startsWith("current:")) return control(`/stack/v1/engines/${name}/current`, { tag: action.slice(8) }); if (action === "remove") return api.delete(`/stack/v1/engines/${name}/builds/${engineTag(engine)}`).then(() => engines.refetch()); return control(`/stack/v1/engines/${name}/${action}`); }

  const rows = useMemo<EngineRow[]>(() => [...(detectedStores.data?.detected ?? []).map((store) => ({ kind: "detected" as const, store })), ...(engines.data?.engines ?? []).map((engine) => ({ kind: "engine" as const, engine }))], [detectedStores.data?.detected, engines.data?.engines]);
  const selectedEngine = engines.data?.engines[selected];
  const detected = detectedStores.data?.detected?.[0];
  const detectedData = detected ? detectedPanel(`${detected.name} · ${detected.path ?? detected.where ?? "local"}`, (action) => { if (action.startsWith("adopt")) void fetch(`/stack/v1/detected/${detected.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: action.split(":")[1]?.split(",").filter(Boolean) ?? detected.couldHold ?? detected.roles ?? [] }) }).then(() => detectedStores.refetch()); }, detected.couldHold ?? detected.roles) : null;

  if (engines.loading || detectedStores.loading) return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><LoaderCircle className="animate-spin" /></Frame>;
  if (rows.length === 0) return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><PageEmptyState title="No engine builds are available" detail="The Stack will show verified local engine builds here when the store has them." /></Frame>;

  return <Frame title="Engines" description="Builds, health, controls, and the settings that shape each runtime."><div className={panelOpen || detectedOpen ? "pr-0 lg:pr-[29rem]" : ""}><ThingsTable<EngineRow>
    columns={[
      { key: "build", header: "Build", width: "38%", render: (row) => row.kind === "detected" ? <div><p className="font-medium">Detected, not adopted · {row.store.name}</p><p className="text-xs text-muted-foreground">{row.store.version} · {row.store.path ?? row.store.where}</p></div> : <div><p className="font-medium">{row.engine.label}</p><p className="text-xs text-muted-foreground">{row.engine.id}</p></div> },
      { key: "platform", header: "Platform", render: (row) => row.kind === "detected" ? `${row.store.kind} · ${row.store.candidateModels ?? 0} candidates` : `${row.engine.platform} · ${row.engine.arch}` },
      { key: "roles", header: "Roles", render: (row) => row.kind === "detected" ? row.store.couldHold?.join(", ") ?? row.store.roles?.join(", ") ?? "Unassigned" : linkCell("/abilities", "View abilities") },
      { key: "state", header: "State", align: "right", render: (row) => row.kind === "detected" ? <Badge variant="outline">Adopt</Badge> : <div><Badge variant={row.engine.notCurrent ? "secondary" : "default"}>{row.engine.state === "current" ? "Current" : "Not current"}</Badge><p className="mt-1 text-xs text-muted-foreground">{row.engine.stateReason ?? "Ready"}{row.engine.currentTag && ` · ${row.engine.currentTag}`}</p>{row.engine.needsRestart && <p className="mt-1 text-xs font-medium text-primary">Needs restart</p>}</div> },
    ]}
    rows={rows}
    getKey={(row) => row.kind === "detected" ? `detected:${row.store.id}` : `engine:${row.engine.id}`}
    getStatus={(row) => row.kind === "detected" ? "detected" : engineStatus(row.engine)}
    selectedKey={selectedEngine ? `engine:${selectedEngine.id}` : undefined}
    onLink={(target) => navigate(target)}
    onRowClick={(row) => { if (row.kind === "detected") setDetectedOpen(true); else selectAt(engines.data?.engines.findIndex((engine) => engine.id === row.engine.id) ?? 0); }}
    getRowProps={(row) => row.kind === "engine" ? { "data-testid": `engine-row-${row.engine.id}`, tabIndex: 0, onKeyDown: (event) => { if (event.key === "ArrowDown") { event.preventDefault(); selectAt(selected + 1); } if (event.key === "ArrowUp") { event.preventDefault(); selectAt(selected - 1); } } } : { className: "bg-muted/30" }}
    empty="No engine builds are available."
  />{selectedEngine && <EnginePanel engine={selectedEngine} open={panelOpen} settings={config.data?.settings} draft={draft} onClose={() => setPanelOpen(false)} onAction={panelAction} onConfigChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} onSave={saveConfig} />}{detected && detectedData && <PropertyPanel kind="Detected" item={{ name: detected.name }} status="Detected" actions={detectedData.actions} facts={detectedData.facts} primaryActions={detectedData.primaryActions} tabs={{ overview: detectedData.overview }} open={detectedOpen} onClose={() => setDetectedOpen(false)} />}</div></Frame>;
}
