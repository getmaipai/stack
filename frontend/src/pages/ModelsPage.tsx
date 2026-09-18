import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/kit/ui/button";
import { Badge } from "@/kit/ui/badge";
import { ThingsTable, linkCell, type ThingsTableGroup, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { applyFilters, countFilterOptions, type FilterGroup } from "@/kit/blocks/filter-column/FilterColumn";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";
import { api, type RoleRecord } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { PageEmptyState } from "@/pages/PageEmptyState";
import { modelPanel } from "@/panels/model";
import { detectedPanel } from "@/panels/detected";
import { groupPanel } from "@/panels/group";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { labelForRole, MODEL_RUNTIME_STATE_LABELS, MODEL_SOURCE_LABELS } from "@/lib/modelStates";
import { displayName } from "@/lib/names";
import { actionsFor } from "@/lib/actions";
import { AddSheet } from "@/kit/blocks/add-sheet/AddSheet";
import { usePhoneMode } from "@/kit/blocks/phone/PhoneMode";
import { ScanStatus, scanComputer, type DetectedScan } from "@/lib/detectedScan";
import { formatBytes } from "@/pages/overview/SegmentedBar";

type Group = { id: string; name: string; parentId: string | null; modelCount: number; bytesOnDisk: number; memoryBytes: number; usage: { requests: number; tokens: number; secondsLoaded?: number; peakMemoryBytes?: number }; status: { loaded: number; ready: number; onDemand: number; failed: number }; worstHealth: string | null };
type Model = { id: string; roles: string[]; state: string; runtimeState?: string; sizeBytes: number | null; measuredFootprintBytes: number | null; estimated: boolean; source: string; licenceSentence?: string; licenceUrl?: string | null; groupId?: string | null; nickname?: string | null; provenance: Record<string, unknown>; modelPath?: string | null };
type DetectedStore = { id: string; name: string; kind: string; version: string; path?: string; where?: string; source?: string; sizeBytes?: number; digest?: string; candidateModels?: number; roles?: string[]; couldHold?: string[] };
type ModelRow = { kind: "model"; model: Model } | { kind: "detected"; store: DetectedStore };

function modelStatus(model: Model): ThingStatus { return model.runtimeState === "failed" ? "attention" : model.runtimeState === "loaded" || model.runtimeState === "ready" ? "ready" : "attention"; }
function detectedName(store: DetectedStore): string { return store.name.endsWith(` ${store.version}`) ? store.name : `${store.name} ${store.version}`; }

export function ModelsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const navigate = useNavigate();
  const phone = usePhoneMode();
  const groups = useApiResource<{ groups: Group[] }>("/stack/v1/groups");
  const models = useApiResource<{ models: Model[] }>("/stack/v1/models");
  const detectedStores = useApiResource<{ detected: DetectedStore[]; foundFiles?: DetectedStore[] }>("/stack/v1/detected");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const refetchDetected = detectedStores.refetch;
  const refetchGroups = groups.refetch;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { if ((JSON.parse(event.data) as { id?: string }).id === "detected.changed") void refetchDetected(); } catch { /* ignore malformed feed data */ } }; return () => stream.close(); }, [refetchDetected]);
  const [selected, setSelected] = useState<{ kind: "group" | "model" | "detected"; id: string } | null>(null);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [filterSearch, setFilterSearch] = useState("");
  const [filterSelections, setFilterSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const [addOpen, setAddOpen] = useState(false);
  const [scanResult, setScanResult] = useState<DetectedScan | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const groupRows = useMemo(() => groups.data?.groups ?? [], [groups.data?.groups]);
  const modelRows = useMemo(() => models.data?.models ?? [], [models.data?.models]);
  const detectedRows = useMemo(() => [...(detectedStores.data?.detected ?? []), ...(detectedStores.data?.foundFiles ?? []).map((file) => ({ ...file, kind: "file", version: "Not imported", roles: file.couldHold }))], [detectedStores.data?.detected, detectedStores.data?.foundFiles]);
  const selectedGroup = selected?.kind === "group" ? groupRows.find((group) => group.id === selected.id) : null;
  const selectedModel = selected?.kind === "model" ? modelRows.find((model) => model.id === selected.id) : null;
  const selectedDetected = selected?.kind === "detected" ? detectedRows.find((item) => item.id === selected.id) : null;
  const modelGroup = selectedModel?.groupId ? groupRows.find((group) => group.id === selectedModel.groupId) : null;
  const noModels = !groups.loading && !models.loading && !detectedStores.loading && groupRows.length === 0 && modelRows.length === 0 && detectedRows.length === 0;
  const roleLabel = useCallback((id: string) => labelForRole(id, roles.data?.roles), [roles.data]);
  const stateLabel = (state: string) => MODEL_RUNTIME_STATE_LABELS[state] ?? state;
  const sourceLabel = (source: string) => MODEL_SOURCE_LABELS[source.toLocaleLowerCase()] ?? source;

  async function groupAction(group: Group, action: string) { if (action === "remove") await api.delete(`/stack/v1/groups/${group.id}`); else if (action !== "move") await api.post(`/stack/v1/groups/${group.id}/actions`, { action }); await groups.refetch(); await models.refetch(); }
  async function adopt(store: DetectedStore, selectedRoles?: string[]) { if (store.kind === "file") { await api.post("/stack/v1/models/import", { path: store.path, id: `imported-${store.digest?.slice(0, 16) ?? store.id.replace(/[^a-z0-9]+/gi, "-")}`, roles: selectedRoles ?? store.couldHold ?? [], licence: "Imported local model" }); } else await fetch(`/stack/v1/detected/${store.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: selectedRoles ?? store.couldHold ?? store.roles ?? [] }) }); await detectedStores.refetch(); await models.refetch(); setSelected(null); }
  const rename = useCallback(async (group: Group) => { const name = renames[group.id]?.trim(); if (!name || name === group.name) return; await fetch(`/stack/v1/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }); await refetchGroups(); }, [refetchGroups, renames]);
  async function renameModel(model: Model, nickname: string) { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: nickname.trim() || null }) }); await models.refetch(); }
  async function moveModel(model: Model, groupId: string) { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId: groupId || null }) }); await models.refetch(); await groups.refetch(); }
  async function createGroup(parentId: string | null) { const name = window.prompt(parentId ? "New subgroup name" : "New group name"); if (!name?.trim()) return; await api.post("/stack/v1/groups", { name: name.trim(), parentId }); await groups.refetch(); }
  async function scanNow() { setScanBusy(true); try { setScanResult(await scanComputer()); await detectedStores.refetch(); await models.refetch(); } finally { setScanBusy(false); } }
  async function modelAction(model: Model, action: string): Promise<void> { if (action === "remove") await api.delete(`/stack/v1/models/${model.id}`); else if (["load", "unload", "pin", "unpin", "checkUpdates"].includes(action)) await api.post(`/stack/v1/models/${model.id}/actions`, { action }); await models.refetch(); }
  function rowActions(row: ModelRow) { if (row.kind === "detected") return actionsFor("detected", {}, (action) => { if (action === "adopt") void adopt(row.store); else if (action === "forget") void fetch(`/stack/v1/detected/${row.store.id}/forget`, { method: "POST" }).then(() => detectedStores.refetch()); }, "row"); return actionsFor("model", { loaded: row.model.runtimeState === "loaded" }, (action) => { if (action === "rename") setRenames((current) => ({ ...current, [row.model.id]: row.model.nickname ?? displayName(row.model.id) })); else if (action === "move") setSelected({ kind: "model", id: row.model.id }); else void modelAction(row.model, action === "update" ? "checkUpdates" : action); }, "row"); }

  const allRows = useMemo<ModelRow[]>(() => [...detectedRows.map((store) => ({ kind: "detected" as const, store })), ...modelRows.map((model) => ({ kind: "model" as const, model }))], [detectedRows, modelRows]);
  const filterAccessors = useMemo(() => ({
    status: (row: ModelRow) => row.kind === "detected" ? (row.store.kind === "file" ? "Not imported" : "Not adopted") : stateLabel(row.model.runtimeState ?? row.model.state),
    role: (row: ModelRow) => row.kind === "detected" ? (row.store.couldHold ?? row.store.roles ?? []).map(roleLabel) : row.model.roles.map(roleLabel),
    group: (row: ModelRow) => row.kind === "detected" ? "Detected" : groupRows.find((group) => group.id === row.model.groupId)?.name ?? "Ungrouped",
    source: (row: ModelRow) => row.kind === "detected" ? sourceLabel(row.store.kind) : sourceLabel(row.model.source),
    search: (row: ModelRow) => row.kind === "detected" ? [row.store.name, row.store.version, row.store.path ?? row.store.where ?? ""] : [row.model.id, row.model.nickname ?? "", row.model.roles.map(roleLabel).join(" ")],
  }), [groupRows, roleLabel]);
  const filteredAllRows = useMemo(() => applyFilters(allRows, filterSearch, filterSelections, filterAccessors), [allRows, filterAccessors, filterSearch, filterSelections]);
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const group = (id: "status" | "role" | "group" | "source", title: string): FilterGroup => ({ id, title, options: countFilterOptions(allRows, filterAccessors[id]), selected: filterSelections[id] ?? new Set<string>(), onChange: (selected) => setFilterSelections((current) => ({ ...current, [id]: selected })) });
    return [group("status", "Status"), group("role", "Role"), group("group", "Group"), group("source", "Source")];
  }, [allRows, filterAccessors, filterSelections]);
  const filteredModelRows = filteredAllRows.filter((row): row is { kind: "model"; model: Model } => row.kind === "model");
  const groupTree = useMemo<ThingsTableGroup<ModelRow>[]>(() => {
    const childrenOf = (parentId: string | null): Group[] => groupRows.filter((group) => group.parentId === parentId);
    const makeGroup = (group: Group): ThingsTableGroup<ModelRow> | null => {
      const childGroups = childrenOf(group.id).map(makeGroup).filter((child): child is ThingsTableGroup<ModelRow> => child !== null);
      const childRows = filteredModelRows.filter((model) => model.model.groupId === group.id);
      if (childRows.length === 0 && childGroups.length === 0) return null;
      return {
      key: group.id,
      ariaLabel: group.name,
      phoneName: group.name,
      phoneSubtitle: `${group.modelCount} models · ${Math.round(group.bytesOnDisk / 1_000_000_000 * 10) / 10} GB`,
      label: <div><p><input aria-label={`Rename ${group.id}`} className="w-48 max-w-full bg-transparent font-medium outline-none" value={renames[group.id] ?? group.name} onChange={(event) => setRenames((current) => ({ ...current, [group.id]: event.target.value }))} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Enter") void rename(group); }} onBlur={() => void rename(group)} /><span className="sr-only">{group.name}</span></p><p className="text-xs text-muted-foreground">{group.modelCount} models · {Math.round(group.bytesOnDisk / 1_000_000_000 * 10) / 10} GB · {group.usage.requests} requests</p></div>,
      rows: childRows,
      groups: childGroups,
      summary: `${group.status.loaded} loaded · ${group.status.ready} ready · ${group.status.onDemand} on demand · ${group.usage.requests} requests · ${group.memoryBytes ? `${Math.round(group.memoryBytes / 1_000_000_000 * 10) / 10} GB in use` : "Not loaded"}`,
      status: group.worstHealth ? "attention" : "ready",
      onClick: () => setSelected({ kind: "group", id: group.id }),
    };
    };
    return childrenOf(null).map(makeGroup).filter((group): group is ThingsTableGroup<ModelRow> => group !== null);
  }, [filteredModelRows, groupRows, renames, rename]);

  const rows = filteredAllRows.filter((row) => row.kind === "detected" || !row.model.groupId);
  const groupPanelData = selectedGroup ? groupPanel(selectedGroup.name, selectedGroup.modelCount, (action) => void groupAction(selectedGroup, action)) : null;
  const modelPanelData = selectedModel ? modelPanel({ id: selectedModel.id, nickname: selectedModel.nickname ?? undefined, group: modelGroup?.name, source: selectedModel.source, licence: typeof selectedModel.provenance.licence === "string" ? selectedModel.provenance.licence : undefined, licenceSentence: selectedModel.licenceSentence, licenceUrl: selectedModel.licenceUrl, modelPath: selectedModel.modelPath, sizeBytes: selectedModel.sizeBytes, measuredFootprintBytes: selectedModel.measuredFootprintBytes, runtimeState: selectedModel.runtimeState }, (action) => { if (action === "rename") setRenames((current) => ({ ...current, [selectedModel.id]: selectedModel.nickname ?? displayName(selectedModel.id) })); else void modelAction(selectedModel, action === "update" ? "checkUpdates" : action); }) : null;
  const detectedPanelData = selectedDetected ? detectedPanel(`${selectedDetected.name} · ${selectedDetected.path ?? selectedDetected.where ?? "local"}`, (action) => { if (action.startsWith("adopt")) void adopt(selectedDetected, action.split(":")[1]?.split(",").filter(Boolean)); }, selectedDetected.couldHold ?? selectedDetected.roles) : null;

  if (noModels) return <Frame title="Models" description="Grouped models, measured footprints, nicknames, and utilization."><ScanStatus scan={scanResult} /><PageEmptyState title="No models are installed yet" detail="Choose an ability to bring the first local model to this computer." action={<div className="flex flex-wrap justify-center gap-3"><Button asChild><a href="/abilities">Add abilities</a></Button><Button variant="outline" onClick={() => void scanNow()} disabled={scanBusy}>{scanBusy ? "Scanning..." : "Scan this computer"}</Button></div>} /></Frame>;
  return <Frame title="Models" description="Grouped models, measured footprints, nicknames, and utilization."><div className={phone ? "hidden" : "flex justify-end"}><Button onClick={() => setAddOpen(true)}><span aria-hidden="true">＋</span>Add</Button></div><ScanStatus scan={scanResult} /><ThingsPage filter={{ search: { value: filterSearch, onChange: setFilterSearch, placeholder: "Search models" }, groups: filterGroups, onClear: () => { setFilterSearch(""); setFilterSelections({}); } }} table={<ThingsTable<ModelRow>
    columns={[
      { key: "name", header: "Name", width: "32%", render: (row) => row.kind === "detected" ? <div><p className="font-medium">{row.store.kind === "file" ? "Found on this computer" : "Detected, not adopted"} · {row.store.name}</p><p className="text-xs text-muted-foreground">{row.store.kind === "file" ? `${row.store.source} · ${Math.round((row.store.sizeBytes ?? 0) / 1_000_000)} MB` : `${row.store.version} · ${row.store.path ?? row.store.where}`}</p></div> : <div className="min-w-0"><input aria-label={`Nickname ${row.model.id}`} className="block w-44 max-w-full truncate bg-transparent font-medium outline-none" defaultValue={renames[row.model.id] ?? row.model.nickname ?? ""} placeholder={displayName(row.model.id)} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.value = row.model.nickname ?? ""; event.currentTarget.blur(); } if (event.key === "Enter") event.currentTarget.blur(); }} onBlur={(event) => void renameModel(row.model, event.target.value)} onClick={(event) => event.stopPropagation()} /><p className="truncate text-xs text-muted-foreground">{row.model.nickname && row.model.nickname !== displayName(row.model.id) ? row.model.id : displayName(row.model.id) !== row.model.id ? row.model.id : null}</p><p className="truncate text-xs text-muted-foreground xl:hidden">{groupRows.find((group) => group.id === row.model.groupId)?.name ?? "Ungrouped"}</p></div> },
      { key: "roles", header: "Roles", width: "17%", render: (row) => row.kind === "detected" ? linkCell("/abilities", (row.store.couldHold ?? row.store.roles ?? []).map(roleLabel).join(", ") || "Unassigned") : linkCell("/abilities", row.model.roles.map(roleLabel).join(", ")) },
      { key: "size", header: "Storage", width: "21%", align: "right", render: (row) => row.kind === "detected" ? `${row.store.candidateModels ?? 0} candidates` : <><div>{row.model.sizeBytes ? `${formatBytes(row.model.sizeBytes)} on disk` : "Size unknown"}</div><div className="text-xs text-muted-foreground">{row.model.measuredFootprintBytes ? `${formatBytes(row.model.measuredFootprintBytes)} in memory (measured)` : "Not measured"}</div></> },
      { key: "group", header: "Group", width: "13%", compact: true, render: (row) => row.kind === "detected" ? <Badge variant="outline">Adopt</Badge> : <Badge variant="outline" className="max-w-full truncate">{groupRows.find((group) => group.id === row.model.groupId)?.name ?? "Ungrouped"}</Badge> },
      { key: "state", header: "State", width: "13%", align: "right", render: (row) => row.kind === "detected" ? "Not adopted" : <><Badge variant="secondary">{stateLabel(row.model.runtimeState ?? row.model.state)}</Badge>{row.model.estimated && <span className="ml-2 text-xs text-muted-foreground">estimated</span>}</> },
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
    onRowClick={(row) => { if (phone && row.kind === "model") navigate(`/models/${encodeURIComponent(row.model.id)}`); else setSelected(row.kind === "detected" ? { kind: "detected", id: row.store.id } : { kind: "model", id: row.model.id }); }}
    actions={[{ label: scanBusy ? "Scanning..." : "Scan this computer", onClick: () => void scanNow(), disabled: scanBusy }, { label: "New group", onClick: () => void createGroup(null) }, ...(selected?.kind === "group" ? [{ label: "New subgroup", onClick: () => void createGroup(selected.id) }] : []), ...(selectedModels.length > 0 ? [{ label: `Move ${selectedModels.length} to group`, onClick: () => { const name = window.prompt("Group name or id"); const group = groupRows.find((item) => item.id === name?.trim() || item.name === name?.trim()); if (group) void Promise.all(selectedModels.map((id) => moveModel(modelRows.find((model) => model.id === id)!, group.id))).then(() => setSelectedModels([])); } }, { label: `Remove ${selectedModels.length}`, onClick: () => void Promise.all(selectedModels.map((id) => api.delete(`/stack/v1/models/${id}`))).then(() => models.refetch()) }] : [])]}
    rowActions={rowActions}
    phoneRow={(row) => row.kind === "detected" ? { name: detectedName(row.store), subtitle: `Not adopted · ${(row.store.couldHold ?? row.store.roles ?? []).map(roleLabel).join(", ") || "Unassigned"}`, status: "Not adopted", tone: "detected" } : { name: row.model.nickname?.trim() || displayName(row.model.id), subtitle: row.model.roles.map(roleLabel).join(", "), status: stateLabel(row.model.runtimeState ?? row.model.state), tone: modelStatus(row.model) }}
    groupActions={(group) => actionsFor("group", { count: groupRows.find((item) => item.id === group.key)?.modelCount ?? 0 }, (action) => { const match = groupRows.find((item) => item.id === group.key); if (match) void groupAction(match, action); }, "row")}
    empty="No models or detected stores are available."
  />} panel={selected ? <>{selectedGroup && groupPanelData && <PropertyPanel kind="Group" item={{ name: selectedGroup.name }} status={selectedGroup.worstHealth ? "Needs attention" : "Ready"} actions={groupPanelData.actions} facts={groupPanelData.facts} primaryActions={groupPanelData.primaryActions} tabs={{ overview: groupPanelData.overview }} open onClose={() => setSelected(null)} />}{selectedModel && modelPanelData && <PropertyPanel kind="Model" item={{ name: selectedModel.nickname ?? displayName(selectedModel.id) }} status={selectedModel.state} actions={modelPanelData.actions} facts={modelPanelData.facts} primaryActions={modelPanelData.primaryActions} tabs={{ overview: modelPanelData.overview, insights: modelPanelData.insights }} open onClose={() => setSelected(null)} />}{selectedDetected && detectedPanelData && <PropertyPanel kind="Detected" item={{ name: selectedDetected.name }} status="Detected" actions={detectedPanelData.actions} facts={detectedPanelData.facts} primaryActions={detectedPanelData.primaryActions} tabs={{ overview: detectedPanelData.overview }} open onClose={() => setSelected(null)} />}</> : null} /><AddSheet kind="model" open={addOpen} onOpenChange={setAddOpen} onAdded={() => { void models.refetch(); void detectedStores.refetch(); }} /></Frame>;
}
