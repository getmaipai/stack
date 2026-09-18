import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { LibraryRecord } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";
import { ThingsTable, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { Card, CardContent } from "@/kit/ui/card";
import type { SectionFrameComponent } from "@/pages/DashboardShell";

type LibraryPageData = LibraryRecord & { markdown: string; files: string[]; numbers: { footprintBytes: number | null; speedTokensPerSecond: number | null; lastUsedAt: string | null } };
function status(row: LibraryRecord): ThingStatus { return row.kind === "model" ? "ready" : "detected"; }
function Markdown({ value }: { value: string }) { return <div className="space-y-3 text-base leading-7">{value.split("\n\n").map((block, index) => { const trimmed = block.trim(); if (!trimmed) return null; if (trimmed.startsWith("# ")) return <h3 className="text-lg font-semibold" key={index}>{trimmed.slice(2)}</h3>; if (trimmed.startsWith("## ")) return <h4 className="font-semibold" key={index}>{trimmed.slice(3)}</h4>; return <p key={index}>{trimmed.replaceAll(/[`*_]/g, "")}</p>; })}</div>; }

export function LibraryPage({ Frame }: { Frame: SectionFrameComponent }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const library = useApiResource<{ library: LibraryRecord[] }>("/stack/v1/library");
  const [selected, setSelected] = useState<string | null>(null);
  const [filterSearch, setFilterSearch] = useState("");
  const updates = useApiResource<{ app: { checksEnabled: boolean } }>("/stack/v1/updates");
  useEffect(() => setSelected(searchParams.get("item")), [searchParams]);
  const page = useApiResource<{ page: LibraryPageData }>(selected ? `/stack/v1/library/${selected}` : null);
  async function fetchDocs() { await api.post("/stack/v1/library/fetch"); await library.refetch(); if (selected) await page.refetch(); }
  const rows = useMemo(() => (library.data?.library ?? []).filter((item) => `${item.title} ${item.kind} ${item.source} ${item.licence}`.toLocaleLowerCase().includes(filterSearch.toLocaleLowerCase())), [filterSearch, library.data?.library]);
  const row = library.data?.library.find((item) => item.id === selected);
  function select(item: LibraryRecord): void { setSelected(item.id); setSearchParams({ item: item.id }); }
  return <Frame title="Library" description="Local docs for the models and engines installed on this computer."><ThingsPage filter={{ search: { value: filterSearch, onChange: setFilterSearch, placeholder: "Search Library" }, groups: [], onClear: () => setFilterSearch("") }} table={<ThingsTable<LibraryRecord> columns={[{ key: "title", header: "Title", width: "35%", render: (item) => <div><p className="font-medium">{item.title}</p><p className="text-xs text-muted-foreground">{item.kind}</p></div> }, { key: "source", header: "Source", render: (item) => <span className="block max-w-xs truncate" title={item.source}>{item.source}</span> }, { key: "licence", header: "Licence", render: (item) => item.licence }, { key: "fetched", header: "Fetched", align: "right", render: (item) => new Date(item.fetchedAt).toLocaleDateString() }]} rows={rows} getKey={(item) => item.id} getStatus={status} selectedKey={selected ?? undefined} onRowClick={select} actions={[{ label: "Fetch the docs for everything", onClick: () => void fetchDocs() }]} empty="Nothing has been fetched into the Library yet." />} panel={row && page.data?.page ? <PropertyPanel kind={row.kind} item={{ name: row.title }} status="Local copy" actions={[]} facts={[{ label: "Source", value: <span className="block break-all text-xs leading-4">{row.source}</span> }, { label: "Licence", value: row.licence }, { label: "Revision", value: row.revision }]} tabs={{ overview: <div className="space-y-5"><Card><CardContent className="p-4"><Markdown value={page.data.page.markdown} /></CardContent></Card><div><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files at this revision</p><ul className="mt-2 space-y-1 text-sm">{page.data.page.files.map((file) => <li key={file}>{file}</li>)}</ul></div></div>, insights: <div className="space-y-3 text-sm"><p>Footprint: {page.data.page.numbers.footprintBytes ? `${Math.round(page.data.page.numbers.footprintBytes / 1_000_000_000 * 10) / 10} GB` : "Not measured"}</p><p>Speed: {page.data.page.numbers.speedTokensPerSecond ? `${page.data.page.numbers.speedTokensPerSecond} tokens per second` : "No result"}</p><p>Last used: {page.data.page.numbers.lastUsedAt ? new Date(page.data.page.numbers.lastUsedAt).toLocaleString() : "Not used"}</p></div>, settings: <p className="text-sm text-muted-foreground">Fetch the docs is {updates.data?.app.checksEnabled ? "enabled" : "disabled"}. The Library uses the existing Updates switch.</p> }} open onClose={() => { setSelected(null); setSearchParams({}); }} /> : null} /></Frame>;
}
