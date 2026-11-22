// Live data: fetch on mount, refetch when the event feed says something
// changed (and every 20 s as a safety net), and report whether the feed is up.
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Engine, HealthItem, Healthz, Role, Status } from "./api";

/** The names the Stack's event feed sends; any of them is a reason to look again (shared with the models page's client, so both read one list). */
export const FEED_EVENTS = ["role.state", "engine.state", "pressure", "job.progress", "job.done", "model.installed", "update.available", "update.applied", "update.failed", "health.changed", "window"] as const;

export interface Snapshot {
  status: Status | null; roles: Role[] | null; health: HealthItem[] | null; engines: Engine[] | null; healthz: Healthz | null;
  error: string | null; loaded: boolean; live: boolean;
}
const EMPTY: Snapshot = { status: null, roles: null, health: null, engines: null, healthz: null, error: null, loaded: false, live: false };

export function useLive(onSignedOut: () => void): { snap: Snapshot; refresh: () => void } {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const out = useRef(onSignedOut);
  out.current = onSignedOut;

  const load = useCallback(async () => {
    try {
      const [status, roles, health, engines, healthz] = await Promise.all([api.status(), api.roles(), api.health(), api.engines(), api.healthz()]);
      setSnap((s) => ({ ...s, status, roles: roles.roles, health: health.health, engines: engines.engines, healthz, error: null, loaded: true }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { out.current(); return; }
      const message = error instanceof ApiError ? error.message : "The Stack did not answer. It may be restarting; this page keeps trying.";
      setSnap((s) => ({ ...s, error: message, loaded: true }));
    }
  }, []);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void load(); }, 250);
  }, [load]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { void load(); }, 20000);
    let source: EventSource | null = null;
    try {
      source = new EventSource("/stack/v1/events");
      // The server sends headers with its first frame (at most 15 s away), so the feed counts as live until it reports an error.
      setSnap((s) => ({ ...s, live: true }));
      source.onopen = () => setSnap((s) => ({ ...s, live: true }));
      source.onerror = () => setSnap((s) => ({ ...s, live: false }));
      source.onmessage = refresh;
      // The feed names its events; any of them is a reason to look again.
      for (const name of FEED_EVENTS) source.addEventListener(name, refresh);
    } catch { /* the poll still keeps the page fresh */ }
    return () => { clearInterval(poll); if (timer.current) clearTimeout(timer.current); source?.close(); };
  }, [load, refresh]);

  return { snap, refresh };
}
