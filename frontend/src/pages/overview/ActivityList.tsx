import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";
import { RelativeTime } from "@/kit/ui/relative-time";
import type { ActivityItem } from "./types";

export function ActivityList({ items, title = "Recent activity" }: { items: ActivityItem[]; title?: string }) {
  return <Card data-widget><CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="divide-y p-0">{items.length ? items.map((item) => <div className="px-5 py-3" key={item.id}><div className="text-sm font-medium">{item.primary}</div><div className="mt-1 text-xs text-muted-foreground">{item.at ? <RelativeTime at={item.at} /> : item.meta}</div></div>) : <div className="px-5 py-4 text-sm text-muted-foreground">No notifications yet.</div>}<div className="border-t px-5 py-3"><Link className="text-sm text-primary hover:underline" to="/alerts">Show more</Link></div></CardContent></Card>;
}
