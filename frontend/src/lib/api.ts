export type OperatorState = { state: "setupRequired" | "signedOut" | "signedIn"; required: boolean };

export interface RoleRecord {
  id: string;
  wire: string;
  residency: string;
  description: string;
  state: "notInstalled" | "installed" | "loading" | "ready" | "busy" | "stopped" | "offline";
  reason: string | null;
  model?: { id: string; sizeBytes: number | null; measuredFootprintBytes: number | null; measuredContextLength: number | null; estimated: boolean } | null;
}

export interface HardwareInfo {
  computerName?: string;
  platform: string;
  arch: string;
  totalRamGb: number;
  cpuCount: number;
  isAppleSilicon: boolean;
  unifiedMemoryGb: number;
  cudaDevices: Array<{ index: number; name: string; vramBytes: number }>;
  freeDiskBytes: number;
  osVersion: string;
}

export interface ProfileTier {
  id: "p16" | "p32" | "p64" | "p128";
  label: string;
  minUnifiedGb: number;
  minVramGb: number;
  resident: string[];
  onDemand: string[];
  installedOnly: string[];
  notAvailable: string[];
  speedRange: { min: number; max: number };
}

export interface HardwareResponse {
  hardware: HardwareInfo;
  proposed: ProfileTier | null;
  tiers: ProfileTier[];
}

export interface SpeedResult {
  at: string;
  ability: string | null;
  modelId: string | null;
  engine: string | null;
  firstTokenMs: number | null;
  loadMs: number | null;
  measuredFootprintBytes: number | null;
  promptTps: number | null;
  tokensPerSecond: number | null;
  contextLength: number | null;
}

export interface BudgetResponse {
  capBytes: number;
  freeMemoryBytes: number;
  availablePercent: number;
  pressure: "normal" | "warn" | "critical";
  loaded: Array<{ id: string; kind: string; peakBytes: number; measured: boolean }>;
  queue: Array<{ id: string; position: number; kind: string }>;
}

export interface NotificationRecord {
  id: string;
  title: string;
  level: string;
  at: string;
  data: string;
  readAt: string | null;
  dismissedAt: string | null;
}

export interface ChannelRecord {
  id: string;
  type: "telegram" | "ntfy";
  name: string;
  serverUrl?: string;
  topic?: string;
  verifiedAt: string | null;
  createdAt: string;
  lastError: string | null;
  lastSentAt: string | null;
  status: "verified" | "unverified" | "failing";
  configPresent: true;
}

export interface RepairRecord {
  id: string;
  title: string;
  detail: string;
  action: string;
  level: string;
  resolvedAt: string | null;
}

export interface HealthItem {
  code: string;
  severity: "critical" | "error" | "warning";
  title: string;
  text: string;
  since: string;
  cause: string;
  fix?: { label: string; action: string };
  learnMore?: string;
}

export interface CheckResult {
  at: string;
  ok: boolean;
  results: Array<{ role: string; ok: boolean; ms: number; reason: string | null; loadMs: number | null; skipped?: boolean }>;
  fitTogether: { ok: boolean; reason: string | null };
  reason: string | null;
}

export type SetupTier = "p16" | "p32" | "p64" | "p128";
export type SetupMode = "small" | "full";
export type DownloadStatus = "queued" | "downloading" | "paused" | "installed" | "failed";

export interface SetupDownload {
  id: string;
  name: string;
  sizeBytes: number;
  completedBytes: number;
  speedBytesPerSecond: number;
  timeLeftSeconds: number | null;
  status: DownloadStatus;
  source: string;
  licence: string;
  reason?: string;
}

export interface SetupPlan {
  tier: SetupTier;
  mode: SetupMode;
  createdAt: string;
  health: string | null;
}

export interface SetupPlanResponse {
  plan: SetupPlan | null;
  downloads: SetupDownload[];
  health: string | null;
}

export interface EngineSetting {
  key: string;
  type: "number" | "boolean" | "text" | "secret" | "password" | "enum";
  default: string | number | boolean;
  group?: string;
  options?: Array<{ value: string; label: string }>;
  label: string;
  help: string;
  disclosure: "basic" | "advanced" | "developer";
  needsRestart: boolean;
  range?: { min?: number; max?: number };
  inEffect: string | number | boolean;
  pending: string | number | boolean | null;
}

export interface EngineRecord {
  id: string;
  label: string;
  platform: string;
  arch: string;
  verified: boolean;
  installed: boolean;
  matchesThisMachine: boolean;
  running: string | null;
  currentTag: string | null;
  newestTag: string | null;
  current: boolean;
  notCurrent: boolean;
  needsRestart: boolean;
  state: "current" | "notCurrent";
  stateReason: "newer installed" | "newer available" | "needs restart" | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : "The Stack returned HTTP " + response.status + ".";
    throw new ApiError(message, response.status, typeof body === "object" && body !== null ? body as Record<string, unknown> : {});
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
