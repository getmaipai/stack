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
export interface CachePlan { owned: { path: string; kind: "tmp_leftover" | "dangling_link"; bytes: number; ageHours: number }[]; outside: { path: string; bytes: number; note: string }[]; tidy: { reclaimable_bytes: number } }

export type SettingValue = string | number | boolean | null;
export interface Setting {
  key: string; selector: "number" | "select" | "text" | "boolean"; label: string; help: string;
  range?: { min?: number; max?: number; options?: { value: string; label: string }[] } | null;
  default?: SettingValue; section: { id: string; collapsed?: boolean; order: number }; level: "basic" | "advanced" | "expert";
  secret?: boolean; needs_restart: boolean; in_effect: SettingValue; pending: SettingValue;
}
export interface SettingsDoc { sections: { id: string; label: string }[]; settings: Setting[] }

export type Tier = "p16" | "p32" | "p64" | "p128";
export type Mode = "matched" | "custom_recommended" | "custom";
export interface PlanRole {
  role: string; enabled: boolean; priority: number; state: "resident" | "on_demand" | "installed" | "shared" | "off" | "unavailable";
  model?: string; peak_bytes?: number; fit: "fits" | "queues" | "refused" | "n/a"; reason: string;
}
export interface Plan { tier: Tier; chat_model: string; budget: { total_bytes: number; resident_cap_bytes: number; resident_bytes: number; room_bytes: number; tight: boolean }; roles: PlanRole[]; notes: string[] }
export interface Recommendation {
  memory: { gb: number; source: string; bytes: number };
  matched: { tier: Tier; quality: string; reason: string } | null;
  custom_recommended: { plan: Plan; why: string[] };
  templates: { tier: Tier; label: string; min_gb: number; cleared: boolean; match: boolean; resident: string[]; on_demand: string[]; not_available: string[] }[];
  saved?: { mode: Mode; tier: string; memory_gb: number; at: string } | null;
  replan?: { needed: boolean; reason: string | null } | null;
}
export interface Applied { mode: Mode; tier: Tier; plan: Plan; installs: { model: string; job: string }[]; skipped: { model: string; reason: string }[] }

export interface UpdateEngine { name: string; installed: string; available: string; availableKnown: boolean; lastChecked: string; notes?: string }
export interface Updates {
  checksEnabled: boolean; engines: UpdateEngine[];
  models: { lastChecked: string; entries: { id: string; installed: string; available: string }[] };
}
export interface HelperStatus {
  installed: boolean; state: string; reason: string | null; keep_warm_minutes: number;
  model: { id: string; repo: string; revision: string; licence: string; approx_bytes: number; url: string; sha256: string; engine: string; role: string };
  tools: { name: string; kind: "read" | "write"; description: string }[];
}
export interface HelperMessage { role: "user" | "assistant"; content: string; at: string; tools?: string[] }
export interface HelperChange { label: string; from: string; to: string }
/** One change the Helper proposes. Confirm sends `action` and `params` back unchanged; the Stack runs the stored copy and refuses an edited one. */
export interface HelperProposal { id: string; action: string; params: Record<string, string | number | boolean>; summary: string; changes: HelperChange[]; note: string | null; at: string; expires_at: string }
export type HelperPending = HelperProposal;
export interface HelperReply { reply: string; pending: HelperProposal[]; tools: string[]; calls: { name: string; args: Record<string, unknown> }[]; dropped: number; wake_ms: number }

export interface CheckResult {
  at: string; ok: boolean; results: { role: string; ok: boolean; ms: number; reason?: string; skipped?: boolean }[];
  fitTogether?: { ok: boolean; reason?: string }; reason?: string;
}

import type { History, Range, Summary } from "./resourceData";

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  codingMode: () => call<import("./modeText").ModeView>("GET", "/stack/v1/coding/mode"),
  setCodingMode: (mode: "normal" | "coding") => call<{ accepted: true }>("POST", "/stack/v1/coding/mode", { mode }),
  codingSelfTest: () => call<{ accepted: true }>("POST", "/stack/v1/coding/mode/self-test", {}),
  roles: () => call<{ roles: Role[] }>("GET", "/stack/v1/roles"),
  health: () => call<{ health: HealthItem[] }>("GET", "/stack/v1/health"),
  fix: (code: string) => call<{ ok: boolean; result: string }>("POST", `/stack/v1/health/${encodeURIComponent(code)}/fix`),
  engines: () => call<{ engines: Engine[] }>("GET", "/stack/v1/engines"),
  restartEngine: (name: string) => call<{ ok: boolean; reason?: string }>("POST", `/stack/v1/engines/${encodeURIComponent(name)}/restart`),
  logs: (tail = 200) => call<{ lines: string[] }>("GET", `/stack/v1/logs?tail=${tail}`),
  engineLogs: (tail = 100) => call<{ roles: Array<{ role: string; lines: Array<{ seq: number; at: string; line: string }> }> }>("GET", `/stack/v1/engine-logs?tail=${tail}`),
  resourcesSummary: () => call<Summary>("GET", "/stack/v1/resources/summary"),
  resourcesHistory: (range: Range) => call<History>("GET", `/stack/v1/resources/history?range=${range}`),
  settings: () => call<SettingsDoc>("GET", "/stack/v1/settings"),
  putSettings: (values: Record<string, SettingValue>) => call<SettingsDoc>("PUT", "/stack/v1/settings", values),
  applySettings: () => call<SettingsDoc>("POST", "/stack/v1/settings/apply", {}),
  recommend: () => call<Recommendation>("POST", "/stack/v1/profiles/recommend", {}),
  applyProfile: (body: { mode: Mode; tier?: Tier; plan?: { roles: { role: string; enabled: boolean; priority: number }[] } }) => call<Applied>("POST", "/stack/v1/profiles/apply", body),
  updates: () => call<Updates>("GET", "/stack/v1/updates"),
  checkUpdates: () => call<Updates>("POST", "/stack/v1/updates/check", {}),
  applyEngine: (name: string) => call<{ applied: boolean; tag?: string; previous?: string }>("POST", `/stack/v1/updates/engines/${encodeURIComponent(name)}/apply`, {}),
  rollbackEngine: (name: string, tag: string) => call<{ ok: true; tag: string }>("POST", `/stack/v1/updates/engines/${encodeURIComponent(name)}/rollback`, { tag }),
  readiness: () => call<CheckResult>("POST", "/stack/v1/check", {}),
  latestReadiness: () => call<{ latest: (CheckResult & { stale?: boolean; staleReason?: string }) | null; running: { startedAt: string } | null }>("GET", "/stack/v1/check/latest"),
  helperStatus: () => call<HelperStatus>("GET", "/stack/v1/helper/status"),
  helperHistory: () => call<{ messages: HelperMessage[]; pending: HelperPending[] }>("GET", "/stack/v1/helper/history"),
  helperChat: (message: string) => call<HelperReply>("POST", "/stack/v1/helper/chat", { message }),
  helperClear: () => call<{ ok: true }>("DELETE", "/stack/v1/helper/history"),
  helperConfirm: (p: HelperProposal) => call<{ ok: true; summary: string; result: string }>("POST", `/stack/v1/helper/actions/${encodeURIComponent(p.id)}/confirm`, { action: p.action, params: p.params }),
  helperCancel: (id: string) => call<{ ok: true }>("POST", `/stack/v1/helper/actions/${encodeURIComponent(id)}/cancel`, {}),
  installHelperModel: (m: HelperStatus["model"]) => call<unknown>("POST", "/stack/v1/models", { id: m.id, role: m.role, repo: m.repo, url: m.url, sha256: m.sha256, approx_bytes: m.approx_bytes, licence: m.licence, revision: m.revision, engine: m.engine }),
  rebootHost: () => call<{ ok: true }>("POST", "/stack/v1/host/reboot", {}),
  restartStack: () => call<{ ok: true }>("POST", "/stack/v1/service/restart"),
  caches: () => call<CachePlan>("GET", "/stack/v1/storage/caches"),
  clearCache: (path: string) => call<{ freed_bytes: number; kept: string[]; problems: string[] }>("POST", "/stack/v1/storage/caches/clear", { path }),
};
