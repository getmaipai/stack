import { Button } from "@/kit/ui/button";

// One sentence, one action (spec section "State"): no illustration, no
// second line of hedging.
export function Empty({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      {actionLabel && onAction && <Button type="button" variant="outline" onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}
