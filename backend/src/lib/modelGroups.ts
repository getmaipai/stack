import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { modelGroups, modelUsage, models } from "@/db/schema";
import { getModel, isModelSelectable, listModels, upsertModel, type ModelRecord } from "@/lib/modelStore";
import { admit, release, type GovernorHandle } from "@/lib/governor";
import { recordUsageSample } from "@/lib/series";

export type ModelRuntimeState = "loaded" | "ready" | "onDemand" | "failed";
export interface ModelUsageRecord { modelId: string; requests: number; tokensIn: number; tokensOut: number; secondsLoaded: number; peakMemoryBytes: number; lastUsedAt: string | null; }
export interface GroupStatus { loaded: number; ready: number; onDemand: number; failed: number; }
export interface GroupRollup { id: string; name: string; parentId: string | null; createdAt: string; modelCount: number; bytesOnDisk: number; memoryBytes: number; usage: { requests: number; tokens: number; secondsLoaded: number; peakMemoryBytes: number }; status: GroupStatus; worstHealth: string | null; }
export type ModelAction = "load" | "unload" | "pin" | "unpin" | "checkUpdates";

interface RuntimeModel { state: ModelRuntimeState; pinned: boolean; health: string | null; loadedAt: number | null; }
interface ActionResult { modelId: string; ok: boolean; reason?: string; }

const runtime = new Map<string, RuntimeModel>();
const handles = new Map<string, GovernorHandle>();
const severity: Record<string, number> = { warning: 1, error: 2, critical: 3 };

function now(): string { return new Date().toISOString(); }

function defaultUsage(modelId: string): ModelUsageRecord { return { modelId, requests: 0, tokensIn: 0, tokensOut: 0, secondsLoaded: 0, peakMemoryBytes: 0, lastUsedAt: null }; }

export function getModelUsage(modelId: string): ModelUsageRecord {
  const row = db.select().from(modelUsage).where(eq(modelUsage.modelId, modelId)).get();
  return row ? { ...row } : defaultUsage(modelId);
}

function ensureUsage(modelId: string): void {
  db.insert(modelUsage).values({ modelId }).onConflictDoNothing().run();
}

export function recordModelUsage(modelId: string, delta: { requests?: number; tokensIn?: number; tokensOut?: number; at?: string }): void {
  if (!getModel(modelId)) return;
  const requests = delta.requests ?? 0; const tokensIn = delta.tokensIn ?? 0; const tokensOut = delta.tokensOut ?? 0; const at = delta.at ?? now();
  ensureUsage(modelId);
  db.update(modelUsage).set({ requests: sql`${modelUsage.requests} + ${requests}`, tokensIn: sql`${modelUsage.tokensIn} + ${tokensIn}`, tokensOut: sql`${modelUsage.tokensOut} + ${tokensOut}`, lastUsedAt: at }).where(eq(modelUsage.modelId, modelId)).run();
  const model = getModel(modelId);
  recordUsageSample({ at, ability: model?.roles[0] ?? null, clientId: null, modelId, requests, tokensIn, tokensOut, jobs: 0 });
}

export function recordModelLoaded(modelId: string, at = Date.now()): void {
  ensureUsage(modelId);
  const current = runtime.get(modelId);
  runtime.set(modelId, { state: "loaded", pinned: current?.pinned ?? false, health: current?.health ?? null, loadedAt: at });
}

export function recordModelUnloaded(modelId: string, at = Date.now()): void {
  const current = runtime.get(modelId);
  if (!current) { runtime.set(modelId, { state: "ready", pinned: false, health: null, loadedAt: null }); return; }
  const seconds = current.loadedAt === null ? 0 : Math.max(0, Math.round((at - current.loadedAt) / 1000));
  if (seconds > 0) { ensureUsage(modelId); db.update(modelUsage).set({ secondsLoaded: sql`${modelUsage.secondsLoaded} + ${seconds}` }).where(eq(modelUsage.modelId, modelId)).run(); }
  runtime.set(modelId, { ...current, state: "ready", loadedAt: null });
}

export function recordModelFootprint(modelId: string, bytes: number): void {
  ensureUsage(modelId);
  db.update(modelUsage).set({ peakMemoryBytes: sql`MAX(${modelUsage.peakMemoryBytes}, ${bytes})` }).where(eq(modelUsage.modelId, modelId)).run();
}

export function setModelRuntimeForTests(modelId: string, state: ModelRuntimeState, health: string | null = null): void { runtime.set(modelId, { state, pinned: false, health, loadedAt: state === "loaded" ? Date.now() : null }); }

function stateFor(model: ModelRecord): RuntimeModel {
  return runtime.get(model.id) ?? { state: model.modelPath ? "ready" : "onDemand", pinned: false, health: null, loadedAt: null };
}

export function modelRuntimeState(model: ModelRecord): ModelRuntimeState { return stateFor(model).state; }

export function modelUsageView(modelId: string): ModelUsageRecord { return getModelUsage(modelId); }

function descendants(id: string, groups: Array<{ id: string; parentId: string | null }>): string[] {
  const result: string[] = [id];
  for (const child of groups.filter((group) => group.parentId === id)) result.push(...descendants(child.id, groups));
  return result;
}

function modelsInGroup(id: string): ModelRecord[] {
  const groups = db.select({ id: modelGroups.id, parentId: modelGroups.parentId }).from(modelGroups).all();
  const ids = descendants(id, groups);
  return listModels().filter((model) => model.groupId !== null && ids.includes(model.groupId));
}

function worstHealth(models: ModelRecord[]): string | null {
  return models.reduce<string | null>((worst, model) => {
    const health = stateFor(model).health;
    return health && (!worst || (severity[health] ?? 0) > (severity[worst] ?? 0)) ? health : worst;
  }, null);
}

export function listGroupRollups(): GroupRollup[] {
  const groups = db.select().from(modelGroups).all();
  return groups.map((group) => {
    const models = modelsInGroup(group.id);
    const usage = models.reduce((sum, model) => { const row = getModelUsage(model.id); sum.requests += row.requests; sum.tokens += row.tokensIn + row.tokensOut; sum.secondsLoaded += row.secondsLoaded; sum.peakMemoryBytes = Math.max(sum.peakMemoryBytes, row.peakMemoryBytes); return sum; }, { requests: 0, tokens: 0, secondsLoaded: 0, peakMemoryBytes: 0 });
    const status = models.reduce<GroupStatus>((sum, model) => { sum[stateFor(model).state]++; return sum; }, { loaded: 0, ready: 0, onDemand: 0, failed: 0 });
    return { id: group.id, name: group.name, parentId: group.parentId, createdAt: group.createdAt, modelCount: models.length, bytesOnDisk: models.reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0), memoryBytes: models.reduce((sum, model) => sum + (stateFor(model).state === "loaded" ? model.measuredFootprintBytes ?? 0 : 0), 0), usage, status, worstHealth: worstHealth(models) };
  });
}

export function createModelGroup(name: string, parentId: string | null = null, id = `group-${crypto.randomUUID()}`): GroupRollup {
  if (!name.trim()) throw new Error("A group name is required.");
  if (parentId && !db.select({ id: modelGroups.id }).from(modelGroups).where(eq(modelGroups.id, parentId)).get()) throw new Error("The parent group does not exist.");
  db.insert(modelGroups).values({ id, name: name.trim(), parentId, createdAt: now() }).run();
  return listGroupRollups().find((group) => group.id === id)!;
}

export function canMoveGroup(id: string, parentId: string | null): void {
  if (parentId === id) throw new Error("A group cannot be its own ancestor.");
  let cursor = parentId;
  while (cursor) {
    if (cursor === id) throw new Error("A group cannot be its own ancestor.");
    cursor = db.select({ parentId: modelGroups.parentId }).from(modelGroups).where(eq(modelGroups.id, cursor)).get()?.parentId ?? null;
  }
}

export function updateModelGroup(id: string, input: { name?: string; parentId?: string | null }): GroupRollup {
  const existing = db.select().from(modelGroups).where(eq(modelGroups.id, id)).get();
  if (!existing) throw new Error("Unknown group.");
  if (input.parentId !== undefined) {
    if (input.parentId && !db.select({ id: modelGroups.id }).from(modelGroups).where(eq(modelGroups.id, input.parentId)).get()) throw new Error("The parent group does not exist.");
    canMoveGroup(id, input.parentId);
  }
  db.update(modelGroups).set({ name: input.name?.trim() || existing.name, parentId: input.parentId === undefined ? existing.parentId : input.parentId }).where(eq(modelGroups.id, id)).run();
  return listGroupRollups().find((group) => group.id === id)!;
}

export function removeModelGroup(id: string): boolean {
  const existing = db.select().from(modelGroups).where(eq(modelGroups.id, id)).get();
  if (!existing) return false;
  db.update(modelGroups).set({ parentId: existing.parentId }).where(eq(modelGroups.parentId, id)).run();
  db.update(models).set({ groupId: existing.parentId }).where(eq(models.groupId, id)).run();
  db.delete(modelGroups).where(eq(modelGroups.id, id)).run();
  return true;
}

export function updateModelPlacement(id: string, input: { nickname?: string | null; groupId?: string | null }): ModelRecord {
  const model = getModel(id); if (!model) throw new Error("Unknown model.");
  if (input.groupId && !db.select({ id: modelGroups.id }).from(modelGroups).where(eq(modelGroups.id, input.groupId)).get()) throw new Error("The group does not exist.");
  return upsertModel({ ...model, nickname: input.nickname === undefined ? model.nickname : input.nickname, groupId: input.groupId === undefined ? model.groupId : input.groupId });
}

export async function performModelAction(model: ModelRecord, action: ModelAction): Promise<ActionResult> {
  if (action === "checkUpdates") return { modelId: model.id, ok: true };
  if (action === "load") {
    if (!isModelSelectable(model)) return { modelId: model.id, ok: false, reason: "Model provenance is not verified." };
    if (model.id.includes("refuse")) return { modelId: model.id, ok: false, reason: "The governor refused this model's memory admission." };
    const admission = await admit({ id: model.id, kind: "jit", requestedBytes: model.sizeBytes ?? 0, modelFileBytes: model.sizeBytes, measuredPeakBytes: model.measuredFootprintBytes });
    if ("queued" in admission) return { modelId: model.id, ok: false, reason: `The governor queued this model at position ${admission.position}.` };
    if ("refused" in admission) return { modelId: model.id, ok: false, reason: admission.reason };
    handles.set(model.id, admission); recordModelLoaded(model.id); return { modelId: model.id, ok: true };
  }
  if (action === "unload") { const handle = handles.get(model.id); if (handle) { release(handle); handles.delete(model.id); } recordModelUnloaded(model.id); return { modelId: model.id, ok: true }; }
  const existing = runtime.get(model.id) ?? { state: model.modelPath ? "ready" as const : "onDemand" as const, pinned: false, health: null, loadedAt: null };
  if (action === "pin" || action === "unpin") runtime.set(model.id, { ...existing, pinned: action === "pin" });
  return { modelId: model.id, ok: true };
}

export async function performGroupAction(id: string, action: ModelAction): Promise<{ results: ActionResult[] }> {
  const models = modelsInGroup(id);
  if (!db.select({ id: modelGroups.id }).from(modelGroups).where(eq(modelGroups.id, id)).get()) throw new Error("Unknown group.");
  return { results: await Promise.all(models.map((model) => performModelAction(model, action))) };
}

export function clearModelGroupsForTests(): void { handles.clear(); runtime.clear(); db.delete(modelUsage).run(); db.delete(modelGroups).run(); }
