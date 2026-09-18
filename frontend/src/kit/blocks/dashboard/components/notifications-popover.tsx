// Reskinned for MaiPai Stack: the header notification bell and its popover.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getIcon } from "@/kit/icons";
import { api, type NotificationRecord } from "@/lib/api";
import { useApiResource } from "@/lib/useApiResource";
import { Badge } from "@/kit/ui/badge";
import { Button } from "@/kit/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/kit/ui/popover";

const Bell = getIcon("Bell");

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function NotificationsBell() {
  const notifications = useApiResource<{ notifications: NotificationRecord[] }>("/stack/v1/notifications");
  const [open, setOpen] = useState(false);
  const rows = notifications.data?.notifications ?? [];
  const unreadCount = rows.filter((item) => item.readAt === null).length;
  const openRows = open ? rows.slice(0, 10) : [];
  const pending = openRows.filter((item) => item.readAt === null).map((item) => item.id);

  useEffect(() => {
    if (!open || pending.length === 0) return;
    let cancelled = false;
    async function markVisible() {
      for (const id of pending) await api.post(`/stack/v1/notifications/${id}/read`);
      if (!cancelled) await notifications.refetch();
    }
    void markVisible();
    return () => { cancelled = true; };
  }, [open, pending, notifications]);

  async function dismissItem(id: string) {
    await api.post(`/stack/v1/notifications/${id}/dismiss`);
    await notifications.refetch();
  }

  async function markAllRead() {
    for (const item of rows.filter((row) => row.readAt === null)) await api.post(`/stack/v1/notifications/${item.id}/read`);
    await notifications.refetch();
  }

  async function clearAll() {
    await api.post("/stack/v1/notifications/clear");
    await notifications.refetch();
  }

  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild data-notifications-trigger aria-label="Notifications">
      <Button variant="ghost" size="icon-sm" className="relative"><Bell className="size-4" />{unreadCount > 0 && <Badge className="absolute -right-1.5 -top-1.5 size-4 min-w-4 rounded-full px-1 py-0 text-[10px]">{unreadCount}</Badge>}</Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 p-0">
      <div className="divide-y">
        {openRows.map((item) => <div className="flex items-start gap-2 p-4" key={item.id}><div className="min-w-0 flex-1"><p className={item.readAt === null ? "text-sm font-medium" : "text-sm text-muted-foreground"}>{item.title}</p><p className="mt-0.5 text-xs text-muted-foreground">{relativeTime(item.at)}</p></div><Button aria-label={`Dismiss ${item.title}`} size="icon-xs" variant="ghost" onClick={() => void dismissItem(item.id)}>x</Button></div>)}
        {openRows.length === 0 && <p className="p-6 text-sm text-muted-foreground">Nothing to show. The Stack will tell you here when something needs you.</p>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t p-3">
        <Button size="sm" variant="ghost" disabled={unreadCount === 0} onClick={() => void markAllRead()}>Mark all read</Button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={rows.length === 0} onClick={() => void clearAll()}>Clear all</Button>
          <Button size="sm" variant="link" asChild><Link to="/alerts">See all</Link></Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>;
}
