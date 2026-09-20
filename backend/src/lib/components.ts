// UI-08: one component list built from the real stores (program decision
// 1, section 3), never a second inventory of its own. Each category reads
// straight from the store or route logic that already owns that data;
// Adapters, Workflows and Training stay empty arrays with managed: false
// until a package category exists to fill them.
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { modelUsage } from "@/db/schema";
import { listChannels } from "@/lib/channels";
import type { ClientRecord } from "@/types";
import { listClients } from "@/lib/clients";
import { listDetected } from "@/lib/detect";
import { DETECTED_ENGINE_VERSION_FLOORS, ENGINE_BINARIES, type EngineBinaryPin } from "@/lib/engineCatalog";
import { engineDir, engineIsBound } from "@/lib/engineInstall";
import { ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { deriveEngineVersionState } from "@/lib/engineState";
import { getGovernorStatus } from "@/lib/governor";
import { readGgufFacts } from "@/lib/gguf";
import { detectHardware, type HardwareInfo } from "@/lib/hardware";
import { listModels, type ModelRecord } from "@/lib/modelStore";
import type { RoleId } from "@/roles";
import { stackSettingValues } from "@/settings/stackKeys";
import { currentEngine } from "@/updates/engines";
import { getChatEngineStatus } from "@/lib/supervisor";

export const ComponentCategorySchema = z.enum(["models", "runtimes", "apps", "extensions", "system", "adapters", "workflows", "training"]);
export type ComponentCategory = z.infer<typeof ComponentCategorySchema>;
export const ComponentStatusSchema = z.enum(["running", "stopped", "detected", "update", "warning", "error", "ready"]);
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const ComponentRowSchema = z.object({
  id: z.string(),
  category: ComponentCategorySchema,
  subtype: z.string().nullable(),
  name: z.string(),
  identifier: z.string().nullable(),
  version: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  status: ComponentStatusSchema,
  statusText: z.string().nullable(),
  runtime: z.string().nullable(),
  resources: z.object({ memoryBytes: z.number().nullable(), gpuPercent: z.number().nullable(), cpuPercent: z.number().nullable() }),
  uptimeSeconds: z.number().nullable(),
  lastUsedAt: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ComponentRow = z.infer<typeof ComponentRowSchema>;

const MANAGED: Record<ComponentCategory, boolean> = { models: true, runtimes: true, apps: true, extensions: true, system: true, adapters: false, workflows: false, training: false };

function row(partial: Omit<ComponentRow, "resources"> & { resources?: Partial<ComponentRow["resources"]> }): ComponentRow {
  return { ...partial, resources: { memoryBytes: null, gpuPercent: null, cpuPercent: null, ...partial.resources } };
}

// LLMs/Image/Video/Audio/Embeddings, per program decision 1's table. A
// model can hold several roles (a chat model can also serve coding, judge,
// router); the first role that names a subtype wins.
function modelSubtype(roles: RoleId[]): string {
  if (roles.some((role) => role === "chat" || role === "coding" || role === "judge" || role === "router")) return "LLMs";
  if (roles.includes("image")) return "Image";
  if (roles.includes("video")) return "Video";
  if (roles.some((role) => role === "stt" || role === "tts" || role === "wakeword" || role === "music")) return "Audio";
  if (roles.some((role) => role === "embed" || role === "rerank")) return "Embeddings";
  return "Other";
}

function chatFamily(roles: RoleId[]): boolean {
  return roles.some((role) => role === "chat" || role === "coding" || role === "judge" || role === "router" || role === "embed" || role === "rerank");
}

function lastModelUsage(modelId: string): string | null {
  return db.select({ lastUsedAt: modelUsage.lastUsedAt }).from(modelUsage).where(eq(modelUsage.modelId, modelId)).get()?.lastUsedAt ?? null;
}

// Best-effort, per program decision 1 ("if present"): a model that hasn't
// been downloaded yet, or whose local file the GGUF reader can't parse,
// still gets a row, just without a quantization note.
async function quantizationNote(model: ModelRecord): Promise<string | null> {
  if (!model.modelPath) return null;
  try {
    const facts = await readGgufFacts(model.modelPath, { allowLocalFile: true });
    return facts.quantization || null;
  } catch {
    return null;
  }
}

async function modelRow(model: ModelRecord): Promise<ComponentRow> {
  const loaded = getGovernorStatus().loaded.find((entry) => entry.id === model.id);
  const status: ComponentStatus = loaded ? "running" : model.installedAt ? "stopped" : "warning";
  const statusText = loaded ? "Loaded and serving requests" : model.installedAt ? "Installed, not loaded" : "Registered, not installed";
  return row({
    id: `model:${model.id}`,
    category: "models",
    subtype: modelSubtype(model.roles),
    name: model.nickname ?? model.id,
    identifier: model.id,
    version: model.revision,
    sizeBytes: model.sizeBytes,
    status,
    statusText,
    runtime: loaded && chatFamily(model.roles) ? "llama-server" : null,
    resources: { memoryBytes: loaded?.peakBytes ?? model.measuredFootprintBytes ?? null },
    uptimeSeconds: null,
    lastUsedAt: lastModelUsage(model.id) ?? loaded?.lastUsedAt ?? null,
    notes: await quantizationNote(model),
  });
}

// The name after the `-b<tag>` marker, the same split routes/engines.ts
// uses to turn a pin id like "llama-server-b10797-macos-arm64" into a
// engine name ("llama-server") and its build tag.
function pinNameAndTag(pin: EngineBinaryPin): { name: string; newestTag: string | null } {
  const marker = pin.id.indexOf("-b");
  const name = marker > 0 ? pin.id.slice(0, marker) : pin.id;
  const newestTag = marker > 0 ? (pin.id.slice(marker + 1).split("-")[0] ?? null) : null;
  return { name, newestTag };
}

function engineRows(): ComponentRow[] {
  const status = getChatEngineStatus();
  const runningBuild = status.kind === "spawned" ? status.identity?.build ?? null : null;
  const rows: ComponentRow[] = [];
  for (const pin of ENGINE_BINARIES) {
    if (pin.platform !== process.platform || pin.arch !== process.arch) continue;
    if (!existsSync(`${engineDir(pin.id)}/${ENGINE_READY_MARKER}`)) continue;
    const { name, newestTag } = pinNameAndTag(pin);
    const currentTag = currentEngine(name)?.split("-")[0] ?? null;
    const derived = deriveEngineVersionState({ running: runningBuild, currentTag, newestTag, needsRestart: false });
    const running = runningBuild !== null && !!currentTag && runningBuild.includes(currentTag);
    rows.push(row({
      id: `runtime:${pin.id}`,
      category: "runtimes",
      subtype: "Engines",
      name: pin.label,
      identifier: pin.id,
      version: currentTag,
      sizeBytes: pin.archive.approxBytes,
      status: derived.state === "notCurrent" ? "update" : running ? "running" : "stopped",
      statusText: derived.state === "notCurrent" ? `A newer build is ${derived.stateReason}.` : running ? "Running" : "Installed, not running",
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: null,
      notes: engineIsBound(name, currentTag ?? "") ? "Bound to an installed model." : null,
    }));
  }
  for (const detected of listDetected()) {
    if (detected.adopted) continue;
    rows.push(row({
      id: `runtime:detected:${detected.id}`,
      category: "runtimes",
      subtype: "Detected",
      name: detected.name,
      identifier: detected.where,
      version: detected.version,
      sizeBytes: null,
      status: "detected",
      statusText: `Detected at ${detected.where}, not adopted.`,
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: detected.lastSeen,
      notes: DETECTED_ENGINE_VERSION_FLOORS[detected.kind] ? `Minimum supported version: ${DETECTED_ENGINE_VERSION_FLOORS[detected.kind]}.` : null,
    }));
  }
  return rows;
}

// A client "holds" coding when it's allowed the coding role; the harness
// vs. plain-coding split has no dedicated field to read (no preset exists
// on a client record yet), so it falls back to a name heuristic.
function looksLikeHarness(client: ClientRecord): boolean {
  return /agent|harness|copilot|cline|aider/i.test(client.name);
}

function appRows(): ComponentRow[] {
  const rows: ComponentRow[] = [];
  for (const client of listClients()) {
    if (client.revokedAt) continue;
    if (!client.allowedRoles.includes("coding")) continue;
    const subtype = looksLikeHarness(client) ? "Agents" : "Coding";
    rows.push(row({
      id: `app:${client.id}`,
      category: "apps",
      subtype,
      name: client.name,
      identifier: client.id,
      version: null,
      sizeBytes: null,
      status: client.lastSeenAt && Date.now() - new Date(client.lastSeenAt).getTime() < 5 * 60_000 ? "running" : "ready",
      statusText: client.lastSeenAt ? `${client.requests} requests` : "Never connected",
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: client.lastSeenAt,
      notes: null,
    }));
  }
  // Chat and Image are the two Tester surfaces (program decision 1);
  // Knowledge is the Library. None of these are clients, so their status
  // comes from whether a model currently serves that role.
  const loadedIds = new Set(getGovernorStatus().loaded.map((entry) => entry.id));
  const testerRoles: Array<{ role: RoleId; name: string; subtype: string }> = [
    { role: "chat", name: "Chat", subtype: "Tester" },
    { role: "image", name: "Image", subtype: "Tester" },
  ];
  for (const surface of testerRoles) {
    const model = listModels().find((candidate) => candidate.roles.includes(surface.role));
    rows.push(row({
      id: `app:tester:${surface.role}`,
      category: "apps",
      subtype: surface.subtype,
      name: surface.name,
      identifier: null,
      version: null,
      sizeBytes: null,
      status: model && loadedIds.has(model.id) ? "running" : model ? "ready" : "warning",
      statusText: model ? `${model.nickname ?? model.id} serves this role.` : "No model serves this role yet.",
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: null,
      notes: null,
    }));
  }
  rows.push(row({
    id: "app:library",
    category: "apps",
    subtype: "Knowledge",
    name: "Library",
    identifier: null,
    version: null,
    sizeBytes: null,
    status: "ready",
    statusText: null,
    runtime: null,
    uptimeSeconds: null,
    lastUsedAt: null,
    notes: null,
  }));
  return rows;
}

function extensionRows(): ComponentRow[] {
  const rows: ComponentRow[] = [];
  for (const channel of listChannels() as Array<{ id: string; type: string; name: string; status: string; lastSentAt: string | null; lastError: string | null }>) {
    rows.push(row({
      id: `extension:channel:${channel.id}`,
      category: "extensions",
      subtype: "Integrations",
      name: channel.name,
      identifier: channel.type,
      version: null,
      sizeBytes: null,
      status: channel.status === "verified" ? "ready" : channel.status === "failing" ? "error" : "warning",
      statusText: channel.lastError,
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: channel.lastSentAt,
      notes: null,
    }));
  }
  const mirror = String(stackSettingValues().huggingFaceEndpoint ?? "");
  rows.push(row({
    id: "extension:hf-mirror",
    category: "extensions",
    subtype: "Integrations",
    name: "Hugging Face mirror",
    identifier: mirror || null,
    version: null,
    sizeBytes: null,
    status: "ready",
    statusText: mirror && mirror !== "https://huggingface.co" ? "Using a custom mirror." : "Using the default Hugging Face endpoint.",
    runtime: null,
    uptimeSeconds: null,
    lastUsedAt: null,
    notes: null,
  }));
  // "The served MCP server" (program decision 1): nothing serves one yet,
  // so there is no row to give it rather than reporting a fabricated one.
  return rows;
}

function systemRows(hardware: HardwareInfo): ComponentRow[] {
  const rows: ComponentRow[] = [];
  if (hardware.cudaDevices.length > 0) {
    for (const gpu of hardware.cudaDevices) {
      rows.push(row({
        id: `system:accelerator:${gpu.index}`,
        category: "system",
        subtype: "Accelerators",
        name: gpu.name,
        identifier: `cuda:${gpu.index}`,
        version: null,
        sizeBytes: gpu.vramBytes,
        status: "ready",
        statusText: gpu.utilizationPct != null ? `${gpu.utilizationPct}% utilized` : null,
        runtime: null,
        resources: { gpuPercent: gpu.utilizationPct ?? null },
        uptimeSeconds: null,
        lastUsedAt: null,
        notes: null,
      }));
    }
  } else if (hardware.isAppleSilicon) {
    rows.push(row({
      id: "system:accelerator:apple",
      category: "system",
      subtype: "Accelerators",
      name: "Apple silicon GPU",
      identifier: null,
      version: null,
      sizeBytes: null,
      status: "ready",
      statusText: null,
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: null,
      notes: null,
    }));
  }
  rows.push(row({
    id: `system:driver:${hardware.isAppleSilicon ? "metal" : "cuda"}`,
    category: "system",
    subtype: "Drivers",
    name: hardware.isAppleSilicon ? "Metal" : "CUDA",
    identifier: null,
    version: null,
    sizeBytes: null,
    status: "ready",
    statusText: null,
    runtime: null,
    uptimeSeconds: null,
    lastUsedAt: null,
    notes: null,
  }));
  for (const pin of ENGINE_BINARIES) {
    if (pin.platform !== process.platform || pin.arch !== process.arch) continue;
    rows.push(row({
      id: `system:dependency:${pin.id}`,
      category: "system",
      subtype: "Dependencies",
      name: pin.label,
      identifier: pin.id,
      version: null,
      sizeBytes: pin.archive.approxBytes,
      status: existsSync(`${engineDir(pin.id)}/${ENGINE_READY_MARKER}`) ? "ready" : "warning",
      statusText: null,
      runtime: null,
      uptimeSeconds: null,
      lastUsedAt: null,
      notes: null,
    }));
  }
  return rows;
}

export interface ComponentsResult { components: ComponentRow[]; managed: Record<ComponentCategory, boolean>; }

// The Overview page (UI-11) hits /components and /components/summary on
// the same load, and each build here opens every installed model's GGUF
// file for its quantization note; a short cache keeps that pair of calls
// to one real pass, the same shape as hardware.ts's own detection cache.
const CACHE_MS = 5_000;
let cached: { at: number; result: ComponentsResult } | null = null;

export async function listComponents(): Promise<ComponentsResult> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  const models = await Promise.all(listModels().map(modelRow));
  const hardware = await detectHardware();
  const components = [...models, ...engineRows(), ...appRows(), ...extensionRows(), ...systemRows(hardware)];
  const result: ComponentsResult = { components, managed: MANAGED };
  cached = { at: Date.now(), result };
  return result;
}

export function __resetComponentsCacheForTests(): void {
  cached = null;
}

export interface ComponentsSummary {
  installed: number;
  running: number;
  clientsConnected: { local: number; remote: number };
  updatesAvailable: number;
  perCategory: Record<ComponentCategory, number>;
}

export async function componentsSummary(): Promise<ComponentsSummary> {
  const { components } = await listComponents();
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  // No client record carries a last address today, so every recently-seen
  // client counts as local (the spec's own fallback for that case).
  const recentClients = listClients().filter((client) => client.lastSeenAt !== null && new Date(client.lastSeenAt).getTime() >= dayAgo);
  const perCategory = Object.fromEntries(ComponentCategorySchema.options.map((category) => [category, components.filter((c) => c.category === category).length])) as Record<ComponentCategory, number>;
  return {
    installed: components.filter((c) => c.status !== "detected").length,
    running: components.filter((c) => c.status === "running").length,
    clientsConnected: { local: recentClients.length, remote: 0 },
    updatesAvailable: components.filter((c) => c.status === "update").length,
    perCategory,
  };
}
