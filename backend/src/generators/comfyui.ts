// ComfyUI as a managed engine (STACK-13b): a pinned release's source
// tree as an engine archive, its environment assembled through the
// pinned uv from a hashed requirements file, the launch the supervisor
// runs for the `image` role, and the render runner the job queue calls:
// one text-to-image workflow through ComfyUI's own queue (`/prompt`,
// `/history/{id}`, `/view`, `/interrupt`), the image back as base64.
// The checkpoint is a store pin the launch links into ComfyUI's model
// folder, so the store's provenance and checksum hold for it.
import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { engineTagRoot } from "@/lib/store/layout";
import { dataDir } from "@/lib/paths";
import { ensureUvEnvironment, managedEnv, uvEnvironmentReady, uvVenvPython, type UvEnvironmentSpec } from "@/lib/uvEnvironment";
import type { EngineClient } from "@/lib/supervisor";
import type { Job, JobMemory, JobProgress } from "@/lib/jobs";
import darwinArm64Requirements from "./comfyui.darwin-arm64.requirements.txt" with { type: "file" };

export const COMFYUI_NAME = "comfyui";
export const COMFYUI_VERSION = MANAGED_RUNTIMES.find((runtime) => runtime.name === COMFYUI_NAME)?.version ?? "v0.36.0";
/** The render's transient working set on top of the resident checkpoint
 * (latents, the VAE decode, the samplers' buffers) at 512 by 512,
 * scaled by pixel count for other sizes, before a measurement replaces
 * it. */
export const COMFYUI_RENDER_TRANSIENT_BYTES = 1_073_741_824;
export const DEFAULT_STEPS = 20;
export const DEFAULT_SIZE = "512x512";
/** The largest side a render may ask for: SD 1.5 was trained at 512 and
 * a larger canvas costs memory the estimate scales for, up to here. */
export const MAX_SIDE = 2048;
const POLL_MS = 500;

export function requirementsFileFor(platform = process.platform, arch = process.arch): string | null {
  if (platform === "darwin" && arch === "arm64") return darwinArm64Requirements;
  return null;
}

/** The source tree the engine archive extracted (main.py at its root),
 * beside the venv the Stack builds in the same directory. */
export function comfyuiRoot(): string { return engineTagRoot(COMFYUI_NAME, COMFYUI_VERSION); }
export function comfyuiEntry(): string { return join(comfyuiRoot(), "main.py"); }
export function comfyuiPython(): string { return uvVenvPython(comfyuiRoot()); }
/** ComfyUI's own base directory (its model folders, inputs, outputs,
 * temp, user settings), under data/ and never inside the source tree. */
export function comfyuiBase(): string { return join(dataDir, "generators", COMFYUI_NAME); }
export function comfyuiSourceInstalled(): boolean { return existsSync(comfyuiEntry()); }
export function comfyuiInstalled(): boolean { return comfyuiSourceInstalled() && uvEnvironmentReady({ root: comfyuiRoot(), proof: comfyuiPython() }); }

function spec(): UvEnvironmentSpec {
  return { name: COMFYUI_NAME, version: COMFYUI_VERSION, root: comfyuiRoot(), requirements: requirementsFileFor(), proof: comfyuiPython() };
}

/** The environment after the source archive: uv, a managed Python, the
 * hashed requirements (torch is the bulk). */
export function ensureComfyuiEnvironment(onProgress: (phase: string) => void = () => {}, options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!comfyuiSourceInstalled()) throw new Error("The ComfyUI source archive is not installed; install the engine build first.");
  return ensureUvEnvironment(spec(), onProgress, options);
}

/** Links the pinned checkpoint into ComfyUI's checkpoints folder under
 * the base directory, so the file the engine loads is the store's, and
 * lays out the folders ComfyUI insists on at start (it lists
 * custom_nodes before it serves, and there are none). */
export function linkCheckpoint(modelPath: string): string {
  const folder = join(comfyuiBase(), "models", "checkpoints");
  for (const dir of [folder, ...["custom_nodes", "input", "output", "temp", "user"].map((name) => join(comfyuiBase(), name))]) mkdirSync(dir, { recursive: true });
  const link = join(folder, basename(modelPath));
  try { unlinkSync(link); } catch { /* first link */ }
  symlinkSync(modelPath, link);
  return basename(modelPath);
}

export function comfyuiCommand(port: number): string[] {
  return [comfyuiPython(), comfyuiEntry(), "--listen", "127.0.0.1", "--port", String(port), "--base-directory", comfyuiBase(), "--disable-auto-launch", "--disable-metadata", "--dont-print-server"];
}

export function comfyuiEnv(): Record<string, string> {
  // ComfyUI's telemetry is opt-in only through its frontend; its
  // manager and API nodes are never enabled. Nothing else leaves.
  return managedEnv({ COMFYUI_BASE: comfyuiBase() });
}

/** What a render asks the governor to hold beyond the resident
 * checkpoint (which the process's own admission covers): the 512 by 512
 * estimate scaled by the pixel count asked for, never under it. A size
 * that does not parse is estimated at the maximum so the governor's
 * answer comes before the runner's refusal. */
export function renderMemory(job?: Pick<Job, "input">): JobMemory {
  let pixels = MAX_SIDE * MAX_SIDE;
  try { const { width, height } = parseSize((job?.input as { size?: string } | null)?.size); pixels = width * height; } catch { /* estimated at the maximum */ }
  return { requestedBytes: Math.ceil(COMFYUI_RENDER_TRANSIENT_BYTES * Math.max(1, pixels / (512 * 512))), engine: "comfyui" };
}

export interface RenderInput { prompt: string; negative_prompt?: string; size?: string; steps?: number; seed?: number; cfg?: number; }

export function parseSize(size: string | undefined): { width: number; height: number } {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size ?? DEFAULT_SIZE);
  if (!match) throw new Error(`size must be <width>x<height> (got ${size}).`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 8 || height % 8) throw new Error("width and height must be multiples of 8.");
  if (width < 64 || height < 64 || width > MAX_SIDE || height > MAX_SIDE) throw new Error(`width and height must be between 64 and ${MAX_SIDE}.`);
  return { width, height };
}

/** The one text-to-image graph: checkpoint, two prompts, an empty
 * latent, the sampler, the decode, the save. Node ids are strings as
 * ComfyUI's API wants them. */
export function workflowFor(input: RenderInput, checkpoint: string): Record<string, unknown> {
  const { width, height } = parseSize(input.size);
  const steps = Number.isInteger(input.steps) && input.steps! > 0 ? Math.min(input.steps!, 150) : DEFAULT_STEPS;
  const seed = Number.isInteger(input.seed) && input.seed! >= 0 ? input.seed! : Math.floor(Math.random() * 2 ** 32);
  const cfg = typeof input.cfg === "number" && input.cfg > 0 ? input.cfg : 7;
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: checkpoint } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: input.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: input.negative_prompt ?? "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
    "5": { class_type: "KSampler", inputs: { seed, steps, cfg, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "maipai", images: ["6", 0] } },
  };
}

interface HistoryEntry { status?: { completed?: boolean; status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }> }

async function jsonOf(response: Response): Promise<unknown> { try { return await response.json(); } catch { return null; } }

/** Runs one render on a living ComfyUI: queues the graph, follows the
 * history until it completes, fetches the image. Progress is by
 * polling ComfyUI's history and queue (its step-by-step progress only
 * travels over its websocket, which a later item may add); cancel
 * interrupts the running render and removes a queued one. */
export async function renderImage(client: EngineClient, checkpoint: string, job: Job, signal: AbortSignal, progress: JobProgress): Promise<{ images: Array<{ b64_json: string; seed?: number }> }> {
  if (!client.raw) throw new Error("The engine client cannot send a graph.");
  const input = (job.input ?? {}) as unknown as RenderInput;
  if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error("A prompt is required.");
  const workflow = workflowFor(input, checkpoint);
  const clientId = `maipai-${job.id}`;
  progress({ status: "queued at the engine" });
  const queued = await client.raw("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) }, signal);
  const queuedBody = await jsonOf(queued) as { prompt_id?: string; error?: unknown; node_errors?: unknown } | null;
  if (!queued.ok || !queuedBody?.prompt_id) throw new Error(`The engine refused the graph (HTTP ${queued.status}): ${JSON.stringify(queuedBody?.error ?? queuedBody?.node_errors ?? "no detail")}`);
  const promptId = queuedBody.prompt_id;
  let cancelled = false;
  const cancel = async () => {
    // A queued render is removed; a running one is interrupted; once.
    if (cancelled) return;
    cancelled = true;
    await client.raw!("/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
    await client.raw!("/interrupt", { method: "POST", body: "" }).catch(() => {});
  };
  const seed = (workflow["5"] as { inputs: { seed: number } }).inputs.seed;
  try {
    while (true) {
      if (signal.aborted) { await cancel(); throw new Error("The render was cancelled."); }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const history = await client.raw(`/history/${promptId}`, { method: "GET" });
      const entry = ((await jsonOf(history) as Record<string, HistoryEntry> | null) ?? {})[promptId];
      if (!entry) { progress({ status: "rendering" }); continue; }
      if (entry.status?.status_str === "error") throw new Error(`The engine failed the render: ${JSON.stringify(entry.status.messages ?? []).slice(0, 400)}`);
      if (!entry.status?.completed) { progress({ status: "rendering" }); continue; }
      const images = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? []);
      if (images.length === 0) throw new Error("The render completed with no image.");
      progress({ percent: 95, status: "fetching the image" });
      const results: Array<{ b64_json: string; seed?: number }> = [];
      for (const image of images) {
        const view = await client.raw(`/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder)}&type=${encodeURIComponent(image.type)}`, { method: "GET" }, signal);
        if (!view.ok) throw new Error(`The engine could not hand back ${image.filename} (HTTP ${view.status}).`);
        results.push({ b64_json: Buffer.from(await view.arrayBuffer()).toString("base64"), seed });
      }
      return { images: results };
    }
  } catch (error) {
    if (signal.aborted) { await cancel(); }
    throw error;
  }
}

/** The generator's post-load and readiness probe: the engine lists the
 * checkpoints it can load, and the pinned one must be among them. */
export async function probeGenerator(client: EngineClient, checkpoint: string | null): Promise<{ status: number; body: unknown }> {
  if (!client.raw) return { status: 501, body: { error: "The engine client cannot ask for its checkpoints." } };
  const response = await client.raw("/object_info/CheckpointLoaderSimple", { method: "GET" });
  const body = await jsonOf(response) as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } } } | null;
  const names = body?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? [];
  return { status: response.status, body: { checkpoint: response.ok && checkpoint !== null && names.includes(checkpoint), names } };
}
