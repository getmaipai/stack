import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";

export function ClientsList({ clients }: { clients: Array<{ id: string; name?: string; requests?: number; lastSeenAt?: string; revokedAt?: string | null }> }) {
  return <Card data-widget><CardHeader className="pb-3"><CardTitle className="text-base">Clients</CardTitle></CardHeader><CardContent className="divide-y p-0">{clients.length ? clients.slice(0, 5).map((client) => <Link className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/40" to={`/access?client=${encodeURIComponent(client.id)}`} key={client.id}><span className="min-w-0 truncate text-sm font-medium">{client.name ?? client.id}</span><span className="shrink-0 text-xs text-muted-foreground">{client.requests ?? 0} requests</span></Link>) : <div className="px-5 py-4 text-sm text-muted-foreground">No clients yet.</div>}</CardContent></Card>;
}
