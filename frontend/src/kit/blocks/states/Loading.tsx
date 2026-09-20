import { Skeleton } from "@/kit/ui/skeleton";
import { cn } from "@/kit/utils";

// Skeletons matching the final card geometry (spec section 4): a row
// height, not a generic spinner, so the layout doesn't jump on load.
export function Loading({ rows = 3, rowHeight = "h-12", className }: { rows?: number; rowHeight?: string; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className={cn("w-full", rowHeight)} />)}
    </div>
  );
}
