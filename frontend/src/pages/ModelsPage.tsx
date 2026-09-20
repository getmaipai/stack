import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/kit/ui/button";
import { getIcon } from "@/kit/icons";
import { CategoryBrowser } from "@/kit/blocks/browser/CategoryBrowser";
import { DataTable, type DataTableColumn } from "@/kit/blocks/browser/DataTable";
import { DetailsPane, type DetailsPaneAction, type DetailsPaneTab } from "@/kit/blocks/pane/DetailsPane";
import { ConfirmDialog } from "@/kit/blocks/ConfirmDialog";
import { Empty } from "@/kit/blocks/states/Empty";
import { Loading } from "@/kit/blocks/states/Loading";
import { StatusPill } from "@/kit/blocks/cards/StatusPill";
import type { StatusKind } from "@/lib/status";
import { useFacetSort } from "@/kit/hooks/useFacetSort";
import { useSelectionPane } from "@/kit/hooks/useSelectionPane";
import { useConfirm } from "@/kit/hooks/useConfirm";
import { api, type RoleRecord } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { labelForRole, MODEL_SOURCE_LABELS } from "@/lib/modelStates";
import { displayName } from "@/lib/names";
import { AddSheet } from "@/kit/blocks/add-sheet/AddSheet";
import { ScanStatus, scanComputer, type DetectedScan } from "@/lib/detectedScan";
import { formatBytes, formatDuration } from "@/lib/format";
import { RelativeTime } from "@/kit/ui/relative-time";
import { searchCatalog, searchHuggingFace, resolveHuggingFace, installFromCatalog, type CatalogEntry } from "@/lib/catalogSearch";
import type { ModelRecommendation, UpdatesResponse } from "@/pages/overview/types";

type Group = { id: string; name: string };
type Model = {
  id: string; roles: string[]; state: string; runtimeState?: string; sizeBytes: number | null; fileMissing?: boolean;
  measuredFootprintBytes: number | null; estimated: boolean; source: string; licenceSentence?: string; licenceUrl?: string | null;
  groupId?: string | null; nickname?: string | null; provenance: Record<string, unknown>; modelPath?: string | null;
  usage?: { requests: number; tokensIn: number; tokensOut: number; secondsLoaded: number; peakMemoryBytes: number; lastUsedAt: string | null };
};
type DetectedStore = { id: string; name: string; kind: string; version: string; path?: string; where?: string; candidateModels?: number; roles?: string[]; couldHold?: string[]; state?: "ready" | "offline" };

const FACET_ROLES: Record<string, string[]> = {
  llm: ["chat", "coding", "judge", "router"],
  image: ["image", "vision"],
  video: ["video"],
  audio: ["stt", "tts", "wakeword", "music"],
  embedding: ["embed", "rerank"],
};
const FACET_HUE: Record<string, string> = { llm: "--hue-violet", image: "--hue-red", video: "--hue-blue", audio: "--hue-orange", embedding: "--hue-teal" };
const FACETS = [
  { id: "all", label: "All" },
  { id: "llm", label: "LLM" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "audio", label: "Audio" },
  { id: "embedding", label: "Embedding" },
];
const SORTS = [{ id: "name", label: "Name" }, { id: "size", label: "Size" }, { id: "lastUsed", label: "Last used" }];

function matchesFacet(facet: string, roles: string[]): boolean {
  if (facet === "all") return true;
  return roles.some((role) => FACET_ROLES[facet]?.includes(role));
}
function hueForRoles(roles: string[]): string {
  const facet = Object.keys(FACET_ROLES).find((id) => matchesFacet(id, roles));
  return (facet && FACET_HUE[facet]) || "--cat-models";
}
function modelStatus(model: Model): StatusKind {
  if (model.fileMissing) return "error";
  if (model.runtimeState === "failed") return "error";
  if (model.runtimeState === "loaded") return "running";
  if (model.runtimeState === "ready" || model.runtimeState === "onDemand") return "ready";
  return "disabled";
}
function IconTile({ hue }: { hue: string }) {
  const Icon = getIcon("Box");
  return <div className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in srgb, var(${hue}) 16%, transparent)`, color: `var(${hue})` }}><Icon className="size-4" aria-hidden="true" /></div>;
}

export function ModelsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const navigate = useNavigate();
  const [state, actions] = useFacetSort({ facet: "all", sort: "name" });
  const pane = useSelectionPane();
  const confirmRemove = useConfirm<Model>();

  const groups = useApiResource<{ groups: Group[] }>("/stack/v1/groups");
  const models = useApiResource<{ models: Model[] }>("/stack/v1/models");
  const detected = useApiResource<{ detected: DetectedStore[] }>("/stack/v1/detected");
  const roles = useApiResource<{ roles: RoleRecord[] }>("/stack/v1/roles");
  const updates = useApiResource<UpdatesResponse>(state.mode === "updates" || state.mode === "recommended" ? "/stack/v1/updates" : null);
  const [browseResults, setBrowseResults] = useState<CatalogEntry[]>([]);
  const [hubResults, setHubResults] = useState<CatalogEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [resolvingEntry, setResolvingEntry] = useState<CatalogEntry | null>(null);
  const [resolveBusy, setResolveBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [scanResult, setScanResult] = useState<DetectedScan | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const refetchDetected = detected.refetch;
  useEffect(() => { if (typeof EventSource === "undefined") return; const stream = new EventSource("/stack/v1/events"); stream.onmessage = (event) => { try { if ((JSON.parse(event.data) as { id?: string }).id === "detected.changed") void refetchDetected(); } catch { /* ignore malformed feed data */ } }; return () => stream.close(); }, [refetchDetected]);
  useEffect(() => {
    if (state.mode !== "browse") return;
    setBrowseLoading(true);
    Promise.all([searchCatalog("model", state.filter), searchHuggingFace(state.filter)])
      .then(([catalog, hub]) => { setBrowseResults(catalog); setHubResults(hub.results); })
      .finally(() => setBrowseLoading(false));
  }, [state.mode, state.filter]);

  const roleLabel = useCallback((id: string) => labelForRole(id, roles.data?.roles), [roles.data]);
  const sourceLabel = (source: string) => MODEL_SOURCE_LABELS[source.toLocaleLowerCase()] ?? source;
  const groupName = (groupId: string | null | undefined) => groups.data?.groups.find((group) => group.id === groupId)?.name ?? "Ungrouped";

  async function modelAction(model: Model, action: string): Promise<void> { if (action === "remove") await api.delete(`/stack/v1/models/${model.id}`); else if (["load", "unload", "pin", "unpin", "checkUpdates"].includes(action)) await api.post(`/stack/v1/models/${model.id}/actions`, { action }); await models.refetch(); }
  async function renameModel(model: Model, nickname: string): Promise<void> { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: nickname.trim() || null }) }); await models.refetch(); }
  async function moveModel(model: Model, groupId: string | null): Promise<void> { await fetch(`/stack/v1/models/${model.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId }) }); await models.refetch(); await groups.refetch(); }
  async function adopt(store: DetectedStore): Promise<void> { await fetch(`/stack/v1/detected/${store.id}/adopt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roles: store.couldHold ?? store.roles ?? ["chat"] }) }); await detected.refetch(); await models.refetch(); }
  async function forget(store: DetectedStore): Promise<void> { await fetch(`/stack/v1/detected/${store.id}/forget`, { method: "POST" }); await detected.refetch(); }
  async function scanNow(): Promise<void> { setScanBusy(true); try { setScanResult(await scanComputer()); await detected.refetch(); await models.refetch(); } finally { setScanBusy(false); } }
  async function removeModel(model: Model): Promise<void> { await api.delete(`/stack/v1/models/${model.id}`); confirmRemove.clear(); pane.close(); await models.refetch(); }
  async function installRecommendation(recommendation: ModelRecommendation): Promise<void> { await api.post("/stack/v1/models", { id: recommendation.id, source: "catalog", roles: [recommendation.role], url: recommendation.download.url, sha256: recommendation.download.sha256, licence: recommendation.license ?? "Catalog model", revision: recommendation.revision }); await updates.refetch(); await models.refetch(); }
  async function chooseBrowseEntry(entry: CatalogEntry): Promise<void> { if (!entry.repo) return; setResolveBusy(true); try { setResolvingEntry(await resolveHuggingFace(entry.repo)); } finally { setResolveBusy(false); } }
  async function installBrowseEntry(entry: CatalogEntry, source: "catalog" | "huggingface"): Promise<void> { await installFromCatalog(entry, source); setResolvingEntry(null); await models.refetch(); }
  async function runSpeedTest(model: Model): Promise<void> {
    try { const body = await api.post<{ result: { tokensPerSecond: number | null } }>("/stack/v1/speed-test"); toast.success(body.result.tokensPerSecond ? `${body.result.tokensPerSecond} tokens/sec on ${displayName(model.id)}.` : "Speed test recorded."); }
    catch (error) { toast.error(error instanceof Error ? error.message : "The speed test failed."); }
  }

  function matchesFilter(query: string, ...haystack: Array<string | null | undefined>): boolean {
    if (!query.trim()) return true;
    const needle = query.trim().toLocaleLowerCase();
    return haystack.some((value) => value?.toLocaleLowerCase().includes(needle));
  }

  const installedModels = models.data?.models ?? [];
  const facetCounts: Record<string, number> = { all: installedModels.length };
  for (const facetId of Object.keys(FACET_ROLES)) facetCounts[facetId] = installedModels.filter((model) => matchesFacet(facetId, model.roles)).length;
  const facetsWithCounts = state.mode === "installed" ? FACETS.map((facet) => ({ ...facet, count: facetCounts[facet.id] })) : FACETS;

  const allModelRows = installedModels.filter((model) => matchesFacet(state.facet, model.roles) && matchesFilter(state.filter, model.id, model.nickname, groupName(model.groupId)));
  const allDetectedRows = (detected.data?.detected ?? []).filter((store) => matchesFacet(state.facet, store.couldHold ?? store.roles ?? []) && matchesFilter(state.filter, store.name, store.path, store.where));
  const noInstalled = !models.loading && !detected.loading && installedModels.length === 0 && (detected.data?.detected ?? []).length === 0;
  const selectedModel = pane.selectedId?.startsWith("model:") ? allModelRows.find((model) => model.id === pane.selectedId!.slice(6)) : undefined;

  const modelColumns: DataTableColumn<Model>[] = [
    { id: "name", header: "Name", className: "min-w-[220px]", cell: (model) => <div className="flex min-w-0 items-center gap-2"><IconTile hue={hueForRoles(model.roles)} /><div className="min-w-0"><p className="truncate font-medium">{model.nickname?.trim() || displayName(model.id)}</p><p className="truncate text-xs text-muted-foreground">{model.id}</p></div></div> },
    { id: "type", header: "Type", cell: (model) => model.roles.map(roleLabel).join(", ") || "Unassigned" },
    { id: "size", header: "Size", cell: (model) => formatBytes(model.sizeBytes) },
    { id: "quantization", header: "Quantization", cell: () => "Not reported", priority: 1 },
    { id: "status", header: "Status", cell: (model) => <StatusPill status={modelStatus(model)} /> },
    { id: "runtime", header: "Runtime", cell: () => "Not reported", priority: 1 },
    { id: "lastUsed", header: "Last used", cell: (model) => model.usage?.lastUsedAt ? <RelativeTime at={model.usage.lastUsedAt} /> : "Never", priority: 1 },
    { id: "notes", header: "Notes", cell: (model) => model.fileMissing ? "File missing" : groupName(model.groupId), priority: 1 },
  ];
  const detectedColumns: DataTableColumn<DetectedStore>[] = [
    { id: "name", header: "Name", className: "min-w-[220px]", cell: (store) => <div className="flex min-w-0 items-center gap-2"><IconTile hue={hueForRoles(store.couldHold ?? store.roles ?? [])} /><div className="min-w-0"><p className="truncate font-medium">{store.name}</p><p className="truncate text-xs text-muted-foreground">Detected, not adopted</p></div></div> },
    { id: "type", header: "Type", cell: (store) => (store.couldHold ?? store.roles ?? []).map(roleLabel).join(", ") || "Unassigned" },
    { id: "status", header: "Status", cell: (store) => <StatusPill status={store.state === "offline" ? "stopped" : "detected"} /> },
    { id: "notes", header: "Notes", cell: (store) => store.path ?? store.where ?? "" },
  ];
  const browseColumns: DataTableColumn<CatalogEntry>[] = [
    { id: "name", header: "Name", className: "min-w-[220px]", cell: (entry) => <div className="flex min-w-0 items-center gap-2"><IconTile hue={hueForRoles(entry.roles ?? [])} /><div className="min-w-0"><p className="truncate font-medium">{displayName(entry.id)}</p><p className="truncate text-xs text-muted-foreground">{entry.source}</p></div></div> },
    { id: "type", header: "Type", cell: (entry) => entry.roles?.map(roleLabel).join(", ") || "Unassigned" },
    { id: "size", header: "Size", cell: (entry) => formatBytes(entry.sizeBytes) },
    { id: "licence", header: "Licence", cell: (entry) => entry.licence ?? "Not resolved" },
    { id: "action", header: "Actions", cell: (entry) => entry.sha256
      ? <Button size="sm" variant="outline" onClick={() => void installBrowseEntry(entry, entry.source === "Hugging Face" ? "huggingface" : "catalog")}>Install</Button>
      : <Button size="sm" variant="outline" disabled={resolveBusy} onClick={() => void chooseBrowseEntry(entry)}>Review</Button> },
  ];
  const recommendedColumns: DataTableColumn<ModelRecommendation>[] = [
    { id: "name", header: "Name", className: "min-w-[220px]", cell: (item) => <div className="flex min-w-0 items-center gap-2"><IconTile hue={hueForRoles([item.role])} /><div className="min-w-0"><p className="truncate font-medium">{displayName(item.id)}</p><p className="truncate text-xs text-muted-foreground">{item.sentence}</p></div></div> },
    { id: "type", header: "Type", cell: (item) => roleLabel(item.role) },
    { id: "action", header: "Actions", cell: (item) => <Button size="sm" variant="outline" onClick={() => void installRecommendation(item)}>Install</Button> },
  ];

  const paneTabs: DetailsPaneTab[] = selectedModel ? [
    { id: "overview", label: "Overview", content: <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">{selectedModel.licenceSentence ?? "Licence not recorded."}</p>
      <div className="grid grid-cols-2 gap-2 *:min-w-0">
        <div><p className="text-xs text-muted-foreground">Type</p><p>{selectedModel.roles.map(roleLabel).join(", ") || "Unassigned"}</p></div>
        <div><p className="text-xs text-muted-foreground">Size</p><p>{formatBytes(selectedModel.sizeBytes)}</p></div>
        <div><p className="text-xs text-muted-foreground">Quantization</p><p>Not reported</p></div>
        <div><p className="text-xs text-muted-foreground">Context length</p><p>Not reported</p></div>
        <div><p className="text-xs text-muted-foreground">Architecture</p><p>Not reported</p></div>
        <div><p className="text-xs text-muted-foreground">Licence</p><p>{typeof selectedModel.provenance.licence === "string" ? selectedModel.provenance.licence : "Not reported"}</p></div>
        <div><p className="text-xs text-muted-foreground">Runtime</p><p>Not reported</p></div>
        <div><p className="text-xs text-muted-foreground">Group</p><p>{groupName(selectedModel.groupId)}</p></div>
        <div><p className="text-xs text-muted-foreground">Source</p><p>{sourceLabel(selectedModel.source)}</p></div>
        <div className="col-span-2"><p className="text-xs text-muted-foreground">Location</p><p className="truncate" title={selectedModel.modelPath ?? undefined}>{selectedModel.modelPath ?? "Not reported"}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-2 border-t pt-3 *:min-w-0">
        <div><p className="text-xs text-muted-foreground">Memory (measured)</p><p>{formatBytes(selectedModel.measuredFootprintBytes)}</p></div>
        <div><p className="text-xs text-muted-foreground">Peak memory (usage)</p><p>{formatBytes(selectedModel.usage?.peakMemoryBytes ?? null)}</p></div>
      </div>
    </div> },
    { id: "settings", label: "Settings", content: <Empty message="This model has no configurable settings yet." /> },
    { id: "usage", label: "Usage", content: <div className="grid grid-cols-2 gap-2 text-sm *:min-w-0">
      <div><p className="text-xs text-muted-foreground">Requests</p><p>{selectedModel.usage?.requests ?? 0}</p></div>
      <div><p className="text-xs text-muted-foreground">Time loaded</p><p>{formatDuration(selectedModel.usage?.secondsLoaded ?? null)}</p></div>
      <div><p className="text-xs text-muted-foreground">Tokens in</p><p>{selectedModel.usage?.tokensIn ?? 0}</p></div>
      <div><p className="text-xs text-muted-foreground">Tokens out</p><p>{selectedModel.usage?.tokensOut ?? 0}</p></div>
      <div className="col-span-2"><p className="text-xs text-muted-foreground">Last used</p><p>{selectedModel.usage?.lastUsedAt ? <RelativeTime at={selectedModel.usage.lastUsedAt} /> : "Never"}</p></div>
    </div> },
    { id: "files", label: "Files", content: selectedModel.modelPath
      ? <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border p-3 text-sm"><span className="min-w-0 truncate">{selectedModel.modelPath.split("/").pop()}</span><span className="shrink-0 text-muted-foreground">{formatBytes(selectedModel.sizeBytes)}</span></div>
      : <Empty message="No files are recorded for this model." /> },
    { id: "logs", label: "Logs", content: <Empty message="No log lines are recorded for this model yet." actionLabel="Open logs" onAction={() => navigate("/logs")} /> },
  ] : [];

  const resolveBlockReason = !resolvingEntry ? undefined
    : resolvingEntry.licenceFlag === "gated" ? "Accept this model's terms on Hugging Face before installing it."
    : resolvingEntry.roles?.[0] === "unknown" ? "This repository has unknown ability, so Install is unavailable."
    : !resolvingEntry.sha256 ? "The selected files do not publish a SHA-256, so Install is unavailable."
    : undefined;
  const resolveTabs: DetailsPaneTab[] = resolvingEntry ? [
    { id: "overview", label: "Overview", content: <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">Revision {resolvingEntry.revision ?? "unknown"} · licence {resolvingEntry.licence ?? "not recorded"} · {formatBytes(resolvingEntry.sizeBytes)}</p>
      <p className="text-muted-foreground">{resolvingEntry.files?.length ?? 0} files · proposed role {resolvingEntry.roles?.[0] ?? "unknown"}</p>
      {resolvingEntry.files?.map((file) => <p key={file.name} className="truncate text-xs text-muted-foreground">{file.name} · {formatBytes(file.sizeBytes)}</p>)}
    </div> },
  ] : [];
  const resolveActions: DetailsPaneAction[] = resolvingEntry ? [
    { label: "Install", icon: "Download", disabledReason: resolveBlockReason, onClick: () => void installBrowseEntry(resolvingEntry, "huggingface") },
  ] : [];

  const paneActions: DetailsPaneAction[] = selectedModel ? [
    { label: "Chat", icon: "MessageSquare", onClick: () => navigate(`/try?model=${encodeURIComponent(selectedModel.id)}`), disabledReason: selectedModel.runtimeState !== "loaded" && selectedModel.runtimeState !== "ready" ? "Load the model first." : undefined },
    selectedModel.runtimeState === "loaded" ? { label: "Stop", icon: "Square", onClick: () => void modelAction(selectedModel, "unload") } : { label: "Load", icon: "Play", onClick: () => void modelAction(selectedModel, "load") },
    { label: "Restart", icon: "RefreshCw", onClick: () => void modelAction(selectedModel, "unload").then(() => modelAction(selectedModel, "load")) },
    { label: "Update", icon: "UploadCloud", onClick: () => void modelAction(selectedModel, "checkUpdates") },
    { label: "Test", icon: "Gauge", onClick: () => void runSpeedTest(selectedModel), disabledReason: !selectedModel.roles.includes("chat") ? "Speed testing currently measures the resident chat model." : undefined },
    { label: "Open logs", icon: "FileText", onClick: () => navigate("/logs") },
    { label: "Remove", icon: "Trash2", destructive: true, onClick: () => confirmRemove.ask(selectedModel) },
  ] : [];

  if (noInstalled && state.mode === "installed") return <Frame title="Models" description="Manage, install, and run AI models"><ScanStatus scan={scanResult} /><Empty message="No models are installed yet." actionLabel="Add a model" onAction={() => setAddOpen(true)} /><AddSheet kind="model" open={addOpen} onOpenChange={setAddOpen} onAdded={() => void models.refetch()} /></Frame>;

  return <Frame title="Models" description="Manage, install, and run AI models">
    <CategoryBrowser facets={facetsWithCounts} sorts={SORTS} primaryAction={{ label: "Install Model", onClick: () => setAddOpen(true) }} state={state} actions={actions}>
      <ScanStatus scan={scanResult} />
      {state.mode === "installed" && (models.loading || detected.loading ? <Loading rows={5} /> :
        <>
          <div className="mb-3 flex justify-end"><Button variant="outline" size="sm" onClick={() => void scanNow()} disabled={scanBusy}>{scanBusy ? "Scanning..." : "Scan this computer"}</Button></div>
          {allDetectedRows.length > 0 && <DataTable data={allDetectedRows} columns={detectedColumns} getRowId={(store) => `detected:${store.id}`} rowMenu={(store) => <><Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void adopt(store)}>Adopt</Button><Button variant="ghost" size="sm" className="w-full justify-start text-destructive" onClick={() => void forget(store)}>Forget</Button></>} />}
          <DataTable data={allModelRows} columns={modelColumns} getRowId={(model) => `model:${model.id}`} activeRowId={pane.selectedId} onRowClick={(model) => pane.select(`model:${model.id}`)} selectedIds={selectedIds} onSelectionChange={setSelectedIds}
            rowMenu={(model) => <>
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => { const name = window.prompt("Nickname", model.nickname ?? displayName(model.id)); if (name !== null) void renameModel(model, name); }}>Rename</Button>
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => {
                const name = window.prompt("Group name (blank for ungrouped)", groupName(model.groupId));
                if (name === null) return;
                const trimmed = name.trim();
                if (trimmed === "") { void moveModel(model, null); return; }
                const group = groups.data?.groups.find((item) => item.name === trimmed);
                if (!group) { window.alert(`No group named "${trimmed}". Existing groups: ${(groups.data?.groups ?? []).map((item) => item.name).join(", ") || "none yet"}.`); return; }
                void moveModel(model, group.id);
              }}>Move to group</Button>
              <Button variant="ghost" size="sm" className="w-full justify-start text-destructive" onClick={() => confirmRemove.ask(model)}>Remove</Button>
            </>}
          />
          {allModelRows.length === 0 && allDetectedRows.length === 0 && <Empty message="No models match this filter." />}
        </>
      )}
      {state.mode === "browse" && (() => {
        const browseRows = [...browseResults, ...hubResults].filter((entry) => matchesFacet(state.facet, entry.roles ?? []));
        return browseLoading ? <Loading rows={5} /> : browseRows.length === 0 ? <Empty message="No catalog entries match this search." /> : <DataTable data={browseRows} columns={browseColumns} getRowId={(entry) => `catalog:${entry.id}`} />;
      })()}
      {state.mode === "updates" && (updates.loading ? <Loading rows={2} /> : !updates.data?.models.available ? <Empty message="No model updates are available." /> : <DataTable data={[updates.data.models]} columns={[{ id: "name", header: "Name", cell: () => "Model bundle" }, { id: "installed", header: "Installed", cell: (item) => `v${item.installed}` }, { id: "available", header: "Available", cell: (item) => item.available ? `v${item.available}` : "" }]} getRowId={() => "models-bundle"} />)}
      {state.mode === "recommended" && (() => {
        const recommendedRows = (updates.data?.recommendations ?? []).filter((item) => matchesFacet(state.facet, [item.role]) && matchesFilter(state.filter, item.id, item.sentence));
        return updates.loading ? <Loading rows={2} /> : recommendedRows.length === 0 ? <Empty message="No recommendations for this computer right now." /> : <DataTable data={recommendedRows} columns={recommendedColumns} getRowId={(item) => `recommend:${item.id}`} />;
      })()}
    </CategoryBrowser>

    {selectedModel && <DetailsPane open onClose={pane.close} icon="Box" hue="--cat-models" name={selectedModel.nickname?.trim() || displayName(selectedModel.id)} identifier={selectedModel.id} status={modelStatus(selectedModel)} tabs={paneTabs} actions={paneActions} />}
    {resolvingEntry && <DetailsPane open onClose={() => setResolvingEntry(null)} icon="Box" hue="--cat-models" name={displayName(resolvingEntry.id)} identifier={resolvingEntry.repo ?? resolvingEntry.id} status={resolveBlockReason ? "warning" : "ready"} tabs={resolveTabs} actions={resolveActions} />}
    <ConfirmDialog open={confirmRemove.target !== null} title={`Remove ${confirmRemove.target ? (confirmRemove.target.nickname?.trim() || displayName(confirmRemove.target.id)) : ""}?`} affectedFiles={confirmRemove.target?.modelPath ? [confirmRemove.target.modelPath] : []} affectedDependents={confirmRemove.target?.roles.map(roleLabel) ?? []} onCancel={confirmRemove.clear} onConfirm={() => confirmRemove.target && void removeModel(confirmRemove.target)} />
    <AddSheet kind="model" open={addOpen} onOpenChange={setAddOpen} onAdded={() => { void models.refetch(); void detected.refetch(); }} />
  </Frame>;
}
