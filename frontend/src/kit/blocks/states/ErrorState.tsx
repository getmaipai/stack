import { Button } from "@/kit/ui/button";

// A recovery action, always (spec section "State"): an error never dead-ends.
export function ErrorState({ message, actionLabel = "Retry", onRetry }: { message: string; actionLabel?: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-center" role="alert">
      <p className="text-sm text-destructive">{message}</p>
      <Button type="button" variant="outline" onClick={onRetry}>{actionLabel}</Button>
    </div>
  );
}
