// The per-role supervisor: one process per role binding, three kinds
// (spawned by the Stack, a managed sidecar, a read-only url the person
// runs), one lifecycle. The pieces that were paid for in the chat-only
// supervisor (the generation guard, the free-port probe, the size-scaled
// liveness wait, the post-load completion, the measured footprint, the
// exit watch, the drain) are the same here, keyed by role.
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { withTimeout } from "@maipai/core/src/withTimeout";
import { isCompiledBinary } from "@/lib/paths";
import { ENGINE_READY_MARKER, installedEnginePin, selectEngineBinary, type ChatEngine, type EngineBinaryPin } from "@/lib/engineCatalog";
import { managedEnv } from "@/lib/uvEnvironment";
import { defaultKvCacheType, llamaServerArgs, mlxKvQuantFor, mlxServeArgs } from "@/lib/engineArgs";
import { currentEngineBinary, currentEngineTag, engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { detectHardware, primaryBudgetBytes } from "@/lib/hardware";
import { identityHeaders, modelFileName, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { getModel, isComponent, isModelSelectable, listModels, recordMeasuredFootprint, type ModelRecord } from "@/lib/modelStore";
import { readFileSync } from "node:fs";
// Imported as a file, so a compiled binary embeds the clip and the probe
// reads it there too, not only from a checkout.
import bundledClipFile from "../speech/fixtures/clover-two-seconds.wav" with { type: "file" };
import { TRANSCRIBE_PATH } from "@/speech/server";
import { loadedWeightsRepo, pocketTtsCommand, pocketTtsEnv, pocketTtsInstalled, POCKET_TTS_ESTIMATED_FOOTPRINT, POCKET_TTS_VERSION } from "@/speech/pocketTts";
import { ensureCloningWeights, POCKET_TTS_PRESET_VOICES, voiceCloningOn } from "@/speech/voices";
import { comfyuiCommand, comfyuiEnv, comfyuiInstalled, COMFYUI_VERSION, linkCheckpoint, probeGenerator } from "@/generators/comfyui";
import { basename } from "node:path";
import { getRunState, refreshMeasuredPeak, release, setGovernorPid, startGovernor, touch as touchGovernor, withdraw as withdrawAdmission, type GovernorHandle, type GovernorTier } from "@/lib/governor";
import { PROFILE_MODEL_BINDINGS, proposeProfile } from "@/profiles";
import { AdmissionRefusedError, waitForAdmission, waitingReason } from "@/lib/admission";
import { emit } from "@/lib/events";
import { MLX_PREFIX_CACHE_FLAG, mlxHeadroomBytes } from "@/lib/mlxMemory";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { ROLES, ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { getMemoryReader } from "@/lib/memory";
import { hfHubRoot } from "@/lib/store/layout";
import { engineSettingValues, settingValues } from "@/settings";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { logger } from "@/lib/log";
import { readGgufFacts } from "@/lib/gguf";
import { largestAdmittedContext, runGgufParser } from "@/lib/fitPlan";
import { getGovernorStatus } from "@/lib/governor";
import { readMlxKvBytesPerToken } from "@/lib/mlxMemory";

export type EngineKind = "spawned" | "managed" | "url";
export type EngineStatus = RoleState | "loading" | "busy" | "stopped";

export interface RoleStatus {
  kind: EngineKind | null;
  state: EngineStatus;
  reason: string | null;
  identity: EngineIdentity | null;
  postLoadCheck: PostLoadCheck | null;
  contextLength?: number | null;
  slots?: number | null;
  contextScope?: "total across slots" | "per slot" | null;
}

export interface PostLoadCheck {
  replyOk: boolean;
  actualBytes: number | null;
  estimatedBytes: number | null;
  loadMs?: number;
  firstTokenMs?: number;
}

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
  /** The engine this process is (the launch plan's name: `llama-server`,
   * `mlx-serve`, `comfyui`), so a route judges what runs, not what the
   * setting names for the next start. */
  engine: string | null;
  contextLength?: number;
  slots?: number;
  contextScope?: "total across slots" | "per slot";
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
const SPAWNABLE_ROLES: RoleId[] = ["chat", "judge", "embed", "vision", "stt", "tts", "image"];
/** The roles the speech worker serves: their runtime ships with the
 * Stack (sherpa-onnx-node in package.json), never as an engine build. */
const SPEECH_ROLES: RoleId[] = ["stt"];
/** The roles a managed Python engine serves (Pocket TTS, STACK-94c;
 * ComfyUI, STACK-13b). */
const MANAGED_ROLES: RoleId[] = ["tts", "image"];
/** The generator roles: their process is admitted as `jit` (evicted
 * when idle) and each render is a job the queue admits on top. */
const GENERATOR_ROLES: RoleId[] = ["image"];
/** The roles loaded on a request and evicted when idle (VISION-01b): the
 * governor admits them as `jit`, they yield to a resident role's start,
 * and an admission never evicts or shrinks a resident. */
const JIT_ROLES: RoleId[] = ["vision"];
export const SPEECH_PATH = "/tts";

/** The role whose process serves this role: `coding`, `judge` and
 * `router` share chat's model and process unless bound elsewhere. */
export function processRoleFor(role: RoleId): RoleId {
  const definition = ROLES[role] as { sharesModelWith?: RoleId };
  if (role === "judge" && machineTier && PROFILE_MODEL_BINDINGS[machineTier]?.judge) return role;
  if (role === "judge" && !machineTier) return "chat";
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
const START_RETRY_BASE_MS = 5_000;
const START_RETRY_CAP_MS = 5 * 60_000;
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

/** A 16 by 16 solid red PNG, the vision probe's picture: no person, no
 * household content, nothing fetched. */
export const VISION_PROBE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==";

export function probeRequest(role: RoleId): { path: string; body: Record<string, unknown> } {
  if (ROLES[role].wire === "embeddings") return { path: "/v1/embeddings", body: { model: role, input: "OK" } };
  if (ROLES[role].wire === "transcription") return { path: TRANSCRIBE_PATH, body: { model: role, audio_base64: bundledClipBase64() } };
  // The speech wire's probe is a form, sent by `probeSpeech`; this shape
  // is what a JSON caller would see and is never sent as JSON.
  if (ROLES[role].wire === "speech") return { path: SPEECH_PATH, body: { model: role, text: PROBE_SENTENCE } };
  // The job wire's probe asks the engine which checkpoints it can load,
  // sent by `probeGenerator`; a render is a job, never a probe.
  if (ROLES[role].wire === "job") return { path: "/object_info/CheckpointLoaderSimple", body: { model: role } };
  // The vision role's probe carries a picture, so "ready" means the
  // projector reads one, not only that the language model answers.
  if (role === "vision") return { path: "/v1/chat/completions", body: { model: role, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: VISION_PROBE_IMAGE } }, { type: "text", text: "What colour fills this picture? Reply with one word." }] }], max_tokens: 16 } };
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

export function parseFitRows(output: string): { rows: { name: string; modelMiB: number; contextMiB: number; computeMiB: number }[] } | null {
  const rows: { name: string; modelMiB: number; contextMiB: number; computeMiB: number }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ name: match[1]!, modelMiB: Number(match[2]), contextMiB: Number(match[3]), computeMiB: Number(match[4]) });
  }
  return rows.length ? { rows } : null;
}

export function fitTotalBytes(parsed: NonNullable<ReturnType<typeof parseFitRows>>): number {
  // Conservative on unified memory; per-device accounting for a discrete GPU belongs to STACK-SIZE-06.
  return parsed.rows.reduce((sum, row) => sum + row.modelMiB + row.contextMiB + row.computeMiB, 0) * 1_048_576;
}

export async function dryRunFootprint(modelPath: string, contextLength: number): Promise<number | null> {
  try {
    const hardware = await detectHardware(); const pin = selectEngineBinary(hardware);
    const fit = process.env.STACK_FIT_BINARY ?? (pin ? join(engineDir(pin), "llama-fit-params") : "");
    if (!fit || !existsSync(fit)) return null;
    const processHandle = Bun.spawn([fit, "--model", modelPath, "--ctx-size", String(contextLength), "--fit", "on", "--fit-print", "on"], { stdout: "pipe", stderr: "pipe" });
    const outputPromise = (async () => `${await new Response(processHandle.stdout).text()}\n${processHandle.stderr ? await new Response(processHandle.stderr).text() : ""}`)();
    const combined = Promise.all([outputPromise, processHandle.exited]);
    try {
      const [output, exitCode] = await withTimeout(combined, 30_000, () => new Error("llama-fit-params timed out."));
      if (exitCode !== 0) return null;
      const parsed = parseFitRows(output);
      return parsed ? fitTotalBytes(parsed) : null;
    } catch (error) {
      if ((error as Error).message === "llama-fit-params timed out.") processHandle.kill();
      return null;
    }
  } catch { return null; }
}

// ---- per-role state -------------------------------------------------------

interface RoleRuntime {
  process: RoleProcess | null;
  starting: Promise<RoleProcess> | null;
  generation: number;
  manuallyStopped: boolean;
  status: RoleStatus;
  lastRealRequestAt: number | null;
  startFailureCount: number;
  retryAfter: number;
}

type ProcessFactory = (role: RoleId, modelId?: string) => Promise<RoleProcess>;
let testFactory: ProcessFactory | null = null;
const runtimes = new Map<RoleId, RoleRuntime>();
const lastRoleStateLog = new Map<RoleId, string>();
const requestLocks = new Map<RoleId, Promise<void>>();

function emitRoleState(role: RoleId, state: RoleState, reason?: string): void {
  const signature = `${state}\n${reason ?? ""}`;
  if (lastRoleStateLog.get(role) === signature) return;
  lastRoleStateLog.set(role, signature);
  const data = { role, state, since: new Date().toISOString(), ...(reason ? { reason } : {}) };
  logger.appendLine(JSON.stringify({ event: "role.state", ...data }));
  emit({ id: "role.state", data });
}

async function acquireRequestProcess(requested: RoleId, modelId?: string): Promise<RoleProcess> {
  const role = processRoleFor(requested);
  const previous = requestLocks.get(role) ?? Promise.resolve();
  let unlock = () => {};
  const held = new Promise<void>((resolve) => { unlock = resolve; });
  const tail = previous.then(() => held);
  requestLocks.set(role, tail);
  await previous;
  try {
    const processRecord = await getProcess(role, modelId);
    processRecord.activeRequests++;
    // A request keeps a jit role's idle clock at zero.
    if (JIT_ROLES.includes(role)) touchGovernor(role);
    const current = runtime(role);
    current.status = { ...current.status, state: "busy", kind: processRecord.kind, identity: processRecord.identity };
    return processRecord;
  } finally {
    unlock();
    if (requestLocks.get(role) === tail) requestLocks.delete(role);
  }
}

// The build that runs is the one the store's `current` link names (the
// swap and the rollback flip that link); before any swap it is the
// machine's pin, which the first install activated.
function engineInstalled(name: ChatEngine = "llama-server"): boolean {
  const current = currentEngineBinary(name, name);
  if (current.state === "ready") return true;
  if (current.state === "unready") return false;
  const pin = installedEnginePin(name);
  return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER));
}

/** The chat wire's engine, from the setting (STACK-93): llama-server
 * unless the person chose mlx-serve; the embed role stays on
 * llama-server, whose embeddings wire the MLX engine does not serve
 * for the pinned models. */
export function chatEngine(): ChatEngine {
  const chosen = settingValues()["stack.engines.chat.engine"];
  return chosen === "mlx-serve" ? "mlx-serve" : "llama-server";
}
function engineForRole(role: RoleId): string | null {
  // The vision projector is a llama-server feature (mtmd); the MLX
  // engine choice for chat never moves it.
  if (role === "vision") return "llama-server";
  if (CHAT_WIRE_ROLES.includes(role)) return chatEngine();
  if (role === "embed") return "llama-server";
  return null;
}

// The binary to launch: the `current` link's build; the machine pin's own
// directory only before any link exists. A link that names an unready
// build is a refusal, never a silent fallback to another build.
function launchBinary(pin: EngineBinaryPin): string {
  const current = currentEngineBinary(pin.name, pin.tool ?? "llama-server");
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
  if (role === "vision") {
    const model = selectedModel(role);
    return !!model && projectorFor(model) !== null && engineInstalled("llama-server");
  }
  return engineInstalled(engineForRole(role) === "mlx-serve" ? "mlx-serve" : "llama-server");
}

function initialStatus(role: RoleId): RoleStatus {
  const installed = SPAWNABLE_ROLES.includes(role) && engineInstalledFor(role) && selectedModel(role) !== null;
  return { kind: null, state: installed ? "installed" : "notInstalled", reason: null, identity: null, postLoadCheck: null };
}

function runtime(role: RoleId): RoleRuntime {
  let current = runtimes.get(role);
  if (!current) {
    current = { process: null, starting: null, generation: 0, manuallyStopped: false, status: initialStatus(role), lastRealRequestAt: null, startFailureCount: 0, retryAfter: 0 };
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

/** Whether a model record declares picture input (the spec's
 * ModelCapabilities.image_input): the one test for the vision role,
 * never a model id (Home rule 8). */
export function declaresImageInput(model: ModelRecord): boolean {
  const declared = model.engineRequirements.imageInput as { projector?: unknown } | undefined;
  return typeof declared?.projector === "string" && declared.projector.length > 0;
}

/** The installed, verified projector a vision model names, or null. */
export function projectorFor(model: ModelRecord): ModelRecord | null {
  if (!declaresImageInput(model)) return null;
  const id = (model.engineRequirements.imageInput as { projector: string }).projector;
  return listModels().find((candidate) => candidate.id === id && candidate.engineRequirements.component === "projector" && isModelSelectable(candidate) && !!candidate.modelPath) ?? null;
}

/** A record the role can run: its own role, not a component, verified,
 * on disk, for the role's engine, and for `vision` declaring picture
 * input. */
function servesRole(model: ModelRecord, role: RoleId, engine: string | null): boolean {
  return model.roles.includes(role) && !isComponent(model) && isModelSelectable(model) && !!model.modelPath && (!engine || !model.engineRequirements.engine || model.engineRequirements.engine === engine) && (role !== "vision" || declaresImageInput(model));
}

export function selectedModel(role: RoleId): ModelRecord | null {
  if (role === "judge" && (!machineTier || !PROFILE_MODEL_BINDINGS[machineTier]?.judge)) return selectedModel("chat");
  // A record names the engine it is for; the chat wire's chosen engine
  // decides which records can serve it (a GGUF for llama-server, an MLX
  // directory for mlx-serve), both installed side by side.
  const engine = engineForRole(role);
  const selectable = listModels().filter((model) => servesRole(model, role, engine));
  const preferred = preferredModels.get(role);
  const profileModel = machineTier ? PROFILE_MODEL_BINDINGS[machineTier]?.[role] : undefined;
  return selectable.find((model) => model.id === preferred) ?? selectable.find((model) => model.id === profileModel) ?? selectable[0] ?? null;
}

/** Models an installed chat process can actually start for a request.
 * Kept beside selection so the API and dispatcher share the same
 * provenance, file and engine-compatibility rules. */
export function selectableModels(role: RoleId): Array<{ id: string; name: string }> {
  const engine = engineForRole(role);
  return listModels()
    .filter((model) => servesRole(model, role, engine))
    .map(({ id }) => ({ id, name: id }));
}

function selectableModel(role: RoleId, modelId: string): ModelRecord | null {
  const engine = engineForRole(role);
  return listModels().find((model) => model.id === modelId && servesRole(model, role, engine)) ?? null;
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
  return { role, kind: "url", client, identity, engine: null, modelId: null, modelRevision: null, pid: null, port: Number(new URL(url).port) || null, activeRequests: 0, retired: false, stop: async () => {} };
}

/** The speech worker's command line, built the way the daemon itself
 * was started: under `bun run`, where execPath is bun itself, the
 * entry file goes in between. A compiled binary is the one case that
 * does NOT just know its own subcommand: sherpa-onnx-node's native
 * binding cannot be loaded from inside a `bun build --compile` binary
 * at all once the same binary also contains the daemon's graph
 * (getmaipai/stack#8, a genuine Bun bundler bug - full repro in
 * speech/sherpa.ts's own loadModule()), so a compiled daemon instead
 * runs the worker through a real `bun`, against the vendored source
 * tree scripts/build-binary.sh ships as `backend-src/` beside the
 * binary - the same source and node_modules a normal `bun run` already
 * resolves the native binding from correctly today, proven live.
 * `STACK_BUN_BIN` (the installer's own bun, the same one it builds the
 * frontend with) is required in that case; unset is a clear error, not
 * a silent fallback to the broken compiled path. */
export function speechWorkerCommand(
  args: { role: RoleId; port: number; modelPath: string; vadPath: string; threads: number },
  runtime: { execPath: string; main: string; isCompiled: boolean; bunBin?: string } = { execPath: process.execPath, main: Bun.main, isCompiled: isCompiledBinary, bunBin: process.env.STACK_BUN_BIN },
): string[] {
  const workerArgs = ["speech-worker", "--role", args.role, "--port", String(args.port), "--model", args.modelPath, "--vad", args.vadPath, "--threads", String(args.threads)];
  if (runtime.isCompiled) {
    if (!runtime.bunBin) throw new EngineUnavailableError("STACK_BUN_BIN is not set; a compiled build runs the stt worker through a real bun, not a re-invocation of itself (getmaipai/stack#8).");
    return [runtime.bunBin, join(dirname(runtime.execPath), "backend-src", "src", "index.ts"), ...workerArgs];
  }
  const viaBun = /^bun(\.exe)?$/i.test(runtime.execPath.split(/[\\/]/).pop() ?? "");
  return [runtime.execPath, ...(viaBun ? [runtime.main] : []), ...workerArgs];
}

export interface LaunchPlan { command: string[]; engine: string; build: string; stdin: "pipe" | "ignore"; contextLength: number; slots?: number; contextScope?: "total across slots" | "per slot"; kind: "spawned" | "managed"; env?: Record<string, string>; healthPath?: string; }

async function contextForLaunch(model: ModelRecord, config: Record<string, number | boolean | string | string[]>, slots = 1): Promise<number> {
  const configured = config.contextLength;
  if (typeof configured === "number" && configured > 0) return configured;
  const status = getGovernorStatus();
  const hardware = await detectHardware();
  const gpuBudgets = hardware.cudaDevices.map((device) => device.vramBytes - (device.usedVramBytes ?? 0));
  const modelCapBytes = Math.min(status.capBytes, primaryBudgetBytes(hardware) || status.capBytes);
  const modelContextTokens = model.modelPath?.endsWith(".gguf")
    ? (await readGgufFacts(model.modelPath, { allowLocalFile: true })).contextLength
    : (() => {
      try { const configPath = join(model.modelPath!, "config.json"); return JSON.parse(readFileSync(configPath, "utf8")).max_position_embeddings ?? 4096; }
      catch { return 4096; }
    })();
  const max = Math.min(modelContextTokens || 4096, 262_144);
  const estimateAt = (contextTokens: number) => model.modelPath?.endsWith(".gguf")
    ? runGgufParser({ target: { path: model.modelPath }, contextTokens: contextTokens * slots, kvCacheType: defaultKvCacheType(), gpuLayers: "all" })
    : null;
  const cpuEstimateAt = (contextTokens: number) => model.modelPath?.endsWith(".gguf")
    ? runGgufParser({ target: { path: model.modelPath }, contextTokens: contextTokens * slots, kvCacheType: defaultKvCacheType(), gpuLayers: 0 })
    : null;
  if (!model.modelPath?.endsWith(".gguf")) {
    const mlxFacts = readMlxKvBytesPerToken(model.modelPath!) === null ? null : { weightsBytes: model.sizeBytes ?? 0, config: JSON.parse(readFileSync(join(model.modelPath!, "config.json"), "utf8")) };
    const result = await largestAdmittedContext({ modelId: model.id, modelFileBytes: model.sizeBytes ?? undefined, measuredPeakBytes: model.measuredFootprintBytes, modelContextTokens: max, mlx: mlxFacts, estimate: null, estimateAt: () => null, kvCacheType: defaultKvCacheType(), unifiedMemory: hardware.isAppleSilicon, deviceBudgetsBytes: gpuBudgets, capBytes: modelCapBytes, workingMarginBytes: status.marginBytes, loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })), asOf: new Date().toISOString().slice(0, 10), tool: { name: "fit-plan", version: "launch" } });
    if (result.plan.verdict !== "yes") {
      const peak = result.plan.roles[0]?.peak.high;
      throw new EngineUnavailableError(`The fit plan cannot admit the minimum 8,192 token context; estimated peak ${peak === null || peak === undefined ? "unknown" : `${(peak / 1_073_741_824).toFixed(1)} GB`} against a ${(modelCapBytes / 1_073_741_824).toFixed(1)} GB model budget.`);
    }
    return result.contextTokens;
  }
  const result = await largestAdmittedContext({ modelId: model.id, modelFileBytes: model.sizeBytes ?? undefined, measuredPeakBytes: model.measuredFootprintBytes, modelContextTokens: Math.floor(max / slots), estimate: null, estimateAt, cpuEstimateAt, memoryContextMultiplier: slots, kvCacheType: defaultKvCacheType(), unifiedMemory: hardware.isAppleSilicon, deviceBudgetsBytes: gpuBudgets, capBytes: modelCapBytes, workingMarginBytes: status.marginBytes, loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })), asOf: new Date().toISOString().slice(0, 10), tool: { name: "gguf-parser", version: "launch" } });
  if (result.plan.verdict !== "yes" && result.plan.verdict !== "slow") {
    const peak = result.plan.roles[0]?.peak.high;
    const memoryReason = `The fit plan cannot admit the minimum 8,192 token context for ${model.id}; estimated peak ${peak === null || peak === undefined ? "unknown" : `${(peak / 1_073_741_824).toFixed(1)} GB`} against a ${(modelCapBytes / 1_073_741_824).toFixed(1)} GB model budget.`;
    throw new EngineUnavailableError(memoryReason);
  }
  return result.contextTokens;
}

/** The whole-machine peak a vision pin carries from a real load on a
 * named machine, or null. */
function measuredPeakFromPin(model: ModelRecord): number | null {
  const measured = model.engineRequirements.measured as { footprintBytes?: unknown } | undefined;
  return typeof measured?.footprintBytes === "number" && measured.footprintBytes > 0 ? measured.footprintBytes : null;
}

/** The context a record's own launch declares (the vision role's short
 * one), which the chat settings never move. */
function declaredLaunchContext(model: ModelRecord): number | null {
  const launch = model.engineRequirements.launch as { contextLength?: unknown } | undefined;
  return typeof launch?.contextLength === "number" && launch.contextLength > 0 ? launch.contextLength : null;
}

/** A resident role about to start yields nothing: every loaded `jit`
 * role is unloaded first, so the resident's context is sized against
 * the residents alone and is never shrunk by a picture model (rule 4). */
async function yieldJitRolesTo(role: RoleId): Promise<void> {
  for (const jit of JIT_ROLES) {
    const current = runtimes.get(jit);
    const launch = current?.starting ?? null;
    // The generation moves first, so a start in flight is no longer
    // wanted: still queued for memory, it is withdrawn at once (chat never
    // waits on a picture model's admission); already admitted and loading,
    // its memory is counted, so chat waits for it to be retired before it
    // is sized (rule 4).
    if (current?.process || launch) await unloadRole(jit, `Unloaded so ${role} starts at its full context.`);
    if (!launch) continue;
    if (getGovernorStatus().loaded.some((item) => item.id === jit)) await launch.catch(() => undefined);
    else { withdrawAdmission(jit); void launch.catch(() => undefined); }
  }
}

/** Resident starts in progress: while any runs, a jit role does not
 * start, so nothing new is admitted beside a resident being sized. */
let residentStarts = 0;

/** What to run for a role: llama-server from the `current` link for the
 * chat and embeddings wires, the speech worker for `stt`. */
/** What to run for a role, exported for the suite; the supervisor calls it after admission. */
export async function launchPlan(role: RoleId, model: ModelRecord, port: number, resolvedContextLength?: number): Promise<LaunchPlan> {
  if (SPEECH_ROLES.includes(role)) {
    const vad = componentModel(role, "vad");
    if (!vad?.modelPath) throw new EngineUnavailableError(`The ${role} voice activity detector is not installed.`);
    const declared = engineSettingValues("engines.llama_server");
    const threads = typeof declared.threads === "number" && declared.threads > 0 ? declared.threads : 2;
    // speechWorkerCommand() itself picks the compiled-binary-vs-bun-run
    // shape (see its own comment, getmaipai/stack#8); no special env
    // needed here either way - a real `bun run` against the vendored
    // source resolves the native binding exactly as dev already does.
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
    // Offline always; the token never travels (STACK-94d).
    return { command: pocketTtsCommand(port), engine: "pocket-tts", build: POCKET_TTS_VERSION, stdin: "ignore", contextLength: 0, kind: "managed", env: pocketTtsEnv() };
  }
  const declared = engineSettingValues("engines.llama_server");
  const config = { contextLength: declared.context_length, slots: declared.slots, threads: declared.threads, cacheRamMb: declared.cache_ram_mb, flashAttention: declared.flash_attention } as Record<string, number | boolean | string | string[]>;
  // A record with its own launch (vision) runs one slot, as its args say.
  const slots = declaredLaunchContext(model) !== null ? 1 : typeof config.slots === "number" && config.slots > 0 ? config.slots : 1;
  const contextLength = resolvedContextLength ?? declaredLaunchContext(model) ?? (typeof config.contextLength === "number" && config.contextLength > 0 ? config.contextLength : await contextForLaunch(model, config, slots));
  if (engineForRole(role) === "mlx-serve") {
    // mlx-serve: one model pinned for the life of the process, loopback
    // only, the context length the llama-server settings declare (one
    // declaration for the chat wire), its logs under data/.
    const pin = installedEnginePin("mlx-serve");
    if (!pin || !engineInstalled("mlx-serve")) throw new EngineUnavailableError("No installed mlx-serve build is available for this machine.");
    const binary = launchBinary(pin);
    // The person-level setting is not read by the Stack yet (STACK-16); undefined means no --kv-quant.
    const args = mlxServeArgs({ modelPath: model.modelPath!, port, contextLength, slots, prefixCacheFlag: MLX_PREFIX_CACHE_FLAG, kvQuant: mlxKvQuantFor(undefined) });
    return { command: [binary, ...args], engine: "mlx-serve", build: currentEngineTag("mlx-serve") ?? pin.tag, stdin: "ignore", contextLength, slots, contextScope: "per slot", kind: "spawned", env: managedEnv() };
  }
  const pin = installedEnginePin();
  if (!pin || !engineInstalled()) throw new EngineUnavailableError("No installed llama-server build is available for this machine.");
  const binary = launchBinary(pin);
  const projector = role === "vision" ? projectorFor(model) : null;
  if (role === "vision" && !projector?.modelPath) throw new EngineUnavailableError(`The ${model.id} projector is not installed.`);
  const args = llamaServerArgs({ modelPath: model.modelPath!, port, config, contextLength, kvCacheType: defaultKvCacheType(), embeddings: role === "embed", projectorPath: projector?.modelPath ?? undefined });
  return { command: [binary, ...args], engine: "llama-server", build: currentEngineTag("llama-server") ?? pin.tag, stdin: "ignore", contextLength, slots, contextScope: "per slot", kind: "spawned" };
}

async function startSpawnedProcess(role: RoleId, modelId?: string): Promise<RoleProcess> {
  if (!SPAWNABLE_ROLES.includes(role)) throw new EngineUnavailableError(`No engine can be started for ${role} on this machine yet.`);
  const model = modelId ? selectableModel(role, modelId) : selectedModel(role);
  if (!engineInstalledFor(role)) {
    const reason = SPEECH_ROLES.includes(role) ? `The ${role} voice activity detector is not installed.`
      : role === "image" ? "The ComfyUI environment is not built on this machine."
      : engineForRole(role) === "mlx-serve" ? "No installed mlx-serve build is available for this machine."
      : role === "tts" ? (pocketTtsInstalled() ? "The tts tokenizer or default voice is not installed." : "The Pocket TTS environment is not built on this machine.")
      : "No installed llama-server build is available for this machine.";
    throw new EngineUnavailableError(reason);
  }
  if (!model?.modelPath) throw new EngineUnavailableError(`No verified and installed ${role} model is available.`);
  const launchConfig = engineSettingValues("engines.llama_server") as Record<string, number | boolean | string | string[]>;
  const ownContext = declaredLaunchContext(model);
  const declaredContextLength = ownContext ?? launchConfig.context_length;
  const slots = ownContext !== null ? 1 : typeof launchConfig.slots === "number" && launchConfig.slots > 0 ? launchConfig.slots : 1;
  const contextLength = typeof declaredContextLength === "number" && declaredContextLength > 0 ? declaredContextLength : await contextForLaunch(model, { ...launchConfig, contextLength: 0 }, slots);
  // The voice engine starts offline; what it may need beyond the pins
  // (the gated cloning weights, with a token and cloning turned on) the
  // Stack fetches first, once. A fetch that fails never stops the start:
  // the engine serves presets, and a cloning request reports the reason.
  if (role === "tts" && voiceCloningOn()) {
    try {
      if (await ensureCloningWeights()) resolveHealth("voice-cloning-weights.tts");
      else raise({ code: "voice-cloning-weights.tts", severity: "warning", title: "The voice-cloning weights could not be fetched", text: "stack.engines.tts.hf_token is not set, so the gated weights were not fetched.", cause: "no token", fix: { label: "Restart engine", action: "restart_engine" } });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      raise({ code: "voice-cloning-weights.tts", severity: "warning", title: "The voice-cloning weights could not be fetched", text: reason, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
    }
  }

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
  const dryRunPeakBytes = engineForRole(role) === "llama-server" && !managed && !generator && !SPEECH_ROLES.includes(role) && model.modelPath.endsWith(".gguf")
    ? await dryRunFootprint(model.modelPath, contextLength * slots)
    : null;
  if (engineForRole(role) === "llama-server" && !managed && !generator && !SPEECH_ROLES.includes(role) && model.modelPath.endsWith(".gguf") && !dryRunPeakBytes && !model.measuredFootprintBytes && !(typeof declaredContextLength === "number" && declaredContextLength > 0)) {
    throw new EngineUnavailableError("The fit plan could not estimate the launched context for the memory governor; install the GGUF parser or set an explicit context length.");
  }
  logger.appendLine(JSON.stringify({ event: "governor.peak-source", role, source: dryRunPeakBytes ? "dry-run" : "none", bytes: dryRunPeakBytes }));
  // A vision model's projector loads beside it: its bytes count too. The
  // fit tool sizes the language model alone, so the projector is added.
  const projectorBytes = role === "vision" ? projectorFor(model)?.sizeBytes ?? 0 : 0;
  const pinMeasured = measuredPeakFromPin(model);
  const request = {
    id: role, kind: JIT_ROLES.includes(role) ? "jit" as const : "resident" as const,
    requestedBytes: managed && !generator ? (model.measuredFootprintBytes ?? POCKET_TTS_ESTIMATED_FOOTPRINT) : (model.sizeBytes ?? 0) + projectorBytes,
    modelFileBytes: managed && !generator ? null : (model.sizeBytes ?? 0) + projectorBytes || null,
    // A jit role's pin carries the whole-machine cost measured on a real
    // load (weights the engine maps are not in the process footprint),
    // and the larger of that and the store's own reading is the peak.
    measuredPeakBytes: JIT_ROLES.includes(role) && pinMeasured !== null ? Math.max(pinMeasured, model.measuredFootprintBytes ?? 0) : model.measuredFootprintBytes,
    dryRunPeakBytes: dryRunPeakBytes === null ? null : dryRunPeakBytes + projectorBytes,
    headroomBytes: engineForRole(role) === "mlx-serve" && !managed && !generator && !SPEECH_ROLES.includes(role) ? mlxHeadroomBytes({ modelDir: model.modelPath!, contextTokens: contextLength }) : null,
    engine: generator ? "comfyui" : managed ? "pocket-tts" : SPEECH_ROLES.includes(role) ? "sherpa-onnx-node" : engineForRole(role) === "mlx-serve" ? "mlx-serve" : "llama-server",
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
  try { plan = await launchPlan(role, model, port, contextLength); } catch (error) { release(admission); throw error; }
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
      const model_ = GENERATOR_ROLES.includes(role) ? basename(model.modelPath!) : loadedWeightsRepo()?.repo ?? null;
      identity = { ...identity, build: `${plan.engine}-${plan.build}`, model: model_ };
    }
    // mlx-serve's /props carries no build_info or model_path: the build
    // is the pin's tag, the model the directory the Stack launched.
    if (plan.engine === "mlx-serve") identity = { ...identity, build: identity.build ?? `mlx-serve-${plan.build}`, model: identity.model ?? basename(model.modelPath!) };
    const check = await postLoadCheck(role, client, handle.pid);
    check.loadMs = Math.round(performance.now() - loadStartedAt);
    if (check.actualBytes !== null) {
      recordMeasuredFootprint(model.id, check.actualBytes, contextLength);
      refreshMeasuredPeak(admission, check.actualBytes);
    }
    runtime(role).status.postLoadCheck = check;
    resolveHealth(`engine.crashed.${role}`);
    resolveHealth(`post-load-check-failed.${role}`);
    const loadedRevision = plan.kind === "managed" && !GENERATOR_ROLES.includes(role) ? loadedWeightsRepo()?.revision ?? null : null;
    const processRecord: RoleProcess = {
      role, kind: plan.kind, client, identity, engine: plan.engine, contextLength: plan.contextLength, slots: plan.slots, contextScope: plan.contextScope, modelId: model.id, modelRevision: loadedRevision ?? model.revision, pid: handle.pid, port, activeRequests: 0, retired: false,
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

async function startProcess(role: RoleId, modelId?: string): Promise<RoleProcess> {
  const resident = !JIT_ROLES.includes(role) && !GENERATOR_ROLES.includes(role);
  if (!resident) return startOne(role, modelId);
  residentStarts++;
  try {
    await yieldJitRolesTo(role);
    return await startOne(role, modelId);
  } finally { residentStarts--; }
}

async function startOne(role: RoleId, modelId?: string): Promise<RoleProcess> {
  if (testFactory) return testFactory(role, modelId);
  const bound = urlBindingFor(role);
  if (bound) return startUrlProcess(role, bound.url);
  return startSpawnedProcess(role, modelId);
}

/** The running process for a role, starting it under the generation
 * guard when it is not. Roles that share another role's model resolve
 * to that role's process. */
export async function getProcess(requested: RoleId, modelId?: string): Promise<RoleProcess> {
  const role = processRoleFor(requested);
  if (getRunState() !== "running") throw new EngineUnavailableError("The Stack is paused.");
  const current = runtime(role);
  if (current.manuallyStopped) throw new EngineUnavailableError(`The ${role} engine was stopped.`);
  if (!current.process && !current.starting && JIT_ROLES.includes(role) && residentStarts > 0) throw new EngineUnavailableError(`The ${role} engine waits while a resident engine starts.`);
  if (current.process) {
    if (!modelId || current.process.kind === "url" || current.process.modelId === modelId) return current.process;
    const previous = current.process;
    current.process = null;
    current.status = { ...current.status, state: "loading", reason: null };
    await retire(previous);
    return getProcess(role, modelId);
  }
  if (!current.starting && current.retryAfter > Date.now()) {
    throw new EngineUnavailableError(current.status.reason ?? `The ${role} engine start is backing off after a failed admission.`);
  }
  if (!current.starting) {
    const generation = current.generation;
    current.status = { ...current.status, state: "loading", reason: null };
    emitRoleState(role, "loaded");
    const launch: Promise<RoleProcess> = startProcess(role, modelId).then(async (started) => {
      if (generation !== current.generation) {
        // Stopped or restarted while it loaded: its admission and memory
        // watch go with it, never left counted in the governor.
        await retire(started);
        if (current.starting === launch) current.starting = null;
        return getProcess(role, modelId);
      }
      current.process = started;
      current.starting = null;
      current.startFailureCount = 0;
      current.retryAfter = 0;
      current.lastRealRequestAt = Date.now();
      current.status = { kind: started.kind, state: "ready", reason: null, identity: started.identity, postLoadCheck: current.status.postLoadCheck, contextLength: started.contextLength ?? null, slots: started.slots ?? null, contextScope: started.contextScope ?? null };
      emit({ id: "engine.state", data: { engine: role, state: "ready" } });
      emitRoleState(role, "ready");
      return started;
    }).catch((error) => {
      if (generation === current.generation) {
        current.starting = null;
        const reason = (error as Error).message;
        current.startFailureCount++;
        const delay = Math.min(START_RETRY_CAP_MS, START_RETRY_BASE_MS * 2 ** Math.min(20, current.startFailureCount - 1));
        current.retryAfter = Date.now() + delay;
        current.status = { ...current.status, state: "offline", reason };
        emitRoleState(role, "offline", reason);
      }
      throw error;
    });
    current.starting = launch;
  }
  const starting = await current.starting;
  if (modelId && starting.kind !== "url" && starting.modelId !== modelId) return getProcess(role, modelId);
  return starting;
}

export function getRoleStatus(requested: RoleId): RoleStatus {
  const role = processRoleFor(requested);
  const current = runtime(role);
  if (current.process && current.status.state !== "busy") current.status = { ...current.status, kind: current.process.kind, state: "ready", identity: current.process.identity, reason: null };
  return { ...current.status, contextLength: current.process?.contextLength ?? current.status.contextLength ?? null, slots: current.process?.slots ?? current.status.slots ?? null, contextScope: current.process?.contextScope ?? current.status.contextScope ?? null };
}

/** The engine whose process serves a role right now, or null when
 * nothing runs; a chat engine chosen by setting but not yet started
 * is not it. */
export function runningEngine(requested: RoleId): string | null {
  const current = runtime(processRoleFor(requested));
  return current.process && !current.process.retired ? current.process.engine : null;
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
  // `unload` is the governor's way to evict a `jit` role (idle, or under
  // pressure): it drains and stops that role's process, never chat's.
  return startGovernor({ pid, tier: machineTier, restart: async () => { await restartRole(role); }, unload: async (id) => {
    // Only a running jit process is evicted here; one still starting is
    // left to its own start, so its admission stays counted.
    if (!JIT_ROLES.includes(id as RoleId) || !runtimes.get(id as RoleId)?.process) return false;
    return unloadRole(id as RoleId, "Unloaded by the memory governor.");
  } });
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
  current.startFailureCount = 0;
  current.retryAfter = 0;
  current.status = { ...current.status, state: "loading", reason: null };
  emit({ id: "engine.state", data: { engine: role, state: "loading" } });
  if (previous) await retire(previous);
}

export async function stopRole(requested: RoleId, reason = "Stopped by Home."): Promise<void> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  current.generation++;
  current.manuallyStopped = true;
  current.startFailureCount = 0;
  current.retryAfter = 0;
  const previous = current.process;
  current.process = null;
  current.starting = null;
  current.status = { ...current.status, state: "stopped", reason };
  emit({ id: "engine.state", data: { engine: role, state: "stopped", reason } });
  emitRoleState(role, "installed", reason);
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

const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "presence_penalty"] as const;
/** The sampling a model's own card recommends (rule 3, the source named
 * on the pin), filled in only where the request said nothing. */
export function withPinSampling(modelId: string | null, body: Record<string, unknown>): Record<string, unknown> {
  if (!modelId) return body;
  const sampling = getModel(modelId)?.engineRequirements.sampling as Partial<Record<(typeof SAMPLING_KEYS)[number], unknown>> | undefined;
  if (!sampling) return body;
  const filled = { ...body };
  for (const key of SAMPLING_KEYS) if (filled[key] === undefined && typeof sampling[key] === "number") filled[key] = sampling[key];
  return filled;
}

export async function requestRole(requested: RoleId, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<RoleReply> {
  const role = processRoleFor(requested);
  const requestedModel = typeof body.model === "string" && body.model !== requested ? body.model : undefined;
  const processRecord = await acquireRequestProcess(requested, requestedModel);
  const current = runtime(role);
  try {
    const completionMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : (timeoutOverrides.completionMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const dispatchBody = withPinSampling(path === "/v1/chat/completions" ? processRecord.modelId : null, requestedModel && processRecord.kind !== "url" ? { ...body, model: role } : body);
    const result = await withTimeout(
      processRecord.client.request(path, dispatchBody, signal),
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
  const requestedModel = typeof body.model === "string" && body.model !== requested ? body.model : undefined;
  const processRecord = await acquireRequestProcess(requested, requestedModel);
  const current = runtime(role);
  try {
    if (!processRecord.client.stream) throw new EngineUnavailableError("The engine does not support streaming.");
    const dispatchBody = withPinSampling(processRecord.modelId, requestedModel && processRecord.kind !== "url" ? { ...body, model: role } : body);
    const response = await processRecord.client.stream(path, { ...dispatchBody, stream: true }, signal);
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
  lastRoleStateLog.clear();
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
      // The token-count wires (STACK-TOKENIZE-01): a template that wraps
      // each message in two marker tokens, a tokenizer that counts
      // whitespace-separated pieces.
      if (path === "/apply-template") return { status: 200, body: { prompt: (Array.isArray(body.messages) ? body.messages as Array<{ content?: unknown }> : []).map((m) => `<m> ${String(m.content ?? "")} </m>`).join(" ") + (Array.isArray(body.tools) ? ` <tools> ${(body.tools as unknown[]).map(() => "tool").join(" ")} </tools>` : "") } };
      if (path === "/tokenize") return { status: 200, body: { tokens: String(body.content ?? "").split(/\s+/).filter(Boolean).map((_, i) => i) } };
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
      // The real engine takes a preset name or an hf:// path it can read offline; anything else is its own 400.
      if (typeof voice === "string" && voice && !(voice in POCKET_TTS_PRESET_VOICES) && !voice.startsWith("hf://")) return new Response(JSON.stringify({ detail: `Unknown voice ${voice}.` }), { status: 400, headers: { "content-type": "application/json" } });
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
  return { role, kind: "url", client, identity: { host: "stub", build: "scripted", model: `scripted-${role}`, healthy: true }, engine: null, modelId: null, modelRevision: null, pid: null, port: null, activeRequests: 0, retired: false, stop: async () => {}, ...overrides };
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
