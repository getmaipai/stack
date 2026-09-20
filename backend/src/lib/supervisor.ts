// The per-role supervisor: one process per role binding, three kinds
// (spawned by the Stack, a managed sidecar, a read-only url the person
// runs), one lifecycle. The pieces that were paid for in the chat-only
// supervisor (the generation guard, the free-port probe, the size-scaled
// liveness wait, the post-load completion, the measured footprint, the
// exit watch, the drain) are the same here, keyed by role.
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { withTimeout } from "@maipai/core/src/withTimeout";
import { ENGINE_READY_MARKER, installedEnginePin, selectEngineBinary, type EngineBinaryPin } from "@/lib/engineCatalog";
import { llamaServerArgs } from "@/lib/engineArgs";
import { currentEngineBinary, engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { detectHardware } from "@/lib/hardware";
import { identityHeaders, modelFileName, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { isModelSelectable, listModels, recordMeasuredFootprint, type ModelRecord } from "@/lib/modelStore";
import { admit, getRunState, release, setGovernorPid, startGovernor, type GovernorHandle } from "@/lib/governor";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { ROLES, ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { getMemoryReader } from "@/lib/memory";
import { readGgufFacts } from "@/lib/gguf";
import { hfUrl } from "@/lib/hf";
import { hfHubRoot } from "@/lib/store/layout";
import { engineSettingValues, settingValues } from "@/settings";
import { bumpStackGeneration } from "@/lib/stackGeneration";

export type EngineKind = "spawned" | "managed" | "url";
export type EngineStatus = RoleState | "loading" | "busy" | "stopped";

export interface RoleStatus {
  kind: EngineKind | null;
  state: EngineStatus;
  reason: string | null;
  identity: EngineIdentity | null;
  postLoadCheck: PostLoadCheck | null;
}

export interface PostLoadCheck {
  replyOk: boolean;
  actualBytes: number | null;
  estimatedBytes: number | null;
  loadMs?: number;
  firstTokenMs?: number;
}

export interface FootprintEstimate { bytes: number; estimated: boolean; contextLength: number; source: "dry-run" | "gguf"; }

export interface EngineClient {
  readonly baseUrl: string;
  request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
  stream?(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
  health(): Promise<boolean>;
}

export interface RoleProcess {
  role: RoleId;
  kind: EngineKind;
  client: EngineClient;
  identity: EngineIdentity;
  modelId: string | null;
  /** The pinned revision of the model the process serves, for the reply headers. */
  modelRevision: string | null;
  pid: number | null;
  port: number | null;
  activeRequests: number;
  retired: boolean;
  governorHandle?: GovernorHandle;
  stopGovernor?: () => void;
  stop(): Promise<void>;
}

export class EngineUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.name = "EngineUnavailableError"; this.reason = reason; }
}

// The roles a llama-server process serves and the request each one's
// post-load check sends. Roles that share chat's model run on chat's
// process; embed has its own model and its own launch flag.
const CHAT_WIRE_ROLES: RoleId[] = ROLE_IDS.filter((role) => ROLES[role].wire === "chat");
const SPAWNABLE_ROLES: RoleId[] = ["chat", "embed"];

/** The role whose process serves this role: `coding`, `judge`, `router`
 * and `vision` share chat's model and process unless bound elsewhere. */
export function processRoleFor(role: RoleId): RoleId {
  const definition = ROLES[role] as { sharesModelWith?: RoleId };
  return definition.sharesModelWith ?? role;
}

// ---- the client -----------------------------------------------------------

class OpenAIEngineClient implements EngineClient {
  constructor(readonly baseUrl: string) {}
  private url(path: string): string { return `${this.baseUrl.replace(/\/$/, "")}${path}`; }

  async request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(this.url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    }
    const responseBody = await response.json().catch(() => ({ error: `Engine returned HTTP ${response.status}.` }));
    return { status: response.status, body: responseBody };
  }

  async stream(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.url(path), { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ ...body, stream: true }), signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new EngineUnavailableError(`Engine streaming request failed: ${(error as Error).message}`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(this.url("/health"), { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch { return false; }
  }
}

// ---- timeouts and probes --------------------------------------------------

const DEFAULT_POST_LOAD_TIMEOUT_MS = 120_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const LOAD_FLOOR_MS = 60_000;
const LOAD_PER_GB_MS = 60_000;
const LOAD_CEILING_MS = 20 * 60_000;
let timeoutOverrides: { loadFloorMs?: number; postLoadMs?: number; completionMs?: number } = {};

export function setSupervisorTimeoutsForTests(overrides: { loadFloorMs?: number; postLoadMs?: number; completionMs?: number } | null): void {
  timeoutOverrides = overrides ?? {};
}

export function loadTimeoutForModel(sizeBytes: number | null | undefined): number {
  const floor = timeoutOverrides.loadFloorMs ?? LOAD_FLOOR_MS;
  const scaled = floor + Math.ceil((sizeBytes ?? 0) / (1024 ** 3)) * LOAD_PER_GB_MS;
  return Math.min(LOAD_CEILING_MS, Math.max(floor, scaled));
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function waitHealthy(client: EngineClient, timeoutMs = LOAD_FLOOR_MS, isAlive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new EngineUnavailableError("Engine exited before becoming healthy.");
    if (await client.health()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new EngineUnavailableError(`Engine did not become healthy before the load timeout (${Math.ceil(timeoutMs / 1000)}s).`);
}

export async function measureProcessMemoryBytes(pid: number | null): Promise<number | null> {
  if (pid === null) return null;
  return getMemoryReader().processFootprint(pid);
}

/** The smallest real request for a role's wire: the post-load check and
 * the readiness check both send it, so "ready" always means the public
 * route's own shape answered. */
export function probeRequest(role: RoleId): { path: string; body: Record<string, unknown> } {
  if (ROLES[role].wire === "embeddings") return { path: "/v1/embeddings", body: { model: role, input: "OK" } };
  // `enable_thinking: false` asks the template to answer in content; a
  // thinking model that answers in reasoning_content is still alive.
  return { path: "/v1/chat/completions", body: { model: role, messages: [{ role: "user", content: "Reply with just the word OK." }], max_tokens: 32, chat_template_kwargs: { enable_thinking: false } } };
}

export function probeReplyOk(role: RoleId, result: { status: number; body: unknown }): boolean {
  if (result.status < 200 || result.status >= 300) return false;
  if (ROLES[role].wire === "embeddings") {
    const data = (result.body as { data?: Array<{ embedding?: unknown }> }).data;
    return Array.isArray(data) && Array.isArray(data[0]?.embedding) && data[0].embedding.length > 0;
  }
  const message = (result.body as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> }).choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : null;
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : null;
  return Boolean((content && content.trim()) || (reasoning && reasoning.trim()));
}

export async function postLoadCheck(role: RoleId, client: EngineClient, pid: number | null): Promise<PostLoadCheck> {
  const startedAt = performance.now();
  const probe = probeRequest(role);
  const result = await withTimeout(
    client.request(probe.path, probe.body),
    timeoutOverrides.postLoadMs ?? DEFAULT_POST_LOAD_TIMEOUT_MS,
    () => new EngineUnavailableError("The post-load check timed out."),
  );
  if (!probeReplyOk(role, result)) throw new EngineUnavailableError("Post-load check did not receive a usable reply.");
  return { replyOk: true, actualBytes: await measureProcessMemoryBytes(pid), estimatedBytes: null, firstTokenMs: Math.round(performance.now() - startedAt) };
}

function parseFitBytes(output: string): number | null {
  const matches = [...output.matchAll(/(?:memory|ram|footprint|requires?)[^\n]*?(\d+(?:\.\d+)?)\s*(GiB|MiB|GB|MB|bytes)/gi)];
  const match = matches.at(-1);
  if (!match) return null;
  const value = Number(match[1]); const unit = match[2]?.toLowerCase();
  return unit === "gib" || unit === "gb" ? Math.round(value * 1_073_741_824) : unit === "mib" || unit === "mb" ? Math.round(value * 1_048_576) : Math.round(value);
}

export async function dryRunFootprint(modelPath: string, contextLength: number): Promise<number | null> {
  try {
    const hardware = await detectHardware(); const pin = selectEngineBinary(hardware);
    const fit = process.env.STACK_FIT_BINARY ?? (pin ? join(engineDir(pin), "llama-fit-params") : "");
    if (!fit || !existsSync(fit)) return null;
    const processHandle = Bun.spawn([fit, "--model", modelPath, "--ctx-size", String(contextLength), "--fit", "on", "--fit-print", "on"], { stdout: "pipe", stderr: "pipe" });
    const output = `${await new Response(processHandle.stdout).text()}\n${processHandle.stderr ? await new Response(processHandle.stderr).text() : ""}`;
    await processHandle.exited;
    return parseFitBytes(output);
  } catch { return null; }
}

export async function estimateFootprint(repo: string, file: string, contextLength: number): Promise<FootprintEstimate> {
  const url = hfUrl(`${repo}/resolve/main/${file}`);
  const facts = await readGgufFacts(url);
  const head = await fetch(url, { method: "HEAD" });
  const weights = Number(head.headers.get("content-length") ?? 0);
  const quantization = facts.quantization.toLowerCase();
  const bytesPerElement = quantization.includes("q4") || quantization === "2" || quantization === "3" ? 18 / 32 : quantization.includes("q8") || quantization === "7" || quantization === "8" ? 34 / 32 : 2;
  const kvBytes = 2 * facts.layers * facts.kvHeads * facts.headDim * contextLength * bytesPerElement;
  return { bytes: Math.ceil(weights + kvBytes + 256 * 1_048_576), estimated: true, contextLength, source: "gguf" };
}

// ---- per-role state -------------------------------------------------------

interface RoleRuntime {
  process: RoleProcess | null;
  starting: Promise<RoleProcess> | null;
  generation: number;
  manuallyStopped: boolean;
  status: RoleStatus;
  lastRealRequestAt: number | null;
}

type ProcessFactory = (role: RoleId) => Promise<RoleProcess>;
let testFactory: ProcessFactory | null = null;
const runtimes = new Map<RoleId, RoleRuntime>();

// The build that runs is the one the store's `current` link names (the
// swap and the rollback flip that link); before any swap it is the
// machine's pin, which the first install activated.
function engineInstalled(): boolean {
  const current = currentEngineBinary("llama-server");
  if (current.state === "ready") return true;
  if (current.state === "unready") return false;
  const pin = installedEnginePin();
  return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER));
}

// The binary to launch: the `current` link's build; the machine pin's own
// directory only before any link exists. A link that names an unready
// build is a refusal, never a silent fallback to another build.
function launchBinary(pin: EngineBinaryPin): string {
  const current = currentEngineBinary("llama-server");
  if (current.state === "ready") return current.path;
  if (current.state === "unready") throw new EngineUnavailableError(`The current engine link names ${current.tag}, which never finished installing.`);
  return engineBinaryPath(pin);
}

function initialStatus(role: RoleId): RoleStatus {
  const installed = SPAWNABLE_ROLES.includes(role) && engineInstalled() && selectedModel(role) !== null;
  return { kind: null, state: installed ? "installed" : "notInstalled", reason: null, identity: null, postLoadCheck: null };
}

function runtime(role: RoleId): RoleRuntime {
  let current = runtimes.get(role);
  if (!current) {
    current = { process: null, starting: null, generation: 0, manuallyStopped: false, status: initialStatus(role), lastRealRequestAt: null };
    runtimes.set(role, current);
  }
  return current;
}

function urlBindingFor(role: RoleId): { kind: EngineKind; url: string } | null {
  const values = settingValues();
  const configured = values[`stack.engines.${role}.host_url`];
  if (typeof configured === "string" && configured.trim()) return { kind: "url", url: configured.trim() };
  const env = process.env[`STACK_${role.toUpperCase()}_ENGINE_URL`];
  if (env) return { kind: "url", url: env };
  return null;
}

const preferredModels = new Map<RoleId, string>();

/** Home's "load this model": the next start of the role uses it if it
 * is selectable; otherwise the first selectable model for the role. */
export function preferModel(role: RoleId, modelId: string | null): void {
  if ((preferredModels.get(role) ?? null) === modelId) return;
  if (modelId) preferredModels.set(role, modelId); else preferredModels.delete(role);
  bumpStackGeneration(`${role} now prefers ${modelId ?? "the first selectable model"}`);
}

export function selectedModel(role: RoleId): ModelRecord | null {
  const selectable = listModels().filter((model) => model.roles.includes(role) && isModelSelectable(model) && model.modelPath);
  const preferred = preferredModels.get(role);
  return selectable.find((model) => model.id === preferred) ?? selectable[0] ?? null;
}

// ---- starting a process ---------------------------------------------------

async function startUrlProcess(role: RoleId, url: string): Promise<RoleProcess> {
  const client = new OpenAIEngineClient(url);
  const identity = await readEngineIdentity(url);
  if (!identity.healthy) {
    const reason = `The ${role} server at the bound URL is offline.`;
    emit({ id: "engine.state", data: { engine: role, state: "offline", reason } });
    raise({ code: `managed-host-offline.${role}`, severity: "error", title: `${ROLES[role].label} server is offline`, text: reason, cause: reason });
    throw new EngineUnavailableError(reason);
  }
  resolveHealth(`managed-host-offline.${role}`);
  return { role, kind: "url", client, identity, modelId: null, modelRevision: null, pid: null, port: Number(new URL(url).port) || null, activeRequests: 0, retired: false, stop: async () => {} };
}

async function startSpawnedProcess(role: RoleId): Promise<RoleProcess> {
  if (!SPAWNABLE_ROLES.includes(role)) throw new EngineUnavailableError(`No engine can be started for ${role} on this machine yet.`);
  const declared = engineSettingValues("engines.llama_server");
  const config = { contextLength: declared.context_length, slots: declared.slots, threads: declared.threads, cacheRamMb: declared.cache_ram_mb, flashAttention: declared.flash_attention } as Record<string, number | boolean | string | string[]>;
  const pin = installedEnginePin();
  const model = selectedModel(role);
  if (!pin || !engineInstalled()) throw new EngineUnavailableError("No installed llama-server build is available for this machine.");
  if (!model?.modelPath) throw new EngineUnavailableError(`No verified and installed ${role} model is available.`);

  const admission = await admit({ id: role, kind: "resident", requestedBytes: model.sizeBytes ?? 0, modelFileBytes: model.sizeBytes, measuredPeakBytes: model.measuredFootprintBytes, engine: "llama-server", pinned: pinnedModels.has(model.id) });
  if ("queued" in admission) throw new EngineUnavailableError(`${role} admission is queued at position ${admission.position}.`);
  if ("refused" in admission) throw new EngineUnavailableError(admission.reason);

  const port = await findFreePort();
  const contextLength = typeof config.contextLength === "number" ? config.contextLength : 4096;
  const binary = launchBinary(pin);
  const handle = Bun.spawn([binary, ...llamaServerArgs({ modelPath: model.modelPath, port, config, contextLength, kvCacheQuantized: process.platform === "darwin", embeddings: role === "embed" })], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, HF_HUB_CACHE: hfHubRoot },
  });
  setGovernorPid(role, handle.pid);
  const client = new OpenAIEngineClient(`http://127.0.0.1:${port}`);
  const stderrText = handle.stderr ? new Response(handle.stderr).text() : Promise.resolve("");
  let exited = false;
  const exitPromise = handle.exited.then((code) => { exited = true; return code; });
  try {
    const exitFailure = exitPromise.then(async (code) => {
      const lines = (await stderrText).trim().split("\n").slice(-5).join(" | ");
      throw new EngineUnavailableError(`Engine exited before becoming healthy (code ${code})${lines ? `: ${lines}` : "."}`);
    });
    void exitFailure.catch(() => {});
    const loadStartedAt = performance.now();
    await Promise.race([waitHealthy(client, loadTimeoutForModel(model.sizeBytes), () => !exited), exitFailure]);
    const identity = await readEngineIdentity(client.baseUrl);
    const check = await postLoadCheck(role, client, handle.pid);
    check.loadMs = Math.round(performance.now() - loadStartedAt);
    if (check.actualBytes !== null) recordMeasuredFootprint(model.id, check.actualBytes, contextLength);
    runtime(role).status.postLoadCheck = check;
    resolveHealth(`engine.crashed.${role}`);
    resolveHealth(`post-load-check-failed.${role}`);
    const processRecord: RoleProcess = {
      role, kind: "spawned", client, identity, modelId: model.id, modelRevision: model.revision, pid: handle.pid, port, activeRequests: 0, retired: false,
      governorHandle: admission,
      stopGovernor: startGovernor({ pid: handle.pid, restart: async () => { await restartRole(role); } }),
      stop: async () => { handle.kill(); await handle.exited; },
    };
    void handle.exited.then(() => {
      const current = runtime(role);
      if (!processRecord.retired && current.process === processRecord) {
        current.process = null;
        current.starting = null;
        current.status = { kind: "spawned", state: "offline", reason: "The spawned engine exited unexpectedly.", identity, postLoadCheck: check };
        emit({ id: "engine.state", data: { engine: role, state: "offline", reason: "The spawned engine exited unexpectedly." } });
        raise({ code: `engine.crashed.${role}`, severity: "error", title: `The ${role} engine crashed`, text: "The spawned engine exited unexpectedly.", cause: "The engine process exited.", fix: { label: "Restart engine", action: "restart_engine" } });
        processRecord.stopGovernor?.();
        if (processRecord.governorHandle) release(processRecord.governorHandle);
      }
    });
    return processRecord;
  } catch (error) {
    handle.kill();
    const message = (error as Error).message;
    emit({ id: "engine.state", data: { engine: role, state: "offline", reason: message } });
    raise({ code: exited ? `engine.crashed.${role}` : `post-load-check-failed.${role}`, severity: "error", title: `${ROLES[role].label} engine failed to start`, text: message, cause: message, fix: { label: "Restart engine", action: "restart_engine" } });
    release(admission);
    throw error;
  }
}

async function startProcess(role: RoleId): Promise<RoleProcess> {
  if (testFactory) return testFactory(role);
  const bound = urlBindingFor(role);
  if (bound) return startUrlProcess(role, bound.url);
  return startSpawnedProcess(role);
}

/** The running process for a role, starting it under the generation
 * guard when it is not. Roles that share another role's model resolve
 * to that role's process. */
export async function getProcess(requested: RoleId): Promise<RoleProcess> {
  const role = processRoleFor(requested);
  if (getRunState() !== "running") throw new EngineUnavailableError("The Stack is paused.");
  const current = runtime(role);
  if (current.manuallyStopped) throw new EngineUnavailableError(`The ${role} engine was stopped.`);
  if (current.process) return current.process;
  if (!current.starting) {
    const generation = current.generation;
    current.status = { ...current.status, state: "loading", reason: null };
    emit({ id: "role.state", data: { role, state: "loaded", since: new Date().toISOString() } });
    current.starting = startProcess(role).then(async (started) => {
      if (generation !== current.generation) {
        started.retired = true;
        await started.stop();
        current.starting = null;
        return getProcess(role);
      }
      current.process = started;
      current.starting = null;
      current.lastRealRequestAt = Date.now();
      current.status = { kind: started.kind, state: "ready", reason: null, identity: started.identity, postLoadCheck: current.status.postLoadCheck };
      emit({ id: "engine.state", data: { engine: role, state: "ready" } });
      emit({ id: "role.state", data: { role, state: "ready", since: new Date().toISOString() } });
      return started;
    }).catch((error) => {
      if (generation === current.generation) {
        current.starting = null;
        current.status = { ...current.status, state: "offline", reason: (error as Error).message };
        emit({ id: "role.state", data: { role, state: "offline", since: new Date().toISOString(), reason: (error as Error).message } });
      }
      throw error;
    });
  }
  return current.starting;
}

export function getRoleStatus(requested: RoleId): RoleStatus {
  const role = processRoleFor(requested);
  const current = runtime(role);
  if (current.process && current.status.state !== "busy") current.status = { ...current.status, kind: current.process.kind, state: "ready", identity: current.process.identity, reason: null };
  return { ...current.status };
}

export function lastRealRequestAt(requested: RoleId): number | null {
  return runtime(processRoleFor(requested)).lastRealRequestAt;
}

/** The identity a role's process is expected to report, and whether it
 * does: a spawned process must name the selected model's file; a url
 * binding with an `expected_version` must report a build containing it.
 * "Ready" is claimed only when this holds (STACK-87). */
export function identityCheck(requested: RoleId): { ok: boolean; expected: string | null; actual: string | null; reason: string | null } {
  const role = processRoleFor(requested);
  const processRecord = runtime(role).process;
  if (!processRecord) return { ok: false, expected: null, actual: null, reason: "No process is running." };
  if (processRecord.kind === "spawned") {
    const model = processRecord.modelId ? listModels().find((candidate) => candidate.id === processRecord.modelId) : null;
    const actual = processRecord.identity.model;
    // A spawned process serves one model record; if the store no longer
    // has it, what runs is not something the Stack vouches for.
    if (!model?.modelPath) return { ok: false, expected: null, actual, reason: `The engine runs ${processRecord.modelId ?? "an unknown model"}, which the store no longer has.` };
    const expected = modelFileName(model.modelPath);
    if (actual && expected !== actual) return { ok: false, expected, actual, reason: `The engine reports ${actual}; the selected model is ${expected}.` };
    return { ok: true, expected, actual, reason: null };
  }
  const expectedVersion = settingValues()[`stack.engines.${role}.expected_version`];
  const actual = processRecord.identity.build;
  if (typeof expectedVersion === "string" && expectedVersion.trim()) {
    if (!actual || !actual.includes(expectedVersion.trim())) return { ok: false, expected: expectedVersion.trim(), actual, reason: `The server reports build ${actual ?? "unknown"}; ${expectedVersion.trim()} was expected.` };
    return { ok: true, expected: expectedVersion.trim(), actual, reason: null };
  }
  return { ok: true, expected: null, actual, reason: null };
}

/** A pid is the proof that this process was launched by this Stack. */
export function roleIsStackOwned(requested: RoleId): boolean {
  const current = runtime(processRoleFor(requested));
  return current.process?.kind === "spawned" && current.process.pid !== null;
}

export function roleCanBeStartedByStack(requested: RoleId): boolean {
  const role = processRoleFor(requested);
  return !runtime(role).process && !urlBindingFor(role) && SPAWNABLE_ROLES.includes(role);
}

async function retire(processRecord: RoleProcess): Promise<void> {
  processRecord.retired = true;
  processRecord.stopGovernor?.();
  while (processRecord.activeRequests > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await processRecord.stop();
  if (processRecord.governorHandle) release(processRecord.governorHandle);
}

export async function restartRole(requested: RoleId): Promise<void> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  current.generation++;
  const previous = current.process;
  current.process = null;
  current.starting = null;
  current.manuallyStopped = false;
  current.status = { ...current.status, state: "loading", reason: null };
  emit({ id: "engine.state", data: { engine: role, state: "loading" } });
  if (previous) await retire(previous);
}

export async function stopRole(requested: RoleId, reason = "Stopped by Home."): Promise<void> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  current.generation++;
  current.manuallyStopped = true;
  const previous = current.process;
  current.process = null;
  current.starting = null;
  current.status = { ...current.status, state: "stopped", reason };
  emit({ id: "engine.state", data: { engine: role, state: "stopped", reason } });
  emit({ id: "role.state", data: { role, state: "installed", since: new Date().toISOString(), reason } });
  if (previous) await retire(previous);
}

/** Drains and unloads a role now, without marking it stopped: the next
 * request starts it again. This is what "free memory" and Home's
 * unload mean; `stopRole` is the explicit stop that stays stopped. */
export async function unloadRole(requested: RoleId, reason: string): Promise<boolean> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  const processRecord = current.process;
  if (!processRecord && !current.starting) return false;
  current.generation++;
  current.process = null;
  current.starting = null;
  current.status = { ...current.status, state: "installed", reason };
  emit({ id: "engine.state", data: { engine: role, state: "installed", reason } });
  if (processRecord) await retire(processRecord);
  return true;
}

export async function unloadAllRoles(reason: string): Promise<RoleId[]> {
  const unloaded: RoleId[] = [];
  for (const role of [...runtimes.keys()]) if (await unloadRole(role, reason)) unloaded.push(role);
  return unloaded;
}

/** Drains and unloads a role that has had no request for the declared
 * idle time (shorter on battery); the process is started again by the
 * next request. Returns true when something was unloaded. */
export async function unloadIdleRole(requested: RoleId, options: { now?: Date; onBattery: boolean; idleMinutes: number; batteryIdleMinutes: number }): Promise<boolean> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  const processRecord = current.process;
  const last = current.lastRealRequestAt;
  const idleMinutes = options.onBattery ? options.batteryIdleMinutes : options.idleMinutes;
  const now = options.now ?? new Date();
  if (!processRecord || processRecord.activeRequests > 0 || last === null || now.getTime() - last < idleMinutes * 60_000) return false;
  current.generation++;
  current.process = null;
  current.starting = null;
  current.status = { ...current.status, state: "installed", reason: `Unloaded after ${idleMinutes} minutes without a request.` };
  emit({ id: "engine.state", data: { engine: role, state: "installed", reason: `Unloaded after ${idleMinutes} minutes without a request.` } });
  await retire(processRecord);
  return true;
}

export async function unloadIdleRoles(options: { now?: Date; onBattery: boolean; idleMinutes: number; batteryIdleMinutes: number }): Promise<RoleId[]> {
  const unloaded: RoleId[] = [];
  for (const role of runtimes.keys()) if (await unloadIdleRole(role, options)) unloaded.push(role);
  return unloaded;
}

export async function stopAllRoles(reason: string): Promise<void> {
  for (const role of [...runtimes.keys()]) if (runtime(role).process || runtime(role).starting) await stopRole(role, reason);
}

// ---- pins -----------------------------------------------------------------

const pinnedModels = new Set<string>();
export function pinModel(id: string, pinned: boolean): void {
  if (pinnedModels.has(id) === pinned) return;
  if (pinned) pinnedModels.add(id); else pinnedModels.delete(id);
  bumpStackGeneration(`model ${id} ${pinned ? "pinned" : "unpinned"}`);
}
export function isModelPinned(id: string): boolean { return pinnedModels.has(id); }

/** Which role runtime, if any, currently serves a model file. */
export function loadedRoleForModel(id: string): RoleId | null {
  for (const [role, current] of runtimes) if (current.process?.modelId === id) return role;
  return null;
}

// ---- requests -------------------------------------------------------------

export interface RoleReply { status: number; body: unknown; headers: Record<string, string>; }
export interface RoleStreamReply { status: number; body: ReadableStream<Uint8Array> | null; headers: Record<string, string>; }

export async function requestRole(requested: RoleId, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<RoleReply> {
  const role = processRoleFor(requested);
  const processRecord = await getProcess(role);
  const current = runtime(role);
  processRecord.activeRequests++;
  current.status = { ...current.status, state: "busy", kind: processRecord.kind, identity: processRecord.identity };
  try {
    const completionMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : (timeoutOverrides.completionMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const result = await withTimeout(
      processRecord.client.request(path, body, signal),
      completionMs,
      () => new EngineUnavailableError(`Engine request timed out after ${Math.ceil(completionMs / 1000)}s.`),
    );
    if (result.status >= 500 && !await processRecord.client.health()) {
      throw new EngineUnavailableError(`Engine returned HTTP ${result.status} and is no longer healthy.`);
    }
    if (result.status >= 200 && result.status < 300) current.lastRealRequestAt = Date.now();
    return { ...result, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: 499, body: { error: "Request cancelled" }, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    }
    if (await processRecord.client.health()) {
      return { status: error instanceof EngineUnavailableError ? 504 : 503, body: { error: (error as Error).message }, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    }
    const unavailable = error instanceof EngineUnavailableError ? error : new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    current.process = null;
    current.starting = null;
    current.status = { ...current.status, state: "offline", reason: unavailable.reason };
    emit({ id: "engine.state", data: { engine: role, state: "offline", reason: unavailable.reason } });
    void retire(processRecord);
    throw unavailable;
  } finally {
    processRecord.activeRequests--;
    if (current.process === processRecord && processRecord.activeRequests === 0) current.status = { ...current.status, state: "ready" };
  }
}

function finishStream(role: RoleId, processRecord: RoleProcess): void {
  const current = runtime(role);
  processRecord.activeRequests--;
  if (current.process === processRecord) {
    if (processRecord.activeRequests === 0) current.status = { ...current.status, state: "ready" };
    current.lastRealRequestAt = Date.now();
  }
}

function trackedStream(role: RoleId, processRecord: RoleProcess, upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let finished = false;
  const finish = () => { if (finished) return; finished = true; finishStream(role, processRecord); };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finish(); }
    },
  });
}

export async function streamRole(requested: RoleId, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<RoleStreamReply> {
  const role = processRoleFor(requested);
  const processRecord = await getProcess(role);
  const current = runtime(role);
  processRecord.activeRequests++;
  current.status = { ...current.status, state: "busy", kind: processRecord.kind, identity: processRecord.identity };
  try {
    if (!processRecord.client.stream) throw new EngineUnavailableError("The engine does not support streaming.");
    const response = await processRecord.client.stream(path, { ...body, stream: true }, signal);
    if (response.status >= 500 && !await processRecord.client.health()) throw new EngineUnavailableError(`Engine returned HTTP ${response.status} and is no longer healthy.`);
    if (!response.body) { finishStream(role, processRecord); return { status: response.status, body: null, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) }; }
    return { status: response.status, body: trackedStream(role, processRecord, response.body), headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
  } catch (error) {
    finishStream(role, processRecord);
    if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) return { status: 499, body: null, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    if (await processRecord.client.health()) return { status: error instanceof EngineUnavailableError ? 504 : 503, body: null, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    const unavailable = error instanceof EngineUnavailableError ? error : new EngineUnavailableError(`Engine streaming request failed: ${(error as Error).message}`);
    current.process = null;
    current.starting = null;
    current.status = { ...current.status, state: "offline", reason: unavailable.reason };
    emit({ id: "engine.state", data: { engine: role, state: "offline", reason: unavailable.reason } });
    void retire(processRecord);
    throw unavailable;
  }
}

// ---- tests ----------------------------------------------------------------

export function resetSupervisorForTests(): void {
  for (const current of runtimes.values()) current.generation++;
  runtimes.clear();
  pinnedModels.clear();
  preferredModels.clear();
}

export function setSupervisorFactoryForTests(factory: ProcessFactory | null): void {
  testFactory = factory;
  resetSupervisorForTests();
}

/** A scripted process for the suite: answers every wire with a fixed
 * reply and streams two chunks, never touching a real engine. */
export function scriptedProcess(role: RoleId, overrides: Partial<RoleProcess> = {}): RoleProcess {
  const client: EngineClient = {
    baseUrl: "in-process://scripted",
    async request(path, body) {
      if (path === "/v1/embeddings") return { status: 200, body: { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], model: role, usage: { prompt_tokens: 1, total_tokens: 1 } } };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1) as { content?: unknown } | undefined;
      const content = typeof last?.content === "string" && last.content.trim() ? "Scripted Stack reply." : "The scripted Stack engine is ready.";
      return { status: 200, body: { id: "scripted-completion", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } } };
    },
    async stream(_path, _body, signal) {
      const encoder = new TextEncoder();
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Scripted" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: " Stack" } }] })}\n\n`,
        `data: ${JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            if (signal?.aborted) { controller.error(new DOMException("Cancelled", "AbortError")); return; }
            controller.enqueue(encoder.encode(chunk));
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    async health() { return true; },
  };
  return { role, kind: "url", client, identity: { host: "stub", build: "scripted", model: `scripted-${role}`, healthy: true }, modelId: null, modelRevision: null, pid: null, port: null, activeRequests: 0, retired: false, stop: async () => {}, ...overrides };
}

export { CHAT_WIRE_ROLES, SPAWNABLE_ROLES };
