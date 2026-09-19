import { useMemo, useState } from "react";
import type { ChannelRecord, NotificationRecord } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ThingsTable, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import { PropertyPanel } from "@/kit/blocks/property-panel/PropertyPanel";
import { channelPanel } from "@/panels/channel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/kit/ui/card";
import { GenericForm } from "@/kit/settings/GenericForm";
import type { SectionFrameComponent } from "@/pages/DashboardShell";
import { RelativeTime } from "@/kit/ui/relative-time";

type AlertRow = { kind: "notification"; notification: NotificationRecord };
function alertStatus(row: AlertRow): ThingStatus { return row.notification.level === "immediate" ? "attention" : "ready"; }
function channelStatus(row: ChannelRecord): ThingStatus { return row.status === "verified" ? "ready" : row.status === "failing" ? "offline" : "attention"; }

export function AlertsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const channels = useApiResource<{ channels: ChannelRecord[] }>("/stack/v1/channels");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  async function clear() { await api.post("/stack/v1/notifications/clear"); await notifications.refetch(); }
  async function sendTest(id: string) { await api.post(`/stack/v1/channels/${id}/test`); await channels.refetch(); }
  const rows = useMemo<AlertRow[]>(() => (notifications.data?.notifications ?? []).map((notification) => ({ kind: "notification" as const, notification })), [notifications.data?.notifications]);
  const selected = channels.data?.channels.find((row) => row.id === selectedChannel);
  const selectedPanel = selected ? channelPanel(selected.type, selected.status, (action) => { if (action === "test") void sendTest(selected.id); }) : null;
  return <Frame title="Alerts" description="Notifications and the ways this Stack can reach you.">
    <div className="space-y-10">
      <ThingsTable<AlertRow> columns={[{ key: "alert", header: "Alert", width: "60%", render: (row) => <div><p className="font-medium">{row.notification.title}</p><p className="text-xs text-muted-foreground">Notification</p></div> }, { key: "detail", header: "When", align: "right", render: (row) => <RelativeTime at={row.notification.at} /> }]} rows={rows} getKey={(row) => `notification:${row.notification.id}`} getStatus={alertStatus} actions={[{ label: "Clear notifications", onClick: () => void clear(), disabled: !(notifications.data?.notifications.length) }]} empty="No notifications yet." />
      <Card>
        <CardHeader><CardTitle>Alert channels</CardTitle><CardDescription>Verified channels receive urgent notifications and serious health changes.</CardDescription></CardHeader>
        <CardContent><ThingsTable<ChannelRecord> columns={[{ key: "channel", header: "Channel", width: "37%", render: (row) => <div><p className="font-medium">{row.name}</p><p className="text-xs text-muted-foreground">{row.type === "telegram" ? "Telegram" : `ntfy${row.topic ? ` · ${row.topic}` : ""}`}</p></div> }, { key: "status", header: "Status", width: "30%", render: (row) => row.status === "verified" ? "Verified" : row.status === "failing" ? row.lastError ?? "Failing" : "Unverified" }, { key: "last", header: "Last sent", width: "29%", align: "right", render: (row) => row.lastSentAt ? <RelativeTime at={row.lastSentAt} /> : "Never" }]} rows={channels.data?.channels ?? []} getKey={(row) => row.id} getStatus={channelStatus} selectedKey={selectedChannel ?? undefined} onRowClick={(row) => setSelectedChannel(row.id)} rowActions={(row) => channelPanel(row.type, row.status, (action) => { if (action === "test") void sendTest(row.id); }).actions} actions={[{ label: "Add channel", onClick: () => undefined }]} empty="No alert channels configured." /></CardContent>
      </Card>
      {selected && selectedPanel && <PropertyPanel kind="Alert channel" item={{ id: selected.id, name: selected.name }} status={selected.status === "verified" ? "Verified" : selected.status === "failing" ? "Failing" : "Unverified"} actions={selectedPanel.actions} primaryActions={selectedPanel.primaryActions} facts={selectedPanel.facts} tabs={{ overview: selectedPanel.overview, settings: <GenericForm settings={selectedPanel.settings} values={{}} onChange={() => undefined} /> }} open={true} onClose={() => setSelectedChannel(null)} />}
    </div>
  </Frame>;
}
