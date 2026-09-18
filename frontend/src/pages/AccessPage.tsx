import { useState } from "react";
import { getIcon } from "@/kit/icons";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { ThingsTable, linkCell } from "@/kit/blocks/things-table/ThingsTable";
import { applyFilters, countFilterOptions, type FilterGroup } from "@/kit/blocks/filter-column/FilterColumn";
import { ThingsPage } from "@/kit/blocks/things-page/ThingsPage";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { clientPanel } from "@/panels/client";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { RelativeTime } from "@/kit/ui/relative-time";

type Client = { id: string; name: string; keyPrefix: string; allowedRoles: string[]; requests?: number; tokensIn?: number; tokensOut?: number; createdAt?: string; lastSeenAt?: string | null };
const FileKey2 = getIcon("FileKey2"); const ShieldCheck = getIcon("ShieldCheck");

export function AccessPage({ Frame }: { Frame: SectionFrameComponent }) {
  const clients = useApiResource<{ clients: Client[] }>("/stack/v1/clients");
  const operator = useApiResource<{ state: string; required: boolean }>("/stack/v1/operator");
  const [selected, setSelected] = useState<string | null>(null);
  const [filterSearch, setFilterSearch] = useState("");
  const [filterSelections, setFilterSelections] = useState<Record<string, ReadonlySet<string>>>({});
  const client = clients.data?.clients.find((item) => item.id === selected);
  const panel = client ? clientPanel(client.name, client.allowedRoles, async () => { await api.delete(`/stack/v1/clients/${client.id}`); setSelected(null); await clients.refetch(); }) : null;
  const rows = clients.data?.clients ?? [];
  const filterAccessors = { kind: (_row: Client) => ["Client", "Key"], role: (row: Client) => row.allowedRoles, status: (_row: Client) => "Active", search: (row: Client) => [row.name, row.keyPrefix, row.allowedRoles.join(" ")] };
  const filteredRows = applyFilters(rows, filterSearch, filterSelections, filterAccessors);
  const filterGroups = ((): FilterGroup[] => {
    const group = (id: string, title: string): FilterGroup => ({ id, title, options: countFilterOptions(rows, filterAccessors[id as keyof typeof filterAccessors]), selected: filterSelections[id] ?? new Set<string>(), onChange: (selected) => setFilterSelections((current) => ({ ...current, [id]: selected })) });
    return [group("kind", "Kind"), group("role", "Role"), group("status", "Status")];
  })();
  return <Frame title="Access" description="Local operator access and role-scoped client keys."><div className="space-y-6"><Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" />Operator</CardTitle></CardHeader><CardContent><p>{operator.data?.required ? "Password protection is enabled." : "Password is deferred until the first client key."}</p><p className="mt-2 text-sm text-muted-foreground">The operator session stays on this computer.</p></CardContent></Card><ThingsPage filter={{ search: { value: filterSearch, onChange: setFilterSearch, placeholder: "Search clients" }, groups: filterGroups, onClear: () => { setFilterSearch(""); setFilterSelections({}); } }} table={<div><div className="mb-4 flex items-center gap-2 text-sm font-medium"><FileKey2 className="size-4 text-primary" />Client keys</div><ThingsTable<Client>
    columns={[
      { key: "client", header: "Client", width: "34%", render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.keyPrefix}</p></div> },
      { key: "roles", header: "Allowed roles", render: (row) => row.allowedRoles.join(", ") },
      { key: "requests", header: "Requests", align: "right", render: (row) => row.requests ?? 0 },
      { key: "lastSeen", header: "Last seen", align: "right", render: (row) => row.lastSeenAt ? <RelativeTime at={row.lastSeenAt} /> : "Never" },
      { key: "key", header: "Key", align: "right", render: (row) => linkCell(`#client-${row.id}`, "Open key") },
    ]}
    rows={filteredRows}
    getKey={(row) => row.id}
    onRowClick={(row) => setSelected(row.id)}
    onLink={(target) => { if (target.startsWith("#client-")) setSelected(target.slice("#client-".length)); }}
    empty="No client keys yet."
  /> </div>} panel={client && panel ? <PropertyPanel kind="Client" item={{ name: client.name }} status="Active" actions={panel.actions} facts={panel.facts} primaryActions={panel.primaryActions} tabs={{ overview: panel.overview }} open onClose={() => setSelected(null)} /> : null} /></div></Frame>;
}
