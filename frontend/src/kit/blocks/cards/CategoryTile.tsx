import { Link } from "react-router-dom";
import { getIcon, type IconName } from "@/kit/icons";

export interface CategoryTileProps {
  icon: IconName;
  hue: string;
  label: string;
  installedCount: number;
  browsePath: string;
}

// Installed Components tiles (spec section 3): category icon, name,
// installed count, Browse All.
export function CategoryTile({ icon, hue, label, installedCount, browsePath }: CategoryTileProps) {
  const Icon = getIcon(icon);
  return (
    <Link to={browsePath} className="flex min-w-[9rem] flex-col gap-2 rounded-xl border bg-[var(--surface-card)] p-3 hover:bg-[var(--surface-pane)]">
      <div className="flex size-9 items-center justify-center rounded-lg" style={{ backgroundColor: `color-mix(in srgb, var(${hue}) 16%, transparent)`, color: `var(${hue})` }}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{installedCount} installed</p>
      </div>
    </Link>
  );
}
