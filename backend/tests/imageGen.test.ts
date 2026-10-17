// IMGGEN-STACK-01/02, IMGGEN-EDIT-01, IMGGEN-LORA-01: the picture service, its
// job API, the edit operations, the LoRA library and the pins, driven by a
// scripted worker (no model, no GPU). The real worker on real weights is
// exercised on a scratch Stack (the design note's "Stack API as built").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob, listJobs } from "@/lib/jobs";
import { STACK_IMAGE_ENGINE_MODELS, STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ZIMAGE_MODELS, STACK_MODELS } from "@/lib/modelCatalog";
import { MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { resolveRoleState } from "@/lib/router";
import { detectImageBase, imageLoras, parseHfLoraUrl, startLoraInstall } from "@/images/loras";
import { registerImageJobs, pngSize } from "@/images/jobs";
import { commitResult, readResult, resultsRoot, sweepResults, workDir } from "@/images/results";
import { ImageGenService, imageEngineActive, imageGen, imageRoleState, imageRequirementsFileFor, overallPercent, workerHandle, type ImageGenDeps, type WorkerEvent, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/images/imageEngine";
import { __setInstalledFamiliesForTests, IMAGE_FAMILIES, parseSize, peakBytes, quantizeFor } from "@/images/models";
import { __resetProvenanceForTests, wasGeneratedHere } from "@/video/provenance";
import { LoraError, scanWords } from "@/lib/media/loraLibrary";
import { parseRegion } from "@/routes/imageGenerations";
import { dataDir } from "@/lib/paths";
import { __resetGenHistoryForTests, GenTracker, historyKey, IMAGE_STAGES } from "@/lib/genProgress";

const GB = 1_073_741_824;

/** A PNG header with the given size (the Stack reads only the header of a finished picture). */
function pngBytes(width: number, height: number, tail = "x"): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
}
const SMALL_PNG_B64 = pngBytes(8, 8).toString("base64");

let spawned = 0;
let killed = 0;
const cancelled: string[] = [];
const requests: WorkerRequest[] = [];

type Script = (request: WorkerRequest, emit: (event: WorkerEvent) => void) => Promise<WorkerReply> | WorkerReply;
const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, seeds: Array.from({ length: request.count ?? 1 }, (_, i) => request.seed + i), ms: 4100, peak_bytes: 13_500_000_000, width: request.width, height: request.height });

function scripted(script: Script = okReply, over: Partial<ImageGenDeps> = {}): ImageGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    snapshot: (family) => `/models/${family}`,
    spawn: async (): Promise<WorkerHandle> => {
      spawned += 1;
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      let abort: ((reply: WorkerReply) => void) | null = null;
      return {
        exited,
        kill: () => { killed += 1; end(143); },
        cancel: (id) => { cancelled.push(id); abort?.({ id, ok: false, code: "cancelled", error: "Cancelled." }); },
        send: async (request, options) => {
          requests.push(request);
          const stopped = new Promise<WorkerReply>((resolve) => { abort = resolve; });
          const reply = await Promise.race([script(request, options.onEvent), stopped, exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "The picture engine stopped before the picture was finished. Try again." }) as WorkerReply)]);
          if (reply.ok) {
            const count = request.op === "edit" ? 1 : request.count ?? 1;
            for (let i = 0; i < count; i++) {
              writeFileSync(join(request.out_dir, `${i}.png`), pngBytes(request.width ?? 640, request.height ?? 480, `PNG${i}`));
              writeFileSync(join(request.out_dir, `${i}.thumb.jpg`), `JPG${i}`);
            }
          }
          return reply;
        },
      };
    },
    ...over,
  };
}

function clean(): void {
  imageGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests();
  __setInstalledFamiliesForTests(null);
  for (const path of ["images", "tmp/images", "tmp/image-lora"]) rmSync(join(dataDir, path), { recursive: true, force: true });
}
beforeEach(() => {
  spawned = 0; killed = 0; requests.length = 0; cancelled.length = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  __setInstalledFamiliesForTests(["flux2-klein-4b", "z-image-turbo"]);
  registerImageJobs();
});
afterEach(() => { delete process.env.IMAGE_IDLE_MS; delete process.env.IMAGE_RESULT_KEEP; delete process.env.IMAGE_RESULT_TTL_MS; clean(); });

const post = (body: Record<string, unknown>) => app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);
type Pic = Record<string, unknown> & { url: string; thumbnail_url: string; b64_json?: string };

/** A safetensors header the way a trainer writes it (the tensors are empty: the Stack reads only the header). */
function loraFile(name: string, options: { base?: "klein" | "zimage" | "sdxl" | "wan"; metadata?: Record<string, string>; modules?: number } = {}): string {
  const base = options.base ?? "klein";
  const header: Record<string, unknown> = {};
  if (options.metadata) header.__metadata__ = options.metadata;
  for (let i = 0; i < (options.modules ?? 3); i++) {
    const prefix = base === "klein" ? `diffusion_model.double_blocks.${i}.img_attn.qkv` : base === "zimage" ? `diffusion_model.layers.${i}.attention.to_k` : base === "wan" ? `diffusion_model.blocks.${i}.self_attn.q` : `lora_unet_down_blocks_${i}_attentions_0_to_q`;
    const dim = base === "klein" ? 3072 : base === "zimage" ? 3840 : base === "wan" ? 3072 : 640;
    const [a, b] = base === "sdxl" ? ["lora_down", "lora_up"] : ["lora_A", "lora_B"];
    header[`${prefix}.${a}.weight`] = { dtype: "F16", shape: [16, dim], data_offsets: [0, 0] };
    header[`${prefix}.${b}.weight`] = { dtype: "F16", shape: [dim, 16], data_offsets: [0, 0] };
  }
  if ((options.modules ?? 3) === 0) header["something.weight"] = { dtype: "F16", shape: [4, 4], data_offsets: [0, 0] };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const dir = mkdtempSync(join(tmpdir(), "imglora-"));
  const path = join(dir, `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}
const lora = (name: string, options: Parameters<typeof loraFile>[1] & { classification?: "all-ages" | "adult-only"; licence?: string } = {}) =>
  imageLoras.importFile({ path: loraFile(name, options), name, licence: options.licence ?? "apache-2.0", classification: options.classification ?? "all-ages", triggerWords: ["t3chnic4lly"] });

// ---- the job API ----

test("pictures are made, polled to done, fetched, and deleted; the picture is the Stack's own for a later clip", async () => {
  imageGen.useDeps(scripted((request, emit) => { emit({ id: request.id, event: "phase", phase: "rendering", percent: 50 }); emit({ id: request.id, event: "image", index: 0, seed: request.seed }); return okReply(request); }));
  const response = await post({ model: "image", prompt: "a paper boat", seed: 7, n: 2, size: "640x480", timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Pic[] };
  expect(body.data).toHaveLength(2);
  expect(body.data[0]).toMatchObject({ width: 640, height: 480, seed: 7, mode: "generate", model: "flux2-klein-4b", steps: 4, content_type: "image/png", lora_ids: [] });
  expect(body.data[1]!.seed).toBe(8);
  expect(Buffer.from(body.data[1]!.b64_json!, "base64").subarray(-4).toString()).toBe("PNG1");
  expect(requests[0]).toMatchObject({ op: "generate", family: "flux2-klein-4b", quantize: 8, width: 640, height: 480, steps: 4, seed: 7, count: 2, loras: [] });
  expect(response.headers.get("x-maipai-engine")).toBeDefined();
  const status = await (await get(`/v1/images/generations/${body.job}`)).json() as Record<string, unknown>;
  expect(status).toMatchObject({ state: "done", phase: "ready", progress: 100, error: null });
  expect((status.data as Pic[])[0]!.b64_json).toBeUndefined();
  const png = await get(body.data[0]!.url);
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array(pngBytes(640, 480, "PNG0")));
  expect((await get(body.data[0]!.thumbnail_url)).headers.get("content-type")).toBe("image/jpeg");
  expect(wasGeneratedHere(new Uint8Array(pngBytes(640, 480, "PNG0")))).toBe(true);
  expect(getJob(body.job)!.result).toMatchObject({ model: "flux2-klein-4b", mode: "generate" });
  expect((await app.request(`/v1/images/generations/${body.job}`, { method: "DELETE" })).status).toBe(200);
  expect((await get(body.data[0]!.url)).status).toBe(404);
  expect((await get(`/v1/images/generations/${body.job}`)).status).toBe(404);
  expect(getGovernorStatus().loaded).toHaveLength(0);
  expect(existsSync(workDir(body.job))).toBe(false);
});

test("neither the prompt nor an input picture is kept in a job record, on the feed or in the result store", async () => {
  imageGen.useDeps(scripted());
  const response = await post({ prompt: "SECRET-PROMPT-WORDS", negative_prompt: "SECRET-NEGATIVE", init_image: SMALL_PNG_B64, image_source: "uploaded", timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string };
  expect(JSON.stringify(listJobs())).not.toContain("SECRET");
  expect(JSON.stringify(getJob(body.job))).not.toContain(SMALL_PNG_B64);
  const meta = readFileSync(join(resultsRoot(), body.job, "meta.json"), "utf8");
  expect(meta).not.toContain("SECRET");
  expect(JSON.parse(meta)).toMatchObject({ mode: "image-to-image", model: "flux2-klein-4b" });
  expect(requests[0]!.prompt).toBe("SECRET-PROMPT-WORDS");
  expect(requests[0]!.init_image).toContain(".init.bin");
  expect(requests[0]!.strength).toBe(0.6);
  // The staged input pictures are gone once the job ends.
  expect(existsSync(requests[0]!.init_image!)).toBe(false);
});

test("past timeout_ms the answer is 202 with the job; status shows queue and phase; cancel stops the worker between steps and returns the memory", async () => {
  imageGen.useDeps(scripted(async (request, emit) => { emit({ id: request.id, event: "phase", phase: "rendering", percent: 40 }); await new Promise(() => {}); return okReply(request); }));
  const response = await post({ prompt: "a boat", timeout_ms: 30 });
  expect(response.status).toBe(202);
  const body = await response.json() as { job: string; data: unknown[] };
  expect(body.data).toEqual([]);
  await Bun.sleep(80);
  const running = await (await get(`/v1/images/generations/${body.job}`)).json() as Record<string, unknown>;
  expect(running).toMatchObject({ state: "running", phase: "rendering", phase_progress: 40, position: null });
  expect(running.progress as number).toBeGreaterThan(5);
  expect(getGovernorStatus().loaded.some((item) => item.kind === "generator")).toBe(true);
  expect((await app.request(`/v1/images/generations/${body.job}`, { method: "DELETE" })).status).toBe(200);
  await Bun.sleep(50);
  expect(cancelled).toEqual([body.job]);
  expect(getJob(body.job)!.state).toBe("cancelled");
  expect((await (await get(`/v1/images/generations/${body.job}`)).json() as Record<string, unknown>).state).toBe("cancelled");
  expect(getGovernorStatus().loaded).toHaveLength(0);
});

test("a second picture waits in line behind the first; a video job in flight holds pictures back; the line is capped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  imageGen.useDeps(scripted(async (request) => { await gate; return okReply(request); }));
  const first = await post({ prompt: "one", timeout_ms: 1 });
  const second = await post({ prompt: "two", timeout_ms: 1 });
  expect(first.status).toBe(202); expect(second.status).toBe(202);
  const queued = await (await get(`/v1/images/generations/${((await second.json()) as { job: string }).job}`)).json() as Record<string, unknown>;
  expect(queued).toMatchObject({ state: "queued", phase: "queued", position: 1 });
  await post({ prompt: "three", timeout_ms: 1 }); await post({ prompt: "four", timeout_ms: 1 });
  const full = await post({ prompt: "five", timeout_ms: 1 });
  expect(full.status).toBe(429);
  expect((await full.json() as { code: string }).code).toBe("queue_full");
  release();
  await Bun.sleep(100);
});

test("a video clip holding the generator admission makes a picture wait, never run beside it", async () => {
  imageGen.useDeps(scripted());
  const held = await admit({ id: "video-job", kind: "generator", requestedBytes: 44 * GB, engine: "video-gen" });
  expect("queued" in held || "refused" in held).toBe(false);
  const response = await post({ prompt: "a boat", timeout_ms: 60 });
  expect(response.status).toBe(202);
  const job = ((await response.json()) as { job: string }).job;
  await Bun.sleep(40);
  expect((await (await get(`/v1/images/generations/${job}`)).json() as { phase: string }).phase).toBe("waiting for memory");
  expect(requests).toHaveLength(0);
});

test("requests are checked: size, count, steps, model, starting picture", async () => {
  imageGen.useDeps(scripted());
  const bad = async (body: Record<string, unknown>) => { const r = await post({ prompt: "x", timeout_ms: 5000, ...body }); return { status: r.status, code: ((await r.json()) as { code?: string }).code }; };
  expect(await bad({ size: "1000x1000" })).toMatchObject({ status: 422, code: "bad_size" });
  expect(await bad({ size: "128x128" })).toMatchObject({ status: 422, code: "bad_size" });
  expect(await bad({ size: "4096x1024" })).toMatchObject({ status: 422, code: "bad_size" });
  expect((await bad({ n: 5 })).status).toBe(400);
  expect(await bad({ steps: 13 })).toMatchObject({ status: 422, code: "bad_steps" });
  // A model id that is not a picture family belongs to the supervised engine path, which answers its own 400.
  expect((await bad({ model: "nonsense-model" })).status).toBe(400);
  expect(await bad({ init_image: "not base64!!" })).toMatchObject({ status: 422, code: "bad_image" });
  expect(await bad({ init_image: Buffer.from("plain text, not a picture").toString("base64") })).toMatchObject({ status: 422, code: "bad_image" });
  expect(requests).toHaveLength(0);
  __setInstalledFamiliesForTests([]);
  expect(imageEngineActive()).toBe(false);
  expect((await post({ prompt: "x" })).status).toBe(503);
});

test("Z-Image-Turbo runs when named, with its own steps, and a smaller tier refuses it", async () => {
  imageGen.useDeps(scripted());
  const response = await post({ model: "z-image-turbo", prompt: "a fox", timeout_ms: 5000 });
  expect(response.status).toBe(200);
  expect(requests[0]).toMatchObject({ family: "z-image-turbo", steps: 9, quantize: 8 });
  __setGovernorTuningForTestsOnly({ tier: "p64", totalMemoryBytes: 64 * GB, freeMemoryBytes: 40 * GB });
  const refused = await post({ model: "z-image-turbo", prompt: "a fox", timeout_ms: 5000 });
  expect(refused.status).toBe(503);
  expect((await refused.json() as { code: string }).code).toBe("not_available_on_this_computer");
  __setGovernorTuningForTestsOnly({ tier: "p32", totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB });
  const small = await post({ prompt: "a fox", timeout_ms: 5000 });
  expect(small.status).toBe(200);
  expect(requests.at(-1)).toMatchObject({ family: "flux2-klein-4b", quantize: 4 });
  __setGovernorTuningForTestsOnly({ tier: "p16", totalMemoryBytes: 16 * GB, freeMemoryBytes: 8 * GB });
  expect((await post({ prompt: "a fox", timeout_ms: 5000 })).status).toBe(503);
});

test("a failed picture reports the engine's sentence and code; an out-of-memory worker is replaced", async () => {
  imageGen.useDeps(scripted((request) => ({ id: request.id, ok: false, code: "out_of_memory", error: "There was not enough memory for that picture. Try a smaller size." })));
  const response = await post({ prompt: "x", timeout_ms: 5000 });
  expect(response.status).toBe(507);
  expect(await response.json()).toMatchObject({ code: "out_of_memory", error: "There was not enough memory for that picture. Try a smaller size." });
  expect(killed).toBe(1);
  await post({ prompt: "x", timeout_ms: 5000 });
  expect(spawned).toBe(2);
  expect(getGovernorStatus().loaded).toHaveLength(0);
});

test("the worker exits after the idle time and starts again on the next picture; it is never started at boot", async () => {
  process.env.IMAGE_IDLE_MS = "400";
  imageGen.useDeps(scripted());
  expect(spawned).toBe(0);
  await post({ prompt: "x", timeout_ms: 5000 });
  expect(spawned).toBe(1);
  expect(imageGen.workerAlive).toBe(true);
  await post({ prompt: "y", timeout_ms: 5000 });
  expect(spawned).toBe(1);
  await Bun.sleep(600);
  expect(killed).toBe(1);
  expect(imageGen.workerAlive).toBe(false);
  await post({ prompt: "z", timeout_ms: 5000 });
  expect(spawned).toBe(2);
});

// ---- LoRAs ----

test("a LoRA is chosen by id or sha256, selects the base it was made for, and reaches the worker with its scale", async () => {
  imageGen.useDeps(scripted());
  const klein = await lora("pixel-style", { base: "klein" });
  const zimage = await lora("technicolor", { base: "zimage" });
  expect(klein.base_model).toBe("flux2-klein-4b");
  expect(zimage.base_model).toBe("z-image-turbo");
  expect(klein.id).toBe(`lora-${klein.sha256.slice(0, 16)}`);
  const one = await post({ prompt: "a fox", loras: [{ id: klein.id, scale: 0.8 }], timeout_ms: 5000 });
  expect(one.status).toBe(200);
  expect(requests[0]).toMatchObject({ family: "flux2-klein-4b", loras: [[imageLoras.path(klein.id), 0.8]] });
  expect(((await one.json()) as { data: Pic[] }).data[0]!.lora_ids).toEqual([klein.id]);
  const two = await post({ prompt: "a fox", loras: [{ sha256: zimage.sha256 }], timeout_ms: 5000 });
  expect(two.status).toBe(200);
  expect(requests[1]).toMatchObject({ family: "z-image-turbo", steps: 9, loras: [[imageLoras.path(zimage.id), 1]] });
  const mixed = await post({ prompt: "a fox", loras: [{ id: klein.id }, { id: zimage.id }], timeout_ms: 5000 });
  expect(mixed.status).toBe(422);
  expect((await mixed.json() as { code: string }).code).toBe("wrong_base_model");
  const wrongModel = await post({ model: "z-image-turbo", prompt: "a fox", loras: [{ id: klein.id }], timeout_ms: 5000 });
  expect((await wrongModel.json() as { code: string }).code).toBe("wrong_base_model");
  const unknown = await post({ prompt: "a fox", loras: [{ id: "lora-0000000000000000" }], timeout_ms: 5000 });
  expect((await unknown.json() as { code: string }).code).toBe("unknown_lora");
  const tooMany = await post({ prompt: "a fox", loras: [1, 2, 3, 4, 5].map(() => ({ id: klein.id })), timeout_ms: 5000 });
  expect(tooMany.status).toBe(400);
});

test("an adult-only LoRA needs an adult audience, whatever list is sent; the class cannot be lifted on a file that names adult content", async () => {
  imageGen.useDeps(scripted());
  const adult = await lora("night-style", { base: "klein", classification: "adult-only" });
  const flagged = await lora("flagged-style", { base: "klein", classification: "all-ages", metadata: { ss_tag_frequency: JSON.stringify({ img: { nsfw: 40, portrait: 20 } }) } });
  expect(flagged.classification).toBe("adult-only");
  expect(flagged.classification_note).toContain("adult-only");
  const child = await post({ prompt: "a fox", loras: [{ id: adult.id }], timeout_ms: 5000 });
  expect(child.status).toBe(422);
  expect((await child.json() as { code: string }).code).toBe("lora_not_allowed");
  const explicit = await post({ prompt: "a fox", loras: [{ id: adult.id }], audience: "all-ages", timeout_ms: 5000 });
  expect(explicit.status).toBe(422);
  expect(requests).toHaveLength(0);
  const allowed = await post({ prompt: "a fox", loras: [{ id: adult.id }], audience: "adult", timeout_ms: 5000 });
  expect(allowed.status).toBe(200);
  await expect(imageLoras.update(flagged.id, { classification: "all-ages" })).rejects.toMatchObject({ code: "classification_locked" });
});

test("a file that is not a usable LoRA, or must never be added, is refused with the reason", async () => {
  await expect(lora("sdxl-style", { base: "sdxl" })).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(lora("video-style", { base: "wan" })).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(lora("empty", { modules: 0 })).rejects.toMatchObject({ code: "not_a_lora" });
  await expect(lora("schoolgirl-nsfw-pack", { base: "klein" })).rejects.toMatchObject({ code: "lora_refused" });
  await expect(lora("loli-style", { base: "klein" })).rejects.toMatchObject({ code: "lora_refused" });
  await expect(lora("celebrity-likeness", { base: "klein" })).rejects.toMatchObject({ code: "lora_refused" });
  await expect(imageLoras.importFile({ path: loraFile("ok"), name: "ok", licence: "creativeml-openrail-m" })).rejects.toMatchObject({ code: "licence_acknowledgement_required" });
  const added = await imageLoras.importFile({ path: loraFile("ok2"), name: "ok2", licence: "creativeml-openrail-m", licenceAcknowledged: true });
  expect(added).toMatchObject({ licence_class: "acknowledged", classification: "adult-only" });
  await expect(imageLoras.importFile({ path: loraFile("ok2"), name: "ok2", licence: "creativeml-openrail-m", licenceAcknowledged: true })).rejects.toBeInstanceOf(LoraError);
  const bad = join(mkdtempSync(join(tmpdir(), "imglora-")), "x.safetensors");
  writeFileSync(bad, "not a safetensors file at all, just text");
  await expect(imageLoras.importFile({ path: bad, name: "x", licence: "mit" })).rejects.toMatchObject({ code: "not_safetensors" });
  expect(scanWords("a portrait of a young woman").refuse).toBe(false);
  expect(scanWords("nsfw teen pack").refuseReason).toBe("minor");
});

test("a changed LoRA file is not used; the library routes add, edit and remove", async () => {
  const record = await lora("changing", { base: "klein" });
  writeFileSync(imageLoras.path(record.id), "tampered bytes of a different length");
  await expect(imageLoras.resolve([{ id: record.id }], "adult", "flux2-klein-4b")).rejects.toMatchObject({ code: "lora_changed" });
  const form = new FormData();
  form.set("file", new File([readFileSync(loraFile("viaroute", { base: "zimage" }))], "viaroute.safetensors"));
  form.set("name", "via route"); form.set("licence", "mit"); form.set("classification", "all-ages"); form.set("trigger_words", "t3chnic4lly, retro");
  const added = await app.request("/stack/v1/image/loras", { method: "POST", body: form });
  expect(added.status).toBe(200);
  const made = await added.json() as { id: string; base_model: string; trigger_words: string[] };
  expect(made).toMatchObject({ base_model: "z-image-turbo", trigger_words: ["t3chnic4lly", "retro"] });
  const patched = await app.request(`/stack/v1/image/loras/${made.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "renamed", strength_default: 0.7 }) });
  expect(await patched.json()).toMatchObject({ name: "renamed", strength_default: 0.7 });
  const listed = await (await app.request("/stack/v1/image/loras")).json() as { loras: unknown[]; base_models: string[] };
  expect(listed.loras).toHaveLength(2);
  expect(listed.base_models).toEqual(["flux2-klein-4b", "z-image-turbo"]);
  expect((await app.request(`/stack/v1/image/loras/${made.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await app.request(`/stack/v1/image/loras/${made.id}`, { method: "DELETE" })).status).toBe(404);
});

test("a LoRA is added from a Hugging Face link only: the link is checked, the file is hashed on arrival, the licence comes from the card", async () => {
  expect(parseHfLoraUrl("https://huggingface.co/owner/name/resolve/main/sub/file.safetensors")).toEqual({ repo: "owner/name", revision: "main", file: "sub/file.safetensors" });
  expect(parseHfLoraUrl("https://huggingface.co/owner/name/blob/abc123/file.safetensors").file).toBe("file.safetensors");
  for (const url of ["http://huggingface.co/o/n/resolve/main/f.safetensors", "https://evil.example/o/n/resolve/main/f.safetensors", "https://huggingface.co.evil.example/o/n/resolve/main/f.safetensors", "https://huggingface.co/o/n/resolve/main/f.bin", "https://huggingface.co/o/n/tree/main", "https://user:pw@huggingface.co/o/n/resolve/main/f.safetensors", "not a link"]) {
    expect(() => parseHfLoraUrl(url)).toThrow(LoraError);
  }
  const file = readFileSync(loraFile("fromhub", { base: "klein" }));
  const seen: string[] = [];
  const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    seen.push(url);
    if (url.startsWith("https://huggingface.co/api/models/")) return new Response(JSON.stringify({ cardData: { license: "apache-2.0" }, tags: ["lora", "text-to-image"] }));
    return new Response(file, { headers: { "content-length": String(file.length) } });
  }) as unknown as typeof fetch;
  const job = startLoraInstall({ url: "https://huggingface.co/owner/name/resolve/main/fromhub.safetensors", name: "from the hub", classification: "all-ages" }, { fetch: fakeFetch });
  for (let i = 0; i < 100 && getJob(job.id)!.state === "running"; i++) await Bun.sleep(20);
  const done = getJob(job.id)!;
  expect(done.state).toBe("done");
  expect(done.result).toMatchObject({ lora: { base_model: "flux2-klein-4b", licence: "apache-2.0", classification: "all-ages", source_url: "https://huggingface.co/owner/name/blob/main/fromhub.safetensors" } });
  expect(seen.every((url) => url.startsWith("https://huggingface.co/"))).toBe(true);
  expect(imageLoras.list()).toHaveLength(1);
  const refused = startLoraInstall({ url: "https://huggingface.co/owner/name/resolve/main/fromhub.safetensors", name: "again" }, { fetch: fakeFetch });
  for (let i = 0; i < 100 && getJob(refused.id)!.state === "running"; i++) await Bun.sleep(20);
  expect(getJob(refused.id)).toMatchObject({ state: "failed" });
  expect(getJob(refused.id)!.reason).toContain("already_added");
});

test("detectImageBase reads the base from the tensors, not the name", () => {
  const info = (keys: string[], dims: number[]) => ({ rank: 16, modules: 2, dims, keys, metadata: undefined });
  expect(detectImageBase(info(["transformer.double_stream_modulation_img.linear.lora_A.weight"], [3072]))).toBe("flux2-klein-4b");
  expect(detectImageBase(info(["diffusion_model.layers.0.attention.to_k.lora_A.weight"], [3840]))).toBe("z-image-turbo");
  expect(() => detectImageBase(info(["lora_unet_down_blocks_0.lora_down.weight"], [640, 1280]))).toThrow(LoraError);
  expect(() => detectImageBase(info(["diffusion_model.blocks.0.self_attn.q.lora_A.weight"], [3072]))).toThrow(LoraError);
  expect(() => detectImageBase(info(["something.lora_A.weight"], [512]))).toThrow(LoraError);
});

// ---- edits ----

test("edit_masked sends the picture, the mask and the region to the worker at bf16 and answers like a generation", async () => {
  imageGen.useDeps(scripted());
  const form = new FormData();
  form.set("operation", "edit_masked");
  form.set("image_source", "uploaded");
  form.set("image", new File([pngBytes(1200, 800)], "in.png", { type: "image/png" }));
  form.set("mask", new File([pngBytes(1200, 800, "mask")], "mask.png", { type: "image/png" }));
  form.set("instruction", "remove the potted plant"); form.set("feather", "6"); form.set("seed", "5"); form.set("timeout_ms", "5000");
  const response = await app.request("/v1/images/edits", { method: "POST", body: form });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Pic[] };
  expect(body.data[0]).toMatchObject({ mode: "edit-masked", model: "flux2-klein-4b", seed: 5, width: 640 });
  expect(requests[0]).toMatchObject({ op: "edit", family: "flux2-klein-4b", quantize: null, prompt: "remove the potted plant", feather: 6, seed: 5, steps: 4 });
  expect(requests[0]!.mask).toContain(".mask.bin");
  expect(requests[0]!.image).toContain(".image.bin");
  expect((await get(body.data[0]!.url)).status).toBe(200);
  expect(JSON.stringify(listJobs())).not.toContain("potted plant");
  expect(existsSync(requests[0]!.image!)).toBe(false);
});

test("edit operations are checked: instruction, mask or region, region shape, picture", async () => {
  imageGen.useDeps(scripted());
  const send = async (fields: Record<string, string>, image: Buffer | null = pngBytes(100, 100)) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    if (!("image_source" in fields)) form.set("image_source", "uploaded");
    form.set("image", new File([image ?? Buffer.from("text")], "in.png"));
    const response = await app.request("/v1/images/edits", { method: "POST", body: form });
    return { status: response.status, code: ((await response.json()) as { code?: string }).code };
  };
  expect(await send({ operation: "edit" })).toMatchObject({ status: 422, code: "instruction_required" });
  expect(await send({ operation: "edit_masked", instruction: "x" })).toMatchObject({ status: 422, code: "mask_required" });
  expect(await send({ operation: "edit_masked", instruction: "x", region: "0.5,0.5,0.9,0.9" })).toMatchObject({ status: 422, code: "bad_region" });
  expect(await send({ operation: "edit", instruction: "x" }, null)).toMatchObject({ status: 422, code: "bad_image" });
  expect(await send({ operation: "edit", instruction: "x", feather: "99" })).toMatchObject({ status: 400 });
  expect(parseRegion("0.1,0.2,0.3,0.4")).toEqual([0.1, 0.2, 0.3, 0.4]);
  expect(parseRegion(undefined)).toBeNull();
  expect(typeof parseRegion("1,2")).toBe("string");
  expect(requests).toHaveLength(0);
  const ok = await send({ operation: "edit_masked", instruction: "make the sofa green", region: "0.1,0.1,0.3,0.3", timeout_ms: "5000" });
  expect(ok.status).toBe(200);
  expect(requests[0]!.region).toEqual([0.1, 0.1, 0.3, 0.3]);
  __setInstalledFamiliesForTests(["z-image-turbo"]);
  expect((await send({ operation: "edit", instruction: "x" })).code).toBe("not_installed");
});

test("the existing tools still answer: an unknown operation is refused by the form, the old results route is untouched", async () => {
  const form = new FormData();
  form.set("operation", "sharpen"); form.set("image", new File([pngBytes(10, 10)], "in.png"));
  expect((await app.request("/v1/images/edits", { method: "POST", body: form })).status).toBe(400);
  expect((await app.request("/v1/images/edits/job-none")).status).toBe(404);
});

// ---- state, pins, protocol ----

test("the image role reads the picture service when its weights are installed and ComfyUI's state otherwise", async () => {
  imageGen.useDeps(scripted());
  expect(imageEngineActive()).toBe(true);
  expect(resolveRoleState("image").state).toBe("installed");
  await post({ prompt: "x", timeout_ms: 5000 });
  expect(resolveRoleState("image").state).toBe("ready");
  imageGen.stop();
  expect(imageRoleState(imageGen).state).toBe("installed");
  __setInstalledFamiliesForTests([]);
  expect(imageEngineActive()).toBe(false);
  expect(imageRoleState(imageGen).state).toBe("notInstalled");
  __setGovernorTuningForTestsOnly({ tier: "p16", totalMemoryBytes: 16 * GB, freeMemoryBytes: 8 * GB });
  __setInstalledFamiliesForTests(["flux2-klein-4b"]);
  expect(imageRoleState(imageGen)).toMatchObject({ state: "notInstalled" });
  expect(imageRoleState(imageGen).reason).toContain("32 GB");
});

test("GET /stack/v1/image reports state, models, limits, edit and what to install", async () => {
  imageGen.useDeps(scripted());
  const body = await (await app.request("/stack/v1/image")).json() as { image: Record<string, any> };
  const image = body.image;
  expect(image).toMatchObject({ state: "needs-setup", available: true, tier: "p128", default_model: "flux2-klein-4b", loras_supported: true, idle_unload_s: 600, edit: { generative: true, masked: true, model: "flux2-klein-4b" } });
  expect(image.models.map((m: { id: string }) => m.id)).toEqual(["flux2-klein-4b", "z-image-turbo"]);
  expect(image.models[0]).toMatchObject({ installed: true, default: true, edit: true, steps_default: 4, peak_gb: 15, quantize: 8, available: true });
  expect(image.models[1]).toMatchObject({ steps_default: 9, edit: false, peak_gb: 34 });
  expect(image.limits).toMatchObject({ min_side: 256, max_side: 2048, size_step: 16, max_n: 4, max_loras: 4, queue_max: 4 });
  expect(image.memory.fits).toBe(true);
  __setInstalledFamiliesForTests([]);
  const empty = (await (await app.request("/stack/v1/image")).json() as { image: Record<string, any> }).image;
  expect(empty).toMatchObject({ state: "not-installed", default_model: null, edit: { generative: false } });
  expect(empty.install.models.length).toBe(STACK_IMAGE_KLEIN_MODELS.length);
  expect(empty.install.remaining_bytes).toBeGreaterThan(15_000_000_000);
  expect((await app.request("/stack/v1/image/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ family: "sdxl" }) })).status).toBe(404);
  const roles = await (await app.request("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string } }> };
  expect(roles.roles.find((role) => role.id === "image")!.state.state).toBe("notInstalled");
});

test("the pins: every file has a revision, sha256, size, hub path and Apache-2.0; ids are unique; only the files mflux reads", () => {
  for (const pins of [STACK_IMAGE_KLEIN_MODELS, STACK_IMAGE_ZIMAGE_MODELS]) {
    expect(pins[0]!.component).toBeUndefined();
    for (const pin of pins) {
      expect(pin.role).toBe("image");
      expect(pin.engine).toBe("mflux");
      expect(pin.license).toBe("Apache-2.0");
      expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.download!.approx_bytes).toBeGreaterThan(0);
      expect(pin.download!.url).toContain(`/resolve/${pin.revision}/${pin.download!.hub_file}`);
      expect(pin.download!.hub_file).toMatch(/^(vae|transformer|text_encoder|tokenizer)\/|^(added_tokens\.json|chat_template\.jinja)$/);
    }
    expect(pins.slice(1).every((pin) => !!pin.component)).toBe(true);
  }
  const ids = STACK_MODELS.map((pin) => pin.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(STACK_IMAGE_KLEIN_MODELS.reduce((sum, pin) => sum + pin.download!.approx_bytes, 0)).toBeLessThan(16_100_000_000);
  expect(STACK_IMAGE_ENGINE_MODELS).toHaveLength(STACK_IMAGE_KLEIN_MODELS.length + STACK_IMAGE_ZIMAGE_MODELS.length);
  const runtime = MANAGED_RUNTIMES.find((entry) => entry.name === "image-gen")!;
  expect(runtime.roles).toEqual(["image"]);
  expect(imageRequirementsFileFor("darwin", "arm64")).toBeTruthy();
  expect(imageRequirementsFileFor("linux", "x64")).toBeNull();
});

test("sizing, quantization, peaks and progress follow the measured table", () => {
  expect(parseSize("1024x768")).toEqual({ width: 1024, height: 768 });
  expect(typeof parseSize("1000x768")).toBe("string");
  expect(quantizeFor("flux2-klein-4b", "generate", "p128")).toBe(8);
  expect(quantizeFor("flux2-klein-4b", "generate", "p32")).toBe(4);
  expect(quantizeFor("flux2-klein-4b", "edit", "p128")).toBeNull();
  expect(peakBytes("flux2-klein-4b", "generate", 8, 0)).toBe(15_000_000_000);
  expect(peakBytes("flux2-klein-4b", "generate", 8, 1)).toBe(16_000_000_000);
  expect(peakBytes("flux2-klein-4b", "edit", null, 0)).toBe(18_000_000_000);
  expect(peakBytes("z-image-turbo", "generate", 8, 0)).toBe(34_000_000_000);
  expect(IMAGE_FAMILIES["flux2-klein-4b"].edit).toBe(true);
  expect(overallPercent("loading", 100)).toBe(5);
  expect(overallPercent("rendering", 100)).toBe(99);
  expect(pngSize(new Uint8Array(pngBytes(321, 123)))).toEqual({ width: 321, height: 123 });
  expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
});

test("results are swept by age and count, and read back only when every picture is there", () => {
  const meta = (job: string) => ({ job, created: 1, mode: "generate" as const, model: "flux2-klein-4b", steps: 4, quantize: 8, lora_ids: [], ms: 1, mlx_peak_gb: null, images: [{ index: 0, seed: 1, width: 8, height: 8, bytes: 1, thumb_bytes: 1 }] });
  const make = (job: string) => { const work = workDir(job); mkdirSync(work, { recursive: true }); writeFileSync(join(work, "0.png"), "p"); writeFileSync(join(work, "0.thumb.jpg"), "t"); commitResult(meta(job), work); };
  const ids = ["a", "b", "c"].map((letter) => `job-00000000-0000-0000-0000-00000000000${letter === "a" ? "1" : letter === "b" ? "2" : "3"}`);
  process.env.IMAGE_RESULT_KEEP = "2";
  ids.forEach(make);
  expect(ids.filter((id) => readResult(id)).length).toBeLessThanOrEqual(2);
  rmSync(join(resultsRoot(), ids[2]!, "0.png"), { force: true });
  expect(readResult(ids[2]!)).toBeNull();
  process.env.IMAGE_RESULT_TTL_MS = "1";
  expect(sweepResults(Date.now() + 1000)).toBeGreaterThanOrEqual(1);
});

/** A fake child process speaking the worker's lines, to exercise the real wrapper. */
function fakeChild(onLine: (line: string, out: (message: unknown) => void, finish: () => void) => void) {
  const encoder = new TextEncoder();
  let push!: (chunk: Uint8Array) => void;
  let close!: () => void;
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { push = (chunk) => controller.enqueue(chunk); close = () => controller.close(); } });
  const stderr = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  let end!: (code: number) => void;
  const exited = new Promise<number>((done) => { end = done; });
  const written: string[] = [];
  const out = (message: unknown) => push(encoder.encode(`${JSON.stringify(message)}\n`));
  const child = { stdin: { write: (data: string) => { for (const line of data.split("\n").filter(Boolean)) { written.push(line); onLine(line, out, () => { close(); end(0); }); } return data.length; }, flush: () => {} }, stdout, stderr, exited, kill: () => { close(); end(143); } };
  out({ ready: true });
  return { child, written };
}

test("the worker wrapper hands events to the caller, matches the reply to the request, sends a cancel line, and reports a dead worker", async () => {
  const { child, written } = fakeChild((line, out) => {
    const message = JSON.parse(line) as { op: string; id: string };
    if (message.op === "generate") { out({ id: message.id, event: "phase", phase: "rendering", percent: 25 }); out({ id: message.id, event: "image", index: 0, seed: 3 }); out({ id: "other", ok: true }); out({ id: message.id, ok: true, seeds: [3], ms: 10 }); }
  });
  const handle = workerHandle(child);
  const events: WorkerEvent[] = [];
  const reply = await handle.send({ id: "r1", op: "generate", family: "flux2-klein-4b", quantize: 8, model_dir: "/m", loras: [], prompt: "p", steps: 4, seed: 3, out_dir: "/o" }, { onEvent: (event) => events.push(event), deadlineMs: 2000 });
  expect(reply).toMatchObject({ ok: true, seeds: [3] });
  expect(events.map((event) => event.event)).toEqual(["phase", "image"]);
  handle.cancel("r1");
  expect(written.some((line) => line === JSON.stringify({ op: "cancel", id: "r1" }))).toBe(true);
  const dying = fakeChild((line, _out, finish) => { if (JSON.parse(line).op === "generate") finish(); });
  const second = workerHandle(dying.child);
  const lost = await second.send({ id: "r2", op: "generate", family: "flux2-klein-4b", quantize: 8, model_dir: "/m", loras: [], prompt: "p", steps: 4, seed: 3, out_dir: "/o" }, { onEvent: () => {}, deadlineMs: 2000 });
  expect(lost).toMatchObject({ ok: false, code: "worker_stopped" });
  const silent = fakeChild(() => {});
  const timed = await workerHandle(silent.child).send({ id: "r3", op: "generate", family: "flux2-klein-4b", quantize: 8, model_dir: "/m", loras: [], prompt: "p", steps: 4, seed: 3, out_dir: "/o" }, { onEvent: () => {}, deadlineMs: 40 });
  expect(timed).toMatchObject({ ok: false, code: "timeout" });
});

test("a service with no environment support says so", () => {
  const none = new ImageGenService(scripted(okReply, { supported: () => false }));
  expect(none.status().state).toBe("unsupported");
  expect(none.supported()).toBe(false);
});

// ---- GENPREVIEW-01: steps, stages and the per-step preview ----

type Live = { state: string; progress: number; progress_fraction: number | null; stage: string | null; stage_label: string | null; step: number | null; steps: number | null; eta_seconds: number | null; preview_url: string | null; preview_step: number | null };
const live = async (job: string) => await (await get(`/v1/images/generations/${job}`)).json() as Live;
const stage = (request: WorkerRequest, name: string, n?: number, of?: number): WorkerEvent => ({ id: request.id, event: "stage", stage: name, ...(n !== undefined ? { n, of } : {}) });

test("a running picture reports its step and stage, serves each new preview, and the preview is gone when the picture is done", async () => {
  __resetGenHistoryForTests();
  let next!: () => void;
  const turn = (): Promise<void> => new Promise((resolve) => { next = resolve; });
  let step = turn();
  imageGen.useDeps(scripted(async (request, emit) => {
    emit(stage(request, "load")); emit(stage(request, "plan")); emit(stage(request, "steps", 0, 4));
    for (let n = 1; n <= 4; n++) {
      await step; step = turn();
      writeFileSync(join(request.out_dir, "preview.jpg"), `PREVIEW-${n}`);
      emit({ id: request.id, event: "preview", index: 0, step: n, steps: 4 });
      emit(stage(request, n === 4 ? "decode" : "steps", n === 4 ? undefined : n, n === 4 ? undefined : 4));
    }
    await step;
    return okReply(request);
  }));
  const { job } = await (await post({ prompt: "a boat", timeout_ms: 20 })).json() as { job: string };
  await Bun.sleep(30);
  const first = await live(job);
  expect(first).toMatchObject({ state: "running", stage: "steps", stage_label: "Drawing, step 1 of 4", step: 0, steps: 4, preview_url: null, preview_step: null });
  expect(requests[0]!.preview).toBe(true);
  expect((await get(`/v1/images/generations/${job}/preview.jpg`)).status).toBe(404);
  let last = first.progress_fraction!;
  for (let n = 1; n <= 2; n++) {
    next(); await Bun.sleep(20);
    const status = await live(job);
    expect(status).toMatchObject({ step: n, steps: 4, preview_step: n });
    expect(status.preview_url).toMatch(new RegExp(`preview\\.jpg\\?v=${n}$`));
    expect(status.progress_fraction!).toBeGreaterThan(last); last = status.progress_fraction!;
    expect(await (await get(status.preview_url!)).text()).toBe(`PREVIEW-${n}`);
    expect(status.eta_seconds).toBeGreaterThanOrEqual(1);
  }
  next(); await Bun.sleep(20); next(); await Bun.sleep(20);
  expect(await live(job)).toMatchObject({ stage: "decode", stage_label: "Finishing the picture", preview_step: 4 });
  next(); await Bun.sleep(80);
  expect(await live(job)).toMatchObject({ state: "done", stage: null, step: null, preview_url: null, preview_step: null, eta_seconds: null });
  expect((await get(`/v1/images/generations/${job}/preview.jpg`)).status).toBe(404);
  expect(existsSync(workDir(job))).toBe(false);
});

test("preview false is passed to the worker as no preview; edits never ask for one", async () => {
  imageGen.useDeps(scripted());
  expect((await post({ prompt: "x", preview: false, timeout_ms: 5000 })).status).toBe(200);
  expect(requests[0]!.preview).toBeUndefined();
  expect((await post({ prompt: "y", timeout_ms: 5000 })).status).toBe(200);
  expect(requests[1]!.preview).toBe(true);
});

test("cancel in each stage stops the worker, removes the work folder and the preview, and clears the live fields", async () => {
  for (const name of ["load", "plan", "steps", "decode"]) {
    cancelled.length = 0; requests.length = 0;
    imageGen.useDeps(scripted((request, emit) => { emit(stage(request, name, name === "steps" ? 2 : undefined, name === "steps" ? 4 : undefined)); writeFileSync(join(request.out_dir, "preview.jpg"), "P"); emit({ id: request.id, event: "preview", index: 0, step: 2, steps: 4 }); return new Promise<WorkerReply>(() => {}); }));
    const { job } = await (await post({ prompt: `cancel ${name}`, timeout_ms: 20 })).json() as { job: string };
    await Bun.sleep(30);
    expect((await live(job)).stage).toBe(name);
    expect((await get(`/v1/images/generations/${job}/preview.jpg`)).status).toBe(200);
    await app.request(`/v1/images/generations/${job}`, { method: "DELETE" });
    await Bun.sleep(30);
    expect(cancelled).toEqual([job]);
    expect(existsSync(workDir(job))).toBe(false);
    expect((await get(`/v1/images/generations/${job}/preview.jpg`)).status).toBe(404);
    expect(await live(job)).toMatchObject({ state: "cancelled", stage: null, preview_url: null });
  }
});

test("several pictures in one job: the fraction covers all of them and never goes back when the next picture starts over", () => {
  __resetGenHistoryForTests();
  let at = 0;
  const tracker = new GenTracker("image", historyKey("image", 1024, 1024), () => at);
  tracker.nextUnit(0, 2);
  const seen: number[] = [];
  const pass = () => { for (const [name, n, of] of [["load"], ["plan"], ["steps", 0, 4], ["steps", 2, 4], ["decode"]] as Array<[string, number?, number?]>) { tracker.enter(name, n ?? null, of ?? null); at += 500; seen.push(tracker.snapshot().fraction); } };
  pass(); tracker.nextUnit(1, 2); seen.push(tracker.snapshot().fraction); pass();
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen[seen.length - 1]!).toBeLessThan(1);
  expect(seen[4]!).toBeLessThan(0.5 + 1e-9);
  expect(IMAGE_STAGES.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1, 5);
});
