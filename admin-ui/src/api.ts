// The admin page's one door to the Stack: same-origin fetch with the session
// cookie, every write carrying `x-stack-admin: 1` (the CSRF rule in the
// Stack's lib/adminGuard.ts; the browser adds the matching Origin itself).
// Only existing /stack/v1/* routes are called (docs/api/openapi.json).

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryAfter?: number) {
    super(message);
  }
}

export interface Role {
  id: string;
  label: string;
  enabled?: boolean;
  priority?: number;
  state: { state: "notInstalled" | "installed" | "loaded" | "ready" | "offline"; since: string; reason?: string | null };
  reason?: string | null;
  plain_reason?: string | null;
  model?: { id: string; sizeBytes: number | null; measuredFootprintBytes: number | null } | null;
}
export interface Problem { code: string; part_id: string | null; plain: string; fix: string; since: string }
export interface Status {
  health: "ok" | "degraded" | "down" | "updating";
  busy: { running: number; waiting: number };
  memory: { total_bytes: number; free_bytes: number; budget_bytes: number; pressure: "normal" | "warn" | "critical" };
  problems: Problem[];
}
export interface HealthItem {
  code: string; severity: "critical" | "error" | "warning"; title: string; text: string; since: string; cause: string;
  fix?: { label: string; action: string };
}
export interface Engine {
  id: string; name: string; label: string; installed: boolean; matchesThisMachine: boolean; running: string | null;
  currentTag: string | null; newestTag: string | null; needsRestart: boolean; state: "current" | "notCurrent";
  roleState: string; roleReason: string | null; update: { newest: string; since: string } | null;
}
export interface Healthz { ok: true; version: string; contract: number; uptimeSeconds: number }

import type { History, Range, Summary } from "./resourceData";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const write = method !== "GET";
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(write ? { "content-type": "application/json", "x-stack-admin": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!response.ok) {
    const fail = (data ?? {}) as { error?: string; code?: string; retry_after?: number };
    throw new ApiError(fail.error ?? `The Stack answered ${response.status}. Try again, and check the log if it keeps happening.`, response.status, fail.code ?? "http_error", fail.retry_after);
  }
  return data as T;
}

export const api = {
  session: () => call<{ signed_in: true; expires_at: string }>("GET", "/stack/v1/admin/session"),
  setup: (code: string, password: string) => call<{ ok: true }>("POST", "/stack/v1/admin/setup", { code, password }),
  login: (password: string) => call<{ ok: true }>("POST", "/stack/v1/admin/login", { password }),
  logout: () => call<{ ok: true }>("POST", "/stack/v1/admin/logout"),
  healthz: () => call<Healthz>("GET", "/healthz"),
  status: () => call<Status>("GET", "/stack/v1/status"),
  roles: () => call<{ roles: Role[] }>("GET", "/stack/v1/roles"),
  health: () => call<{ health: HealthItem[] }>("GET", "/stack/v1/health"),
  fix: (code: string) => call<{ ok: boolean; result: string }>("POST", `/stack/v1/health/${encodeURIComponent(code)}/fix`),
  engines: () => call<{ engines: Engine[] }>("GET", "/stack/v1/engines"),
  restartEngine: (name: string) => call<{ ok: boolean; reason?: string }>("POST", `/stack/v1/engines/${encodeURIComponent(name)}/restart`),
  logs: (tail = 200) => call<{ lines: string[] }>("GET", `/stack/v1/logs?tail=${tail}`),
  resourcesSummary: () => call<Summary>("GET", "/stack/v1/resources/summary"),
  resourcesHistory: (range: Range) => call<History>("GET", `/stack/v1/resources/history?range=${range}`),
  restartStack: () => call<{ ok: true }>("POST", "/stack/v1/service/restart"),
};
