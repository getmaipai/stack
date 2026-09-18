import { useEffect, useState } from "react";
import { cn } from "@/kit/utils";
import { formatRelative } from "@/lib/relativeTime";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

export function RelativeTime({ at, className }: { at: string; className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const absolute = new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time className={cn("cursor-default", className)} dateTime={at}>{formatRelative(at, now)}</time>
        </TooltipTrigger>
        <TooltipContent>{absolute}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
