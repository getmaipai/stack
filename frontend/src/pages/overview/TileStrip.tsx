import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/kit/ui/card";

export type Tile = { id: string; name: string; value?: string; href: string; title?: string };

export function TileStrip({ title, tiles, empty }: { title: string; tiles: Tile[]; empty: string }) {
  return <Card data-widget><CardHeader className="pb-3"><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="flex gap-3 overflow-x-auto">{tiles.length ? tiles.map((tile) => <Link className="flex size-24 shrink-0 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-2 text-center hover:border-primary/60" key={tile.id} title={tile.title} to={tile.href}><span aria-hidden="true" className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold text-primary">{tile.name.slice(0, 1).toUpperCase()}</span><span className="line-clamp-2 text-xs font-medium">{tile.name}</span>{tile.value && <span className="text-[10px] text-muted-foreground">{tile.value}</span>}</Link>) : <div className="py-2 text-sm text-muted-foreground">{empty}</div>}</CardContent></Card>;
}
