import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ENGINE_BINARIES, ENGINE_READY_MARKER } from "@/lib/engineCatalog";
import { engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { identityHeaders, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { isModelSelectable, listModels, type ModelRecord } from "@/lib/modelStore";
import { withTimeout } from "@/lib/withTimeout";
import { admit, release, startGovernor, type GovernorHandle } from "@/lib/governor";
import { emit } from "@/lib/events";
import { raiseRepair } from "@/lib/repairs";
import type { RoleState } from "@/roles";

export type EngineKind = "spawned" | "managed" | "url";

export interface ChatEngineStatus {
  kind: EngineKind | null;
  state: RoleState;
  reason: string | null;
  identity: EngineIdentity | null;
  postLoadCheck: PostLoadCheck | null;
}

export interface PostLoadCheck {
  replyOk: boolean;
  actualBytes: number | null;
  estimatedBytes: number | null;
}

export async function measureProcessMemoryBytes(pid: number | null): Promise<number | null> {
  if (pid === null) return null;
  try {
    const processHandle = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(processHandle.stdout).text();
    await processHandle.exited;
    const residentKb = Number.parseInt(output.trim(), 10);
    return Number.isFinite(residentKb) && residentKb > 0 ? residentKb * 1024 : null;
  } catch {
    return null;
  }
}

export interface EngineClient {
  readonly baseUrl: string;
  complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
  health(): Promise<boolean>;
}

export interface ChatBackend {
  client: EngineClient;
  kind: EngineKind;
  identity: EngineIdentity;
  pid: number | null;
  stop(): Promise<void>;
  activeRequests: number;
  retired: boolean;
  governorHandle?: GovernorHandle;
  stopGovernor?: () => void;
}

export class EngineUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "EngineUnavailableError";
    this.reason = reason;
  }
}

class OpenAIEngineClient implements EngineClient {
  constructor(readonly baseUrl: string) {}

  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    }
    const responseBody = await response.json().catch(() => ({ error: `Engine returned HTTP ${response.status}.` }));
    return { status: response.status, body: responseBody };
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

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

interface SupervisorState {
  backend: ChatBackend | null;
  startingPromise: Promise<ChatBackend> | null;
  generation: number;
  manuallyStopped: boolean;
  status: ChatEngineStatus;
}

type BackendFactory = () => Promise<ChatBackend>;
let testBackendFactory: BackendFactory | null = null;

function initialStatus(): ChatEngineStatus {
  const pin = ENGINE_BINARIES.find((entry) => entry.platform === process.platform && entry.arch === process.arch && !entry.requiresNvidia);
  const installed = !!pin && existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER));
  return { kind: null, state: installed ? "installed" : "notInstalled", reason: null, identity: null, postLoadCheck: null };
}

const state: SupervisorState = {
  backend: null,
  startingPromise: null,
  generation: 0,
  manuallyStopped: false,
  status: initialStatus(),
};

function configuredUrl(): { kind: EngineKind; url: string } | null {
  const managed = process.env.STACK_MANAGED_ENGINE_URL;
  if (managed) return { kind: "managed", url: managed };
  const url = process.env.STACK_CHAT_ENGINE_URL ?? process.env.MAIPAI_LLAMA_SERVER_URL;
  return url ? { kind: "url", url } : null;
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

export async function postLoadCheck(client: EngineClient, pid: number | null): Promise<PostLoadCheck> {
  const result = await withTimeout(
    client.complete({ model: "chat", messages: [{ role: "user", content: "Reply with just the word OK." }], max_tokens: 16 }),
    timeoutOverrides.postLoadMs ?? DEFAULT_POST_LOAD_TIMEOUT_MS,
    () => new EngineUnavailableError("The post-load check timed out."),
  );
  const content = (result.body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (result.status < 200 || result.status >= 300 || typeof content !== "string" || !content.trim()) {
    throw new EngineUnavailableError("Post-load check did not receive a usable completion.");
  }
  return { replyOk: true, actualBytes: await measureProcessMemoryBytes(pid), estimatedBytes: null };
}

function selectedChatModel(): ModelRecord | null {
  return listModels().find((model) => model.roles.includes("chat") && isModelSelectable(model) && model.modelPath) ?? null;
}

async function startUrlBackend(kind: EngineKind, url: string): Promise<ChatBackend> {
  const client = new OpenAIEngineClient(url);
  const identity = await readEngineIdentity(url);
  if (!identity.healthy) {
    const reason = `The ${kind} engine is offline.`;
    emit({ id: "engine.state", data: { engine: "chat", state: "offline", reason } });
    raiseRepair("Chat engine is offline", reason, "check_host");
    throw new EngineUnavailableError(reason);
  }
  return { client, kind, identity, pid: null, activeRequests: 0, retired: false, stop: async () => {} };
}

async function startSpawnedBackend(): Promise<ChatBackend> {
  const pin = ENGINE_BINARIES.find((entry) => entry.platform === process.platform && entry.arch === process.arch && !entry.requiresNvidia);
  const model = selectedChatModel();
  if (!pin || !existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER))) {
    throw new EngineUnavailableError("No installed llama-server build is available for this machine.");
  }
  if (!model?.modelPath) throw new EngineUnavailableError("No verified and installed chat model is available.");

  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: model.sizeBytes ?? 0, modelFileBytes: model.sizeBytes, measuredPeakBytes: null, engine: "llama-server" });
  if ("queued" in admission) throw new EngineUnavailableError(`Chat admission is queued at position ${admission.position}.`);
  if ("refused" in admission) throw new EngineUnavailableError(admission.reason);

  const port = await findFreePort();
  const processHandle = Bun.spawn([engineBinaryPath(pin), "--model", model.modelPath, "--port", String(port)], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const client = new OpenAIEngineClient(`http://127.0.0.1:${port}`);
  const stderrText = processHandle.stderr ? new Response(processHandle.stderr).text() : Promise.resolve("");
  let exited = false;
  const exitPromise = processHandle.exited.then((code) => {
    exited = true;
    return code;
  });
  try {
    const exitFailure = exitPromise.then(async (code) => {
      const lines = (await stderrText).trim().split("\n").slice(-5).join(" | ");
      throw new EngineUnavailableError(`Engine exited before becoming healthy (code ${code})${lines ? `: ${lines}` : "."}`);
    });
    void exitFailure.catch(() => {});
    await Promise.race([waitHealthy(client, loadTimeoutForModel(model.sizeBytes), () => !exited), exitFailure]);
    const identity = await readEngineIdentity(client.baseUrl);
    const check = await postLoadCheck(client, processHandle.pid);
    state.status.postLoadCheck = check;
    const backend: ChatBackend = {
      client,
      kind: "spawned",
      identity,
      pid: processHandle.pid,
      activeRequests: 0,
      retired: false,
      governorHandle: admission,
      stopGovernor: startGovernor({ pid: processHandle.pid }),
      stop: async () => {
        processHandle.kill();
        await processHandle.exited;
      },
    };
    void processHandle.exited.then(() => {
      if (!backend.retired && state.backend === backend) {
        state.backend = null;
        state.status = { kind: "spawned", state: "offline", reason: "The spawned engine exited unexpectedly.", identity, postLoadCheck: check };
        state.startingPromise = null;
      }
    });
    return backend;
  } catch (error) {
    processHandle.kill();
    emit({ id: "engine.state", data: { engine: "chat", state: "offline", reason: (error as Error).message } });
    raiseRepair("Chat engine failed to start", (error as Error).message, "restart_engine");
    release(admission);
    throw error;
  }
}

async function startBackend(): Promise<ChatBackend> {
  if (testBackendFactory) return testBackendFactory();
  const configured = configuredUrl();
  if (configured) return startUrlBackend(configured.kind, configured.url);
  return startSpawnedBackend();
}

export function getChatEngineStatus(): ChatEngineStatus {
  if (state.backend && state.status.state !== "busy") state.status = { ...state.status, kind: state.backend.kind, state: "ready", identity: state.backend.identity, reason: null };
  return { ...state.status };
}

export async function getChatBackend(): Promise<ChatBackend> {
  if (state.manuallyStopped) throw new EngineUnavailableError("The chat engine was stopped by the operator.");
  if (state.backend) return state.backend;
  if (!state.startingPromise) {
    const generation = state.generation;
    state.status = { ...state.status, state: "loading", reason: null };
    state.startingPromise = startBackend().then(async (backend) => {
      if (generation !== state.generation) {
        backend.retired = true;
        await backend.stop();
        state.startingPromise = null;
        return getChatBackend();
      }
      state.backend = backend;
      state.status = { kind: backend.kind, state: "ready", reason: null, identity: backend.identity, postLoadCheck: state.status.postLoadCheck };
      return backend;
    }).catch((error) => {
      if (generation === state.generation) {
        state.startingPromise = null;
        state.status = { ...state.status, state: "offline", reason: (error as Error).message };
      }
      throw error;
    });
  }
  return state.startingPromise;
}

async function retireBackend(backend: ChatBackend): Promise<void> {
  backend.retired = true;
  backend.stopGovernor?.();
  while (backend.activeRequests > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await backend.stop();
  if (backend.governorHandle) release(backend.governorHandle);
}

export async function restartChatEngine(): Promise<void> {
  state.generation++;
  const previous = state.backend;
  state.backend = null;
  state.startingPromise = null;
  state.manuallyStopped = false;
  state.status = { ...state.status, state: "loading", reason: null };
  if (previous) await retireBackend(previous);
}

export async function stopChatEngine(): Promise<void> {
  state.generation++;
  state.manuallyStopped = true;
  const previous = state.backend;
  state.backend = null;
  state.startingPromise = null;
  state.status = { ...state.status, state: "stopped", reason: "Stopped by the operator." };
  if (previous) await retireBackend(previous);
}

export function reportChatEngineExited(reason = "The spawned engine exited unexpectedly."): void {
  const previous = state.backend;
  state.backend = null;
  state.startingPromise = null;
  state.status = { ...state.status, state: "offline", reason };
  emit({ id: "engine.state", data: { engine: "chat", state: "offline", reason } });
  raiseRepair("Chat engine is offline", reason, "restart_engine");
  if (previous) {
    previous.retired = true;
    void previous.stop();
  }
}

export async function completeChat(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const backend = await getChatBackend();
  backend.activeRequests++;
  state.status = { ...state.status, state: "busy", kind: backend.kind, identity: backend.identity };
  try {
    const completionMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : (timeoutOverrides.completionMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const result = await withTimeout(
      backend.client.complete({ ...body, model }, signal),
      completionMs,
      () => new EngineUnavailableError(`Engine completion timed out after ${Math.ceil(completionMs / 1000)}s.`),
    );
    if (result.status >= 500) {
      if (!await backend.client.health()) {
        throw new EngineUnavailableError(`Engine returned HTTP ${result.status} and is no longer healthy.`);
      }
    }
    return { ...result, headers: identityHeaders(backend.identity) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: 499, body: { error: "Request cancelled" }, headers: identityHeaders(backend.identity) };
    }
    if (await backend.client.health()) {
      const message = (error as Error).message;
      return { status: error instanceof EngineUnavailableError ? 504 : 503, body: { error: message }, headers: identityHeaders(backend.identity) };
    }
    const unavailable = error instanceof EngineUnavailableError
      ? error
      : new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    state.backend = null;
    state.status = { ...state.status, state: "offline", reason: unavailable.reason };
    void retireBackend(backend);
    throw unavailable;
  } finally {
    backend.activeRequests--;
    if (state.backend === backend && backend.activeRequests === 0) state.status = { ...state.status, state: "ready" };
  }
}

export function resetSupervisorForTests(): void {
  state.backend = null;
  state.startingPromise = null;
  state.generation++;
  state.manuallyStopped = false;
  state.status = initialStatus();
}

export function setSupervisorFactoryForTests(factory: BackendFactory | null): void {
  testBackendFactory = factory;
  resetSupervisorForTests();
}
