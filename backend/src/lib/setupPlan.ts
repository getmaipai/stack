import { eq } from "drizzle-orm";
import { db } from "@/db";
import { meta } from "@/db/schema";
import { emit } from "@/lib/events";
import { scriptedEnginesEnabled } from "@/lib/supervisor";

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

const PLAN_KEY = "setup.plan";
const DOWNLOADS_KEY = "setup.downloads";
const SCRIPTED_ITEMS: Array<Pick<SetupDownload, "id" | "name" | "sizeBytes" | "source" | "licence"> & { durationMs: number }> = [
  { id: "chat-model", name: "Chat model", sizeBytes: 700 * 1_000_000, source: "MaiPai Catalog", licence: "Apache-2.0", durationMs: 8_000 },
  { id: "voice-in-model", name: "Voice in model", sizeBytes: 80 * 1_000_000, source: "MaiPai Catalog", licence: "MIT", durationMs: 4_000 },
  { id: "voice-out-model", name: "Voice out model", sizeBytes: 150 * 1_000_000, source: "MaiPai Catalog", licence: "MIT", durationMs: 8_000 },
];

let timer: ReturnType<typeof setInterval> | null = null;
let itemStartedAt = 0;
let itemElapsedMs = 0;

function read<T>(key: string): T | null {
  const row = db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  db.insert(meta).values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(value) } })
    .run();
}

function downloads(): SetupDownload[] {
  return read<SetupDownload[]>(DOWNLOADS_KEY) ?? [];
}

function saveDownloads(items: SetupDownload[]): void {
  write(DOWNLOADS_KEY, items);
}

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
  itemStartedAt = 0;
  itemElapsedMs = 0;
}

function startNext(items: SetupDownload[]): void {
  const next = items.find((item) => item.status === "queued");
  if (!next) {
    stopTimer();
    return;
  }
  const definition = SCRIPTED_ITEMS.find((item) => item.id === next.id);
  next.status = "downloading";
  if (definition) {
    next.speedBytesPerSecond = Math.round(next.sizeBytes / (definition.durationMs / 1000));
    next.timeLeftSeconds = Math.ceil(definition.durationMs / 1000);
  }
  itemStartedAt = Date.now();
  itemElapsedMs = 0;
  saveDownloads(items);
}

function tick(): void {
  const items = downloads();
  const current = items.find((item) => item.status === "downloading");
  if (!current) {
    if (items.some((item) => item.status === "queued")) startNext(items);
    else stopTimer();
    return;
  }

  const definition = SCRIPTED_ITEMS.find((item) => item.id === current.id);
  if (!definition) return;
  const elapsed = Math.max(0, Date.now() - itemStartedAt);
  itemElapsedMs = Math.max(itemElapsedMs, elapsed);
  const fraction = Math.min(1, itemElapsedMs / definition.durationMs);
  current.completedBytes = Math.round(current.sizeBytes * fraction);
  current.speedBytesPerSecond = Math.round(current.sizeBytes / (definition.durationMs / 1000));
  current.timeLeftSeconds = Math.ceil(Math.max(0, definition.durationMs - itemElapsedMs) / 1000);
  emit({ id: "job.progress", data: { job: "setup-downloads", item: current.id, percent: Math.round(fraction * 100), completedBytes: current.completedBytes, totalBytes: current.sizeBytes } });

  if (fraction >= 1) {
    current.status = "installed";
    current.timeLeftSeconds = 0;
    emit({ id: "model.installed", data: { model: current.name, item: current.id } });
    saveDownloads(items);
    if (items.some((item) => item.status === "queued")) startNext(items);
    else stopTimer();
  } else {
    saveDownloads(items);
  }
}

export function getSetupPlan(): { plan: SetupPlan | null; downloads: SetupDownload[]; health: string | null } {
  const plan = read<SetupPlan>(PLAN_KEY);
  return { plan, downloads: downloads(), health: plan?.health ?? null };
}

export function chooseSetupPlan(tier: SetupTier, mode: SetupMode): { queued: true; plan: SetupPlan; downloads: SetupDownload[]; health: string | null } {
  stopTimer();
  const plan: SetupPlan = {
    tier,
    mode,
    createdAt: new Date().toISOString(),
    health: scriptedEnginesEnabled() ? null : "Downloads arrive with the store.",
  };
  const items: SetupDownload[] = scriptedEnginesEnabled()
    ? SCRIPTED_ITEMS.map(({ durationMs: _durationMs, ...item }) => ({ ...item, completedBytes: 0, speedBytesPerSecond: 0, timeLeftSeconds: null, status: "queued" as const }))
    : [];
  write(PLAN_KEY, plan);
  saveDownloads(items);
  if (items.length > 0) {
    startNext(items);
    timer = setInterval(tick, 250);
    (timer as unknown as { unref?: () => void }).unref?.();
  }
  return { queued: true, plan, downloads: items, health: plan.health };
}

export function pauseSetupDownload(id: string): SetupDownload | null {
  const items = downloads();
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.status !== "downloading") return item ?? null;
  itemElapsedMs += Math.max(0, Date.now() - itemStartedAt);
  item.status = "paused";
  item.speedBytesPerSecond = 0;
  saveDownloads(items);
  stopTimer();
  return item;
}

export function resumeSetupDownload(id: string): SetupDownload | null {
  const items = downloads();
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.status !== "paused") return item ?? null;
  const definition = SCRIPTED_ITEMS.find((candidate) => candidate.id === item.id);
  item.status = "downloading";
  itemStartedAt = Date.now();
  itemElapsedMs = definition && item.sizeBytes > 0 ? item.completedBytes / item.sizeBytes * definition.durationMs : 0;
  timer = setInterval(tick, 250);
  (timer as unknown as { unref?: () => void }).unref?.();
  saveDownloads(items);
  return item;
}

export function __resetSetupPlanForTests(): void {
  stopTimer();
  db.delete(meta).where(eq(meta.key, PLAN_KEY)).run();
  db.delete(meta).where(eq(meta.key, DOWNLOADS_KEY)).run();
}
