import { useMemo, useState } from "react";
import type { ChannelRecord, NotificationRecord, RepairRecord } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ThingsTable, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { channelPanel } from "@/panels/channel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { GenericForm } from "@/kit/settings/GenericForm";
import type { SectionFrameComponent } from "@/pages/DashboardShell";

type AlertRow = { kind: "notification"; notification: NotificationRecord } | { kind: "repair"; repair: RepairRecord };
function alertStatus(row: AlertRow): ThingStatus { return row.kind === "repair" || row.notification.level === "immediate" ? "attention" : "ready"; }
function channelStatus(row: ChannelRecord): ThingStatus { return row.status === "verified" ? "ready" : row.status === "failing" ? "offline" : "attention"; }

export function AlertsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  const channels = useApiResource<{ channels: ChannelRecord[] }>("/stack/v1/channels");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  async function clear() { await api.post("/stack/v1/notifications/clear"); await notifications.refetch(); }
  async function sendTest(id: string) { await api.post(`/stack/v1/channels/${id}/test`); await channels.refetch(); }
  const rows = useMemo<AlertRow[]>(() => [...(notifications.data?.notifications.slice(0, 5) ?? []).map((notification) => ({ kind: "notification" as const, notification })), ...(repairs.data?.repairs.filter((item) => !item.resolvedAt) ?? []).map((repair) => ({ kind: "repair" as const, repair }))], [notifications.data?.notifications, repairs.data?.repairs]);
  const selected = channels.data?.channels.find((row) => row.id === selectedChannel);
  const selectedPanel = selected ? channelPanel(selected.type, selected.status, (action) => { if (action === "test") void sendTest(selected.id); }) : null;
  return <Frame title="Alerts" description="Notifications, repairs, and the ways this Home can reach you.">
    <div className="space-y-10">
      <ThingsTable<AlertRow> columns={[{ key: "alert", header: "Alert", width: "38%", render: (row) => row.kind === "notification" ? <div><p className="font-medium">{row.notification.title}</p><p className="text-xs text-muted-foreground">Notification</p></div> : <div><p className="font-medium">{row.repair.title}</p><p className="text-xs text-muted-foreground">Repair</p></div> }, { key: "detail", header: "Detail", render: (row) => row.kind === "notification" ? new Date(row.notification.at).toLocaleString() : row.repair.detail }, { key: "action", header: "Action", align: "right", render: (row) => row.kind === "notification" ? "Review" : row.repair.action }]} rows={rows} getKey={(row) => row.kind === "notification" ? `notification:${row.notification.id}` : `repair:${row.repair.id}`} getStatus={alertStatus} actions={[{ label: "Clear notifications", onClick: () => void clear(), disabled: !(notifications.data?.notifications.length) }]} empty="No notifications or repairs need your attention." />
      <Card>
        <CardHeader><CardTitle>Alert channels</CardTitle><CardDescription>Verified channels receive urgent notifications and serious health changes.</CardDescription></CardHeader>
        <CardContent><ThingsTable<ChannelRecord> columns={[{ key: "channel", header: "Channel", width: "38%", render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.type === "telegram" ? "Telegram" : `ntfy${row.topic ? ` · ${row.topic}` : ""}`}</p></div> }, { key: "status", header: "Status", render: (row) => row.status === "verified" ? "Verified" : row.status === "failing" ? row.lastError ?? "Failing" : "Unverified" }, { key: "last", header: "Last sent", align: "right", render: (row) => row.lastSentAt ? new Date(row.lastSentAt).toLocaleString() : "Never" }]} rows={channels.data?.channels ?? []} getKey={(row) => row.id} getStatus={channelStatus} selectedKey={selectedChannel ?? undefined} onRowClick={(row) => setSelectedChannel(row.id)} actions={[{ label: "Add channel", onClick: () => undefined }]} empty="No alert channels configured." /></CardContent>
      </Card>
      {selected && selectedPanel && <PropertyPanel kind="Alert channel" item={{ id: selected.id, name: selected.name }} status={selected.status === "verified" ? "Verified" : selected.status === "failing" ? "Failing" : "Unverified"} actions={selectedPanel.actions} primaryActions={selectedPanel.primaryActions} facts={selectedPanel.facts} tabs={{ overview: selectedPanel.overview, settings: <GenericForm settings={selectedPanel.settings} values={{}} onChange={() => undefined} /> }} open={true} onClose={() => setSelectedChannel(null)} />}
    </div>
  </Frame>;
}
