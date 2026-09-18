import { useMemo } from "react";
import type { NotificationRecord, RepairRecord } from "@/lib/api";
import { api } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { ThingsTable, type ThingStatus } from "@/kit/blocks/things-table/ThingsTable";
import type { SectionFrameComponent } from "@/pages/DashboardShell";

type AlertRow = { kind: "notification"; notification: NotificationRecord } | { kind: "repair"; repair: RepairRecord };

function alertStatus(row: AlertRow): ThingStatus { return row.kind === "repair" || row.notification.level === "immediate" ? "attention" : "ready"; }

export function AlertsPage({ Frame }: { Frame: SectionFrameComponent }) {
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const repairs = useApiResource<{ repairs: RepairRecord[] }>("/stack/v1/repairs");
  async function clear() { await api.post("/stack/v1/notifications/clear"); await notifications.refetch(); }
  const rows = useMemo<AlertRow[]>(() => [...(notifications.data?.notifications.slice(0, 5) ?? []).map((notification) => ({ kind: "notification" as const, notification })), ...(repairs.data?.repairs.filter((item) => !item.resolvedAt) ?? []).map((repair) => ({ kind: "repair" as const, repair }))], [notifications.data?.notifications, repairs.data?.repairs]);
  return <Frame title="Alerts" description="Notifications and one-action repairs from the Stack."><ThingsTable<AlertRow>
    columns={[
      { key: "alert", header: "Alert", width: "38%", render: (row) => row.kind === "notification" ? <div><p className="font-medium">{row.notification.title}</p><p className="text-xs text-muted-foreground">Notification</p></div> : <div><p className="font-medium">{row.repair.title}</p><p className="text-xs text-muted-foreground">Repair</p></div> },
      { key: "detail", header: "Detail", render: (row) => row.kind === "notification" ? new Date(row.notification.at).toLocaleString() : row.repair.detail },
      { key: "action", header: "Action", align: "right", render: (row) => row.kind === "notification" ? "Review" : row.repair.action },
    ]}
    rows={rows}
    getKey={(row) => row.kind === "notification" ? `notification:${row.notification.id}` : `repair:${row.repair.id}`}
    getStatus={alertStatus}
    actions={[{ label: "Clear notifications", onClick: () => void clear(), disabled: !(notifications.data?.notifications.length) }]}
    empty="No notifications or repairs need your attention."
  /></Frame>;
}
