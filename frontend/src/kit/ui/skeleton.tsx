// Copied from home's kit until KIT-01 extracts `@maipai/ui`; do not edit here.
import { cn } from "@/kit/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
