// MaiPai Stack fixed footer: a quiet operational summary. Spec: "Fixed
// footer", "Footer summary reference".
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useApiResource } from "@/lib/useApiResource";
import { useStackCounts } from "@/hooks/use-stack-counts";

interface HealthzResponse { ok: true; version: string; uptimeSeconds: number }
interface RunStateResponse { state: "running" | "pausing" | "paused" }

export function StackFooter() {
  const healthz = useApiResource<HealthzResponse>("/healthz");
  const runState = useApiResource<RunStateResponse>("/stack/v1/run-state");
  const counts = useStackCounts();
  const refetchRunState = runState.refetch;

  // Self-contained: refetch on the same "run.state" event the rest of the
  // shell reacts to, so pausing from the search commands updates this text
  // without waiting on a page navigation to remount the footer.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const stream = new EventSource("/stack/v1/events");
    stream.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as { id?: string };
        if (envelope.id === "run.state") void refetchRunState();
      } catch { /* An invalid event cannot take down the footer. */ }
    };
    return () => stream.close();
  }, [refetchRunState]);

  const paused = runState.data?.state === "paused" || runState.data?.state === "pausing";
  const dotClass = paused ? "bg-muted-foreground" : counts.health.severity === "critical" || counts.health.severity === "error" ? "bg-[var(--hue-red)]" : counts.health.severity === "warning" ? "bg-[var(--hue-orange)]" : "bg-[var(--hue-teal)]";
  const statusText = paused ? "Paused by you" : counts.health.text;

  return (
    <footer className="flex h-10 shrink-0 items-center border-t bg-[var(--surface-sidebar)] px-3 text-xs text-muted-foreground sm:px-4 lg:px-6">
      <div className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3">
        <span className="truncate">MaiPai Stack v{healthz.data?.version ?? "…"}</span>
        <div className="hidden min-w-0 items-center justify-center gap-3 sm:flex">
          <Link to="/settings/updates" className="hover:text-foreground">{counts.updatesAvailable} update{counts.updatesAvailable === 1 ? "" : "s"} available</Link>
          <span aria-hidden="true">·</span>
          {/* Plain text, not a Link: /packages doesn't exist until UI-14 builds it. */}
          <span className="hidden md:inline">{counts.componentsInstalled} components installed</span>
          <span aria-hidden="true" className="hidden md:inline">·</span>
          <Link to="/monitoring" className="hover:text-foreground">{counts.componentsRunning} running</Link>
        </div>
        <div className="flex items-center justify-self-end gap-1.5">
          <span className={`size-2 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
          <span className="truncate">{statusText}</span>
        </div>
      </div>
    </footer>
  );
}
