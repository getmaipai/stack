import type { BudgetResponse, HardwareResponse, HealthItem, NotificationRecord, RoleRecord, SpeedResult } from "@/lib/api";

export type Range = "hour" | "day" | "week" | "month";
export type SeriesSample = SpeedResult & { requests?: number; tokensIn?: number; tokensOut?: number; freeBytes?: number; pressure?: string };
export type SeriesResponse = { range: string; usage: SeriesSample[]; memory: SeriesSample[]; speed: SeriesSample[] };
export type UpdatesResponse = { app: { installed: string; available: string | null }; engines: { installed: string; available: string | null }; models: { installed: string; available: string | null } };
export type StorageResponse = { freeDiskBytes: number; byCategory: Record<string, number> };
export type Counts = { engines: number; models: number; clients: number };
export type Status = { label: string; value?: number; href: string; tone: "default" | "secondary" | "destructive" | "outline" };
export type ActivityItem = { id: string; primary: string; meta: string };

export type FactsProps = {
  hardware?: HardwareResponse["hardware"];
  healthz?: { version: string; uptimeSeconds: number };
  budget?: BudgetResponse;
  updates?: UpdatesResponse;
  counts: Counts;
  onSpeedTest: () => void;
  speedTesting: boolean;
};

export type OverviewData = {
  roles: RoleRecord[];
  health: HealthItem[];
  notifications: NotificationRecord[];
};
