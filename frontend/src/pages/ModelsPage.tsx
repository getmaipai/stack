import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/kit/ui/button";
import { Badge } from "@/kit/ui/badge";
import { ThingsTable, linkCell, type ThingsTableGroup, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { PageEmptyState } from "@/pages/PageEmptyState";
import { modelPanel } from "@/panels/model";
import { detectedPanel } from "@/panels/detected";
import { groupPanel } from "@/panels/group";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";

type Group = { id: string; name: string; parentId: string | null; modelCount: number; bytesOnDisk: number; memoryBytes: number; usage: { requests: number; tokens: number; secondsLoaded?: number; peakMemoryBytes?: number }; status: { loaded: number; ready: number; onDemand: number; failed: number }; worstHealth: string | null };
type Model = { id: string; roles: string[]; state: string; runtimeState?: string; sizeBytes: number | null; measuredFootprintBytes: number | null; estimated: boolean; source: string; groupId?: string | null; nickname?: string | null; provenance: Record<string, unknown> };
type DetectedStore = { id: string; name: string; kind: string; version: string; path?: string; where?: string; candidateModels?: number; roles?: string[]; couldHold?: string[] };
type ModelRow = { kind: "model"; model: Model } | { kind: "detected"; store: DetectedStore };

function modelStatus(model: Model): ThingStatus { return model.runtimeState === "failed" ? "attention" : model.runtimeState === "loaded" || model.runtimeState === "ready" ? "ready" : "attention"; }

export function ModelsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const navigate = useNavigate();
  const groups = useApiResource<{ groups: Group[] }>("/stack/v1/groups");
  const models = useApiResource<{ models: Model[] }>("/stack/v1/models");
  const detectedStores = useApiResource<{ detected: DetectedStore[] }>("/stack/v1/detected");
  const refetchDetected = detectedStores.refetch;
  const refetchGroups = groups.refetch;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { if ((JSON.parse(event.data) as { id?: string }).id === "detected.changed") void refetchDetected(); } catch { /* ignore malformed feed data */ } }; return () => stream.close(); }, [refetchDetected]);
  const [selected, setSelected] = useState<{ kind: "group" | "model" | "detected"; id: string } | null>(null);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const groupRows = useMemo(() => groups.data?.groups ?? [], [groups.data?.groups]);
  const modelRows = useMemo(() => models.data?.models ?? [], [models.data?.models]);
  const detectedRows = useMemo(() => detectedStores.data?.detected ?? [], [detectedStores.data?.detected]);
  const selectedGroup = selected?.kind === "group" ? groupRows.find((group) => group.id === selected.id) : null;
  const selectedModel = selected?.kind === "model" ? modelRows.find((model) => model.id === selected.id) : null;
  const selectedDetected = selected?.kind === "detected" ? detectedRows.find((item) => item.id === selected.id) : null;
  const modelGroup = selectedModel?.groupId ? groupRows.find((group) => group.id === selectedModel.groupId) : null;
  const noModels = !groups.loading && !models.loading && !detectedStores.loading && groupRows.length === 0 && modelRows.length === 0 && detectedRows.length === 0;

  async function groupAction(group: Group, action: string) { if (action === "remove") await api.delete(`/stack/v1/groups/${group.id}`); else if (action !== "move") await api.post(`/stack/v1/groups/${group.id}/actions`, { action }); await groups.refetch(); await models.refetch(); }
  async function adopt(store: DetectedStore, selectedRoles?: string[]) { await fetch(`/stack/v1/detected/${store.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: selectedRoles ?? store.couldHold ?? store.roles ?? [] }) }); await detectedStores.refetch(); setSelected(null); }
  const rename = useCallback(async (group: Group) => { const name = renames[group.id]?.trim(); if (!name || name === group.name) return; await fetch(`/stack/v1/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await refetchGroups(); }, [refetchGroups, renames]);
  async function renameModel(model: Model, nickname: string) { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: nickname.trim() || null }) }); await models.refetch(); }
  async function moveModel(model: Model, groupId: string) { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: groupId || null }) }); await models.refetch(); await groups.refetch(); }
  async function createGroup(parentId: string | null) { const name = window.prompt(parentId ? "New subgroup name" : "New group name"); if (!name?.trim()) return; await api.post("/stack/v1/groups", { name: name.trim(), parentId }); await groups.refetch(); }

  const groupTree = useMemo<ThingsTableGroup<ModelRow>[]>(() => {
    const childrenOf = (parentId: string | null): Group[] => groupRows.filter((group) => group.parentId === parentId);
    const makeGroup = (group: Group): ThingsTableGroup<ModelRow> => ({
      key: group.id,
      ariaLabel: group.name,
      label: <div><p><input aria-label={`Rename ${group.id}`} className="w-48 max-w-full bg-transparent font-medium outline-none" value={renames[group.id] ?? group.name} onChange={(event) => setRenames((current) => ({ ...current, [group.id]: event.target.value }))} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") void rename(group); }} onBlur={() => void rename(group)} /><span className="sr-only">{group.name}</span></p><p className="text-xs text-muted-foreground">{group.modelCount} models · {Math.round(group.bytesOnDisk / 1_000_000_000 * 10) / 10} GB · {group.usage.requests} requests</p></div>,
      rows: modelRows.filter((model) => model.groupId === group.id).map((model) => ({ kind: "model" as const, model })),
      groups: childrenOf(group.id).map(makeGroup),
      summary: <><span>{group.status.loaded} loaded · {group.status.ready} ready · {group.status.onDemand} on demand</span><span className="ml-4">{group.memoryBytes ? `${Math.round(group.memoryBytes / 1_000_000_000 * 10) / 10} GB in use` : "Not loaded"}</span></>,
      status: group.worstHealth ? "attention" : "ready",
      onClick: () => setSelected({ kind: "group", id: group.id }),
    });
    return childrenOf(null).map(makeGroup);
  }, [groupRows, modelRows, renames, rename]);

  const rows = useMemo<ModelRow[]>(() => [...detectedRows.map((store) => ({ kind: "detected" as const, store })), ...modelRows.filter((model) => !model.groupId).map((model) => ({ kind: "model" as const, model }))], [detectedRows, modelRows]);
  const groupPanelData = selectedGroup ? groupPanel(selectedGroup.name, selectedGroup.modelCount, (action) => void groupAction(selectedGroup, action)) : null;
  const modelPanelData = selectedModel ? modelPanel({ id: selectedModel.id, nickname: selectedModel.nickname ?? undefined, group: modelGroup?.name, source: selectedModel.source, licence: typeof selectedModel.provenance.licence === "string" ? selectedModel.provenance.licence : undefined, measuredFootprintBytes: selectedModel.measuredFootprintBytes }, () => {}) : null;
  const detectedPanelData = selectedDetected ? detectedPanel(`${selectedDetected.name} · ${selectedDetected.path ?? selectedDetected.where ?? "local"}`, (action) => { if (action.startsWith("adopt")) void adopt(selectedDetected, action.split(":")[1]?.split(",").filter(Boolean)); }, selectedDetected.couldHold ?? selectedDetected.roles) : null;

  if (noModels) return <Frame title="Models" description="Grouped models, measured footprints, nicknames, and utilization."><PageEmptyState title="No models are installed yet" detail="Choose an ability to bring the first local model to this computer." action={<Button asChild><a href="/abilities">Add abilities</a></Button>} /></Frame>;
  return <Frame title="Models" description="Grouped models, measured footprints, nicknames, and utilization."><div className={selected ? "pr-0 lg:pr-[29rem]" : ""}><ThingsTable<ModelRow>
    columns={[
      { key: "name", header: "Name", width: "38%", render: (row) => row.kind === "detected" ? <div><p className="font-medium">Detected, not adopted · {row.store.name}</p><p className="text-xs text-muted-foreground">{row.store.version} · {row.store.path ?? row.store.where}</p></div> : <div className="min-w-0"><input aria-label={`Nickname ${row.model.id}`} className="block w-44 max-w-full truncate bg-transparent font-medium outline-none" defaultValue={row.model.nickname ?? ""} placeholder={row.model.id} onBlur={(event) => void renameModel(row.model, event.target.value)} onClick={(event) => event.stopPropagation()} /><span className="block truncate text-xs text-muted-foreground">{row.model.id}</span></div> },
      { key: "roles", header: "Roles", render: (row) => row.kind === "detected" ? linkCell("/abilities", row.store.couldHold?.join(", ") ?? row.store.roles?.join(", ") ?? "Unassigned") : linkCell("/abilities", row.model.roles.join(", ")) },
      { key: "size", header: "Storage", align: "right", render: (row) => row.kind === "detected" ? `${row.store.candidateModels ?? 0} candidates` : `${row.model.sizeBytes ? `${Math.round(row.model.sizeBytes / 1_000_000 * 10) / 10} MB` : "Size unknown"} · ${row.model.measuredFootprintBytes ? `${Math.round(row.model.measuredFootprintBytes / 1_000_000 * 10) / 10} MB measured` : "Not measured"}` },
      { key: "group", header: "Group", render: (row) => row.kind === "detected" ? <Badge variant="outline">Adopt</Badge> : <select aria-label={`Move ${row.model.id}`} className="max-w-36 bg-transparent" defaultValue={row.model.groupId ?? ""} onChange={(event) => void moveModel(row.model, event.target.value)} onClick={(event) => event.stopPropagation()}><option value="">Ungrouped</option>{groupRows.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select> },
      { key: "state", header: "State", align: "right", render: (row) => row.kind === "detected" ? "Detected" : <><Badge variant="secondary">{row.model.runtimeState ?? row.model.state}</Badge>{row.model.estimated && <span className="ml-2 text-xs text-muted-foreground">estimated</span>}</> },
    ]}
    rows={rows}
    groups={groupTree}
    getKey={(row) => row.kind === "detected" ? `detected:${row.store.id}` : `model:${row.model.id}`}
    getStatus={(row) => row.kind === "detected" ? "detected" : modelStatus(row.model)}
    selectable={{ rowSelectable: (row) => row.kind === "model" }}
    onSelectionChange={(selectedRows) => setSelectedModels(selectedRows.filter((row): row is { kind: "model"; model: Model } => row.kind === "model").map((row) => row.model.id))}
    selectedKey={selected ? `${selected.kind}:${selected.id}` : undefined}
    getRowProps={(row) => row.kind === "detected" ? { className: "bg-muted/30" } : {}}
    onLink={(target) => navigate(target)}
    onRowClick={(row) => setSelected(row.kind === "detected" ? { kind: "detected", id: row.store.id } : { kind: "model", id: row.model.id })}
    actions={[{ label: "New group", onClick: () => void createGroup(null) }, ...(selected?.kind === "group" ? [{ label: "New subgroup", onClick: () => void createGroup(selected.id) }] : []), ...(selectedModels.length > 0 ? [{ label: `Remove ${selectedModels.length}`, onClick: () => void Promise.all(selectedModels.map((id) => api.delete(`/stack/v1/models/${id}`))).then(() => models.refetch()) }] : [])]}
    empty="No models or detected stores are available."
  />{selectedGroup && groupPanelData && <PropertyPanel kind="Group" item={{ name: selectedGroup.name }} status={selectedGroup.worstHealth ? "Needs attention" : "Ready"} actions={groupPanelData.actions} facts={groupPanelData.facts} primaryActions={groupPanelData.primaryActions} tabs={{ overview: groupPanelData.overview }} open onClose={() => setSelected(null)} />}{selectedModel && modelPanelData && <PropertyPanel kind="Model" item={{ name: selectedModel.nickname ?? selectedModel.id }} status={selectedModel.state} actions={modelPanelData.actions} facts={modelPanelData.facts} primaryActions={modelPanelData.primaryActions} tabs={{ overview: modelPanelData.overview, insights: modelPanelData.insights }} open onClose={() => setSelected(null)} />}{selectedDetected && detectedPanelData && <PropertyPanel kind="Detected" item={{ name: selectedDetected.name }} status="Detected" actions={detectedPanelData.actions} facts={detectedPanelData.facts} primaryActions={detectedPanelData.primaryActions} tabs={{ overview: detectedPanelData.overview }} open onClose={() => setSelected(null)} />}</div></Frame>;
}
