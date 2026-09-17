export type OperatorState = "setupRequired" | "signedOut" | "signedIn";

export interface RoleRecord {
  id: string;
  wire: string;
  residency: string;
  description: string;
  state: "notInstalled" | "installed" | "loading" | "ready" | "busy" | "stopped" | "offline";
  reason: string | null;
}

export interface HardwareInfo {
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
}

export interface HardwareResponse {
  hardware: HardwareInfo;
  proposed: ProfileTier | null;
  tiers: ProfileTier[];
}

export interface BudgetResponse {
  capBytes: number;
  freeMemoryBytes: number;
  pressure: boolean;
  loaded: Array<{ id: string; kind: string; peakBytes: number; measured: boolean }>;
  queue: Array<{ id: string; position: number; kind: string }>;
}

export interface NotificationRecord {
  id: string;
  title: string;
  level: string;
  at: string;
  data: string;
}

export interface RepairRecord {
  id: string;
  title: string;
  detail: string;
  action: string;
  level: string;
  resolvedAt: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body
      ? String(body.error)
      : "The Stack returned HTTP " + response.status + ".";
    throw new Error(message);
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
};
