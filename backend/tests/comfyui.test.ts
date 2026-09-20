// STACK-13b: ComfyUI as the image generator. The workflow the runner
// builds, the render against a scripted ComfyUI (queued, followed,
// fetched, cancelled with an interrupt), the generator's probe, the
// launch and its environment, the engine rows, and the images route
// rendering end to end through the real runner on the scripted engine.
// Nothing here runs uv, ComfyUI or torch.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "@/app";
import { registerGenerators } from "@/generators";
import { comfyuiCommand, comfyuiEnv, COMFYUI_VERSION, linkCheckpoint, parseSize, probeGenerator, renderImage, requirementsFileFor, workflowFor } from "@/generators/comfyui";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetHealthForTests } from "@/lib/health";
import { __resetJobsForTests, createJob, waitForJob } from "@/lib/jobs";
import { clearModelsForTests, upsertModel } from "@/lib/modelStore";
import { dataDir, modelsDir } from "@/lib/paths";
import { runCheck } from "@/lib/readiness";
import { __scriptedInterruptsForTests, getRoleStatus, resetSupervisorForTests, scriptedProcess, setSupervisorFactoryForTests } from "@/lib/supervisor";

const GB = 1_073_741_824;
beforeEach(() => { __resetHealthForTests(); __resetJobsForTests(); __resetGovernorForTests(); __setGovernorTuningForTestsOnly({ totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB, tier: "p32" }); clearModelsForTests(); setSupervisorFactoryForTests(async (role) => scriptedProcess(role)); });
afterEach(() => { setSupervisorFactoryForTests(null); resetSupervisorForTests(); __resetJobsForTests(); __resetGovernorForTests(); clearModelsForTests(); });

function imageModel(): string {
  const path = join(modelsDir, "sd-test", "scripted-image.safetensors");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "weights");
  upsertModel({ id: "sd-test", roles: ["image"], source: "catalog", provenance: { repo: "x/y" }, revision: "r", sha256: "e".repeat(64), licence: "CreativeML-OpenRAIL-M", verifiedAt: new Date().toISOString(), modelPath: path, sizeBytes: 7 });
  return path;
}

test("the workflow is one text-to-image graph on the pinned checkpoint with the person's prompt, size, steps and seed", () => {
  const graph = workflowFor({ prompt: "a lighthouse at dusk", negative_prompt: "text", size: "640x448", steps: 12, seed: 7 }, "v1-5-pruned-emaonly.safetensors") as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  expect(graph["1"]!.inputs.ckpt_name).toBe("v1-5-pruned-emaonly.safetensors");
  expect(graph["2"]!.inputs.text).toBe("a lighthouse at dusk");
  expect(graph["3"]!.inputs.text).toBe("text");
  expect(graph["4"]!.inputs).toMatchObject({ width: 640, height: 448, batch_size: 1 });
  expect(graph["5"]!.inputs).toMatchObject({ steps: 12, seed: 7, cfg: 7, sampler_name: "euler" });
  expect(graph["7"]!.class_type).toBe("SaveImage");
  expect(parseSize(undefined)).toEqual({ width: 512, height: 512 });
  expect(() => parseSize("500x500")).toThrow(/multiples of 8/);
  expect(() => parseSize("big")).toThrow(/width>x<height/);
  const seeded = workflowFor({ prompt: "x" }, "c") as Record<string, { inputs: { seed: number } }>;
  expect(seeded["5"]!.inputs.seed).toBeGreaterThanOrEqual(0);
});

test("a render queues the graph, follows the history to completion, fetches the image and reports progress", async () => {
  const client = scriptedProcess("image").client;
  const job = createJob({ kind: "image", role: "image", input: { prompt: "a lighthouse" }, state: "running" });
  const statuses: string[] = [];
  const result = await renderImage(client, "scripted-image.safetensors", job, new AbortController().signal, (update) => { if (update.status) statuses.push(update.status); });
  expect(result.images.length).toBe(1);
  expect(Buffer.from(result.images[0]!.b64_json, "base64").subarray(1, 4).toString()).toBe("PNG");
  expect(statuses[0]).toBe("queued at the engine");
  expect(statuses).toContain("rendering");
  expect(statuses.at(-1)).toBe("fetching the image");
  await expect(renderImage(client, "c", createJob({ kind: "image", input: { prompt: "  " } }), new AbortController().signal, () => {})).rejects.toThrow(/prompt is required/);
});

test("a cancelled render interrupts the engine's queue", async () => {
  const client = scriptedProcess("image").client;
  const job = createJob({ kind: "image", role: "image", input: { prompt: "slow" }, state: "running" });
  const controller = new AbortController();
  const before = __scriptedInterruptsForTests();
  setTimeout(() => controller.abort(), 100);
  await expect(renderImage(client, "scripted-image.safetensors", job, controller.signal, () => {})).rejects.toThrow(/cancelled/);
  expect(__scriptedInterruptsForTests()).toBe(before + 1);
});

test("the generator's probe is the engine's checkpoint list, and the pinned file must be on it", async () => {
  const client = scriptedProcess("image").client;
  expect((await probeGenerator(client, "scripted-image.safetensors")).body).toMatchObject({ checkpoint: true });
  expect((await probeGenerator(client, "other.safetensors")).body).toMatchObject({ checkpoint: false });
  expect((await probeGenerator(client, null)).body).toMatchObject({ checkpoint: false });
});

test("the launch runs ComfyUI's entry from its venv on loopback with its base directory under data/, and links the store's checkpoint", () => {
  const command = comfyuiCommand(8799);
  expect(command[0]).toMatch(/\/engines\/comfyui\/v0\.36\.0\/venv\/bin\/python$/);
  expect(command[1]).toMatch(/\/engines\/comfyui\/v0\.36\.0\/main\.py$/);
  expect(command.slice(2)).toEqual(["--listen", "127.0.0.1", "--port", "8799", "--base-directory", join(dataDir, "generators", "comfyui"), "--disable-auto-launch", "--disable-metadata", "--dont-print-server"]);
  const env = comfyuiEnv();
  expect(env.HOME).toBe(join(dataDir, "home"));
  expect(env.STACK_SECRETS_KEY).toBeUndefined();
  expect(COMFYUI_VERSION).toBe("v0.36.0");
  expect(requirementsFileFor("darwin", "arm64")).toMatch(/comfyui\.darwin-arm64\.requirements\.txt$/);
  expect(requirementsFileFor("linux", "x64")).toBeNull();
  const path = imageModel();
  expect(linkCheckpoint(path)).toBe("scripted-image.safetensors");
  const link = join(dataDir, "generators", "comfyui", "models", "checkpoints", "scripted-image.safetensors");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(existsSync(link)).toBe(true);
  rmSync(join(dataDir, "generators"), { recursive: true, force: true });
});

test("the engines list names ComfyUI's source pins for image and the environment as a managed row", async () => {
  const body = await (await app.request("/stack/v1/engines")).json() as { engines: Array<{ id: string; name: string; matchesThisMachine: boolean; installed: boolean }> };
  expect(body.engines.filter((engine) => engine.name === "comfyui" && engine.id.startsWith("comfyui-v0.36.0-")).length).toBe(3);
  expect(body.engines.find((engine) => engine.id === "comfyui-v0.36.0")).toMatchObject({ name: "comfyui", installed: false, matchesThisMachine: true });
});

test("POST /v1/images/generations renders through the real runner on the scripted engine, with the process's identity on the job's role", async () => {
  imageModel();
  registerGenerators();
  const response = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "image", prompt: "a lighthouse", size: "512x512", steps: 4 }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<{ b64_json: string; seed: number }> };
  expect(body.data.length).toBe(1);
  expect(Buffer.from(body.data[0]!.b64_json, "base64").subarray(1, 4).toString()).toBe("PNG");
  expect(typeof body.data[0]!.seed).toBe("number");
  expect(getRoleStatus("image").state).toBe("ready");
  const done = await waitForJob(body.job, 1_000);
  expect(done?.state).toBe("done");
  // The readiness check probes the generator's checkpoint list, never a render.
  const check = await runCheck({ roleIds: ["image"] });
  expect(check.results[0]).toMatchObject({ role: "image", ok: true });
  rmSync(join(dataDir, "generators"), { recursive: true, force: true });
});

test("with the checkpoint installed but no environment, the images route is the no-engine 503 with that reason", async () => {
  setSupervisorFactoryForTests(null);
  imageModel();
  registerGenerators();
  const response = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "image", prompt: "x" }) });
  expect(response.status).toBe(503);
  expect((await response.json() as { offline_reason: string }).offline_reason).toMatch(/No image engine is installed/);
});

test("the launch lays out the folders ComfyUI lists at start, custom_nodes first", () => {
  linkCheckpoint(imageModel());
  for (const name of ["custom_nodes", "input", "output", "temp", "user"]) expect(existsSync(join(dataDir, "generators", "comfyui", name))).toBe(true);
  rmSync(join(dataDir, "generators"), { recursive: true, force: true });
});

test("the render's memory ask scales with the pixels asked for and a size outside the bounds is refused", async () => {
  const { renderMemory, MAX_SIDE } = await import("@/generators/comfyui");
  expect(renderMemory({ input: { size: "512x512" } }).requestedBytes).toBe(GB);
  expect(renderMemory({ input: { size: "1024x1024" } }).requestedBytes).toBe(4 * GB);
  expect(renderMemory({ input: { size: "256x256" } }).requestedBytes).toBe(GB);
  expect(renderMemory({ input: { size: "nonsense" } }).requestedBytes).toBe(GB * (MAX_SIDE * MAX_SIDE) / (512 * 512));
  expect(() => parseSize("4096x4096")).toThrow(/between 64 and 2048/);
});

test("an extracted source is not a built environment: the archive's marker never stands for the venv's", async () => {
  const { uvEnvironmentReady, ENV_READY_MARKER } = await import("@/lib/uvEnvironment");
  const { ENGINE_READY_MARKER } = await import("@/lib/engineCatalog");
  const root = join(dataDir, "engines", "test-env", "v1");
  mkdirSync(join(root, "venv", "bin"), { recursive: true });
  writeFileSync(join(root, ENGINE_READY_MARKER), "now");
  writeFileSync(join(root, "venv", "bin", "python"), "");
  expect(uvEnvironmentReady({ root, proof: join(root, "venv", "bin", "python") })).toBe(false);
  writeFileSync(join(root, ENV_READY_MARKER), "now");
  expect(uvEnvironmentReady({ root, proof: join(root, "venv", "bin", "python") })).toBe(true);
  rmSync(join(dataDir, "engines", "test-env"), { recursive: true, force: true });
});
