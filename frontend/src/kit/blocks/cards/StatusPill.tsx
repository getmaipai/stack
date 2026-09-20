import { cn } from "@/kit/utils";
import { statusDotClass, statusFor, type StatusKind } from "@/lib/status";

// Never rely on hue alone (spec section 4): the label is always present
// text, the dot is decoration.
export function StatusPill({ status, className }: { status: StatusKind; className?: string }) {
  const entry = statusFor(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium", className)}>
      {entry.dot && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(status))} />}
      {entry.label}
    </span>
  );
}
