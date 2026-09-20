import { getIcon, type IconName } from "@/kit/icons";

export interface ActionTileProps {
  icon: IconName;
  label: string;
  subtitle: string;
  onClick: () => void;
}

// Quick Actions tiles (spec section 3): icon, direct-verb label, one
// supporting line.
export function ActionTile({ icon, label, subtitle, onClick }: ActionTileProps) {
  const Icon = getIcon(icon);
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-3 rounded-xl border bg-[var(--surface-card)] p-3 text-left hover:bg-[var(--surface-pane)]">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-pane)] text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
    </button>
  );
}
