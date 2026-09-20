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
import { currentEngineBinary, currentEngineTag, engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { detectHardware } from "@/lib/hardware";
import { identityHeaders, modelFileName, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { isComponent, isModelSelectable, listModels, recordMeasuredFootprint, type ModelRecord } from "@/lib/modelStore";
import { readFileSync } from "node:fs";
// Imported as a file, so a compiled binary embeds the clip and the probe
// reads it there too, not only from a checkout.
import bundledClipFile from "../speech/fixtures/clover-two-seconds.wav" with { type: "file" };
import { TRANSCRIBE_PATH } from "@/speech/server";
import { loadedWeightsRepo, pocketTtsCommand, pocketTtsEnv, pocketTtsInstalled, POCKET_TTS_ESTIMATED_FOOTPRINT, POCKET_TTS_VERSION } from "@/speech/pocketTts";
import { comfyuiCommand, comfyuiEnv, comfyuiInstalled, COMFYUI_VERSION, linkCheckpoint, probeGenerator } from "@/generators/comfyui";
import { basename } from "node:path";
import { getRunState, release, setGovernorPid, startGovernor, type GovernorHandle, type GovernorTier } from "@/lib/governor";
import { proposeProfile } from "@/profiles";
import { AdmissionRefusedError, waitForAdmission, waitingReason } from "@/lib/admission";
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
  /** A request in the engine's own shape (a multipart form to Pocket
   * TTS's /tts), the reply streamed back as is. */
  raw?(path: string, init: { method: string; body?: FormData | string | Uint8Array; headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response>;
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
  /** Open live sessions on this process; a retire closes them first,
   * so a drain never waits on a client that would talk forever. */
  sessions?: Set<() => void>;
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
const SPAWNABLE_ROLES: RoleId[] = ["chat", "embed", "stt", "tts", "image"];
/** The roles the speech worker serves: their runtime ships with the
 * Stack (sherpa-onnx-node in package.json), never as an engine build. */
const SPEECH_ROLES: RoleId[] = ["stt"];
/** The roles a managed Python engine serves (Pocket TTS, STACK-94c;
 * ComfyUI, STACK-13b). */
const MANAGED_ROLES: RoleId[] = ["tts", "image"];
/** The generator roles: their process is admitted as `jit` (evicted
 * when idle) and each render is a job the queue admits on top. */
const GENERATOR_ROLES: RoleId[] = ["image"];
export const SPEECH_PATH = "/tts";

/** The role whose process serves this role: `coding`, `judge`, `router`
 * and `vision` share chat's model and process unless bound elsewhere. */
export function processRoleFor(role: RoleId): RoleId {
  const definition = ROLES[role] as { sharesModelWith?: RoleId };
  return definition.sharesModelWith ?? role;
}

// ---- the client -----------------------------------------------------------

class OpenAIEngineClient implements EngineClient {
  /** `healthPath`: the route that says the engine lives; llama-server,
   * the speech worker and Pocket TTS have `/health`, ComfyUI has
   * `/system_stats` and no `status` field, so any 2xx there counts. */
  constructor(readonly baseUrl: string, readonly healthPath = "/health") {}
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

  async raw(path: string, init: { method: string; body?: FormData | string | Uint8Array; headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.url(path), { method: init.method, headers: init.headers, body: init.body, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(this.url(this.healthPath), { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch { return false; }
  }
}

// ---- timeouts and probes --------------------------------------------------

const DEFAULT_POST_LOAD_TIMEOUT_MS = 120_000;
/** How long a start waits on the governor before it fails with the
 * governor's numbers: long enough for a release in flight, short
 * enough that a request through the public route answers. */
const START_WAIT_MS = 15_000;
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
/** The one short sentence the `tts` post-load check and readiness probe
 * render (a persona-roster name, never household text). */
export const PROBE_SENTENCE = "Clover, the kitchen light is on.";
/** spec/voice's /tts form: `text`, and a voice only when named. */
export function speechForm(text: string, voiceUrl?: string): FormData {
  const form = new FormData();
  form.append("text", text);
  if (voiceUrl) form.append("voice_url", voiceUrl);
  return form;
}
/** The speech wire's probe: the form through the engine's own shape, the
 * reply drained; ok when the engine answered 200 with audio. */
export async function probeSpeech(client: EngineClient, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  if (!client.raw) return { status: 501, body: { error: "The engine client cannot send a form." } };
  const response = await client.raw(SPEECH_PATH, { method: "POST", body: speechForm(PROBE_SENTENCE) }, signal);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, body: { bytes: bytes.byteLength, audio: type.startsWith("audio/") && bytes.byteLength > 44 } };
}

/** The checkpoint file a generator role's engine must list. */
export function expectedCheckpoint(role: RoleId): string | null {
  const model = selectedModel(role);
  return model?.modelPath ? basename(model.modelPath) : null;
}

let bundledClip: string | null = null;
/** The bundled two-second clip, base64, the `stt` probe's audio. */
export function bundledClipBase64(): string {
  bundledClip ??= readFileSync(bundledClipFile).toString("base64");
  return bundledClip;
}

export function probeRequest(role: RoleId): { path: string; body: Record<string, unknown> } {
  if (ROLES[role].wire === "embeddings") return { path: "/v1/embeddings", body: { model: role, input: "OK" } };
  if (ROLES[role].wire === "transcription") return { path: TRANSCRIBE_PATH, body: { model: role, audio_base64: bundledClipBase64() } };
  // The speech wire's probe is a form, sent by `probeSpeech`; this shape
  // is what a JSON caller would see and is never sent as JSON.
  if (ROLES[role].wire === "speech") return { path: SPEECH_PATH, body: { model: role, text: PROBE_SENTENCE } };
  // The job wire's probe asks the engine which checkpoints it can load,
  // sent by `probeGenerator`; a render is a job, never a probe.
  if (ROLES[role].wire === "job") return { path: "/object_info/CheckpointLoaderSimple", body: { model: role } };
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
  if (ROLES[role].wire === "transcription") {
    const text = (result.body as { text?: unknown }).text;
    return typeof text === "string" && text.trim().length > 0;
  }
  if (ROLES[role].wire === "speech") return (result.body as { audio?: unknown }).audio === true;
  if (ROLES[role].wire === "job") return (result.body as { checkpoint?: unknown }).checkpoint === true;
  const message = (result.body as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> }).choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : null;
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : null;
  return Boolean((content && content.trim()) || (reasoning && reasoning.trim()));
}

export async function postLoadCheck(role: RoleId, client: EngineClient, pid: number | null): Promise<PostLoadCheck> {
  const startedAt = performance.now();
  const probe = probeRequest(role);
  const result = await withTimeout(
    ROLES[role].wire === "speech" ? probeSpeech(client) : ROLES[role].wire === "job" ? probeGenerator(client, expectedCheckpoint(role)) : client.request(probe.path, probe.body),
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

/** Whether the role's engine is on this machine: the `current`
 * llama-server build for the chat wire, the bundled speech runtime plus
 * its detector component for the speech roles. */
function engineInstalledFor(role: RoleId): boolean {
  // A scripted engine stands in for an installed one, as it does at launch.
  if (testFactory) return true;
  if (SPEECH_ROLES.includes(role)) return componentModel(role, "vad") !== null;
  if (role === "tts") return pocketTtsInstalled() && componentModel(role, "tokenizer") !== null && componentModel(role, "voice") !== null;
  if (role === "image") return comfyuiInstalled();
  return engineInstalled();
}

function initialStatus(role: RoleId): RoleStatus {
  const installed = SPAWNABLE_ROLES.includes(role) && engineInstalledFor(role) && selectedModel(role) !== null;
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

/** Whether anything could serve the role: a selectable model for a
 * spawned engine, or a url binding. An offline role with neither has
 * nothing to probe or to repair. */
export function roleIsBound(requested: RoleId): boolean {
  const role = processRoleFor(requested);
  return urlBindingFor(role) !== null || (SPAWNABLE_ROLES.includes(role) && selectedModel(role) !== null);
}

/** Whether the role's engine is on this machine (or bound by url), as
 * distinct from its model: a generator with a checkpoint and no
 * environment is the honest no-engine answer, never a failed render. */
export function roleHasEngine(requested: RoleId): boolean {
  const role = processRoleFor(requested);
  return urlBindingFor(role) !== null || engineInstalledFor(role);
}

/** A piece the role's engine loads beside its model (the `stt` voice
 * activity detector), installed and verified like a model. */
export function componentModel(role: RoleId, component: string): ModelRecord | null {
  return listModels().find((model) => model.roles.includes(role) && model.engineRequirements.component === component && isModelSelectable(model) && model.modelPath) ?? null;
}

export function selectedModel(role: RoleId): ModelRecord | null {
  const selectable = listModels().filter((model) => model.roles.includes(role) && !isComponent(model) && isModelSelectable(model) && model.modelPath);
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

/** The speech worker's command line, built the way the daemon itself
 * was started: the compiled binary knows the subcommand; under `bun
 * run`, where execPath is bun itself, the entry file goes in between. */
export function speechWorkerCommand(args: { role: RoleId; port: number; modelPath: string; vadPath: string; threads: number }, runtime: { execPath: string; main: string } = { execPath: process.execPath, main: Bun.main }): string[] {
  const viaBun = /^bun(\.exe)?$/i.test(runtime.execPath.split(/[\\/]/).pop() ?? "");
  return [runtime.execPath, ...(viaBun ? [runtime.main] : []), "speech-worker", "--role", args.role, "--port", String(args.port), "--model", args.modelPath, "--vad", args.vadPath, "--threads", String(args.threads)];
}

interface LaunchPlan { command: string[]; engine: string; build: string; stdin: "pipe" | "ignore"; contextLength: number; kind: "spawned" | "managed"; env?: Record<string, string>; healthPath?: string; }

/** What to run for a role: llama-server from the `current` link for the
 * chat and embeddings wires, the speech worker for `stt`. */
function launchPlan(role: RoleId, model: ModelRecord, port: number): LaunchPlan {
  if (SPEECH_ROLES.includes(role)) {
    const vad = componentModel(role, "vad");
    if (!vad?.modelPath) throw new EngineUnavailableError(`The ${role} voice activity detector is not installed.`);
    const declared = engineSettingValues("engines.llama_server");
    const threads = typeof declared.threads === "number" && declared.threads > 0 ? declared.threads : 2;
    return { command: speechWorkerCommand({ role, port, modelPath: model.modelPath!, vadPath: vad.modelPath, threads }), engine: "sherpa-onnx-node", build: "bundled", stdin: "pipe", contextLength: 0, kind: "spawned" };
  }
  if (role === "image") {
    if (!comfyuiInstalled()) throw new EngineUnavailableError("The ComfyUI environment is not built on this machine.");
    // The pinned checkpoint, linked into ComfyUI's folder so the file it
    // loads is the store's.
    linkCheckpoint(model.modelPath!);
    return { command: comfyuiCommand(port), engine: "comfyui", build: COMFYUI_VERSION, stdin: "ignore", contextLength: 0, kind: "managed", env: comfyuiEnv(), healthPath: "/system_stats" };
  }
  if (role === "tts") {
    if (!pocketTtsInstalled()) throw new EngineUnavailableError("The Pocket TTS environment is not built on this machine.");
    // The person's token, if set, reaches exactly this environment.
    const token = settingValues()["stack.engines.tts.hf_token"];
    const env = pocketTtsEnv(typeof token === "string" && token.trim() ? { HF_TOKEN: token.trim() } : {});
    return { command: pocketTtsCommand(port), engine: "pocket-tts", build: POCKET_TTS_VERSION, stdin: "ignore", contextLength: 0, kind: "managed", env };
  }
  const declared = engineSettingValues("engines.llama_server");
  const config = { contextLength: declared.context_length, slots: declared.slots, threads: declared.threads, cacheRamMb: declared.cache_ram_mb, flashAttention: declared.flash_attention } as Record<string, number | boolean | string | string[]>;
  const pin = installedEnginePin();
  if (!pin || !engineInstalled()) throw new EngineUnavailableError("No installed llama-server build is available for this machine.");
  const contextLength = typeof config.contextLength === "number" ? config.contextLength : 4096;
  const binary = launchBinary(pin);
  const args = llamaServerArgs({ modelPath: model.modelPath!, port, config, contextLength, kvCacheQuantized: process.platform === "darwin", embeddings: role === "embed" });
  return { command: [binary, ...args], engine: "llama-server", build: currentEngineTag("llama-server") ?? pin.tag, stdin: "ignore", contextLength, kind: "spawned" };
}

async function startSpawnedProcess(role: RoleId): Promise<RoleProcess> {
  if (!SPAWNABLE_ROLES.includes(role)) throw new EngineUnavailableError(`No engine can be started for ${role} on this machine yet.`);
  const model = selectedModel(role);
  if (!engineInstalledFor(role)) {
    const reason = SPEECH_ROLES.includes(role) ? `The ${role} voice activity detector is not installed.`
      : role === "image" ? "The ComfyUI environment is not built on this machine."
      : role === "tts" ? (pocketTtsInstalled() ? "The tts tokenizer or default voice is not installed." : "The Pocket TTS environment is not built on this machine.")
      : "No installed llama-server build is available for this machine.";
    throw new EngineUnavailableError(reason);
  }
  if (!model?.modelPath) throw new EngineUnavailableError(`No verified and installed ${role} model is available.`);

  // A generator's process holds its checkpoint as a resident the
  // supervisor's idle unload evicts (the file times the engine's
  // multiplier until measured); each render is admitted on top by the
  // job queue. Pocket TTS is the runtime's footprint, not its weights
  // times a multiplier. A start the governor queues waits a short
  // while for memory (a request through the public route cannot hang
  // for minutes), then fails with the governor's words and numbers;
  // the wait's watcher releases a late admission, so no phantom.
  const managed = MANAGED_ROLES.includes(role);
  const generator = GENERATOR_ROLES.includes(role);
  const request = {
    id: role, kind: "resident" as const,
    requestedBytes: managed && !generator ? (model.measuredFootprintBytes ?? POCKET_TTS_ESTIMATED_FOOTPRINT) : model.sizeBytes ?? 0,
    modelFileBytes: managed && !generator ? null : model.sizeBytes,
    measuredPeakBytes: model.measuredFootprintBytes,
    engine: generator ? "comfyui" : managed ? "pocket-tts" : SPEECH_ROLES.includes(role) ? "sherpa-onnx-node" : "llama-server",
    pinned: pinnedModels.has(model.id),
  };
  let timedOut = false;
  // A stop or a restart during the wait (the generation moves) means
  // nobody wants this admission any more.
  const startGeneration = runtime(role).generation;
  let admission: GovernorHandle | null;
  try {
    admission = await waitForAdmission(request, { stillWanted: () => !timedOut && !stoppingAll && runtime(role).generation === startGeneration, timeoutMs: START_WAIT_MS, onGaveUp: () => { timedOut = true; } });
  } catch (error) {
    throw new EngineUnavailableError(error instanceof AdmissionRefusedError ? error.message.replace(/^\S+ needs about/, `The ${role} engine needs about`) : (error as Error).message);
  }
  if (!admission) throw new EngineUnavailableError(stoppingAll ? "The Stack is stopping." : runtime(role).generation !== startGeneration ? `The ${role} engine was stopped while it waited for memory.` : `${waitingReason(role, request)} The ${role} engine waited ${Math.round(START_WAIT_MS / 1000)} s for memory and gave up.`);

  const port = await findFreePort();
  let plan: LaunchPlan;
  try { plan = launchPlan(role, model, port); } catch (error) { release(admission); throw error; }
  const contextLength = plan.contextLength;
  const spawnEngine = () => {
    try {
      return Bun.spawn(plan.command, { stdout: "ignore", stderr: "pipe", stdin: plan.stdin, env: plan.env ?? { ...process.env, HF_HUB_CACHE: hfHubRoot } });
    } catch (error) {
      // A binary that will not even start (a truncated or wrong-arch file)
      // is the same failure as a crash before health, said in one sentence.
      release(admission);
      const code = (error as { code?: string }).code ?? (error as Error).name;
      const reason = `The ${plan.build} build of ${plan.engine} could not be started (${code}).`;
      emit({ id: "engine.state", data: { engine: role, state: "offline", reason } });
      raise({ code: `engine.crashed.${role}`, severity: "error", title: `${ROLES[role].label} engine failed to start`, text: reason, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
      throw new EngineUnavailableError(reason);
    }
  };
  const handle = spawnEngine();
  setGovernorPid(role, handle.pid);
  const client = new OpenAIEngineClient(`http://127.0.0.1:${port}`, plan.healthPath);
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
    let identity = await readEngineIdentity(client.baseUrl, undefined, plan.healthPath);
    // A managed engine exposes no build or model of its own; the Stack
    // knows both: the version it installed, and the model it linked (the
    // checkpoint file for ComfyUI; for Pocket TTS the weights the hub
    // cache holds, read after health and never assumed from the config).
    if (plan.kind === "managed") {
      const model_ = GENERATOR_ROLES.includes(role) ? basename(model.modelPath!) : loadedWeightsRepo({ tokenSet: !!plan.env?.HF_TOKEN })?.repo ?? null;
      identity = { ...identity, build: `${plan.engine}-${plan.build}`, model: model_ };
    }
    const check = await postLoadCheck(role, client, handle.pid);
    check.loadMs = Math.round(performance.now() - loadStartedAt);
    if (check.actualBytes !== null) recordMeasuredFootprint(model.id, check.actualBytes, contextLength);
    runtime(role).status.postLoadCheck = check;
    resolveHealth(`engine.crashed.${role}`);
    resolveHealth(`post-load-check-failed.${role}`);
    const loadedRevision = plan.kind === "managed" && !GENERATOR_ROLES.includes(role) ? loadedWeightsRepo({ tokenSet: !!plan.env?.HF_TOKEN })?.revision ?? null : null;
    const processRecord: RoleProcess = {
      role, kind: plan.kind, client, identity, modelId: model.id, modelRevision: loadedRevision ?? model.revision, pid: handle.pid, port, activeRequests: 0, retired: false,
      governorHandle: admission,
      stopGovernor: watchProcessMemory(role, handle.pid),
      stop: async () => { handle.kill(); await handle.exited; },
    };
    void handle.exited.then(() => {
      const current = runtime(role);
      if (!processRecord.retired && current.process === processRecord) {
        current.process = null;
        current.starting = null;
        current.status = { kind: plan.kind, state: "offline", reason: "The spawned engine exited unexpectedly.", identity, postLoadCheck: check };
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
  if (processRecord.kind === "spawned" || (processRecord.kind === "managed" && processRecord.pid !== null)) {
    const model = processRecord.modelId ? listModels().find((candidate) => candidate.id === processRecord.modelId) : null;
    const actual = processRecord.identity.model;
    // A spawned process serves one model record; if the store no longer
    // has it, what runs is not something the Stack vouches for.
    if (!model?.modelPath) return { ok: false, expected: null, actual, reason: `The engine runs ${processRecord.modelId ?? "an unknown model"}, which the store no longer has.` };
    // A managed engine's identity names the weights repository it loaded
    // (read from the hub cache); the record names the one pinned, and
    // the gated twin of that repository serves the same voice.
    if (processRecord.kind === "managed" && !GENERATOR_ROLES.includes(role)) {
      const pinnedRepo = typeof model.provenance.repo === "string" ? model.provenance.repo : null;
      const twins = pinnedRepo ? [pinnedRepo, pinnedRepo.replace(/-without-voice-cloning$/, "")] : [];
      if (!actual) return { ok: false, expected: pinnedRepo, actual, reason: "The engine's weights could not be read from the hub cache." };
      if (!twins.includes(actual)) return { ok: false, expected: pinnedRepo, actual, reason: `The engine loaded ${actual}; the pinned weights are ${pinnedRepo}.` };
      return { ok: true, expected: pinnedRepo, actual, reason: null };
    }
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

/** The machine's tier, from the hardware profile: the daemon sets it at
 * start, and every governor watch started for a process carries it, so
 * the governor keeps the tier's working margin back (a Studio's 20 GB,
 * not the p16 default's 4 GB; STACK-06e). */
let machineTier: GovernorTier | undefined;
export function setMachineTier(tier: GovernorTier | null | undefined): void { machineTier = tier ?? undefined; }
export function currentMachineTier(): GovernorTier | undefined { return machineTier; }
/** Reads the hardware, sets the tier from the proposed profile, and
 * starts the governor's own memory watch with it, so the tier's margin
 * is in force from the daemon's start, before any process is spawned
 * (a process's watch carries the same tier again). Returns the tier
 * and the watch's stop. */
export async function setMachineTierFromHardware(): Promise<{ tier: GovernorTier | null; stop: () => void }> {
  const hardware = await detectHardware();
  const tier = proposeProfile(hardware)?.id as GovernorTier | undefined;
  setMachineTier(tier);
  // The daemon's own pid: no loaded item carries it, so this watch only
  // keeps the reading and the tier, never restarts anything.
  return { tier: tier ?? null, stop: startGovernor({ pid: process.pid, tier: machineTier }) };
}

/** The governor's watch on a spawned process (its RSS against the
 * measured peak, a restart on a breach), carrying the machine's tier. */
export function watchProcessMemory(role: RoleId, pid: number): () => void {
  return startGovernor({ pid, tier: machineTier, restart: async () => { await restartRole(role); } });
}

/** A pid is the proof that this process was launched by this Stack. */
export function roleIsStackOwned(requested: RoleId): boolean {
  const current = runtime(processRoleFor(requested));
  return (current.process?.kind === "spawned" || current.process?.kind === "managed") && current.process.pid !== null;
}

export function roleCanBeStartedByStack(requested: RoleId): boolean {
  const role = processRoleFor(requested);
  return !runtime(role).process && !urlBindingFor(role) && SPAWNABLE_ROLES.includes(role);
}

async function retire(processRecord: RoleProcess): Promise<void> {
  processRecord.retired = true;
  processRecord.stopGovernor?.();
  for (const close of processRecord.sessions ?? []) close();
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

/** Set while the daemon stops, so a start still waiting on the
 * governor gives up at once instead of holding the stop for its
 * deadline; the wait's watcher returns any late admission. */
let stoppingAll = false;
export async function stopAllRoles(reason: string): Promise<void> {
  stoppingAll = true;
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
export interface RoleStreamReply { status: number; body: ReadableStream<Uint8Array> | null; headers: Record<string, string>; contentType?: string; }

/** The speech wire: spec/voice's form to the engine's /tts, the reply
 * streamed back as it is generated (audio/wav with the placeholder data
 * size the spec's consumer tolerates). A client abort closes our side
 * and is a normal end; a 4xx from the engine (an unknown voice) is
 * passed through with its body. */
export async function speakRole(requested: RoleId, form: FormData, signal?: AbortSignal): Promise<RoleStreamReply> {
  const role = processRoleFor(requested);
  const processRecord = await getProcess(role);
  const current = runtime(role);
  processRecord.activeRequests++;
  current.status = { ...current.status, state: "busy", kind: processRecord.kind, identity: processRecord.identity };
  const headers = () => identityHeaders(processRecord.identity, processRecord.modelRevision);
  try {
    if (!processRecord.client.raw) throw new EngineUnavailableError("The engine does not take a form.");
    const response = await processRecord.client.raw(SPEECH_PATH, { method: "POST", body: form }, signal);
    if (response.status >= 500 && !await processRecord.client.health()) throw new EngineUnavailableError(`Engine returned HTTP ${response.status} and is no longer healthy.`);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!response.body) { finishStream(role, processRecord); return { status: response.status, body: null, headers: headers(), contentType }; }
    if (response.status >= 200 && response.status < 300) current.lastRealRequestAt = Date.now();
    return { status: response.status, body: trackedStream(role, processRecord, response.body), headers: headers(), contentType };
  } catch (error) {
    finishStream(role, processRecord);
    if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) return { status: 499, body: null, headers: headers() };
    if (await processRecord.client.health()) return { status: error instanceof EngineUnavailableError ? 504 : 503, body: null, headers: headers() };
    const unavailable = error instanceof EngineUnavailableError ? error : new EngineUnavailableError(`Engine request failed: ${(error as Error).message}`);
    current.process = null;
    current.starting = null;
    current.status = { ...current.status, state: "offline", reason: unavailable.reason };
    emit({ id: "engine.state", data: { engine: role, state: "offline", reason: unavailable.reason } });
    void retire(processRecord);
    throw unavailable;
  }
}

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
  stoppingAll = false;
  for (const current of runtimes.values()) current.generation++;
  runtimes.clear();
  pinnedModels.clear();
  preferredModels.clear();
  scriptedHistoryLooks = 0;
  scriptedInterrupts = 0;
}

export function setSupervisorFactoryForTests(factory: ProcessFactory | null): void {
  testFactory = factory;
  resetSupervisorForTests();
}

/** A scripted process for the suite: answers every wire with a fixed
 * reply and streams two chunks, never touching a real engine. */
let scriptedHistoryLooks = 0;
let scriptedInterrupts = 0;
/** How many times the scripted ComfyUI was interrupted, for the suite. */
export function __scriptedInterruptsForTests(): number { return scriptedInterrupts; }
export function scriptedProcess(role: RoleId, overrides: Partial<RoleProcess> = {}): RoleProcess {
  const client: EngineClient = {
    baseUrl: "in-process://scripted",
    async request(path, body) {
      if (path === "/v1/embeddings") return { status: 200, body: { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }], model: role, usage: { prompt_tokens: 1, total_tokens: 1 } } };
      // The transcription wire: the bundled clip's sentence for any WAV
      // with bytes in it, an empty transcript for an empty one.
      if (path === TRANSCRIBE_PATH) return { status: 200, body: { text: typeof body.audio_base64 === "string" && body.audio_base64.length > 0 ? "Clover, the kitchen light is on." : "" } };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1) as { content?: unknown } | undefined;
      const content = typeof last?.content === "string" && last.content.trim() ? "Scripted Stack reply." : "The scripted Stack engine is ready.";
      return { status: 200, body: { id: "scripted-completion", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 } } };
    },
    async raw(path, init, signal) {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      // A scripted ComfyUI: one checkpoint on offer, a graph queued as
      // `scripted-prompt`, complete on the second look, one 1x1 PNG.
      if (path === "/object_info/CheckpointLoaderSimple") return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["scripted-image.safetensors"]] } } } });
      if (path === "/prompt") { scriptedHistoryLooks = 0; return json({ prompt_id: "scripted-prompt", number: 1, node_errors: {} }); }
      if (path.startsWith("/history/")) { scriptedHistoryLooks += 1; return json(scriptedHistoryLooks < 2 ? {} : { "scripted-prompt": { status: { completed: true, status_str: "success", messages: [] }, outputs: { "7": { images: [{ filename: "maipai_00001_.png", subfolder: "", type: "output" }] } } } }); }
      if (path.startsWith("/view?")) return new Response(Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")), { status: 200, headers: { "content-type": "image/png" } });
      if (path === "/queue" || path === "/interrupt") { scriptedInterrupts += path === "/interrupt" ? 1 : 0; return json({}); }
      if (path !== SPEECH_PATH) return json({ error: "Not found." }, 404);
      const form = init.body instanceof FormData ? init.body : null;
      const voice = form?.get("voice_url");
      if (typeof voice === "string" && voice && voice !== "alba") return new Response(JSON.stringify({ detail: `Unknown voice ${voice}.` }), { status: 400, headers: { "content-type": "application/json" } });
      // A 24 kHz mono 16-bit WAV in two chunks: the header with the
      // placeholder data size Pocket TTS writes, then a beat of silence.
      const header = new Uint8Array(44);
      const view = new DataView(header.buffer);
      const tag = (offset: number, text: string) => { for (let index = 0; index < 4; index += 1) header[offset + index] = text.charCodeAt(index); };
      tag(0, "RIFF"); view.setUint32(4, 2_000_000_036, true); tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 24_000, true); view.setUint32(28, 48_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, 2_000_000_000, true);
      const chunks = [header, new Uint8Array(4_800)];
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) { controller.error(new DOMException("Aborted", "AbortError")); return; }
          const next = chunks.shift();
          if (!next) { controller.close(); return; }
          await new Promise((resolve) => setTimeout(resolve, 5));
          controller.enqueue(next);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "audio/wav" } });
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

/** Runs work on a role's living process as one request: the process
 * is started if it is not (admitted, probed), counted busy while the
 * work runs so a drain waits for it, and its end is a real request for
 * the `ready` claim. An engine that stops answering during the work
 * is retired with the reason, as after any request. */
export async function runOnRole<T>(requested: RoleId, work: (processRecord: RoleProcess) => Promise<T>): Promise<T> {
  const role = processRoleFor(requested);
  const processRecord = await getProcess(role);
  const current = runtime(role);
  processRecord.activeRequests++;
  current.status = { ...current.status, state: "busy", kind: processRecord.kind, identity: processRecord.identity };
  try {
    const result = await work(processRecord);
    current.lastRealRequestAt = Date.now();
    return result;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError") && !await processRecord.client.health()) {
      const unavailable = new EngineUnavailableError(`Engine failed during a job: ${(error as Error).message}`);
      current.process = null;
      current.starting = null;
      current.status = { ...current.status, state: "offline", reason: unavailable.reason };
      emit({ id: "engine.state", data: { engine: role, state: "offline", reason: unavailable.reason } });
      void retire(processRecord);
      throw unavailable;
    }
    throw error;
  } finally {
    finishStream(role, processRecord);
  }
}

/** A live session on a role's process (the speech session): the process
 * counts it as an active request until `release`, so a drain waits for
 * it, and its end is a real request for the `ready` claim, as a
 * stream's end is. */
export interface RoleSession { baseUrl: string; headers: Record<string, string>; release(): void; }

/** `onRetire` runs when the process is stopped or restarted under the
 * session (the daemon stopping, a "Restart engine" fix): the caller
 * closes its client so the drain can finish. */
export async function openRoleSession(requested: RoleId, onRetire: () => void = () => {}): Promise<RoleSession> {
  const role = processRoleFor(requested);
  const processRecord = await getProcess(role);
  // A process retired while this session was being opened has already
  // closed its sessions; one registered now would hold the drain.
  if (processRecord.retired) throw new EngineUnavailableError(`The ${role} engine is restarting.`);
  processRecord.activeRequests++;
  processRecord.sessions ??= new Set();
  let released = false;
  const session: RoleSession = {
    baseUrl: processRecord.client.baseUrl,
    headers: identityHeaders(processRecord.identity, processRecord.modelRevision),
    release() {
      if (released) return;
      released = true;
      processRecord.sessions?.delete(close);
      finishStream(role, processRecord);
    },
  };
  const close = () => { onRetire(); session.release(); };
  processRecord.sessions.add(close);
  return session;
}
