import { useState } from "react";
import { getIcon } from "@/kit/icons";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { ThingsTable, linkCell } from "@/kit/blocks/things-table/ThingsTable";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { clientPanel } from "@/panels/client";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";

type Client = { id: string; name: string; keyPrefix: string; allowedRoles: string[]; requests?: number; tokensIn?: number; tokensOut?: number; createdAt?: string; lastSeenAt?: string | null };
const FileKey2 = getIcon("FileKey2"); const ShieldCheck = getIcon("ShieldCheck");

function relativeTime(value?: string | null): string {
  if (!value) return "Never";
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AccessPage({ Frame }: { Frame: SectionFrameComponent }) {
  const clients = useApiResource<{ clients: Client[] }>("/stack/v1/clients");
  const operator = useApiResource<{ state: string; required: boolean }>("/stack/v1/operator");
  const [selected, setSelected] = useState<string | null>(null);
  const client = clients.data?.clients.find((item) => item.id === selected);
  const panel = client ? clientPanel(client.name, client.allowedRoles, async () => { await api.delete(`/stack/v1/clients/${client.id}`); setSelected(null); await clients.refetch(); }) : null;
  return <Frame title="Access" description="Local operator access and role-scoped client keys."><div className="space-y-6"><Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5 text-primary" />Operator</CardTitle></CardHeader><CardContent><p>{operator.data?.required ? "Password protection is enabled." : "Password is deferred until the first client key."}</p><p className="mt-2 text-sm text-muted-foreground">The operator session stays on this computer.</p></CardContent></Card><div className={client ? "pr-0 lg:pr-[29rem]" : ""}><div className="mb-4 flex items-center gap-2 text-sm font-medium"><FileKey2 className="size-4 text-primary" />Client keys</div><ThingsTable<Client>
    columns={[
      { key: "client", header: "Client", width: "34%", render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.keyPrefix}</p></div> },
      { key: "roles", header: "Allowed roles", render: (row) => row.allowedRoles.join(", ") },
      { key: "requests", header: "Requests", align: "right", render: (row) => row.requests ?? 0 },
      { key: "lastSeen", header: "Last seen", align: "right", render: (row) => row.lastSeenAt ? relativeTime(row.lastSeenAt) : "Never" },
      { key: "key", header: "Key", align: "right", render: (row) => linkCell(`#client-${row.id}`, "Open key") },
    ]}
    rows={clients.data?.clients ?? []}
    getKey={(row) => row.id}
    onRowClick={(row) => setSelected(row.id)}
    onLink={(target) => { if (target.startsWith("#client-")) setSelected(target.slice("#client-".length)); }}
    empty="No client keys yet."
  />{client && panel && <PropertyPanel kind="Client" item={{ name: client.name }} status="Active" actions={panel.actions} facts={panel.facts} primaryActions={panel.primaryActions} tabs={{ overview: panel.overview }} open onClose={() => setSelected(null)} />}</div></div></Frame>;
}
