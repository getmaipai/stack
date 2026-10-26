// The per-role supervisor: one process per role binding, three kinds
// (spawned by the Stack, a managed sidecar, a read-only url the person
// runs), one lifecycle. The pieces that were paid for in the chat-only
// supervisor (the generation guard, the free-port probe, the size-scaled
// liveness wait, the post-load completion, the measured footprint, the
// exit watch, the drain) are the same here, keyed by role.
import { noteComponentUse } from "@/lib/componentUse";
import { existsSync } from "node:fs";
import { CODING_GENERATION_PATHS, clampThinking, dropClientSampling } from "@/lib/codingWire";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { withTimeout } from "@maipai/core/src/withTimeout";
import { isCompiledBinary } from "@/lib/paths";
import { ENGINE_READY_MARKER, installedEnginePin, selectEngineBinary, type CodingEngine, type EngineBinaryPin } from "@/lib/engineCatalog";
import { managedEnv } from "@/lib/uvEnvironment";
import { codingServerArgs, defaultKvCacheType, llamaServerArgs, mlxKvQuantFor, mlxServeArgs, splashArgs, type KvCacheType } from "@/lib/engineArgs";
import { currentEngineBinary, currentEngineTag, engineBinaryPath, engineDir } from "@/lib/engineInstall";
import { detectAppleChip, detectHardware, primaryBudgetBytes } from "@/lib/hardware";
import { identityHeaders, modelFileName, readEngineIdentity, type EngineIdentity } from "@/lib/identity";
import { getModel, isComponent, isModelSelectable, listModels, recordMeasuredFootprint, type ModelRecord } from "@/lib/modelStore";
import { readFileSync } from "node:fs";
// Imported as a file, so a compiled binary embeds the clip and the probe
// reads it there too, not only from a checkout.
import bundledClipFile from "../speech/fixtures/clover-two-seconds.wav" with { type: "file" };
import { TRANSCRIBE_PATH } from "@/speech/server";
import { loadedWeightsRepo, pocketTtsCommand, pocketTtsEnv, pocketTtsInstalled, POCKET_TTS_VERSION } from "@/speech/pocketTts";
import { ensureCloningWeights, POCKET_TTS_PRESET_VOICES, voiceCloningOn } from "@/speech/voices";
import { materializeServerScript, mlxAudioCommand, mlxAudioEnv, mlxAudioInstalled, MLX_AUDIO_VERSION } from "@/speech/mlxAudio";
import { newLaunchKey, omlxCommand, omlxEnv, omlxInstalled, omlxSupportedHere, OMLX_VERSION, prepareModelFolder, resetState as resetOmlxState } from "@/chat/omlx";
import { OmlxEngineClient } from "@/chat/omlxClient";
import { CHAT_ENGINE_SETTING, clearChatEngineFailures, FALLBACK_AFTER_FAILURES, markChatEngineFailed, resolveChatEngine, type ChatEngineChoice, type ChatEngineId } from "@/lib/chatEngines";
import { clearTtsEngineFailures, markTtsEngineFailed, resolveTtsEngine, TTS_ENGINE_SETTING, TTS_ENGINES, type TtsEngineChoice, type TtsEngineId } from "@/speech/ttsEngines";
import { STACK_CODING_DRAFT_MODEL, STACK_CODING_MODEL, STACK_CODING_HEAVY_MODEL, STACK_CODING_HEAVY_DRAFT_MODEL, STACK_TTS_CHATTERBOX_MODEL, STACK_TTS_CHATTERBOX_PARTS } from "@/lib/modelCatalog";
import { clearCodingEngineFailures, codingEngineFailure, CODING_ENGINE_SETTING, markCodingEngineFailed, resolveCodingEngine, SPLASH_CACHE_GB_DEFAULT, SPLASH_CACHE_GB_SETTING, splashEnv, splashFootprintEstimateBytes, type CodingEngineChoice, type SplashFacts } from "@/lib/splash";
import { layOutSplashCache, SplashLayoutError, splashPairFor } from "@/lib/splashStore";
import { TreeSnapshot, treeMemoryBytes } from "@/lib/processTree";
import { comfyuiCommand, comfyuiEnv, comfyuiInstalled, COMFYUI_VERSION, linkCheckpoint, probeGenerator } from "@/generators/comfyui";
import { basename } from "node:path";
import { admissionRoomBytes, getRunState, refreshMeasuredPeak, release, setGovernorPid, setIdleTtlSeconds, startGovernor, touch as touchGovernor, withdraw as withdrawAdmission, type GovernorHandle, type GovernorTier } from "@/lib/governor";
import { PROFILE_MODEL_BINDINGS, proposeProfile } from "@/profiles";
import { AdmissionRefusedError, governorPeak, waitForAdmission, waitingReason } from "@/lib/admission";
import { emit } from "@/lib/events";
import { MLX_PREFIX_CACHE_FLAG, mlxHeadroomBytes } from "@/lib/mlxMemory";
import { raise, resolve as resolveHealth } from "@/lib/health";
import { ROLES, ROLE_IDS, type RoleId, type RoleState } from "@/roles";
import { getMemoryReader } from "@/lib/memory";
import { classifyCrash, describeStartFailure, stderrEvidence, type CrashVerdict } from "@/lib/crashClassifier";
import { memoryLevel } from "@/lib/memoryState";
import { hfHubRoot } from "@/lib/store/layout";
import { engineSettingValues, gpuLayersFor, settingValues, type GpuLayers, type SettingValue } from "@/settings";
import { bumpStackGeneration } from "@/lib/stackGeneration";
import { logger } from "@/lib/log";
import { readGgufFacts } from "@/lib/gguf";
import { estimatorAvailable, largestAdmittedContext, placedOnProcessor, runGgufParser, type GgufEstimate } from "@/lib/fitPlan";
import { getGovernorStatus } from "@/lib/governor";
import { codingPauseBoundMs, heavyGate, isolationRules, PausableProcess, setProtectedPidProvider, type Lease, type PausableWorker } from "@/lib/heavyGate";
import { readMlxKvBytesPerToken } from "@/lib/mlxMemory";
import { currentHomeMode, homeModeEnteringCoding, homeModeLeavingCoding, homeModeSwitching } from "@/lib/homeMode";

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
  /** VISION-02b: the process was launched with its projector and reads
   * pictures; false for a text-only launch. */
  imageInput?: boolean;
  /** The process was launched with a projector (whether or not the
   * picture check then passed); false for a text-only launch. */
  projectorLoaded?: boolean;
  /** The most tokens one picture takes in this process (the record's
   * declared --image-max-tokens), when it reads pictures. */
  pictureTokensMax?: number | null;
  pid: number | null;
  port: number | null;
  activeRequests: number;
  retired: boolean;
  /** The coding engine only (CODE-STACK-01 S3b): the process as the isolation gate may stop it while a chat request runs. */
  pausable?: PausableWorker;
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

/** A start the memory governor could not admit: the engine is fine, the computer is full. The role goes back to `installed` with the reason, never `offline`, and nothing resident is evicted to make room (CODE-STACK-01 S2). */
export class EngineDoesNotFitError extends EngineUnavailableError {
  constructor(reason: string) { super(reason); this.name = "EngineDoesNotFitError"; }
}

// The roles a llama-server process serves and the request each one's
// post-load check sends. Roles that share chat's model run on chat's
// process; embed has its own model and its own launch flag.
const CHAT_WIRE_ROLES: RoleId[] = ROLE_IDS.filter((role) => ROLES[role].wire === "chat");
const SPAWNABLE_ROLES: RoleId[] = ["chat", "coding", "judge", "embed", "vision", "stt", "tts", "image"];
/** The roles the speech worker serves: their runtime ships with the
 * Stack (sherpa-onnx-node in package.json), never as an engine build. */
const SPEECH_ROLES: RoleId[] = ["stt"];
/** The roles a managed Python engine serves (Pocket TTS, STACK-94c;
 * ComfyUI, STACK-13b). */
const MANAGED_ROLES: RoleId[] = ["tts", "image"];
/** The generator roles: their process is admitted as `jit` (evicted
 * when idle) and each render is a job the queue admits on top. */
const GENERATOR_ROLES: RoleId[] = ["image"];
/** The roles loaded on a request and evicted when idle (VISION-01b; the
 * coding role joined with CODE-STACK-01 S2 and adds a lease, a keep-warm
 * limit of its own and yielding to generator jobs): the
 * governor admits them as `jit`, they yield to a resident role's start,
 * and an admission never evicts or shrinks a resident. */
const JIT_ROLES: RoleId[] = ["vision", "coding"];
export const SPEECH_PATH = "/tts";

/** The role whose process serves this role: `coding`, `judge` and
 * `router` share chat's model and process unless bound elsewhere. */
export function processRoleFor(role: RoleId): RoleId {
  if (currentHomeMode() === "coding" && !homeModeLeavingCoding() && ["chat", "judge", "router"].includes(role)) return "coding";
  const definition = ROLES[role] as { sharesModelWith?: RoleId };
  if (role === "judge" && machineTier && PROFILE_MODEL_BINDINGS[machineTier]?.judge) return role;
  if (role === "judge" && !machineTier) return "chat";
  return definition.sharesModelWith ?? role;
}

/** The existing role.state feed is also Home's mode transition signal. */
export function emitHomeModeTransition(): void {
  for (const role of ["chat", "judge", "router"] as const) emitRoleState(role, "loaded", undefined, "mode_change");
}
export function emitHomeModeReady(): void {
  for (const role of ["chat", "judge", "router"] as const) if (getRoleStatus(role).state === "ready") emitRoleState(role, "ready", undefined, "mode_change");
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

/** Splash answers 404 to a model name it does not serve, and the coding wires carry the role name (`coding`) or whatever a client sent: every request to it is renamed to the one name it serves (the pin's id, `--served-model-name`). */
export class ServedNameClient implements EngineClient {
  constructor(private readonly inner: EngineClient, private readonly servedName: string) {}
  get baseUrl(): string { return this.inner.baseUrl; }
  request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; body: unknown }> { return this.inner.request(path, { ...body, model: this.servedName }, signal); }
  stream(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> { return this.inner.stream!(path, { ...body, model: this.servedName }, signal); }
  health(): Promise<boolean> { return this.inner.health(); }
}

// ---- timeouts and probes --------------------------------------------------

const DEFAULT_POST_LOAD_TIMEOUT_MS = 120_000;
/** How long a start waits on the governor before it fails with the
 * governor's numbers: long enough for a release in flight, short
 * enough that a request through the public route answers. */
const START_WAIT_MS = 15_000;
const START_RETRY_BASE_MS = 5_000;
const START_RETRY_CAP_MS = 5 * 60_000;
const DOES_NOT_FIT_RETRY_MS = 3_000;
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
  return getMemoryReader().processMemoryBytes(pid);
}

/** The smallest real request for a role's wire: the post-load check and
 * the readiness check both send it, so "ready" always means the public
 * route's own shape answered. */
/** The one short sentence the `tts` post-load check and readiness probe
 * render (a persona-roster name, never household text). */
export const PROBE_SENTENCE = "Clover, the kitchen light is on.";
/** spec/voice's /tts form: `text`, and a voice only when named. */
/** What the scripted engine received on the speech path, one object per request (for the suite). */
export const scriptedSpeechLog: Array<Record<string, string>> = [];

export function speechForm(text: string, voiceUrl?: string, voice: { temperature?: number; pitch_semitones?: number } = {}): FormData {
  const form = new FormData();
  form.append("text", text);
  if (voiceUrl) form.append("voice_url", voiceUrl);
  // VOICES-02: a voice made from a clip carries its own sampling temperature and pitch offset (a zero offset is no shift).
  if (voice.temperature !== undefined) form.append("temperature", String(voice.temperature));
  if (voice.pitch_semitones !== undefined && voice.pitch_semitones !== 0) form.append("pitch_semitones", String(voice.pitch_semitones));
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

/** VISION-02b: a chat process launched with its projector reads the
 * vision probe's picture once after load. A failure leaves chat serving
 * text (a picture reader never stops chat, rule 6) and the role row says
 * it does not read pictures. */
export async function picturesProbeOk(client: EngineClient): Promise<boolean> {
  const probe = probeRequest("vision");
  try {
    const result = await withTimeout(client.request(probe.path, { ...probe.body, model: "chat" }), timeoutOverrides.postLoadMs ?? DEFAULT_POST_LOAD_TIMEOUT_MS, () => new EngineUnavailableError("The picture check timed out."));
    return probeReplyOk("vision", result);
  } catch {
    return false;
  }
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

/** The engine's own dry run of a launch: llama-fit-params at the context
 * and with the KV cache type and flash attention the launch itself uses
 * (VISION-02b: without them the tool sized an f16 cache, about twice the
 * q8_0 cache a macOS launch runs, and refused a chat the fit plan had
 * admitted). */
export async function dryRunFootprint(modelPath: string, contextLength: number, opts: { kvCacheType?: KvCacheType; flashAttention?: boolean } = {}): Promise<number | null> {
  try {
    const hardware = await detectHardware(); const pin = selectEngineBinary(hardware);
    const fit = process.env.STACK_FIT_BINARY ?? (pin ? join(engineDir(pin), "llama-fit-params") : "");
    if (!fit || !existsSync(fit)) return null;
    const kv = opts.kvCacheType && opts.kvCacheType !== "f16" ? ["-ctk", opts.kvCacheType, "-ctv", opts.kvCacheType] : [];
    const fa = opts.flashAttention === undefined ? [] : ["-fa", opts.flashAttention ? "on" : "off"];
    const processHandle = Bun.spawn([fit, "--model", modelPath, "--ctx-size", String(contextLength), ...kv, ...fa, "--fit", "on", "--fit-print", "on"], { stdout: "pipe", stderr: "pipe" });
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
  /** Why the last start was refused for memory (the coding role); cleared by a start that worked. */
  cannotFitReason?: string | null;
}

type ProcessFactory = (role: RoleId, modelId?: string) => Promise<RoleProcess>;
let testFactory: ProcessFactory | null = null;
const runtimes = new Map<RoleId, RoleRuntime>();
// ISOLATION-01: the pids of every engine this supervisor runs; the heavy gate never stops one of them.
setProtectedPidProvider(() => [...runtimes.values()].map((current) => current.process?.pid).filter((pid): pid is number => typeof pid === "number"));
const lastRoleStateLog = new Map<RoleId, string>();
const requestLocks = new Map<RoleId, Promise<void>>();

function emitRoleState(role: RoleId, state: RoleState, reason?: string, cause?: string): void {
  const signature = `${state}\n${reason ?? ""}\n${cause ?? ""}`;
  if (lastRoleStateLog.get(role) === signature) return;
  lastRoleStateLog.set(role, signature);
  const data = { role, state, since: new Date().toISOString(), ...(reason ? { reason } : {}), ...(cause ? { cause } : {}) };
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
    if (role === "coding") codingYieldBegin(processRecord);
    noteComponentUse(processRecord.modelId);
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
function engineInstalled(name: string = "llama-server"): boolean {
  const current = currentEngineBinary(name, name);
  if (current.state === "ready") return true;
  if (current.state === "unready") return false;
  const pin = installedEnginePin(name);
  return !!pin && existsSync(join(engineDir(pin), ENGINE_READY_MARKER));
}

/** Whether a verified oMLX model record is on disk. */
function omlxModelInstalled(): boolean {
  return listModels().some((model) => model.roles.includes("chat") && model.engineRequirements.engine === "omlx" && isModelSelectable(model) && !!model.modelPath);
}
function chatEngineInstalled(id: ChatEngineId): boolean {
  return id === "omlx" ? omlxInstalled() && omlxModelInstalled() : engineInstalled(id);
}
/** What the choice checks: oMLX falls back to llama-server until it and its model are installed; an explicit mlx-serve is honoured as before (its start says what is missing). */
function chatEngineAvailableForChoice(id: ChatEngineId): boolean {
  return id === "omlx" ? chatEngineInstalled("omlx") : true;
}

/** Which chat engine a start would choose: the setting (`auto` is the
 * tier's default), then what is installed, then what failed to start
 * this run (ENGINE-MLX-01). */
export function activeChatChoice(): ChatEngineChoice {
  return resolveChatEngine({
    setting: settingValues()[CHAT_ENGINE_SETTING],
    tier: machineTier,
    installed: chatEngineAvailableForChoice,
    unsupported: (id) => id === "omlx" ? omlxSupportedHere().reason : null,
  });
}

/** The chat wire's engine the settings and the machine choose
 * (STACK-93, ENGINE-MLX-01): the engine the next start runs. A running
 * process keeps its own engine until it restarts (`runningEngine`). */
export function chatEngine(): ChatEngineId {
  return activeChatChoice().engine;
}
// ---- the coding role's engine (CODE-STACK-01 S5a) --------------------------------------

/** What the machine says about itself, set once at the daemon's start (and by the suite). Unset means unknown, which Splash refuses. */
let codingMachine: Omit<SplashFacts, "tier"> | null = null;
export function setCodingMachineFacts(facts: Omit<SplashFacts, "tier"> | null): void { codingMachine = facts; }
/** An engine forced for the length of one start (the fallback to llama-server for the request that Splash could not serve). */
let forcedCodingEngine: CodingEngine | null = null;

/** Whether Splash's draft is installed: the pinned component record, verified and on disk. */
function splashDraftInstalled(): boolean { return componentModel("coding", "draft") !== null; }
function codingModelInstalled(): boolean {
  return listModels().some((model) => model.roles.includes("coding") && !isComponent(model) && isModelSelectable(model) && !!model.modelPath);
}

/** Which engine the next coding start runs: the setting, then the machine (Apple M3 or newer, 36 GB or more, macOS 26.4 or later, the 64 and 128 GB tiers), then what is installed, then what failed to start this run. A start that fell back to llama-server for one request forces it for that start. */
export function activeCodingChoice(): CodingEngineChoice {
  const requested = settingValues()[CODING_ENGINE_SETTING];
  if (forcedCodingEngine) return { engine: forcedCodingEngine, requested: requested === "splash" ? "splash" : requested === "llama-server" ? "llama-server" : "auto", reason: null };
  const machine = codingMachine ?? { platform: process.platform, arch: process.arch, chipGeneration: null, chipName: null, memoryGb: 0, osVersion: null };
  return resolveCodingEngine({ setting: requested, facts: { ...machine, tier: machineTier }, splashInstalled: engineInstalled("splash"), draftReady: splashDraftInstalled(), modelReady: codingModelInstalled() });
}
export function codingModeHardwareEligible(): boolean {
  const machine = codingMachine;
  const version = machine?.osVersion?.match(/^(\d+)\.(\d+)/);
  return machineTier === "p128" && process.platform === "darwin" && process.arch === "arm64" && !!machine && (machine.chipGeneration ?? 0) >= 3 && !!version && (Number(version[1]) > 26 || (Number(version[1]) === 26 && Number(version[2]) >= 4));
}
export function splashInstalledForHomeMode(): boolean { return engineInstalled("splash"); }

/** The engine the model records are chosen for: a GGUF serves both coding engines, so the role's records are not filtered by engine. */
function recordEngineFor(role: RoleId): string | null { return role === "coding" ? null : engineForRole(role); }

function engineForRole(role: RoleId): string | null {
  if (role === "coding") return currentHomeMode() === "coding" || homeModeEnteringCoding() ? "splash" : activeCodingChoice().engine;
  // The vision projector is a llama-server feature (mtmd); the MLX
  // engine choice for chat never moves it.
  if (role === "vision") return "llama-server";
  // A chat-wire role with a process of its own (the judge on the tiers that
  // bind a 4B model to it) runs on llama-server whatever engine chat uses:
  // the MLX pin is chat's model, not the judge's.
  if (CHAT_WIRE_ROLES.includes(role)) return processRoleFor(role) === "chat" ? chatEngine() : "llama-server";
  if (role === "embed") return "llama-server";
  // The voice role's records name the engine they are for; the engine in
  // effect (the setting, the tier, what is installed) decides which.
  if (role === "tts") return TTS_ENGINES[activeTtsChoice().engine].catalogEngine;
  // The supervisor's image process is ComfyUI; the mflux worker's records (IMGGEN-STACK-01) belong to the image service, not to a spawned engine.
  if (role === "image") return "comfyui";
  return null;
}

// ---- the voice engine in effect (VOICE-STUDIO-01) ---------------------------

/** Whether an engine can start here: its environment is built and every
 * file it loads is a verified record on disk. */
export function ttsEngineInstalled(id: TtsEngineId): boolean {
  if (id === "pocket") return pocketTtsInstalled() && componentModel("tts", "tokenizer") !== null && componentModel("tts", "voice") !== null;
  if (id === "chatterbox-turbo") {
    if (!mlxAudioInstalled()) return false;
    const have = new Set(listModels().filter((model) => model.roles.includes("tts") && isModelSelectable(model) && !!model.modelPath).map((model) => model.id));
    return [STACK_TTS_CHATTERBOX_MODEL, ...STACK_TTS_CHATTERBOX_PARTS].every((pin) => have.has(pin.id));
  }
  return false;
}

/** Which voice engine answers: the setting (`auto` is the tier's
 * default), then what is installed and what failed to start this run. */
export function activeTtsChoice(): TtsEngineChoice {
  return resolveTtsEngine({ setting: settingValues()[TTS_ENGINE_SETTING], tier: machineTier, installed: ttsEngineInstalled });
}

/** The engine a request is served by right now: the running process's
 * when there is one (a setting change waits for the engine's restart),
 * otherwise the one a start would choose. */
export function ttsEngineInEffect(): TtsEngineId {
  const running = runtime("tts").process;
  if (running && !running.retired) {
    if (running.engine === TTS_ENGINES["chatterbox-turbo"].catalogEngine) return "chatterbox-turbo";
    if (running.engine === TTS_ENGINES.pocket.catalogEngine) return "pocket";
  }
  return activeTtsChoice().engine;
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
export function engineInstalledFor(role: RoleId): boolean {
  // A scripted engine stands in for an installed one, as it does at launch.
  if (testFactory) return true;
  if (SPEECH_ROLES.includes(role)) return componentModel(role, "vad") !== null;
  if (role === "tts") return ttsEngineInstalled(activeTtsChoice().engine);
  if (role === "image") return comfyuiInstalled();
  if (role === "vision") {
    const model = selectedModel(role);
    return !!model && projectorFor(model) !== null && engineInstalled("llama-server");
  }
  const engine = engineForRole(role);
  return engine === "omlx" ? chatEngineInstalled("omlx") : engineInstalled(engine === "mlx-serve" || engine === "splash" ? engine : "llama-server");
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

/** The projector a launch loads beside the model: the vision role's, or
 * a chat model's own when its record declares picture input (VISION-02b:
 * one resident process reads pictures). A chat model whose projector is
 * not installed starts text-only and says so on its role row; a missing
 * picture reader never stops chat. */
export function launchProjectorFor(role: RoleId, model: ModelRecord): ModelRecord | null {
  if (role !== "vision" && role !== "chat") return null;
  return projectorFor(model);
}

/** Whether a role reads pictures (VISION-02b): its running process was
 * launched with a projector, or, with nothing running, its selected
 * model declares picture input and the projector is installed. A bound
 * vision URL is itself the configured vision engine. Never a model id
 * (Home rule 8). */
export function roleReadsPictures(requested: RoleId, model: ModelRecord | null): boolean {
  const role = processRoleFor(requested);
  // The vision role's URL is explicitly bound as the vision engine, so
  // capability reporting follows that binding without claiming for any
  // other role's remote server.
  if (role === "vision" && urlBindingFor(role)) return true;
  if (urlBindingFor(role)) return false;
  const running = runtime(role).process;
  if (running && !running.retired) return running.imageInput === true;
  return !!model && projectorFor(model) !== null;
}

/** The most tokens one picture takes in the role's running process, or
 * null when it reads no pictures or declares no bound. */
export function pictureTokensMax(requested: RoleId): number | null {
  const running = runtime(processRoleFor(requested)).process;
  return running && !running.retired && running.imageInput ? running.pictureTokensMax ?? null : null;
}

/** Whether a launch's memory reading is stored for its model: always,
 * except a model that reads pictures launched without its projector,
 * whose reading leaves the projector out (a review, VISION-02b). */
export function keepsMeasuredFootprint(model: ModelRecord, launchedWithProjector: boolean): boolean {
  return !declaresImageInput(model) || launchedWithProjector;
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
  if (currentHomeMode() === "coding" && !homeModeLeavingCoding() && ["chat", "judge", "router"].includes(role)) {
    const heavy = getModel(STACK_CODING_HEAVY_MODEL.id);
    return heavy && isModelSelectable(heavy) && !!heavy.modelPath ? heavy : null;
  }
  if (role === "coding" && currentHomeMode() === "coding") {
    const heavy = getModel(STACK_CODING_HEAVY_MODEL.id);
    return heavy && isModelSelectable(heavy) && !!heavy.modelPath ? heavy : null;
  }
  if (role === "judge" && (!machineTier || !PROFILE_MODEL_BINDINGS[machineTier]?.judge)) return selectedModel("chat");
  // A record names the engine it is for; the chat wire's chosen engine
  // decides which records can serve it (a GGUF for llama-server, an MLX
  // directory for mlx-serve), both installed side by side.
  const engine = recordEngineFor(role);
  const selectable = listModels().filter((model) => servesRole(model, role, engine) && (role !== "coding" || (model.id !== STACK_CODING_HEAVY_MODEL.id || machineTier === "p128")));
  // The session's "load this" first, then the choice Home stored in the setting (it survives a restart).
  const stored = role === "chat" ? String(settingValues()["stack.engines.chat.model"] ?? "") : role === "coding" ? String(settingValues()["stack.engines.coding.model"] ?? "") : "";
  const preferred = preferredModels.get(role) ?? (stored || undefined);
  const codingPreference = role === "coding" ? preferred : undefined;
  const candidates = role === "coding" ? selectable.filter((model) => model.id !== STACK_CODING_HEAVY_MODEL.id || (machineTier === "p128" && codingPreference === STACK_CODING_HEAVY_MODEL.id)) : selectable;
  const profileModel = machineTier ? PROFILE_MODEL_BINDINGS[machineTier]?.[role] : undefined;
  return candidates.find((model) => model.id === preferred) ?? candidates.find((model) => model.id === profileModel) ?? candidates[0] ?? null;
}

/** Models an installed chat process can actually start for a request.
 * Kept beside selection so the API and dispatcher share the same
 * provenance, file and engine-compatibility rules. */
export function selectableModels(role: RoleId): Array<{ id: string; name: string }> {
  if (currentHomeMode() === "coding" && ["chat", "judge", "router"].includes(role)) return selectedModel("chat") ? [{ id: STACK_CODING_HEAVY_MODEL.id, name: STACK_CODING_HEAVY_MODEL.id }] : [];
  const engine = recordEngineFor(role);
  return listModels()
    .filter((model) => servesRole(model, role, engine) && (role !== "coding" || model.id !== STACK_CODING_HEAVY_MODEL.id || machineTier === "p128"))
    .map(({ id }) => ({ id, name: id }));
}

function selectableModel(role: RoleId, modelId: string): ModelRecord | null {
  const engine = recordEngineFor(role);
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

export interface LaunchPlan { command: string[]; engine: string; build: string; stdin: "pipe" | "ignore"; contextLength: number; slots?: number; contextScope?: "total across slots" | "per slot"; kind: "spawned" | "managed"; env?: Record<string, string>; healthPath?: string; /** A client of the engine's own (oMLX's wire differs a little from llama-server's). */ client?: (baseUrl: string) => EngineClient; /** What the engine cannot report about itself: the Stack knows both. */ identity?: { build: string; model: string }; /** A projector was loaded: the process reads pictures. */ imageInput?: boolean; /** The engine is a tree of processes (Splash: the launcher that becomes the server, and the native engine under it): a pause, a stop and a memory reading reach every member. */ tree?: boolean; /** Run after the engine is healthy: proves it serves the model the Stack launched (Splash lists its served name); throws EngineUnavailableError when it does not. */ verifyServed?: (baseUrl: string) => Promise<void>; /** The most tokens one picture takes in this process, when the record declares it. */ pictureTokensMax?: number | null; }

/** The refusal text when the fit plan cannot admit the minimum context:
 * what went wrong in the person's terms, then the next step (org STYLE.md,
 * "Error messages"). `peakBytes` null means the plan could not size the model. */
export function fitRefusalMessage(input: { modelId: string; peakBytes: number | null | undefined; budgetBytes: number; onProcessor: boolean; sizeKnown: boolean; sizerInstalled: boolean }): string {
  const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  const memory = input.onProcessor ? "system memory" : "graphics memory";
  if (input.peakBytes === null || input.peakBytes === undefined) {
    const cause = !input.sizeKnown ? "the size of its file is not recorded" : !input.sizerInstalled ? "the model size checker is not installed" : "its architecture is not one the size checker can estimate";
    const fix = !input.sizeKnown ? "Restart the Stack, which reads the file size again, or install the model again from Models." : !input.sizerInstalled ? "Install the size checker from the Stack's repairs list, then start this engine again." : "Set a context length under the llama-server settings, which skips the estimate, then start this engine again.";
    return `${input.modelId} was not started because the Stack cannot tell how much memory it needs: ${cause}. ${fix}`;
  }
  const choice = input.onProcessor ? "Free some memory or raise \"Memory for models\" in the Memory settings" : "Free some graphics memory, or set where this model runs to the processor in its engine settings";
  return `${input.modelId} was not started: it needs about ${gb(input.peakBytes)} of ${memory} to run its smallest context (8,192 tokens), and ${gb(input.budgetBytes)} is available. ${choice}, then start this engine again.`;
}

async function contextForLaunch(model: ModelRecord, config: Record<string, number | boolean | string | string[]>, slots = 1, gpuLayers: GpuLayers = "all"): Promise<number> {
  const onProcessor = gpuLayers === 0;
  const configured = config.contextLength;
  if (typeof configured === "number" && configured > 0) return configured;
  const status = getGovernorStatus();
  const hardware = await detectHardware();
  const gpuBudgets = hardware.cudaDevices.map((device) => device.vramBytes - (device.usedVramBytes ?? 0));
  // A role on the processor is held to system memory (the governor's
  // model budget), never to the graphics card's free memory.
  const modelCapBytes = onProcessor ? status.capBytes : Math.min(status.capBytes, primaryBudgetBytes(hardware) || status.capBytes);
  const placement = <T extends { deviceBudgetsBytes: number[]; unifiedMemory: boolean }>(input: T) => onProcessor ? placedOnProcessor(input) : input;
  const modelContextTokens = model.modelPath?.endsWith(".gguf")
    ? (await readGgufFacts(model.modelPath, { allowLocalFile: true })).contextLength
    : (() => {
      try { const configPath = join(model.modelPath!, "config.json"); return JSON.parse(readFileSync(configPath, "utf8")).max_position_embeddings ?? 4096; }
      catch { return 4096; }
    })();
  const max = Math.min(modelContextTokens || 4096, 262_144);
  // A chat model that reads pictures loads its projector beside it
  // (VISION-02b): the fit tool sizes the language model alone, so the
  // projector's bytes are added to every estimate the plan reads.
  const projectorBytes = projectorFor(model)?.sizeBytes ?? 0;
  const withProjector = async (estimate: Promise<GgufEstimate | null>): Promise<GgufEstimate | null> => {
    const value = await estimate;
    return value && projectorBytes > 0 ? { ...value, vramNonumaBytes: value.vramNonumaBytes + projectorBytes, ramNonumaBytes: value.ramNonumaBytes + projectorBytes } : value;
  };
  const cpuEstimateAt = (contextTokens: number) => model.modelPath?.endsWith(".gguf")
    ? withProjector(runGgufParser({ target: { path: model.modelPath }, contextTokens: contextTokens * slots, kvCacheType: defaultKvCacheType(), gpuLayers: 0 }))
    : null;
  // On the processor the one estimate is the processor-side one, run once per context.
  const processorEstimates = new Map<number, ReturnType<typeof cpuEstimateAt>>();
  const estimateAt = (contextTokens: number) => {
    if (!onProcessor) return model.modelPath?.endsWith(".gguf")
      ? withProjector(runGgufParser({ target: { path: model.modelPath }, contextTokens: contextTokens * slots, kvCacheType: defaultKvCacheType(), gpuLayers: "all" }))
      : null;
    if (!processorEstimates.has(contextTokens)) processorEstimates.set(contextTokens, cpuEstimateAt(contextTokens));
    return processorEstimates.get(contextTokens)!;
  };
  if (!model.modelPath?.endsWith(".gguf")) {
    const mlxFacts = readMlxKvBytesPerToken(model.modelPath!) === null ? null : { weightsBytes: model.sizeBytes ?? 0, config: JSON.parse(readFileSync(join(model.modelPath!, "config.json"), "utf8")) };
    const result = await largestAdmittedContext({ modelId: model.id, modelFileBytes: model.sizeBytes ?? undefined, measuredPeakBytes: model.measuredFootprintBytes, modelContextTokens: max, mlx: mlxFacts, estimate: null, estimateAt: () => null, kvCacheType: defaultKvCacheType(), ...placement({ unifiedMemory: hardware.isAppleSilicon, deviceBudgetsBytes: gpuBudgets }), capBytes: modelCapBytes, workingMarginBytes: status.marginBytes, loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })), asOf: new Date().toISOString().slice(0, 10), tool: { name: "fit-plan", version: "launch" } });
    if (result.plan.verdict !== "yes") {
      const peak = result.plan.roles[0]?.peak.high;
      throw new EngineUnavailableError(fitRefusalMessage({ modelId: model.id, peakBytes: peak, budgetBytes: modelCapBytes, onProcessor, sizeKnown: (model.sizeBytes ?? 0) > 0, sizerInstalled: estimatorAvailable() }));
    }
    return result.contextTokens;
  }
  const result = await largestAdmittedContext({ modelId: model.id, modelFileBytes: model.sizeBytes === null ? undefined : model.sizeBytes + projectorBytes, measuredPeakBytes: model.measuredFootprintBytes, measuredContextTokens: model.measuredContextLength, modelContextTokens: Math.floor(max / slots), estimate: null, estimateAt, cpuEstimateAt: onProcessor ? estimateAt : cpuEstimateAt, memoryContextMultiplier: slots, kvCacheType: defaultKvCacheType(), ...placement({ unifiedMemory: hardware.isAppleSilicon, deviceBudgetsBytes: gpuBudgets }), capBytes: modelCapBytes, workingMarginBytes: status.marginBytes, loaded: status.loaded.map((item) => ({ role: item.id, kind: item.kind, peakBytes: item.peakBytes, measured: item.measured })), asOf: new Date().toISOString().slice(0, 10), tool: { name: "gguf-parser", version: "launch" } });
  if (result.plan.verdict !== "yes" && result.plan.verdict !== "slow") {
    const peak = result.plan.roles[0]?.peak.high;
    const memoryReason = fitRefusalMessage({ modelId: model.id, peakBytes: peak, budgetBytes: modelCapBytes, onProcessor, sizeKnown: (model.sizeBytes ?? 0) > 0, sizerInstalled: estimatorAvailable() });
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

/** The chat-template variables a record's launch pins (STACK-MUSE-01:
 * Muse Glimmer's reasoning strength), string values only, or null. */
function declaredChatTemplateKwargs(model: ModelRecord): Record<string, string> | null {
  const launch = model.engineRequirements.launch as { chatTemplateKwargs?: unknown } | undefined;
  const kwargs = launch?.chatTemplateKwargs;
  if (!kwargs || typeof kwargs !== "object") return null;
  const entries = Object.entries(kwargs as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/** The most tokens one picture may take in a model that reads pictures,
 * as its record declares (VISION-02b), or null. */
function declaredPictureTokensMax(model: ModelRecord): number | null {
  const launch = model.engineRequirements.launch as { imageMaxTokens?: unknown } | undefined;
  return typeof launch?.imageMaxTokens === "number" && launch.imageMaxTokens > 0 ? launch.imageMaxTokens : null;
}

/** The context an oMLX chat process serves: the Stack's context setting when it names one, else the model's own maximum (the engine allocates cache as a conversation grows, so the maximum costs nothing until used). */
function omlxContextLength(model: ModelRecord, config: Record<string, number | boolean | string | string[]>): number {
  const configured = config.context_length ?? config.contextLength;
  if (typeof configured === "number" && configured > 0) return configured;
  try {
    const parsed = JSON.parse(readFileSync(join(model.modelPath!, "config.json"), "utf8")) as { max_position_embeddings?: unknown; text_config?: { max_position_embeddings?: unknown } };
    const declared = parsed.text_config?.max_position_embeddings ?? parsed.max_position_embeddings;
    if (typeof declared === "number" && declared > 0) return Math.min(declared, 262_144);
  } catch { /* an unreadable config: the conservative default */ }
  return 32_768;
}

/** Whether a record's launch says its weights read pictures themselves (an MLX build carries the vision tower; llama-server loads a projector file instead). */
function declaredReadsPictures(model: ModelRecord): boolean {
  const launch = model.engineRequirements.launch as { readsPictures?: unknown } | undefined;
  return launch?.readsPictures === true;
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

// ---- the coding engine (CODE-STACK-01 S2) ----------------------------------

const CODING_WINDOW_STEPS = [131_072, 98_304, 65_536, 49_152, 32_768];
const CODING_WINDOW_FLOOR = 32_768;

/** The coding process's launch settings, from `stack.engines.coding.*`:
 * slots (0 = the tier's own: 2 on p128, 1 below), the thinking ceiling at
 * the server, the keep-warm limit and the window it asks for. */
export function codingLaunchSettings(values: Record<string, SettingValue> = settingValues()): { slots: number; thinkingBudgetTokens: number; keepWarmMinutes: number; contextLength: number } {
  const number = (key: string, fallback: number): number => { const value = values[`stack.engines.coding.${key}`]; return typeof value === "number" && Number.isFinite(value) ? value : fallback; };
  const slotsSetting = number("slots", 0);
  return {
    slots: slotsSetting > 0 ? Math.floor(slotsSetting) : machineTier === "p128" ? 2 : 1,
    thinkingBudgetTokens: Math.max(0, Math.floor(number("thinking_budget_ceiling", 2000))),
    keepWarmMinutes: Math.max(1, Math.floor(number("keep_warm_minutes", 15))),
    contextLength: Math.max(8192, Math.floor(number("context_length", 131_072))),
  };
}

/** The keep-warm limit in seconds, as the governor holds it for the coding item: it is evicted exactly this long after its last request ended (a poll every 5 s notices), and the daemon's idle tick unloads at the same limit as a backstop. */
export function codingKeepWarmSeconds(): number { return codingLaunchSettings().keepWarmMinutes * 60; }

// ---- the coding engine yields to chat (CODE-STACK-01 S3b) ----------------------

/** `stack.engines.coding.yield_to_chat` (default true), read live: an admin can turn the yield off and the engine continues at once. */
export function codingYieldsToChat(values: Record<string, SettingValue> = settingValues()): boolean {
  // In Home's coding mode the coding process IS the chat process: yielding to chat would pause the engine that is answering it (a 20 second wait on every request, found by the end to end run).
  if (currentHomeMode() === "coding" || homeModeEnteringCoding()) return false;
  return values["stack.engines.coding.yield_to_chat"] !== false;
}

/** One isolation lease per coding process while it serves a request, however many requests run at once (the engine has slots): the gate stops the process while a chat request (or any interactive request but coding's own) is in flight and continues it when quiet, for at most `codingMaxPauseMs` at a time. It exists only while a request is in flight, so an idle engine is never stopped and the keep-warm clock never runs through a pause. */
const codingYield = new WeakMap<RoleProcess, { lease: Lease; holds: number }>();

function codingYieldBegin(processRecord: RoleProcess): void {
  if (!processRecord.pausable) return;
  const held = codingYield.get(processRecord);
  if (held) { held.holds++; return; }
  const lease = heavyGate.attach({ role: "coding", worker: processRecord.pausable, skipCoding: true, maxPauseMs: () => codingPauseBoundMs(processRecord.engine), enabled: () => codingYieldsToChat() });
  codingYield.set(processRecord, { lease, holds: 1 });
}

function codingYieldEnd(processRecord: RoleProcess): void {
  const held = codingYield.get(processRecord);
  if (!held || --held.holds > 0) return;
  held.lease.detach();
  codingYield.delete(processRecord);
}

/** Milliseconds this process has been stopped for chat while the current requests ran. */
function codingPausedMs(processRecord: RoleProcess): number { return codingYield.get(processRecord)?.lease.pausedMs() ?? 0; }

/** A process the gate has stopped cannot answer a health check, and a failed check retires an engine. Every path that checks health after a request went wrong continues the process first. */
function continueForHealth(processRecord: RoleProcess): void { processRecord.pausable?.resume(); }

/** A completion timeout that does not run while the process is stopped for chat: a paused coding answer is waiting, not stuck. */
function withActiveTimeout<T>(work: Promise<T>, ms: number, pausedMs: () => number, onTimeout: () => Error): Promise<T> {
  const startedAt = Date.now();
  const pausedAtStart = pausedMs();
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (wait: number) => {
      timer = setTimeout(() => {
        const left = ms - (Date.now() - startedAt - (pausedMs() - pausedAtStart));
        if (left > 5) arm(left); else reject(onTimeout());
      }, wait);
    };
    arm(ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** Pushes the keep-warm setting into the governor (a live setting). */
export function applyCodingKeepWarm(values?: Record<string, SettingValue>): void {
  setIdleTtlSeconds("coding", codingLaunchSettings(values).keepWarmMinutes * 60);
}

/** The window the coding process starts with: the one asked for while the
 * engine's own dry run says it fits in what the governor can admit now
 * without evicting anything, else the next smaller step, down to 32,768.
 * `peakBytes` is the dry run's reading at the chosen window (null when the
 * dry run is not available), so the admission does not run it twice. */
export async function codingContextFor(model: ModelRecord, desired: number): Promise<{ contextLength: number; dryRunPeakBytes: number | null }> {
  const steps = [desired, ...CODING_WINDOW_STEPS.filter((step) => step < desired)].filter((step, index, all) => all.indexOf(step) === index);
  let last = { contextLength: Math.min(desired, CODING_WINDOW_FLOOR), dryRunPeakBytes: null as number | null };
  for (const step of steps) {
    // The dry run sizes any llama-server model path the pin resolves to; a store file with no .gguf extension is sized the same way.
    const dry = model.modelPath ? await dryRunFootprint(model.modelPath, step, { kvCacheType: "q8_0", flashAttention: true }) : null;
    const peak = dry ?? Math.ceil((model.sizeBytes ?? 0) * 1.3);
    last = { contextLength: step, dryRunPeakBytes: dry };
    if (peak <= admissionRoomBytes()) return last;
  }
  return last;
}

/** What a person is told when the coding model cannot be admitted: the
 * problem in their terms, then the next step. Nothing resident is stopped
 * to make room, and the message says so. */
export function codingMemoryMessage(input: { peakBytes: number; freeBytes: number; budgetBytes: number; marginBytes: number }): string {
  const gb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (input.peakBytes > input.budgetBytes) return `The coding model needs about ${gb(input.peakBytes)}, but the memory set aside for models on this computer is ${gb(input.budgetBytes)}. Raise "Memory for models" in the Memory settings, then send the request again.`;
  return `The coding model needs about ${gb(input.peakBytes)} to load, and this computer has ${gb(input.freeBytes)} free after keeping ${gb(input.marginBytes)} back. Chat and the other always-on models stay loaded. Wait for the picture, video or song job to finish, or close a large app, then send the request again.`;
}

function codingRefusal(request: Parameters<typeof waitForAdmission>[0]): string {
  const status = getGovernorStatus();
  return codingMemoryMessage({ peakBytes: governorPeak(request), freeBytes: status.freeMemoryBytes, budgetBytes: status.capBytes, marginBytes: status.marginBytes });
}

/** The state of the coding engine for the role list and the later health
 * work: additive, read-only, and it never starts the process. */
export interface CodingEngineStatus {
  state: "notInstalled" | "installed" | "loading" | "ready" | "busy" | "offline";
  keep_warm_minutes: number;
  /** Seconds since the last request ended while the engine is loaded and free; null when unloaded or busy. */
  idle_seconds: number | null;
  slots: number | null;
  slots_busy: number;
  /** Why the model cannot be loaded now (the last refusal for memory, or a model larger than the model budget); null when nothing is known to stop it. */
  cannot_fit_reason: string | null;
  /** The engine serving coding: the running process's while one runs, else the one the next start chooses. */
  engine: CodingEngine;
  /** What the setting asks for. */
  engine_requested: "auto" | CodingEngine;
  /** Why the faster engine is not in use though it was wanted (plain words); null when nothing is amiss. */
  engine_reason: string | null;
}

export function codingEngineStatus(): CodingEngineStatus {
  const current = runtime("coding");
  const settings = codingLaunchSettings();
  const running = current.process && !current.process.retired ? current.process : null;
  const base = getRoleStatus("coding");
  const model = selectedModel("coding");
  let state: CodingEngineStatus["state"];
  if (running) state = running.activeRequests > 0 ? "busy" : "ready";
  else if (current.starting || base.state === "loading") state = "loading";
  else if (base.state === "offline") state = "offline";
  else state = model && engineInstalledFor("coding") ? "installed" : "notInstalled";
  const lastEnd = current.lastRealRequestAt;
  return {
    state,
    keep_warm_minutes: settings.keepWarmMinutes,
    idle_seconds: running && running.activeRequests === 0 && lastEnd !== null ? Math.max(0, Math.round((Date.now() - lastEnd) / 1000)) : null,
    slots: running?.slots ?? (state === "notInstalled" ? null : settings.slots),
    slots_busy: running ? Math.min(running.activeRequests, running.slots ?? settings.slots) : 0,
    cannot_fit_reason: state === "installed" || state === "offline" ? codingCannotFitReason() : null,
    ...codingEngineFields(running),
  };
}

function codingEngineFields(running: RoleProcess | null): Pick<CodingEngineStatus, "engine" | "engine_requested" | "engine_reason"> {
  const choice = activeCodingChoice();
  const serving = running?.engine === "splash" || running?.engine === "llama-server" ? running.engine : choice.engine;
  // A running llama-server under a Splash choice is the fallback: say why.
  const reason = serving === choice.engine ? choice.reason : codingEngineFailure() ? `Splash did not start (${codingEngineFailure()!.reason}), so coding is using the slower engine, llama-server.` : null;
  return { engine: serving, engine_requested: choice.requested, engine_reason: reason };
}

/** The engine the coding role runs on, from what is configured and installed, without starting anything (S3: the wire check reads it before a request can start the engine). */
let codingEngineForTests: string | null | undefined;
export function codingEngineName(): string | null { return codingEngineForTests !== undefined ? codingEngineForTests : engineForRole("coding"); }
export function setCodingEngineForTests(engine: string | null | undefined): void { codingEngineForTests = engine; }

/** What `GET /v1/models?role=coding` lists: the coding role's one served model, or null when none is bound. The window is the running engine's when loaded and the one the next start asks for otherwise; the ceiling is the live setting. Never starts the engine. */
export function codingServedModel(): { id: string; context_length: number; thinking_budget_ceiling: number } | null {
  const model = selectedModel("coding");
  if (!model) return null;
  const settings = codingLaunchSettings();
  const running = runtime("coding").process;
  return { id: model.id, context_length: running && !running.retired && running.contextLength ? running.contextLength : settings.contextLength, thinking_budget_ceiling: settings.thinkingBudgetTokens };
}

/** Why coding cannot load right now, from facts at hand (no dry run, no process): the last refusal for memory, or a model whose estimated peak exceeds the model budget outright. */
export function codingCannotFitReason(): string | null {
  if (runtime("coding").process) return null;
  const refused = runtime("coding").cannotFitReason ?? null;
  if (refused) return refused;
  const model = selectedModel("coding");
  if (!model?.sizeBytes) return null;
  const peak = Math.ceil((model.measuredFootprintBytes ?? model.sizeBytes * 1.3));
  const status = getGovernorStatus();
  return peak > status.capBytes ? codingMemoryMessage({ peakBytes: peak, freeBytes: status.freeMemoryBytes, budgetBytes: status.capBytes, marginBytes: status.marginBytes }) : null;
}

/** The governor's way to evict a jit item (idle, keep-warm or pressure):
 * drains and unloads it. The coding engine is never unloaded while it
 * serves a request (the lease), so a generator job waits for it and a
 * long answer is never cut off by the idle clock. */
export async function unloadJitForGovernor(id: string): Promise<boolean> {
  const role = id as RoleId;
  if (!JIT_ROLES.includes(role)) return false;
  const current = runtimes.get(role);
  if (!current?.process) return false;
  if (role === "coding") {
    if (current.process.activeRequests > 0) return false;
    const keepWarmMs = codingKeepWarmSeconds() * 1000;
    const idleLong = current.lastRealRequestAt !== null && Date.now() - current.lastRealRequestAt >= keepWarmMs - 6_000;
    return unloadRole(role, idleLong ? `Unloaded after ${codingLaunchSettings().keepWarmMinutes} minutes without a coding request.` : "Unloaded to free memory for other work.");
  }
  return unloadRole(role, "Unloaded by the memory governor.");
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
  if (role === "tts" && activeTtsChoice().engine === "chatterbox-turbo") {
    if (!mlxAudioInstalled()) throw new EngineUnavailableError("The MLX voice environment is not built on this machine.");
    const script = await materializeServerScript();
    return { command: mlxAudioCommand(script, port, "chatterbox-turbo", TTS_ENGINES["chatterbox-turbo"].repo!), engine: "chatterbox-turbo", build: MLX_AUDIO_VERSION, stdin: "ignore", contextLength: 0, kind: "managed", env: mlxAudioEnv() };
  }
  if (role === "tts") {
    if (!pocketTtsInstalled()) throw new EngineUnavailableError("The Pocket TTS environment is not built on this machine.");
    // Offline always; the token never travels (STACK-94d).
    return { command: pocketTtsCommand(port), engine: "pocket-tts", build: POCKET_TTS_VERSION, stdin: "ignore", contextLength: 0, kind: "managed", env: pocketTtsEnv() };
  }
  const declared = engineSettingValues("engines.llama_server");
  const config = { contextLength: declared.context_length, slots: declared.slots, threads: declared.threads, cacheRamMb: declared.cache_ram_mb, flashAttention: declared.flash_attention } as Record<string, number | boolean | string | string[]>;
  // The coding role sizes its own window (codingContextFor) and never reaches the chat launch's context fit.
  const codingRole = role === "coding";
  // A record with its own launch (vision) runs one slot, as its args say.
  const slots = declaredLaunchContext(model) !== null ? 1 : typeof config.slots === "number" && config.slots > 0 ? config.slots : 1;
  const contextLength = resolvedContextLength ?? (codingRole ? codingLaunchSettings().contextLength : null) ?? declaredLaunchContext(model) ?? (typeof config.contextLength === "number" && config.contextLength > 0 ? config.contextLength : engineForRole(role) === "omlx" ? omlxContextLength(model, config) : await contextForLaunch(model, config, slots, gpuLayersFor(role)));
  if (codingRole && engineForRole(role) === "splash") return splashLaunchPlan(model, port, resolvedContextLength ?? codingLaunchSettings().contextLength);
  if (engineForRole(role) === "omlx") {
    // oMLX (ENGINE-MLX-01): an environment the Stack built, serving the one
    // pinned MLX directory on loopback behind a random key. Offline, with
    // its prompt cache emptied at every launch. The record's pinned
    // template variables ride with every request (the client).
    if (!omlxInstalled()) throw new EngineUnavailableError("The oMLX environment is not built on this machine.");
    resetOmlxState();
    const { folder, modelId } = prepareModelFolder(model.modelPath!);
    const apiKey = newLaunchKey();
    const kwargs = declaredChatTemplateKwargs(model) ?? undefined;
    const command = omlxCommand({ port, modelFolder: folder, apiKey, concurrent: slots });
    return {
      command, engine: "omlx", build: `omlx-${OMLX_VERSION}`, stdin: "ignore", contextLength, slots, contextScope: "per slot", kind: "spawned", env: omlxEnv(),
      imageInput: declaredReadsPictures(model), pictureTokensMax: null,
      client: (baseUrl) => new OmlxEngineClient({ baseUrl, apiKey, modelId, templateKwargs: kwargs }),
      identity: { build: `omlx-${OMLX_VERSION}`, model: basename(model.modelPath!) },
    };
  }
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
  if (role === "coding") {
    // The coding role's own launch: thinking on under a server-side budget, q8_0 KV, one shared window, offline.
    const coding = codingLaunchSettings();
    const window = resolvedContextLength ?? coding.contextLength;
    const args = codingServerArgs({ modelPath: model.modelPath!, port, contextLength: window, slots: coding.slots, thinkingBudgetTokens: coding.thinkingBudgetTokens, alias: model.id });
    return { command: [binary, ...args], engine: "llama-server", build: currentEngineTag("llama-server") ?? pin.tag, stdin: "ignore", contextLength: window, slots: coding.slots, contextScope: "total across slots", kind: "spawned", imageInput: false, pictureTokensMax: null };
  }
  const projector = launchProjectorFor(role, model);
  if (role === "vision" && !projector?.modelPath) throw new EngineUnavailableError(`The ${model.id} projector is not installed.`);
  const pictureTokensMax = projector?.modelPath ? declaredPictureTokensMax(model) : null;
  const args = llamaServerArgs({ modelPath: model.modelPath!, port, config, contextLength, kvCacheType: defaultKvCacheType(), gpuLayers: gpuLayersFor(role), embeddings: role === "embed", projectorPath: projector?.modelPath ?? undefined, onePictureSlot: role === "vision", imageMaxTokens: pictureTokensMax ?? undefined, chatTemplateKwargs: declaredChatTemplateKwargs(model) ?? undefined });
  return { command: [binary, ...args], engine: "llama-server", build: currentEngineTag("llama-server") ?? pin.tag, stdin: "ignore", contextLength, slots, contextScope: "per slot", kind: "spawned", imageInput: !!projector?.modelPath, pictureTokensMax };
}

/** The coding role on Splash (CODE-STACK-01 S5a): the bundled Python runs the launcher, which becomes the server and starts the native engine under it. The Stack lays out the hub cache first (hardlinks of its own pinned files), so the engine starts offline and downloads nothing; a layout it cannot make is a plain-words refusal that sends the request to llama-server. */
export function splashLaunchPlan(model: ModelRecord, port: number, contextLength: number): LaunchPlan {
  const pin = installedEnginePin("splash");
  if (!pin || !engineInstalled("splash")) throw new EngineUnavailableError("No installed Splash build is available for this machine.");
  const launcher = launchBinary(pin);
  // The pin's tool is `engine/splash`; the program's root is two levels up.
  const root = dirname(dirname(launcher));
  let layout: ReturnType<typeof layOutSplashCache>;
  const pair = splashPairFor(model.id);
  try { layout = layOutSplashCache(getModel, pair.pin, pair.draftPin); } catch (error) { if (error instanceof SplashLayoutError) throw new EngineUnavailableError(error.message); throw error; }
  const values = settingValues();
  const cacheSetting = values[SPLASH_CACHE_GB_SETTING];
  const cacheGb = typeof cacheSetting === "number" && Number.isFinite(cacheSetting) ? Math.max(0, Math.floor(cacheSetting)) : SPLASH_CACHE_GB_DEFAULT;
  const coding = codingLaunchSettings(values);
  const tag = currentEngineTag("splash") ?? pin.tag;
  const modeCoding = currentHomeMode() === "coding" || homeModeEnteringCoding();
  const governor = getGovernorStatus();
  const stayingBytes = modeCoding ? governor.loaded.filter((item) => !["chat", "judge", "coding"].includes(item.id)).reduce((sum, item) => sum + item.peakBytes, 0) : 0;
  const draftRecord = model.id === STACK_CODING_HEAVY_MODEL.id ? getModel(STACK_CODING_HEAVY_DRAFT_MODEL.id) : componentModel("coding", "draft");
  const estimate = splashFootprintEstimateBytes({ weightsBytes: model.sizeBytes ?? 0, draftBytes: draftRecord?.sizeBytes ?? STACK_CODING_HEAVY_DRAFT_MODEL.download!.approx_bytes, contextTokens: contextLength });
  const maxMemoryBytes = modeCoding ? Math.max(1, Math.min(governor.capBytes - stayingBytes, estimate + governor.marginBytes)) : null;
  const args = splashArgs({ model: layout.model, revision: layout.revision, port, servedModelName: model.id, thinkingBudgetTokens: coding.thinkingBudgetTokens, contextLength, cacheGb, ...(modeCoding ? { defaultReasoningEffort: "none" as const, maxMemory: `${Math.max(1, Math.floor(maxMemoryBytes! / 1_073_741_824))}G`, decodeShare: 1.0 } : {}) });
  return {
    command: [join(root, "python", "bin", "python3"), "-u", join(root, "install", "launcher.py"), ...args],
    engine: "splash", build: tag, stdin: "ignore", contextLength,
    // Splash schedules requests itself (its queue is 32 deep); `slots` is the number of coding requests Home should expect to run at once, reported, not enforced.
    slots: coding.slots, contextScope: "total across slots", kind: "spawned", imageInput: false, pictureTokensMax: null,
    env: splashEnv(layout), healthPath: "/ready", tree: true,
    client: (baseUrl) => new ServedNameClient(new OpenAIEngineClient(baseUrl, "/ready"), model.id),
    // Splash has no /props: the Stack knows both what it launched and which file it linked.
    identity: { build: `splash-${tag}`, model: modelFileName(model.modelPath!) },
    verifyServed: (baseUrl) => verifySplashServes(baseUrl, model.id),
  };
}

/** The readiness identity check: the engine on this port lists the served name the Stack gave it and calls itself Splash. */
export async function verifySplashServes(baseUrl: string, servedName: string): Promise<void> {
  let listed: Array<{ id?: unknown; owned_by?: unknown }> = [];
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null) as { data?: unknown } | null;
    if (response.ok && Array.isArray(body?.data)) listed = body.data as typeof listed;
  } catch { /* said below */ }
  const match = listed.find((entry) => entry.id === servedName);
  if (!match) throw new EngineUnavailableError(`Splash started but does not serve ${servedName} (it lists ${listed.map((entry) => String(entry.id)).join(", ") || "nothing"}), so coding is not using it.`);
  if (match.owned_by !== "splash") throw new EngineUnavailableError(`The engine on the coding port did not identify itself as Splash (it says ${String(match.owned_by)}), so coding is not using it.`);
}

// ---- unexpected exits (ROBUST-01) -----------------------------------------

export interface EngineExit { exitCode: number | null; signal: string | null; stderrTail: string[]; ranMs: number; }
export interface CrashReport extends EngineExit { role: RoleId; kind: EngineKind; engine: string | null; modelId: string | null; wasBusy: boolean; verdict: CrashVerdict; }
let crashListener: ((report: CrashReport) => void) | null = null;
/** The self-heal controller's hook: called once for every engine that
 * exited without the Stack asking it to. */
export function setCrashListener(listener: ((report: CrashReport) => void) | null): void { crashListener = listener; }

/** An engine that exited on its own: the role goes offline, the Repairs
 * item names the classified cause, the governor lets go of its memory,
 * and the self-heal listener hears about it. A process the Stack retired
 * (a stop, a restart, an unload) is not a crash and is ignored. */
export function reportEngineExit(role: RoleId, processRecord: RoleProcess, exit: EngineExit, check?: PostLoadCheck | null): boolean {
  const current = runtime(role);
  if (processRecord.retired || current.process !== processRecord) return false;
  const wasBusy = processRecord.activeRequests > 0;
  current.process = null;
  current.starting = null;
  const verdict = classifyCrash({ exitCode: exit.exitCode, signal: exit.signal, stderrTail: exit.stderrTail, memoryLevel: memoryLevel() });
  current.status = { kind: processRecord.kind, state: "offline", reason: "The spawned engine exited unexpectedly.", identity: processRecord.identity, postLoadCheck: check ?? current.status.postLoadCheck };
  emit({ id: "engine.state", data: { engine: role, state: "offline", reason: "The spawned engine exited unexpectedly." } });
  logger.appendLine(JSON.stringify({ event: "engine.exit", role, exitCode: exit.exitCode, signal: exit.signal, ranMs: exit.ranMs, cause: verdict.kind, memoryLevel: memoryLevel(), stderrTail: exit.stderrTail.slice(-20) }));
  raise({ code: `engine.crashed.${role}`, severity: "error", title: `The ${role} engine crashed`, text: `${verdict.cause} ${verdict.fix}`, cause: verdict.cause, fix: { label: "Restart engine", action: "restart_engine" } });
  processRecord.stopGovernor?.();
  if (processRecord.governorHandle) release(processRecord.governorHandle);
  if (crashListener && !stoppingAll) {
    try { crashListener({ ...exit, role, kind: processRecord.kind, engine: processRecord.engine, modelId: processRecord.modelId, wasBusy, verdict }); } catch (error) { logger.appendLine(JSON.stringify({ event: "self-heal.error", role, error: (error as Error).message })); }
  }
  return true;
}

/** Roles with a process the Stack could start, that report offline and
 * have nothing running or starting: the state a crash leaves when
 * nothing asks the role for a request (Home pauses chat while it is
 * offline, so no request ever restarts it). */
export function offlineRolesWithoutProcess(): RoleId[] {
  const found: RoleId[] = [];
  for (const [role, current] of runtimes) {
    if (current.status.state === "offline" && !current.process && !current.starting && !current.manuallyStopped && SPAWNABLE_ROLES.includes(role) && !urlBindingFor(role) && (testFactory !== null || (engineInstalledFor(role) && selectedModel(role) !== null))) found.push(role);
  }
  return found;
}

export function roleGeneration(role: RoleId): number { return runtime(processRoleFor(role)).generation; }
export function roleHasProcess(role: RoleId): boolean { const current = runtime(processRoleFor(role)); return !!current.process || !!current.starting; }
export function roleManuallyStopped(role: RoleId): boolean { return runtime(processRoleFor(role)).manuallyStopped; }
export function isStoppingAll(): boolean { return stoppingAll; }

/** The self-heal start: the role's process again, then proof it works.
 * The start's own post-load check already sent one request; this adds the
 * identity check and a second one-token request, so "ready" is claimed
 * only for a role that answers as the model the Stack selected. */
export async function healStart(requested: RoleId): Promise<{ ok: true } | { ok: false; reason: string }> {
  const role = processRoleFor(requested);
  const current = runtime(role);
  current.startFailureCount = 0;
  current.retryAfter = 0;
  try {
    const started = await getProcess(role);
    const identity = identityCheck(role);
    const wire = ROLES[role].wire;
    let failure: string | null = identity.ok ? null : identity.reason ?? "The restarted engine did not report the selected model.";
    if (!failure) {
      const probe = wire === "speech" ? await probeSpeech(started.client) : wire === "job" ? null : await started.client.request(probeRequest(role).path, probeRequest(role).body);
      if (probe && !probeReplyOk(role, probe)) failure = "The restarted engine did not answer a one-token check.";
    }
    if (failure) {
      // Never leave a process the check refused standing as "ready".
      if (current.process === started) {
        current.process = null;
        current.status = { ...current.status, state: "offline", reason: failure };
        emitRoleState(role, "offline", failure);
        void retire(started);
      }
      return { ok: false, reason: failure };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof EngineUnavailableError ? error.reason : (error as Error).message };
  }
}

async function startSpawnedProcess(role: RoleId, modelId?: string): Promise<RoleProcess> {
  if (!SPAWNABLE_ROLES.includes(role)) throw new EngineUnavailableError(`No engine can be started for ${role} on this machine yet.`);
  const model = modelId ? selectableModel(role, modelId) : selectedModel(role);
  if (!engineInstalledFor(role)) {
    const reason = SPEECH_ROLES.includes(role) ? `The ${role} voice activity detector is not installed.`
      : role === "image" ? "The ComfyUI environment is not built on this machine."
      : engineForRole(role) === "mlx-serve" ? "No installed mlx-serve build is available for this machine."
      : engineForRole(role) === "omlx" ? "The oMLX environment or its model is not installed on this machine."
      : engineForRole(role) === "splash" ? "Splash or its draft model is not installed on this machine."
      : role === "tts" ? (activeTtsChoice().engine === "chatterbox-turbo" ? "The Chatterbox Turbo files are not all installed." : pocketTtsInstalled() ? "The tts tokenizer or default voice is not installed." : "The Pocket TTS environment is not built on this machine.")
      : "No installed llama-server build is available for this machine.";
    throw new EngineUnavailableError(reason);
  }
  if (!model?.modelPath) throw new EngineUnavailableError(`No verified and installed ${role} model is available.`);
  const launchConfig = engineSettingValues("engines.llama_server") as Record<string, number | boolean | string | string[]>;
  // The coding role: its slots and its window come from its own settings, and the window steps down until the engine's dry run fits what the governor can admit without evicting anything.
  const coding = role === "coding" ? codingLaunchSettings() : null;
  // On Splash there is no `llama-fit-params`: the window is the setting's (Splash's key-value cache is small) and the governor's figure is an estimate, until the post-load reading of the process tree replaces it.
  const onSplash = coding !== null && engineForRole(role) === "splash";
  const splashEstimate = onSplash ? splashFootprintEstimateBytes({ weightsBytes: model.sizeBytes ?? 0, draftBytes: getModel(splashPairFor(model.id).draftPin.id)?.sizeBytes ?? splashPairFor(model.id).draftPin.download!.approx_bytes, contextTokens: coding!.contextLength }) : null;
  const codingWindow = coding ? (onSplash ? { contextLength: coding.contextLength, dryRunPeakBytes: splashEstimate } : await codingContextFor(model, coding.contextLength)) : null;
  const ownContext = coding ? codingWindow!.contextLength : declaredLaunchContext(model);
  const declaredContextLength = ownContext ?? launchConfig.context_length;
  const slots = coding ? coding.slots : ownContext !== null ? 1 : typeof launchConfig.slots === "number" && launchConfig.slots > 0 ? launchConfig.slots : 1;
  const contextLength = typeof declaredContextLength === "number" && declaredContextLength > 0 ? declaredContextLength : engineForRole(role) === "omlx" ? omlxContextLength(model, launchConfig) : await contextForLaunch(model, { ...launchConfig, contextLength: 0 }, slots, gpuLayersFor(role));
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
  // A role placed on the processor is sized by the processor-side
  // estimate; the dry run (llama-fit-params) plans graphics-card layers.
  const onProcessor = gpuLayersFor(role) === 0;
  const dryRunPeakBytes = coding ? codingWindow!.dryRunPeakBytes : engineForRole(role) === "llama-server" && !managed && !generator && !SPEECH_ROLES.includes(role) && model.modelPath.endsWith(".gguf")
    ? onProcessor
      ? (await runGgufParser({ target: { path: model.modelPath }, contextTokens: contextLength * slots, kvCacheType: defaultKvCacheType(), gpuLayers: 0 }))?.ramNonumaBytes ?? null
      : await dryRunFootprint(model.modelPath, contextLength * slots, { kvCacheType: defaultKvCacheType(), flashAttention: launchConfig.flash_attention !== false })
    : null;
  if (engineForRole(role) === "llama-server" && !managed && !generator && !SPEECH_ROLES.includes(role) && model.modelPath.endsWith(".gguf") && !dryRunPeakBytes && !model.measuredFootprintBytes && !(typeof declaredContextLength === "number" && declaredContextLength > 0)) {
    throw new EngineUnavailableError("The fit plan could not estimate the launched context for the memory governor; install the GGUF parser or set an explicit context length.");
  }
  logger.appendLine(JSON.stringify({ event: "governor.peak-source", role, source: onSplash ? "splash-estimate" : dryRunPeakBytes ? "dry-run" : "none", bytes: dryRunPeakBytes }));
  // A projector loads beside the model (the vision role's, or a chat
  // model's that reads pictures): its bytes count too. The fit tool sizes
  // the language model alone, so the projector is added.
  const projectorBytes = launchProjectorFor(role, model)?.sizeBytes ?? 0;
  const pinMeasured = measuredPeakFromPin(model);
  const request = {
    id: role, kind: JIT_ROLES.includes(role) && !(role === "coding" && (currentHomeMode() === "coding" || homeModeEnteringCoding())) ? "jit" as const : "resident" as const,
    requestedBytes: managed && !generator ? (model.measuredFootprintBytes ?? TTS_ENGINES[activeTtsChoice().engine].estimatedFootprintBytes) : (model.sizeBytes ?? 0) + projectorBytes,
    modelFileBytes: managed && !generator ? null : (model.sizeBytes ?? 0) + projectorBytes || null,
    // A jit role's pin carries the whole-machine cost measured on a real
    // load (weights the engine maps are not in the process footprint),
    // and the larger of that and the store's own reading is the peak.
    measuredPeakBytes: onSplash ? null : JIT_ROLES.includes(role) && pinMeasured !== null ? Math.max(pinMeasured, model.measuredFootprintBytes ?? 0) : model.measuredFootprintBytes,
    dryRunPeakBytes: dryRunPeakBytes === null ? null : dryRunPeakBytes + projectorBytes,
    headroomBytes: engineForRole(role) === "mlx-serve" && !managed && !generator && !SPEECH_ROLES.includes(role) ? mlxHeadroomBytes({ modelDir: model.modelPath!, contextTokens: contextLength }) : null,
    engine: generator ? "comfyui" : managed ? TTS_ENGINES[activeTtsChoice().engine].catalogEngine : SPEECH_ROLES.includes(role) ? "sherpa-onnx-node" : engineForRole(role) === "mlx-serve" ? "mlx-serve" : engineForRole(role) === "omlx" ? "oMLX" : onSplash ? "splash" : "llama-server",
    pinned: pinnedModels.has(model.id),
    // The coding engine gives way to a generator job while it is idle (CODE-STACK-01 S2).
    ...(role === "coding" ? { yieldsToGenerators: !(currentHomeMode() === "coding" || homeModeEnteringCoding()), pinned: currentHomeMode() === "coding" || homeModeEnteringCoding() || pinnedModels.has(model.id) } : {}),
  };
  // The coding engine's own keep-warm limit replaces the governor-wide idle limit for it.
  if (role === "coding") applyCodingKeepWarm();
  let timedOut = false;
  // A stop or a restart during the wait (the generation moves) means
  // nobody wants this admission any more.
  const startGeneration = runtime(role).generation;
  let admission: GovernorHandle | null;
  try {
    admission = await waitForAdmission(request, { stillWanted: () => !timedOut && !stoppingAll && runtime(role).generation === startGeneration, timeoutMs: START_WAIT_MS, onGaveUp: () => { timedOut = true; } });
  } catch (error) {
    if (role === "coding" && error instanceof AdmissionRefusedError) throw new EngineDoesNotFitError(codingRefusal(request));
    throw new EngineUnavailableError(error instanceof AdmissionRefusedError ? error.message.replace(/^\S+ needs about/, `The ${role} engine needs about`) : (error as Error).message);
  }
  if (!admission && role === "coding" && !stoppingAll && runtime(role).generation === startGeneration) throw new EngineDoesNotFitError(codingRefusal(request));
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
  // Splash is a tree of processes: remembered by command so a stop or a crash leaves no member holding memory.
  const tree = plan.tree ? new TreeSnapshot(handle.pid) : null;
  const client = plan.client ? plan.client(`http://127.0.0.1:${port}`) : new OpenAIEngineClient(`http://127.0.0.1:${port}`, plan.healthPath);
  const stderrText = handle.stderr ? new Response(handle.stderr).text() : Promise.resolve("");
  let exited = false;
  const exitPromise = handle.exited.then((code) => { exited = true; return code; });
  try {
    const exitFailure = exitPromise.then(async (code) => {
      throw new EngineUnavailableError(describeStartFailure(code, await stderrText));
    });
    void exitFailure.catch(() => {});
    const loadStartedAt = performance.now();
    await Promise.race([waitHealthy(client, loadTimeoutForModel(model.sizeBytes), () => !exited), exitFailure]);
    // The engine answered; it must also be the engine and the model the Stack launched.
    if (plan.verifyServed) await plan.verifyServed(client.baseUrl);
    let identity = plan.identity ? { host: "local" as const, build: plan.identity.build, model: plan.identity.model, healthy: true } : await readEngineIdentity(client.baseUrl, undefined, plan.healthPath);
    // A managed engine exposes no build or model of its own; the Stack
    // knows both: the version it installed, and the model it linked (the
    // checkpoint file for ComfyUI; for Pocket TTS the weights the hub
    // cache holds, read after health and never assumed from the config).
    if (plan.kind === "managed") {
      const model_ = GENERATOR_ROLES.includes(role) ? basename(model.modelPath!) : plan.engine === "chatterbox-turbo" ? TTS_ENGINES["chatterbox-turbo"].repo : loadedWeightsRepo()?.repo ?? null;
      identity = { ...identity, build: `${plan.engine}-${plan.build}`, model: model_ };
    }
    // mlx-serve's /props carries no build_info or model_path: the build
    // is the pin's tag, the model the directory the Stack launched.
    if (plan.engine === "mlx-serve") identity = { ...identity, build: identity.build ?? `mlx-serve-${plan.build}`, model: identity.model ?? basename(model.modelPath!) };
    const check = await postLoadCheck(role, client, tree ? null : handle.pid);
    // A tree's weights are held by its native child: the reading is the whole tree's, and it is not stored on the model (the llama-server reading belongs to the same pin).
    if (tree) { tree.refresh(); check.actualBytes = treeMemoryBytes(handle.pid, (member) => getMemoryReader().processMemoryBytes(member)); }
    const keepsFootprint = tree ? false : keepsMeasuredFootprint(model, plan.imageInput === true);
    const readsPictures = plan.imageInput === true && (role === "vision" || await picturesProbeOk(client));
    if (plan.imageInput === true && !readsPictures) raise({ code: `picture-check-failed.${role}`, severity: "warning", title: "Chat cannot read pictures right now", text: `The ${model.id} projector loaded but did not read the check picture; chat answers text only until it restarts.`, cause: "picture check failed", fix: { label: "Restart engine", action: "restart_engine" } });
    else resolveHealth(`picture-check-failed.${role}`);
    check.loadMs = Math.round(performance.now() - loadStartedAt);
    if (check.actualBytes !== null) {
      // A model that reads pictures, launched without its projector (not
      // installed yet), is not its usual footprint: that reading is not
      // stored, so a later launch with the projector never plans on it.
      if (keepsFootprint) recordMeasuredFootprint(model.id, check.actualBytes, contextLength);
      refreshMeasuredPeak(admission, check.actualBytes);
    }
    runtime(role).status.postLoadCheck = check;
    resolveHealth(`engine.crashed.${role}`);
    resolveHealth(`post-load-check-failed.${role}`);
    const loadedRevision = plan.kind === "managed" && !GENERATOR_ROLES.includes(role) ? (plan.engine === "chatterbox-turbo" ? model.revision : loadedWeightsRepo()?.revision) ?? null : null;
    // The coding engine is the one engine the isolation gate may stop (it yields to chat); no other engine gets a pausable handle.
    const codingPausable = role === "coding" && plan.kind === "spawned" ? new PausableProcess(handle.pid, handle.exited, { engine: true, tree: plan.tree === true }) : undefined;
    const processRecord: RoleProcess = {
      role, kind: plan.kind, client, identity, engine: plan.engine, contextLength: plan.contextLength, slots: plan.slots, contextScope: plan.contextScope, modelId: model.id, modelRevision: loadedRevision ?? model.revision, imageInput: readsPictures, projectorLoaded: plan.imageInput === true, pictureTokensMax: readsPictures ? plan.pictureTokensMax ?? null : null, pid: handle.pid, port, activeRequests: 0, retired: false,
      governorHandle: admission,
      stopGovernor: watchProcessMemory(role, handle.pid, keepsFootprint ? { modelId: model.id, contextLength } : undefined, tree ? (pid) => Promise.resolve(treeMemoryBytes(pid, (member) => getMemoryReader().processMemoryBytes(member))) : undefined),
      ...(role === "coding" && plan.kind === "spawned" ? { pausable: codingPausable } : {}),
      // A stopped process holds SIGTERM until it runs again, so it continues first. A tree is asked to stop from its root, given a few seconds, and then every member that is still running is stopped, so nothing is left holding memory.
      stop: async () => {
        codingPausable?.resume();
        if (!tree) { handle.kill(); await handle.exited; return; }
        tree.refresh();
        handle.kill();
        await Promise.race([handle.exited, new Promise((done) => setTimeout(done, 8_000))]);
        await tree.stopAll();
        await handle.exited;
      },
    };
    const spawnedAt = Date.now();
    void handle.exited.then(async (exitCode) => {
      // A tree whose root went away on its own: whatever of it is left is stopped now.
      if (tree) void tree.stopAll(3_000);
      // The last stderr lines say why it died (the memory manager's kill
      // leaves none); read with a short bound so a held pipe never stalls the report.
      const tail = await Promise.race([stderrText, new Promise<string>((resolve) => setTimeout(() => resolve(""), 500))]).catch(() => "");
      reportEngineExit(role, processRecord, { exitCode: typeof exitCode === "number" ? exitCode : null, signal: handle.signalCode ?? null, stderrTail: stderrEvidence(tail, 20), ranMs: Date.now() - spawnedAt }, check);
    });
    return processRecord;
  } catch (error) {
    if (tree) { tree.refresh(); handle.kill(); await tree.stopAll(3_000); } else handle.kill();
    const message = (error as Error).message;
    if (exited) {
      // A start that failed leaves the same log event as a crash, with the first errors and the tail.
      const failedStderr = await Promise.race([stderrText, new Promise<string>((resolve) => setTimeout(() => resolve(""), 500))]).catch(() => "");
      logger.appendLine(JSON.stringify({ event: "engine.exit", role, exitCode: handle.exitCode, signal: handle.signalCode ?? null, phase: "start", cause: message, stderrTail: stderrEvidence(failedStderr, 20) }));
    }
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
  if (role === "tts") return startVoiceWithFallback(modelId);
  if (role === "chat") return startChatWithFallback(modelId);
  if (role === "coding") return currentHomeMode() === "coding" || homeModeEnteringCoding() ? startSpawnedProcess("coding", STACK_CODING_HEAVY_MODEL.id) : startCodingWithFallback(modelId);
  return startSpawnedProcess(role, modelId);
}

/** oMLX that cannot start (a crash, a refusal, a load that never
 * finished) is tried once more; the second failure sends chat to
 * llama-server for the rest of this run, with a warning that says why. A
 * failed chat engine never leaves the household without chat. A restart
 * of the chat engine clears the memory and tries the chosen engine again. */
async function startChatWithFallback(modelId?: string, start: (role: RoleId, modelId?: string) => Promise<RoleProcess> = startSpawnedProcess): Promise<RoleProcess> {
  if (activeChatChoice().engine !== "omlx") return start("chat", modelId);
  let reason = "";
  for (let attempt = 1; attempt <= FALLBACK_AFTER_FAILURES; attempt++) {
    try {
      const started = await start("chat", modelId);
      resolveHealth("chat.engine-fallback");
      return started;
    } catch (error) {
      if (stoppingAll) throw error;
      reason = error instanceof Error ? error.message : String(error);
      markChatEngineFailed("omlx", reason);
    }
  }
  raise({ code: "chat.engine-fallback", severity: "warning", title: "oMLX did not start; chat is on llama-server", text: reason, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
  return start("chat");
}
/** The fallback with the spawn replaced, for the suite. */
export const startChatWithFallbackForTests = startChatWithFallback;

/** Splash is the coding engine where the machine qualifies and it is installed with its draft; llama-server is the fallback (CODE-STACK-01 S5a). A Splash start that fails (a crash, a layout it cannot make, an engine that does not serve the model, a refusal for memory) sends the same request to llama-server, raises a warning that says what happened, that coding is on the slower engine and what to do, and, unless it was only a refusal for memory, keeps coding on llama-server until the coding engine is restarted. A refusal for memory is not held against Splash: the next start tries it again. The warning clears when a Splash start works. */
async function startCodingWithFallback(modelId?: string, start: (role: RoleId, modelId?: string) => Promise<RoleProcess> = startSpawnedProcess): Promise<RoleProcess> {
  const choice = activeCodingChoice();
  if (choice.engine !== "splash") {
    // An admin who asked for Splash and is not getting it is told why, once, as a warning; `auto` on a Mac that cannot run it says nothing.
    // A failure already raised its own warning, which stays until a Splash start works.
    if (!codingEngineFailure()) {
      if (choice.requested === "splash" && choice.reason) raise({ code: "coding.engine-fallback", severity: "warning", title: "Splash is not running; coding is on llama-server", text: choice.reason, cause: choice.reason, fix: { label: "Restart engine", action: "restart_engine" } });
      else if (choice.requested !== "splash") resolveHealth("coding.engine-fallback");
    }
    return start("coding", modelId);
  }
  try {
    const started = await start("coding", modelId);
    resolveHealth("coding.engine-fallback");
    return started;
  } catch (error) {
    if (stoppingAll) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const noRoom = error instanceof EngineDoesNotFitError;
    if (!noRoom) markCodingEngineFailed(reason);
    raise({ code: "coding.engine-fallback", severity: "warning", title: "Splash did not start; coding is on llama-server", text: `${/[.!?]$/.test(reason) ? reason : `${reason}.`} Coding is using the slower engine, llama-server, ${noRoom ? "for this request. Wait for the picture, video or song job to finish, or close a large app." : "until the coding engine is restarted. Restart the coding engine to try Splash again."}`, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
    forcedCodingEngine = "llama-server";
    try { return await start("coding", modelId); } finally { forcedCodingEngine = null; }
  }
}
/** The fallback with the spawn replaced, for the suite. */
export const startCodingWithFallbackForTests = startCodingWithFallback;

/** A voice engine other than Pocket TTS that cannot start (a crash, a
 * memory refusal, a load that never finished) falls back to Pocket TTS
 * for the rest of this run, with a warning that says why; a failed
 * voice engine never fails the Stack or chat. A restart of the voice
 * engine clears the memory and tries the chosen engine again. */
async function startVoiceWithFallback(modelId?: string): Promise<RoleProcess> {
  const choice = activeTtsChoice();
  if (choice.engine === "pocket") return startSpawnedProcess("tts", modelId);
  try {
    const started = await startSpawnedProcess("tts", modelId);
    resolveHealth("tts.engine-fallback");
    return started;
  } catch (error) {
    if (stoppingAll) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    markTtsEngineFailed(choice.engine, reason);
    raise({ code: "tts.engine-fallback", severity: "warning", title: `${TTS_ENGINES[choice.engine].label} did not start; the voice is on Pocket TTS`, text: reason, cause: reason, fix: { label: "Restart engine", action: "restart_engine" } });
    return startSpawnedProcess("tts");
  }
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
    const waiting = current.status.reason ?? `The ${role} engine start is backing off after a failed admission.`;
    throw current.cannotFitReason ? new EngineDoesNotFitError(waiting) : new EngineUnavailableError(waiting);
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
      current.cannotFitReason = null;
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
        // A refusal for memory is not a broken engine: the role stays `installed` with the reason, and a retry is allowed after a few seconds (the person may have closed something).
        const noRoom = error instanceof EngineDoesNotFitError;
        const delay = noRoom ? DOES_NOT_FIT_RETRY_MS : Math.min(START_RETRY_CAP_MS, START_RETRY_BASE_MS * 2 ** Math.min(20, current.startFailureCount - 1));
        current.retryAfter = Date.now() + delay;
        current.cannotFitReason = noRoom ? reason : null;
        current.status = { ...current.status, state: noRoom ? "installed" : "offline", reason };
        emitRoleState(role, noRoom ? "installed" : "offline", reason);
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
  // What the coding role's engine choice needs to know about this Mac (CODE-STACK-01 S5a).
  const chip = await detectAppleChip();
  setCodingMachineFacts({ platform: hardware.platform, arch: hardware.arch, chipGeneration: chip?.generation ?? null, chipName: chip?.name ?? null, memoryGb: hardware.totalRamGb, osVersion: hardware.osVersion });
  // The daemon's own pid: no loaded item carries it, so this watch only
  // keeps the reading and the tier, never restarts anything.
  return { tier: tier ?? null, stop: startGovernor({ pid: process.pid, tier: machineTier }) };
}

/** The governor's watch on a spawned process (its memory against its
 * own post-load reading, a restart on a sustained runaway once it is
 * idle), carrying the machine's tier. With `measured`, a rise in this
 * run's peak is stored for the model, so the next admission and fit plan
 * start from the latest run. */
export function watchProcessMemory(role: RoleId, pid: number, measured?: { modelId: string; contextLength: number }, processMemory?: (pid: number) => Promise<number | null>): () => void {
  // `unload` is the governor's way to evict a `jit` role (idle, or under
  // pressure): it drains and stops that role's process, never chat's.
  return startGovernor({ pid, tier: machineTier, ...(processMemory ? { processMemory } : {}), restart: async () => { await restartRole(role); }, busy: () => {
    const current = runtimes.get(role)?.process;
    return current?.pid === pid && current.activeRequests > 0;
  }, onPeak: measured ? (_id, bytes) => { recordMeasuredFootprint(measured.modelId, bytes, measured.contextLength); } : undefined, unload: async (id) => {
    // Only a running jit process is evicted here; one still starting is
    // left to its own start, so its admission stays counted. The coding
    // engine also declines while it serves a request.
    return unloadJitForGovernor(id);
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

/** VISION-03f: a chat process that started text-only (its projector was
 * not installed yet, or its record did not declare one) is restarted once
 * the projector is installed and verified, so the next message reads
 * pictures without anyone restarting the Stack. A process that did load
 * its projector is left alone, even when its picture check failed (that
 * has its own health item and a restart action). Returns the roles
 * restarted. */
export async function restartForNewProjector(): Promise<RoleId[]> {
  const restarted: RoleId[] = [];
  for (const role of ["chat"] as RoleId[]) {
    const running = runtime(role).process;
    const model = selectedModel(role);
    if (!running || running.retired || running.projectorLoaded === true || !model || running.modelId !== model.id) continue;
    if (!launchProjectorFor(role, model)) continue;
    await restartRole(role);
    restarted.push(role);
  }
  return restarted;
}

/** ENGINE-MLX-01: a chat process still on llama-server once oMLX and its
 * model are installed and verified is restarted onto oMLX, so the switch
 * needs no one to restart the Stack. Only an idle process moves, and
 * only when the engine in effect for a fresh start differs. Returns true
 * when it restarted chat. */
export async function restartForNewChatEngine(): Promise<boolean> {
  const running = runtime("chat").process;
  if (!running || running.retired || running.kind === "url" || running.activeRequests > 0) return false;
  if (running.engine === activeChatChoice().engine) return false;
  await restartRole("chat");
  return true;
}

/** Called when a person or a setting restarts a role by hand: the
 * self-heal controller forgets its failures and any retry it had pending. */
let restartListener: ((role: RoleId) => void) | null = null;
export function setRestartListener(listener: ((role: RoleId) => void) | null): void { restartListener = listener; }

export async function restartRole(requested: RoleId): Promise<void> {
  restartListener?.(processRoleFor(requested));
  await recycleRole(requested);
}

/** Retires the role's process and leaves the next start to the caller, without telling the self-heal controller a person did it (a canary's restart request counts toward the breaker). */
export async function recycleRole(requested: RoleId): Promise<void> {
  const role = processRoleFor(requested);
  if (role === "tts") clearTtsEngineFailures();
  if (role === "chat") clearChatEngineFailures();
  if (role === "coding") clearCodingEngineFailures();
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
export interface IdleUnloadOptions { now?: Date; onBattery: boolean; idleMinutes: number; batteryIdleMinutes: number; keep?: RoleId[]; /** A role's own idle limit in minutes, in place of both runtime-wide limits: the coding engine's keep-warm setting. */ roleIdleMinutes?: Partial<Record<RoleId, number>> }

export async function unloadIdleRole(requested: RoleId, options: IdleUnloadOptions): Promise<boolean> {
  const role = processRoleFor(requested);
  if (role === "coding" && (currentHomeMode() === "coding" || homeModeEnteringCoding())) return false;
  if (!options.onBattery && options.keep?.includes(role)) return false;
  const current = runtime(role);
  const processRecord = current.process;
  const last = current.lastRealRequestAt;
  const idleMinutes = options.roleIdleMinutes?.[role] ?? (options.onBattery ? options.batteryIdleMinutes : options.idleMinutes);
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

export async function unloadIdleRoles(options: IdleUnloadOptions): Promise<RoleId[]> {
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

/** The body a request is dispatched with, after the model's own sampling. The
 * coding role (CODE-STACK-01 S3) drops every client sampling field and sets
 * the pin's, on every generation path and streaming or not (design 3.6:
 * client sampling dropped); the token-count paths carry no sampling. Every other
 * role keeps its rule: the pin fills only what the request left out, on
 * `/v1/chat/completions` when not streaming and on any path when streaming. */
function samplingFor(role: RoleId, requested: RoleId, path: string, modelId: string | null, body: Record<string, unknown>, streaming: boolean): Record<string, unknown> {
  if (role === "coding" && requested === "coding") return CODING_GENERATION_PATHS.includes(path) ? withPinSampling(modelId, dropClientSampling(body)) : body;
  return withPinSampling(streaming || path === "/v1/chat/completions" ? modelId : null, body);
}

export function applyHomeModeCodingDefaults(requested: RoleId, body: Record<string, unknown>): Record<string, unknown> {
  if (requested !== "coding" || currentHomeMode() !== "coding") return body;
  const out = { ...body };
  if (out.reasoning_effort === undefined) out.reasoning_effort = "medium";
  if (out.thinking_budget_tokens === undefined) out.thinking_budget_tokens = codingLaunchSettings().thinkingBudgetTokens;
  return clampThinking(out, codingLaunchSettings().thinkingBudgetTokens);
}

export async function requestRole(requested: RoleId, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<RoleReply> {
  if (homeModeSwitching() && ["chat", "judge", "router", "coding"].includes(requested)) throw new EngineUnavailableError("Home is changing modes. Try the request again in a few seconds.");
  const role = processRoleFor(requested);
  const requestedModel = typeof body.model === "string" && body.model !== requested ? body.model : undefined;
  const processRecord = await acquireRequestProcess(requested, requestedModel);
  const current = runtime(role);
  try {
    const completionMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : (timeoutOverrides.completionMs ?? DEFAULT_COMPLETION_TIMEOUT_MS);
    const dispatchBody = samplingFor(role, requested, path, processRecord.modelId, requestedModel && processRecord.kind !== "url" ? { ...applyHomeModeCodingDefaults(requested, body), model: role } : applyHomeModeCodingDefaults(requested, body), false);
    const timedOut = () => new EngineUnavailableError(`Engine request timed out after ${Math.ceil(completionMs / 1000)}s.`);
    const answered = processRecord.client.request(path, dispatchBody, signal);
    const result = await (role === "coding" ? withActiveTimeout(answered, completionMs, () => codingPausedMs(processRecord), timedOut) : withTimeout(answered, completionMs, timedOut));
    if (result.status >= 500 && (continueForHealth(processRecord), !await processRecord.client.health())) {
      throw new EngineUnavailableError(`Engine returned HTTP ${result.status} and is no longer healthy.`);
    }
    if (result.status >= 200 && result.status < 300) current.lastRealRequestAt = Date.now();
    return { ...result, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { status: 499, body: { error: "Request cancelled" }, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    }
    continueForHealth(processRecord);
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
    if (role === "coding") { codingYieldEnd(processRecord); touchGovernor(role); }
    if (current.process === processRecord && processRecord.activeRequests === 0) current.status = { ...current.status, state: "ready" };
  }
}

function finishStream(role: RoleId, processRecord: RoleProcess): void {
  const current = runtime(role);
  processRecord.activeRequests--;
  // The coding engine's keep-warm clock counts from the end of its last request, not from its start.
  if (role === "coding") { codingYieldEnd(processRecord); touchGovernor(role); }
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
  if (homeModeSwitching() && ["chat", "judge", "router", "coding"].includes(requested)) throw new EngineUnavailableError("Home is changing modes. Try the request again in a few seconds.");
  const role = processRoleFor(requested);
  const requestedModel = typeof body.model === "string" && body.model !== requested ? body.model : undefined;
  const processRecord = await acquireRequestProcess(requested, requestedModel);
  const current = runtime(role);
  try {
    if (!processRecord.client.stream) throw new EngineUnavailableError("The engine does not support streaming.");
    const dispatchBody = samplingFor(role, requested, path, processRecord.modelId, requestedModel && processRecord.kind !== "url" ? { ...applyHomeModeCodingDefaults(requested, body), model: role } : applyHomeModeCodingDefaults(requested, body), true);
    const response = await processRecord.client.stream(path, { ...dispatchBody, stream: true }, signal);
    if (response.status >= 500 && (continueForHealth(processRecord), !await processRecord.client.health())) throw new EngineUnavailableError(`Engine returned HTTP ${response.status} and is no longer healthy.`);
    const contentType = response.headers.get("content-type") ?? undefined;
    if (!response.body) { finishStream(role, processRecord); return { status: response.status, body: null, headers: identityHeaders(processRecord.identity, processRecord.modelRevision), contentType }; }
    return { status: response.status, body: trackedStream(role, processRecord, response.body), headers: identityHeaders(processRecord.identity, processRecord.modelRevision), contentType };
  } catch (error) {
    finishStream(role, processRecord);
    if ((error instanceof DOMException && error.name === "AbortError") || signal?.aborted) return { status: 499, body: null, headers: identityHeaders(processRecord.identity, processRecord.modelRevision) };
    continueForHealth(processRecord);
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
  codingEngineForTests = undefined;
  stoppingAll = false;
  clearTtsEngineFailures();
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
      if (form) scriptedSpeechLog.push(Object.fromEntries([...form.entries()].map(([name, value]) => [name, String(value)])));
      // The real engine takes a preset name, an hf:// path it can read offline or (Chatterbox) a clip address; anything else is its own 400.
      if (typeof voice === "string" && voice && !(voice in POCKET_TTS_PRESET_VOICES) && !voice.startsWith("hf://") && !/^https?:\/\//.test(voice)) return new Response(JSON.stringify({ detail: `Unknown voice ${voice}.` }), { status: 400, headers: { "content-type": "application/json" } });
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
