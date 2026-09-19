import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { currentEngine } from "@/updates/engines";
import { getModelUsage } from "@/lib/modelGroups";
import { listModels, removeModel } from "@/lib/modelStore";
import { manifestReferenceCount } from "@/lib/store/blobs";
import { removeEngine } from "@/lib/engineInstall";
import { dataDir } from "@/lib/paths";
import { stackSettingValues } from "@/settings/stackKeys";

const DAY = 86_400_000;

export type HygieneKind = "unused-model" | "duplicate-file" | "orphan-blob" | "old-engine-build" | "stale-log";
export interface HygieneItem { id: string; kind: HygieneKind; what: string; why: string; sizeBytes: number; }
export interface HygieneReport { items: HygieneItem[]; reclaimableBytes: number; generatedAt: string; }
export interface DownloadHistoryEntry { at: string; completedBytes: number; }
export interface DiskWarningInput { freeDiskBytes: number; downloads: DownloadHistoryEntry[]; now?: number; }

interface FileEntry { path: string; size: number; digest: string; }
export interface ModelInput { id: string; modelPath: string | null; sizeBytes: number | null; lastUsedAt: string | null; }
export interface HygieneOptions { root?: string; now?: number; models?: ModelInput[]; retentionDays?: number; }

function filesUnder(root: string): Array<{ path: string; size: number }> {
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; size: number }> = [];
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(child);
      else if (entry.isFile()) { try { files.push({ path: child, size: statSync(child).size }); } catch { /* A concurrent cleanup is retried next time. */ } }
    }
  };
  walk(root);
  return files;
}

function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function idFor(kind: HygieneKind, value: string): string { return `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`; }

function modelInputs(): ModelInput[] {
  return listModels().map((model) => ({ ...model, lastUsedAt: getModelUsage(model.id).lastUsedAt }));
}

export function storageHygiene(options: HygieneOptions = {}): HygieneReport {
  const root = options.root ?? dataDir; const now = options.now ?? Date.now(); const items: HygieneItem[] = [];
  const models = options.models ?? modelInputs();
  for (const model of models) {
    if (!model.modelPath || !existsSync(model.modelPath) || !model.lastUsedAt || now - new Date(model.lastUsedAt).getTime() < 30 * DAY) continue;
    const size = statSync(model.modelPath).size;
    items.push({ id: `unused-model:${model.id}`, kind: "unused-model", what: model.id, why: "Unused for 30 days", sizeBytes: size });
  }
  const seen = new Map<string, FileEntry>();
  for (const file of filesUnder(join(root, "models"))) {
    if (file.path.includes(`${join(root, "models", "manifests")}/`)) continue;
    const key = digest(file.path); const first = seen.get(key);
    if (first) items.push({ id: idFor("duplicate-file", file.path), kind: "duplicate-file", what: file.path, why: `Same bytes as ${first.path}`, sizeBytes: file.size });
    else seen.set(key, { ...file, digest: key });
  }
  const blobRoot = join(root, "store", "blobs");
  for (const file of filesUnder(blobRoot)) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    if (manifestReferenceCount(name) === 0) items.push({ id: idFor("orphan-blob", file.path), kind: "orphan-blob", what: file.path, why: "No model manifest references this blob", sizeBytes: file.size });
  }
  const engines = join(root, "engines");
  if (existsSync(engines)) for (const engine of readdirSync(engines, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const current = root === dataDir ? currentEngine(engine.name) : null;
    const builds = readdirSync(join(engines, engine.name), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    const kept = new Set([current, ...builds.slice(0, 1)].filter((value): value is string => Boolean(value)));
    for (const build of builds) if (!kept.has(build)) {
      const path = join(engines, engine.name, build); const size = filesUnder(path).reduce((sum, file) => sum + file.size, 0);
      if (size > 0) items.push({ id: `old-engine-build:${engine.name}:${build}`, kind: "old-engine-build", what: `${engine.name} ${build}`, why: "Current build and one previous build are kept", sizeBytes: size });
    }
  }
  const retentionDays = options.retentionDays ?? Number(stackSettingValues().historyRetention ?? 30);
  for (const file of filesUnder(join(root, "logs"))) if (now - statSync(file.path).mtimeMs >= retentionDays * DAY) items.push({ id: idFor("stale-log", file.path), kind: "stale-log", what: file.path, why: `Older than ${retentionDays} days`, sizeBytes: file.size });
  return { items, reclaimableBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0), generatedAt: new Date(now).toISOString() };
}

export function cleanStorageHygiene(ids: string[], options: HygieneOptions = {}): HygieneItem[] {
  const report = storageHygiene(options); const wanted = new Set(ids); const unknown = ids.find((id) => !report.items.some((item) => item.id === id));
  if (unknown) throw new Error(`Cleanup item is not in the current report: ${unknown}`);
  const removed: HygieneItem[] = [];
  for (const item of report.items) if (wanted.has(item.id)) {
    if (item.kind === "unused-model") {
      const model = (options.models ?? modelInputs()).find((candidate) => candidate.id === item.what);
      if (model?.modelPath) rmSync(model.modelPath, { force: true });
      if (!options.models) removeModel(item.what);
    }
    else if (item.kind === "old-engine-build") { const [name, tag] = item.what.split(" "); if (name && tag) removeEngine(name, tag); }
    else rmSync(item.what, { force: true });
    removed.push(item);
  }
  return removed;
}

export function diskFillsSoon({ freeDiskBytes, downloads, now = Date.now() }: DiskWarningInput): boolean {
  const recent = downloads.filter((entry) => now - new Date(entry.at).getTime() <= 7 * DAY).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (recent.length < 2) return false;
  const first = recent[0]!; const last = recent.at(-1)!; const elapsed = new Date(last.at).getTime() - new Date(first.at).getTime();
  if (elapsed <= 0 || last.completedBytes <= first.completedBytes) return false;
  return freeDiskBytes / ((last.completedBytes - first.completedBytes) / elapsed) <= 3 * DAY;
}

function historyPath(root: string): string { return join(root, "logs", "download-history.jsonl"); }
export function downloadHistory(root = dataDir): DownloadHistoryEntry[] {
  try { return readFileSync(historyPath(root), "utf8").split("\n").flatMap((line) => { try { const item = JSON.parse(line) as DownloadHistoryEntry; return typeof item.at === "string" && typeof item.completedBytes === "number" ? [item] : []; } catch { return []; } }); } catch { return []; }
}
export function recordDownloadHistory(completedBytes: number, root = dataDir, at = new Date().toISOString()): void {
  mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
  appendFileSync(historyPath(root), `${JSON.stringify({ at, completedBytes })}\n`, { mode: 0o600 });
}
