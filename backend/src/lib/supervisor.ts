import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { ENGINE_READY_MARKER, installedEnginePin, selectEngineBinary } from "@/lib/engineCatalog";
import { llamaServerArgs } from "@/lib/engineArgs";
import { engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { detectHardware } from "@/lib/hardware";
import { identityHeaders, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { isModelSelectable, listModels, recordMeasuredFootprint, type ModelRecord } from "@/lib/modelStore";
import { withTimeout } from "@/lib/withTimeout";
import { admit, getRunState, release, startGovernor, type GovernorHandle } from "@/lib/governor";
import { emit } from "@/lib/events";
import { raise, resolve as resolveHealth } from "@/lib/health";
import type { RoleState } from "@/roles";
import { getMemoryReader } from "@/lib/memory";
import { readGgufFacts } from "@/lib/gguf";
import { hfHubRoot } from "@/lib/store/layout";
import { activateEngineConfig, settingValues } from "@/settings/engineKeys";
import { recordSpeedResult } from "@/lib/series";
import { recordModelFootprint, recordModelLoaded, recordModelUnloaded } from "@/lib/modelGroups";
import { getManagedEngineUrl } from "@/lib/detect";

export type EngineKind = "spawned" | "managed" | "url";

export type EngineStatus = RoleState | "loading" | "busy" | "stopped";

export interface ChatEngineStatus {
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

export function scriptedEnginesEnabled(): boolean {
  return process.env.STACK_SCRIPTED_ENGINES === "1" && process.env.NODE_ENV !== "production";
}

export async function measureProcessMemoryBytes(pid: number | null): Promise<number | null> {
  if (pid === null) return null;
  return getMemoryReader().processFootprint(pid);
}

export interface FootprintEstimate { bytes: number; estimated: boolean; contextLength: number; source: "dry-run" | "gguf"; }

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
    const fit = process.env.STACK_FIT_BINARY ?? (pin ? join(engineDir(pin.id), "llama-fit-params") : "");
    if (!fit || !existsSync(fit)) return null;
    const processHandle = Bun.spawn([fit, "--model", modelPath, "--ctx-size", String(contextLength), "--fit", "on", "--fit-print", "on"], { stdout: "pipe", stderr: "pipe" });
    const output = `${await new Response(processHandle.stdout).text()}\n${processHandle.stderr ? await new Response(processHandle.stderr).text() : ""}`;
    await processHandle.exited;
    return parseFitBytes(output);
  } catch { return null; }
}

import { hfUrl } from "@/lib/hf";

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

export interface EngineClient {
  readonly baseUrl: string;
  complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }>;
  stream?(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
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

  async stream(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.baseUrl.replace(/\/$/, "") + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new EngineUnavailableError("Engine streaming request failed: " + (error as Error).message);
    }
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
  lastRealRequestAt: number | null;
}

type BackendFactory = () => Promise<ChatBackend>;
let testBackendFactory: BackendFactory | null = null;

function initialStatus(): ChatEngineStatus {
  if (scriptedEnginesEnabled()) {
    return {
      kind: "url",
      state: "ready",
      reason: null,
      identity: { host: "stub", build: "scripted", model: "scripted-chat", healthy: true },
      postLoadCheck: { replyOk: true, actualBytes: null, estimatedBytes: null },
    };
  }
  const pin = installedEnginePin();
  const installed = !!pin && existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER));
  return { kind: null, state: installed ? "installed" : "notInstalled", reason: null, identity: null, postLoadCheck: null };
}

const state: SupervisorState = {
  backend: null,
  startingPromise: null,
  generation: 0,
  manuallyStopped: false,
  status: initialStatus(),
  lastRealRequestAt: null,
};

function configuredUrl(): { kind: EngineKind; url: string } | null {
  const adopted = getManagedEngineUrl("chat");
  if (adopted) return { kind: "managed", url: adopted };
  const managed = process.env.STACK_MANAGED_ENGINE_URL;
  if (managed) return { kind: "managed", url: managed };
  const url = process.env.STACK_CHAT_ENGINE_URL ?? process.env.MAIPAI_LLAMA_SERVER_URL;
  return url ? { kind: "url", url } : null;
}

class ScriptedEngineClient implements EngineClient {
  readonly baseUrl = "in-process://scripted";

  async complete(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1) as { content?: unknown } | undefined;
    const content = typeof last?.content === "string" && last.content.trim()
      ? "Scripted Stack reply."
      : "The scripted Stack engine is ready.";
    return {
      status: 200,
      body: {
        id: "scripted-completion",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 },
      },
    };
  }

  async stream(_body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const encoder = new TextEncoder();
    const chunks = [
      "data: " + JSON.stringify({ choices: [{ delta: { content: "Scripted" } }] }) + "\n\n",
      "data: " + JSON.stringify({ choices: [{ delta: { content: " Stack" } }] }) + "\n\n",
      "data: " + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 2 } }) + "\n\n",
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          if (signal?.aborted) {
            controller.error(new DOMException("Cancelled", "AbortError"));
            return;
          }
          controller.enqueue(encoder.encode(chunk));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        controller.close();
      },
      cancel() {},
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  async health(): Promise<boolean> {
    return true;
  }
}

function scriptedBackend(): ChatBackend {
  return {
    client: new ScriptedEngineClient(),
    kind: "url",
    identity: { host: "stub", build: "scripted", model: "scripted-chat", healthy: true },
    pid: null,
    activeRequests: 0,
    retired: false,
    stop: async () => {},
  };
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

export async function postLoadCheck(client: EngineClient, pid: number | null, contextLength = 4096): Promise<PostLoadCheck> {
  // `enable_thinking: false` asks the template to answer in content; a
  // thinking model that answers in reasoning_content is still alive.
  const startedAt = performance.now();
  const result = await withTimeout(
    client.complete({ model: "chat", messages: [{ role: "user", content: "Reply with just the word OK." }], max_tokens: 32, chat_template_kwargs: { enable_thinking: false } }),
    timeoutOverrides.postLoadMs ?? DEFAULT_POST_LOAD_TIMEOUT_MS,
    () => new EngineUnavailableError("The post-load check timed out."),
  );
  const message = (result.body as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> }).choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : null;
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : null;
  if (result.status < 200 || result.status >= 300 || !(content && content.trim()) && !(reasoning && reasoning.trim())) {
    throw new EngineUnavailableError("Post-load check did not receive a usable completion.");
  }
  return { replyOk: true, actualBytes: await measureProcessMemoryBytes(pid), estimatedBytes: null, firstTokenMs: Math.round(performance.now() - startedAt) };
}

function selectedChatModel(): ModelRecord | null {
  return listModels().find((model) => model.roles.includes("chat") && isModelSelectable(model) && model.modelPath) ?? null;
}

async function startUrlBackend(kind: EngineKind, url: string): Promise<ChatBackend> {
  activateEngineConfig("managed", "managed");
  const managed = settingValues("managed", "managed");
  const client = new OpenAIEngineClient(typeof managed.hostUrl === "string" && managed.hostUrl ? managed.hostUrl : url);
  const identity = await readEngineIdentity(url);
  if (!identity.healthy) {
    const reason = `The ${kind} engine is offline.`;
    emit({ id: "engine.state", data: { engine: "chat", state: "offline", reason } });
    raise({ code: "managed-host-offline", severity: "error", title: "Chat engine is offline", text: reason, cause: reason, fix: { label: "Check host", action: "check_host" } });
    throw new EngineUnavailableError(reason);
  }
  return { client, kind, identity, pid: null, activeRequests: 0, retired: false, stop: async () => {} };
}

async function startSpawnedBackend(): Promise<ChatBackend> {
  activateEngineConfig("llama-server", "llama-server");
  const config = settingValues("llama-server", "llama-server");
  const pin = installedEnginePin();
  const model = selectedChatModel();
  if (!pin || !existsSync(join(engineDir(pin.id), ENGINE_READY_MARKER))) {
    throw new EngineUnavailableError("No installed llama-server build is available for this machine.");
  }
  if (!model?.modelPath) throw new EngineUnavailableError("No verified and installed chat model is available.");

  const admission = await admit({ id: "chat", kind: "resident", requestedBytes: model.sizeBytes ?? 0, modelFileBytes: model.sizeBytes, measuredPeakBytes: model.measuredFootprintBytes, engine: "llama-server" });
  if ("queued" in admission) throw new EngineUnavailableError(`Chat admission is queued at position ${admission.position}.`);
  if ("refused" in admission) throw new EngineUnavailableError(admission.reason);

  const port = await findFreePort();
  const contextLength = typeof config.contextLength === "number" ? config.contextLength : 4096;
  const processHandle = Bun.spawn([engineBinaryPath(pin), ...llamaServerArgs({ modelPath: model.modelPath, port, config, contextLength, kvCacheQuantized: process.platform === "darwin" })], {
    stdout: "ignore",
    stderr: "pipe",
    env: { ...process.env, HF_HUB_CACHE: hfHubRoot },
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
    const loadStartedAt = performance.now();
    await Promise.race([waitHealthy(client, loadTimeoutForModel(model.sizeBytes), () => !exited), exitFailure]);
    const identity = await readEngineIdentity(client.baseUrl);
    const check = await postLoadCheck(client, processHandle.pid, contextLength);
    check.loadMs = Math.round(performance.now() - loadStartedAt);
    if (check.actualBytes !== null) { recordMeasuredFootprint(model.id, check.actualBytes, contextLength); recordModelFootprint(model.id, check.actualBytes); }
    state.status.postLoadCheck = check;
    resolveHealth("engine.crashed");
    resolveHealth("post-load-check-failed");
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
    recordModelLoaded(model.id);
    void processHandle.exited.then(() => {
      if (!backend.retired && state.backend === backend) {
        state.backend = null;
        state.status = { kind: "spawned", state: "offline", reason: "The spawned engine exited unexpectedly.", identity, postLoadCheck: check };
        raise({ code: "engine.crashed", severity: "error", title: "The chat engine crashed", text: "The spawned engine exited unexpectedly.", cause: "The engine process exited.", fix: { label: "Restart engine", action: "restart_engine" } });
        state.startingPromise = null;
      }
    });
    return backend;
  } catch (error) {
    processHandle.kill();
    emit({ id: "engine.state", data: { engine: "chat", state: "offline", reason: (error as Error).message } });
    const message = (error as Error).message;
    raise({ code: exited ? "engine.crashed" : "post-load-check-failed", severity: "error", title: "Chat engine failed to start", text: message, cause: message, fix: { label: "Restart engine", action: "restart_engine" } });
    release(admission);
    throw error;
  }
}

async function startBackend(): Promise<ChatBackend> {
  activateEngineConfig("llama-server", "llama-server");
  if (scriptedEnginesEnabled()) return scriptedBackend();
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
  if (getRunState() !== "running") throw new EngineUnavailableError("The Stack is paused.");
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
      if (backend.identity.model && getModelById(backend.identity.model)) recordModelLoaded(backend.identity.model);
      state.lastRealRequestAt = Date.now();
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

function getModelById(id: string | null): ModelRecord | null {
  return id ? listModels().find((model) => model.id === id) ?? null : null;
}

async function retireBackend(backend: ChatBackend): Promise<void> {
  backend.retired = true;
  backend.stopGovernor?.();
  while (backend.activeRequests > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await backend.stop();
  if (backend.identity.model) recordModelUnloaded(backend.identity.model);
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
  raise({ code: "managed-host-offline", severity: "error", title: "Chat engine is offline", text: reason, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
  emit({ id: "repair", data: { id: "managed-host-offline", title: "Chat engine is offline", detail: reason, action: "restart_engine", level: "immediate" } });
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
    const startedAt = performance.now();
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
    if (result.status >= 200 && result.status < 300) {
      state.lastRealRequestAt = Date.now();
      const usage = (result.body as { usage?: { completion_tokens?: unknown } }).usage;
      const completionTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;
      recordSpeedResult({ ability: model, modelId: backend.identity.model, engine: backend.identity.build, firstTokenMs: Math.round(performance.now() - startedAt), tokensPerSecond: completionTokens && completionTokens > 0 ? Math.round(completionTokens / Math.max((performance.now() - startedAt) / 1000, 0.001)) : null });
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

export interface ChatStreamResult {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers: Record<string, string>;
}

function finishStream(backend: ChatBackend): void {
  backend.activeRequests--;
  if (state.backend === backend) {
    if (backend.activeRequests === 0) state.status = { ...state.status, state: "ready" };
    state.lastRealRequestAt = Date.now();
  }
}

function trackedStream(backend: ChatBackend, upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    finishStream(backend);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

export async function streamChat(model: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatStreamResult> {
  const backend = await getChatBackend();
  backend.activeRequests++;
  state.status = { ...state.status, state: "busy", kind: backend.kind, identity: backend.identity };
  try {
    if (!backend.client.stream) throw new EngineUnavailableError("The engine does not support streaming.");
    const response = await backend.client.stream({ ...body, model, stream: true }, signal);
    if (response.status >= 500 && !await backend.client.health()) {
      throw new EngineUnavailableError("Engine returned HTTP " + response.status + " and is no longer healthy.");
    }
    if (!response.body) {
      finishStream(backend);
      return { status: response.status, body: null, headers: identityHeaders(backend.identity) };
    }
    return { status: response.status, body: trackedStream(backend, response.body), headers: identityHeaders(backend.identity) };
  } catch (error) {
    finishStream(backend);
    if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) {
      return { status: 499, body: null, headers: identityHeaders(backend.identity) };
    }
    if (error instanceof EngineUnavailableError) {
      if (await backend.client.health()) {
        return { status: 504, body: null, headers: identityHeaders(backend.identity) };
      }
      state.backend = null;
      state.status = { ...state.status, state: "offline", reason: error.reason };
      void retireBackend(backend);
      throw error;
    }
    if (await backend.client.health()) {
      return { status: 503, body: null, headers: identityHeaders(backend.identity) };
    }
    state.backend = null;
    state.status = { ...state.status, state: "offline", reason: (error as Error).message };
    void retireBackend(backend);
    throw new EngineUnavailableError("Engine streaming request failed: " + (error as Error).message);
  }
}

export function resetSupervisorForTests(): void {
  state.backend = null;
  state.startingPromise = null;
  state.generation++;
  state.manuallyStopped = false;
  state.status = initialStatus();
  state.lastRealRequestAt = null;
}

// The moment the last real request (or post-load check) succeeded, or null
// if none has since the supervisor started. This is the source of a role's
// `ready` claim and its `checkedAt` stamp.
export function lastRealRequestAt(): number | null {
  return state.lastRealRequestAt;
}

export function setSupervisorFactoryForTests(factory: BackendFactory | null): void {
  testBackendFactory = factory;
  resetSupervisorForTests();
}
