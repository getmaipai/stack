// VIDEO-GEN-01 to 03: the video service, its job API, the LoRA library and the
// pins, driven by a scripted worker (no model, no GPU). The real worker on real
// weights is exercised on a scratch Stack (docs/design in Home, VIDEO-GEN-08);
// one test here runs the real worker's request checks when VIDEO_GEN_PYTHON names
// a prepared environment.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly, admit, getGovernorStatus } from "@/lib/governor";
import { __resetJobsForTests, getJob, listJobs } from "@/lib/jobs";
import { STACK_MODELS, STACK_VIDEO_MODEL, STACK_VIDEO_TOKENIZER } from "@/lib/modelCatalog";
import { PROFILE_TIERS } from "@/profiles";
import { ENGINE_BINARIES, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { registerVideoJobs, stashClip, unstashClip } from "@/video/jobs";
import { importLora, listLoras, LoraError, readLoraHeader, resolveLoras, updateLora, removeLora, licenceClass } from "@/video/loras";
import { __resetProvenanceForTests, recordGeneratedImage, wasGeneratedHere } from "@/video/provenance";
import { commitResult, deleteResult, readResult, resultsRoot, sweepResults, workDir, type VideoResultMeta } from "@/video/results";
import { memoryVerdict, overallPercent, tierAvailability, VideoError, videoGen, videoRequirementsFileFor, videoRoleState, VideoGenService, workerHandle, type VideoGenDeps, type WorkerEvent, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/video/videoGen";
import { dataDir } from "@/lib/paths";

const GB = 1_073_741_824;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG).toString("base64");

let spawned = 0;
let killed = 0;
const requests: WorkerRequest[] = [];

type Script = (request: WorkerRequest, emit: (event: WorkerEvent) => void) => Promise<WorkerReply> | WorkerReply;
const okReply = (request: WorkerRequest): WorkerReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 44_000_000_000 });

function scripted(script: Script = okReply, over: Partial<VideoGenDeps> = {}): VideoGenDeps {
  return {
    supported: () => true,
    ensureEnvironment: async () => {},
    paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
    spawn: async (): Promise<WorkerHandle> => {
      spawned += 1;
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited,
        kill: () => { killed += 1; end(143); },
        send: async (request, options) => {
          requests.push(request);
          const reply = await Promise.race([script(request, options.onEvent), exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "The video engine stopped before the clip was finished. Try again." }) as WorkerReply)]);
          if (reply.ok) { writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA"); }
          return reply;
        },
      };
    },
    ...over,
  };
}

function clean(): void {
  videoGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests();
  rmSync(join(dataDir, "video"), { recursive: true, force: true });
  rmSync(join(dataDir, "tmp", "video"), { recursive: true, force: true });
}
beforeEach(() => {
  spawned = 0; killed = 0; requests.length = 0;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  registerVideoJobs();
});
afterEach(() => { delete process.env.VIDEO_IDLE_MS; delete process.env.VIDEO_RESULT_KEEP; delete process.env.VIDEO_RESULT_TTL_MS; clean(); });

const post = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });

/** A safetensors file whose header says what a Wan LoRA's does (the tensors themselves are empty: the Stack reads only the header). */
function loraFile(name: string, options: { dim?: number; metadata?: Record<string, string>; keys?: "AB" | "down-up"; modules?: number } = {}): string {
  const dim = options.dim ?? 3072;
  const header: Record<string, unknown> = {};
  if (options.metadata) header.__metadata__ = options.metadata;
  const [a, b] = options.keys === "down-up" ? ["lora_down", "lora_up"] : ["lora_A", "lora_B"];
  for (let i = 0; i < (options.modules ?? 3); i++) {
    header[`diffusion_model.blocks.${i}.self_attn.q.${a}.weight`] = { dtype: "F16", shape: [16, dim], data_offsets: [0, 0] };
    header[`diffusion_model.blocks.${i}.self_attn.q.${b}.weight`] = { dtype: "F16", shape: [dim, 16], data_offsets: [0, 0] };
  }
  if ((options.modules ?? 3) === 0) header["something.weight"] = { dtype: "F16", shape: [4, 4], data_offsets: [0, 0] };
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const dir = mkdtempSync(join(tmpdir(), "lora-"));
  const path = join(dir, `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}
const lora = (name: string, over: Record<string, unknown> = {}) => importLora({ path: loraFile(name, over as never), name, licence: "apache-2.0", ...(over.classification ? { classification: over.classification as never } : {}) });

// ---- the job API ----

test("a clip is made, polled to done, fetched with and without a range, and deleted", async () => {
  videoGen.useDeps(scripted((request, emit) => { emit({ id: request.id, event: "phase", phase: "rendering", percent: 50 }); return okReply(request); }));
  const response = await post({ prompt: "a paper boat", seed: 7, timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; data: Array<Record<string, unknown>> };
  expect(body.data[0]).toMatchObject({ width: 832, height: 480, frames: 121, fps: 24, seconds: 5, seed: 7, mode: "text-to-video", model: STACK_VIDEO_MODEL.id, content_type: "video/mp4", lora_ids: [] });
  expect(response.headers.get("x-maipai-engine")).toBeDefined();
  expect(requests[0]).toMatchObject({ num_frames: 121, width: 832, height: 480, seed: 7, loras: [], image: null });
  const status = await (await get(`/v1/videos/generations/${body.job}`)).json() as Record<string, unknown>;
  expect(status).toMatchObject({ state: "done", phase: "ready", progress: 100, error: null });
  const full = await get(body.data[0]!.url as string);
  expect(full.headers.get("content-type")).toBe("video/mp4");
  expect(await full.text()).toBe("MP4DATA-0123456789");
  const part = await get(body.data[0]!.url as string, { range: "bytes=2-5" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 2-5/18");
  expect(await part.text()).toBe("4DAT");
  const tail = await get(body.data[0]!.url as string, { range: "bytes=-4" });
  expect(await tail.text()).toBe("6789");
  expect((await get(body.data[0]!.poster_url as string)).headers.get("content-type")).toBe("image/jpeg");
  expect((await app.request(`/v1/videos/generations/${body.job}`, { method: "DELETE" })).status).toBe(200);
  expect((await get(body.data[0]!.url as string)).status).toBe(404);
  expect((await get(`/v1/videos/generations/${body.job}`)).status).toBe(404);
  // The governor admission is back, and the work folder is gone.
  expect(getGovernorStatus().loaded).toHaveLength(0);
  expect(existsSync(workDir(body.job))).toBe(false);
});

test("neither the prompt nor the picture is kept in a job record, on the feed or in the result store", async () => {
  videoGen.useDeps(scripted());
  recordGeneratedImage(PNG);
  const response = await post({ prompt: "SECRET-PROMPT-WORDS", negative_prompt: "SECRET-NEGATIVE", image: PNG_B64, image_source: "generated", timeout_ms: 5000 });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string };
  expect(JSON.stringify(listJobs())).not.toContain("SECRET");
  expect(JSON.stringify(getJob(body.job))).not.toContain(PNG_B64);
  const meta = readFileSync(join(resultsRoot(), body.job, "meta.json"), "utf8");
  expect(meta).not.toContain("SECRET");
  expect(JSON.parse(meta)).toMatchObject({ mode: "image-to-video", model: STACK_VIDEO_MODEL.id });
  expect(requests[0]!.prompt).toBe("SECRET-PROMPT-WORDS");
  expect(requests[0]!.image).toContain("reference.bin");
});

test("past timeout_ms the answer is 202 with the job; the status shows the phase and progress; cancel stops the worker and returns the memory", async () => {
  videoGen.useDeps(scripted((request, emit) => new Promise<WorkerReply>(() => { emit({ id: request.id, event: "phase", phase: "decoding", percent: 50 }); })));
  const response = await post({ prompt: "a long one", timeout_ms: 50 });
  expect(response.status).toBe(202);
  const { job } = await response.json() as { job: string };
  await Bun.sleep(30);
  const status = await (await get(`/v1/videos/generations/${job}`)).json() as { state: string; phase: string; progress: number; phase_progress: number };
  expect(status).toMatchObject({ state: "running", phase: "decoding", phase_progress: 50 });
  expect(status.progress).toBe(overallPercent("decoding", 50));
  expect(getGovernorStatus().loaded.map((item) => item.kind)).toEqual(["generator"]);
  const cancelled = await app.request(`/v1/videos/generations/${job}`, { method: "DELETE" });
  expect(await cancelled.json()).toEqual({ job, state: "cancelled" });
  await Bun.sleep(30);
  expect(killed).toBe(1);
  expect(getGovernorStatus().loaded).toHaveLength(0);
  expect((await (await get(`/v1/videos/generations/${job}`)).json() as { state: string }).state).toBe("cancelled");
});

test("a second clip waits behind the first with its position; the fifth is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  videoGen.useDeps(scripted(async (request) => { await gate; return okReply(request); }));
  const jobs: string[] = [];
  for (let i = 0; i < 4; i++) jobs.push(((await (await post({ prompt: `clip ${i}`, timeout_ms: 20 })).json()) as { job: string }).job);
  const second = await (await get(`/v1/videos/generations/${jobs[1]}`)).json() as { state: string; phase: string; position: number | null };
  expect(second).toMatchObject({ state: "queued", phase: "queued", position: 1 });
  const refused = await post({ prompt: "one too many", timeout_ms: 20 });
  expect(refused.status).toBe(429);
  expect(((await refused.json()) as { code: string }).code).toBe("queue_full");
  release();
  await Bun.sleep(200);
  expect(requests).toHaveLength(4);
  expect(spawned).toBe(1);
});

test("a failed clip carries the worker's code and status; an out-of-memory failure restarts the worker for the next clip", async () => {
  let first = true;
  videoGen.useDeps(scripted((request) => { if (first) { first = false; return { id: request.id, ok: false, code: "out_of_memory", error: "The computer ran out of memory while making the clip. Close other big apps and try again." }; } return okReply(request); }));
  const failed = await post({ prompt: "too big", timeout_ms: 5000 });
  expect(failed.status).toBe(507);
  expect(await failed.json()).toMatchObject({ code: "out_of_memory", error: expect.stringContaining("Close other big apps") });
  const again = await post({ prompt: "again", timeout_ms: 5000 });
  expect(again.status).toBe(200);
  expect(spawned).toBe(2);
});

test("video is off below 128 GB, not installed without the model, and refused with the numbers when it cannot fit beside what is resident", async () => {
  videoGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p32", totalMemoryBytes: 32 * GB, freeMemoryBytes: 24 * GB });
  const off = await post({ prompt: "x" });
  expect(off.status).toBe(503);
  expect(await off.json()).toMatchObject({ code: "not_available_on_this_computer", error: expect.stringContaining("128 GB of memory") });
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB });
  videoGen.useDeps(scripted(okReply, { paths: () => null }));
  const missing = await post({ prompt: "x" });
  expect(missing.status).toBe(503);
  expect(((await missing.json()) as { code: string }).code).toBe("not_installed");
  videoGen.useDeps(scripted());
  __setGovernorTuningForTestsOnly({ tier: "p128", totalMemoryBytes: 64 * GB, freeMemoryBytes: 60 * GB });
  await admit({ id: "chat", kind: "resident", requestedBytes: 28 * GB, pinned: true });
  const full = await post({ prompt: "x" });
  expect(full.status).toBe(503);
  expect(await full.json()).toMatchObject({ code: "no_memory", error: "Not enough free memory for video right now. Close other big jobs, or try again in a few minutes." });
  expect(memoryVerdict().ok).toBe(false);
  expect(tierAvailability("p128").available).toBe(true);
  expect(tierAvailability("p64")).toMatchObject({ available: false, code: "not_available_on_this_computer" });
  expect(tierAvailability("p16").available).toBe(false);
});

test("size and length are held to the measured limits", async () => {
  videoGen.useDeps(scripted());
  for (const size of ["1280x704", "832x481", "128x128", "480x864"]) {
    const response = await post({ prompt: "x", size });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("bad_size");
  }
  expect((await post({ prompt: "x", seconds: 6 })).status).toBe(400);
  expect((await post({ prompt: "x", seconds: 0 })).status).toBe(400);
  expect((await post({ prompt: "" })).status).toBe(400);
  const portrait = await post({ prompt: "x", size: "480x832", seconds: 2, timeout_ms: 5000 });
  expect(portrait.status).toBe(200);
  expect(requests[0]).toMatchObject({ width: 480, height: 832, num_frames: 49 });
});

test("the model id of the video role never reaches the clip runner through the images route", async () => {
  videoGen.useDeps(scripted());
  const response = await app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "video", prompt: "x" }) });
  expect(response.status).toBe(503);
  expect(requests).toHaveLength(0);
});

// ---- the reference picture gate (VIDEO-GEN-12) ----

test("a clip starts from a picture only when this Stack made it", async () => {
  videoGen.useDeps(scripted());
  const none = await post({ prompt: "x", image: PNG_B64 });
  expect(none.status).toBe(422);
  expect(((await none.json()) as { code: string }).code).toBe("reference_source_required");
  const uploaded = await post({ prompt: "x", image: PNG_B64, image_source: "uploaded" });
  expect(uploaded.status).toBe(422);
  expect(await uploaded.json()).toMatchObject({ code: "reference_image_refused", error: expect.stringContaining("uploaded picture or a photo of a person") });
  const foreign = await post({ prompt: "x", image: PNG_B64, image_source: "generated" });
  expect(foreign.status).toBe(422);
  expect(((await foreign.json()) as { code: string }).code).toBe("reference_not_generated");
  const junk = await post({ prompt: "x", image: Buffer.from("not a picture at all").toString("base64"), image_source: "generated" });
  expect(((await junk.json()) as { code: string }).code).toBe("bad_image");
  expect(requests).toHaveLength(0);
  recordGeneratedImage(PNG);
  const accepted = await post({ prompt: "x", image: `data:image/png;base64,${PNG_B64}`, image_source: "generated", timeout_ms: 5000 });
  expect(accepted.status).toBe(200);
  expect(wasGeneratedHere(PNG)).toBe(true);
  expect(wasGeneratedHere(new Uint8Array([1, 2, 3]))).toBe(false);
});

test("the poster of a clip this Stack made counts as a picture made here", async () => {
  videoGen.useDeps(scripted());
  const made = await post({ prompt: "x", timeout_ms: 5000 });
  expect(made.status).toBe(200);
  expect(wasGeneratedHere(new TextEncoder().encode("JPEGDATA"))).toBe(true);
});

// ---- LoRAs in a job ----

test("a job applies only the LoRAs it names, at the strength it names, and an all-ages job never applies an adult-only one", async () => {
  videoGen.useDeps(scripted());
  const style = await lora("style", { classification: "all-ages" });
  const adult = await lora("adult-look");
  expect(style.classification).toBe("all-ages");
  expect(adult.classification).toBe("adult-only");
  const ok = await post({ prompt: "x", loras: [{ id: style.id, strength: 0.6 }], audience: "all-ages", timeout_ms: 5000 });
  expect(ok.status).toBe(200);
  expect(requests[0]!.loras).toEqual([[expect.stringContaining(`${style.id}.safetensors`), 0.6]]);
  expect(((await ok.json()) as { data: Array<{ lora_ids: string[] }> }).data[0]!.lora_ids).toEqual([style.id]);
  const blocked = await post({ prompt: "x", loras: [{ id: adult.id }] });
  expect(blocked.status).toBe(422);
  expect(((await blocked.json()) as { code: string }).code).toBe("lora_not_allowed");
  const allowed = await post({ prompt: "x", loras: [{ id: adult.id }], audience: "adult", timeout_ms: 5000 });
  expect(allowed.status).toBe(200);
  expect(requests[1]!.loras[0]![1]).toBe(1);
  const unknown = await post({ prompt: "x", loras: [{ id: "lora-0000000000000000" }], audience: "adult" });
  expect(((await unknown.json()) as { code: string }).code).toBe("unknown_lora");
  expect((await post({ prompt: "x", loras: [{ id: style.id, strength: 3 }] })).status).toBe(400);
});

// ---- the LoRA library ----

test("a LoRA is added with its hash, rank, licence and class; a second add is refused; edits and removal work", async () => {
  const path = loraFile("watercolour");
  const record = await importLora({ path, name: "Watercolour", licence: "MIT", sourceUrl: "https://example.com/watercolour", triggerWords: ["wtrclr style"], classification: "all-ages", addedBy: "adult-1" });
  expect(record).toMatchObject({ name: "Watercolour", base_model: "wan2.2-ti2v-5b", rank: 16, modules: 3, licence_class: "free", classification: "all-ages", strength_default: 1, trigger_words: ["wtrclr style"], added_by: "adult-1" });
  expect(record.id).toBe(`lora-${record.sha256.slice(0, 16)}`);
  expect(existsSync(join(dataDir, "video", "loras", `${record.id}.safetensors`))).toBe(true);
  await expect(importLora({ path, name: "Again", licence: "mit" })).rejects.toMatchObject({ code: "already_added", status: 409 });
  const edited = await updateLora(record.id, { name: "Watercolour 2", strengthDefault: 0.8, classification: "adult-only" });
  expect(edited).toMatchObject({ name: "Watercolour 2", strength_default: 0.8, classification: "adult-only" });
  expect(listLoras()).toHaveLength(1);
  const list = await (await get("/stack/v1/video/loras")).json() as { loras: Array<{ id: string }>; max_per_clip: number };
  expect(list.loras.map((entry) => entry.id)).toEqual([record.id]);
  expect(list.max_per_clip).toBe(4);
  expect(await removeLora(record.id)).toBe(true);
  expect(existsSync(join(dataDir, "video", "loras", `${record.id}.safetensors`))).toBe(false);
  expect(await removeLora(record.id)).toBe(false);
});

test("a LoRA for another model, a file that is not a LoRA, and a licence nobody acknowledged are refused with what to do", async () => {
  await expect(lora("big", { dim: 5120 })).rejects.toMatchObject({ code: "wrong_base_model", status: 422 });
  await expect(lora("small", { dim: 1536 })).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(lora("odd", { dim: 2048 })).rejects.toMatchObject({ code: "wrong_base_model" });
  await expect(lora("empty", { modules: 0 })).rejects.toMatchObject({ code: "not_a_lora" });
  const text = join(mkdtempSync(join(tmpdir(), "lora-")), "x.safetensors");
  writeFileSync(text, "this is not a safetensors file at all");
  await expect(importLora({ path: text, name: "x", licence: "mit" })).rejects.toMatchObject({ code: "not_safetensors" });
  const nc = loraFile("noncommercial");
  await expect(importLora({ path: nc, name: "nc", licence: "cc-by-nc-sa-4.0" })).rejects.toMatchObject({ code: "licence_acknowledgement_required" });
  const acknowledged = await importLora({ path: nc, name: "nc", licence: "cc-by-nc-sa-4.0", licenceAcknowledged: true });
  expect(acknowledged.licence_class).toBe("acknowledged");
  expect(licenceClass("Apache-2.0")).toBe("free");
  expect(licenceClass("unknown")).toBe("acknowledged");
  await expect(importLora({ path: loraFile("lic"), name: "l", licence: "" })).rejects.toMatchObject({ code: "licence_required" });
  expect(readLoraHeader(loraFile("down", { keys: "down-up" })).modules).toBe(3);
});

test("uncertain means adult-only; a file whose own metadata names adult content cannot be all-ages; a minor in a sexual context is never added", async () => {
  expect((await lora("plain")).classification).toBe("adult-only");
  const adult = await importLora({ path: loraFile("lewd-pack", { metadata: { ss_tag_frequency: JSON.stringify({ a: { nsfw: 12, "1girl": 40 } }) } }), name: "Pack", licence: "mit", classification: "all-ages" });
  expect(adult.classification).toBe("adult-only");
  expect(adult.classification_note).toContain("names adult content");
  await expect(updateLora(adult.id, { classification: "all-ages" })).rejects.toMatchObject({ code: "classification_locked", status: 409 });
  await expect(importLora({ path: loraFile("loli-style"), name: "x", licence: "mit" })).rejects.toMatchObject({ code: "lora_refused" });
  await expect(importLora({ path: loraFile("kid-set", { metadata: { ss_tag_frequency: "{\"x\":{\"nude\":3,\"child\":9}}" } }), name: "kid", licence: "mit" })).rejects.toMatchObject({ code: "lora_refused" });
  // Words that only look alike do not trip it.
  expect((await importLora({ path: loraFile("sussex-skies", { metadata: { name: "Sussex Dickens" } }), name: "Skies", licence: "mit", classification: "all-ages" })).classification).toBe("all-ages");
});

test("a changed file is caught before it is applied", async () => {
  const record = await lora("steady", { classification: "all-ages" });
  const file = join(dataDir, "video", "loras", `${record.id}.safetensors`);
  writeFileSync(file, "tampered after it was added");
  await expect(resolveLoras([{ id: record.id }], "adult")).rejects.toMatchObject({ code: "lora_changed" });
  await expect(resolveLoras([{ id: record.id }, { id: record.id }], "adult")).rejects.toMatchObject({ code: "duplicate_lora" });
  await expect(resolveLoras(Array.from({ length: 5 }, (_, i) => ({ id: `lora-${String(i).repeat(16)}` })), "adult")).rejects.toBeInstanceOf(LoraError);
});

test("the library routes take a multipart upload and answer in plain words", async () => {
  const path = loraFile("route-lora");
  const form = new FormData();
  form.set("file", new File([readFileSync(path)], "route-lora.safetensors"));
  form.set("name", "Route LoRA"); form.set("licence", "apache-2.0"); form.set("trigger_words", "a, b");
  const added = await app.request("/stack/v1/video/loras", { method: "POST", body: form });
  expect(added.status).toBe(200);
  const record = await added.json() as { id: string; trigger_words: string[]; classification: string };
  expect(record.trigger_words).toEqual(["a", "b"]);
  expect(record.classification).toBe("adult-only");
  const patched = await app.request(`/stack/v1/video/loras/${record.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ classification: "all-ages", strength_default: 0.7 }) });
  expect(await patched.json()).toMatchObject({ classification: "all-ages", strength_default: 0.7 });
  const again = new FormData();
  again.set("file", new File([readFileSync(path)], "route-lora.safetensors")); again.set("name", "Dup"); again.set("licence", "mit");
  expect((await app.request("/stack/v1/video/loras", { method: "POST", body: again })).status).toBe(409);
  const wrong = new FormData();
  wrong.set("file", new File([readFileSync(loraFile("fat", { dim: 5120 }))], "fat.safetensors")); wrong.set("name", "Fat"); wrong.set("licence", "mit");
  const refused = await app.request("/stack/v1/video/loras", { method: "POST", body: wrong });
  expect(refused.status).toBe(422);
  expect(((await refused.json()) as { error: string }).error).toContain("different video model");
  expect((await app.request(`/stack/v1/video/loras/${record.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await app.request(`/stack/v1/video/loras/${record.id}`, { method: "DELETE" })).status).toBe(404);
});

// ---- the service ----

test("one worker serves clips one at a time, reports the phases in order, and exits when idle", async () => {
  process.env.VIDEO_IDLE_MS = "30";
  const service = new VideoGenService(scripted((request, emit) => { for (const phase of ["rendering", "decoding", "encoding"] as const) emit({ id: request.id, event: "phase", phase, percent: 100 }); return okReply(request); }));
  const phases: string[] = [];
  const input = (name: string) => ({ prompt: "x", negativePrompt: null, imagePath: null, width: 832, height: 480, frames: 121, seed: 1, loras: [], outputDir: join(tmpdir(), `video-svc-${name}-${process.pid}`) });
  await Promise.all([service.run(input("a"), { jobId: "job-a", onPhase: (phase) => phases.push(phase) }), service.run(input("b"), { jobId: "job-b" })]);
  expect(spawned).toBe(1);
  expect(phases.filter((phase, index) => phases.indexOf(phase) === index)).toEqual(["setting up", "loading", "rendering", "decoding", "encoding"]);
  expect(service.status().state).toBe("idle");
  expect(videoRoleState(service).state).toBe("ready");
  await Bun.sleep(100);
  expect(killed).toBe(1);
  expect(service.status().state).toBe("needs-setup");
  expect(videoRoleState(service).state).toBe("installed");
});

test("the first clip builds the environment and says so; a failed build says what to check; no model is a 503 with no worker", async () => {
  const phasesSeen: string[] = [];
  const building = new VideoGenService(scripted(okReply, { ensureEnvironment: async (onProgress) => { onProgress("packages"); } }));
  await building.run({ prompt: "x", negativePrompt: null, imagePath: null, width: 832, height: 480, frames: 121, seed: 1, loras: [], outputDir: join(tmpdir(), `video-env-${process.pid}`) }, { jobId: "job-1", onPhase: (phase) => phasesSeen.push(phase) });
  expect(phasesSeen[0]).toBe("setting up");
  building.stop();
  const failing = new VideoGenService(scripted(okReply, { ensureEnvironment: async () => { throw new Error("uv exited 2: network unreachable"); } }));
  const error = await failing.run({ prompt: "x", negativePrompt: null, imagePath: null, width: 832, height: 480, frames: 121, seed: 1, loras: [], outputDir: "/tmp/never" }, { jobId: "job-2" }).catch((caught) => caught as VideoError);
  expect(error).toBeInstanceOf(VideoError);
  expect((error as VideoError).message).toContain("internet connection");
  const bare = new VideoGenService(scripted(okReply, { paths: () => null }));
  const missing = await bare.run({ prompt: "x", negativePrompt: null, imagePath: null, width: 832, height: 480, frames: 121, seed: 1, loras: [], outputDir: "/tmp/never" }, { jobId: "job-3" }).catch((caught) => caught as VideoError);
  expect((missing as VideoError).code).toBe("model_missing");
  expect(spawned).toBe(1);
  expect(bare.status().state).toBe("not-installed");
});

test("overall progress is weighted by where the time goes and never goes backwards", () => {
  const steps = [["loading", 0], ["loading", 100], ["rendering", 0], ["rendering", 100], ["decoding", 0], ["decoding", 50], ["decoding", 100], ["encoding", 0], ["encoding", 100]] as const;
  const values = steps.map(([phase, percent]) => overallPercent(phase, percent));
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(values[0]).toBe(0);
  expect(values.at(-1)).toBe(100);
  expect(overallPercent("decoding", 0)).toBe(13);
});

// A fake child process for the line protocol.
function fakeChild() {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const err = new TransformStream<Uint8Array, Uint8Array>();
  const input: string[] = [];
  let end!: (code: number) => void;
  const exited = new Promise<number>((done) => { end = done; });
  const writer = out.writable.getWriter();
  const encode = (value: unknown) => writer.write(new TextEncoder().encode(`${typeof value === "string" ? value : JSON.stringify(value)}\n`));
  return { child: { stdin: { write: (data: string) => { input.push(data); }, flush: () => {} }, stdout: out.readable, stderr: err.readable, exited, kill: () => end(143) }, input, send: encode, end };
}

test("the line protocol: ready, phase events for this job only, one reply, a stop mid-clip, and a deadline", async () => {
  const fake = fakeChild();
  const worker = workerHandle(fake.child as never);
  await fake.send({ ready: true });
  const events: string[] = [];
  const sending = worker.send({ id: "j1" } as WorkerRequest, { deadlineMs: 5000, onEvent: (event) => events.push(`${event.phase}:${event.percent}`) });
  await Bun.sleep(10);
  expect(JSON.parse(fake.input[0]!).id).toBe("j1");
  await fake.send("log noise that is not json");
  await fake.send({ id: "other", event: "phase", phase: "decoding", percent: 9 });
  await fake.send({ id: "j1", event: "phase", phase: "rendering", percent: 40 });
  await fake.send({ id: "j1", ok: true, width: 832 });
  expect(await sending).toMatchObject({ ok: true, width: 832 });
  expect(events).toEqual(["rendering:40"]);
  const stopped = worker.send({ id: "j2" } as WorkerRequest, { deadlineMs: 5000, onEvent: () => {} });
  await Bun.sleep(10);
  fake.end(1);
  expect(await stopped).toMatchObject({ ok: false, code: "worker_stopped" });
  const slow = fakeChild();
  const timed = workerHandle(slow.child as never);
  await slow.send({ ready: true });
  expect(await timed.send({ id: "j3" } as WorkerRequest, { deadlineMs: 30, onEvent: () => {} })).toMatchObject({ ok: false, code: "timeout" });
});

// ---- results ----

test("results keep the newest few for a day, and a swept clip is gone", () => {
  process.env.VIDEO_RESULT_KEEP = "2";
  const make = (n: number): VideoResultMeta => {
    const job = `job-00000000-0000-0000-0000-00000000000${n}`;
    const work = workDir(job); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "video.mp4"), "v"); writeFileSync(join(work, "poster.jpg"), "p");
    const meta: VideoResultMeta = { job, created: 1, width: 832, height: 480, frames: 121, fps: 24, seconds: 5, seed: n, model: "m", mode: "text-to-video", lora_ids: [], ms: 1, bytes: 1, poster_bytes: 1, mlx_peak_gb: null };
    commitResult(meta, work);
    utimesSync(join(resultsRoot(), job), new Date(Date.now() - (10 - n) * 1000), new Date(Date.now() - (10 - n) * 1000));
    return meta;
  };
  const metas = [1, 2, 3].map(make);
  expect(readdirSync(resultsRoot()).sort()).toEqual([metas[1]!.job, metas[2]!.job].sort());
  expect(readResult(metas[0]!.job)).toBeNull();
  process.env.VIDEO_RESULT_TTL_MS = "1";
  expect(sweepResults(Date.now() + 5000)).toBe(2);
  expect(deleteResult(metas[2]!.job)).toBe(false);
  expect(readResult("../../etc/passwd")).toBeNull();
});

test("a stashed clip is taken once", () => {
  stashClip("t", { prompt: "p", negativePrompt: null, image: null, width: 1, height: 1, frames: 1, seed: 1, loras: [], loraIds: [] });
  expect(unstashClip("t")?.prompt).toBe("p");
  expect(unstashClip("t")).toBeNull();
});

// ---- state, pins and plans ----

test("the role state and the status route say what is installed and what a clip may be", async () => {
  videoGen.useDeps(scripted());
  const status = await (await get("/stack/v1/video")).json() as { video: Record<string, any> };
  expect(status.video).toMatchObject({ available: true, tier: "p128", audio: false, loras_supported: true, state: "needs-setup" });
  expect(status.video.limits).toMatchObject({ max_seconds: 5, max_frames: 121, default_size: "832x480", fps: 24 });
  expect(status.video.reference_images.uploaded).toBe(false);
  expect(status.video.install.models.map((model: { id: string }) => model.id)).toEqual([STACK_VIDEO_MODEL.id, STACK_VIDEO_TOKENIZER.id]);
  const roles = await (await get("/stack/v1/roles")).json() as { roles: Array<{ id: string; state: { state: string }; endpoints: string[] }> };
  const video = roles.roles.find((role) => role.id === "video")!;
  expect(video.endpoints).toEqual(["/v1/videos/generations"]);
  expect(video.state.state).toBe("installed");
  __setGovernorTuningForTestsOnly({ tier: "p32" });
  const off = await (await get("/stack/v1/video")).json() as { video: Record<string, any> };
  expect(off.video).toMatchObject({ available: false, state: "off", code: "not_available_on_this_computer" });
  expect(off.video.limits.max_seconds).toBe(0);
});

test("the pins are exact: revisions, hashes, file lists that add up, Apache-2.0, a tokenizer component, and the engine pin and requirements are hashed", async () => {
  for (const pin of [STACK_VIDEO_MODEL, STACK_VIDEO_TOKENIZER]) {
    expect(pin.role).toBe("video");
    expect(pin.engine).toBe("video-gen");
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    const files = pin.download!.files!;
    expect(files.length).toBeGreaterThan(0);
    expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBe(pin.download!.approx_bytes);
    for (const file of files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.find((file) => pin.download!.url.endsWith(`/${file.path}`))!.sha256).toBe(pin.download!.sha256);
    expect(STACK_MODELS).toContain(pin);
  }
  expect(STACK_VIDEO_MODEL.download!.files!.map((file) => file.path)).toEqual(["model.safetensors", "t5_encoder.safetensors", "vae.safetensors", "config.json"]);
  expect(STACK_VIDEO_TOKENIZER.component).toBe("tokenizer");
  expect(STACK_VIDEO_MODEL.measured!.footprintBytes).toBe(44_088_747_800);
  const engine = ENGINE_BINARIES.find((pin) => pin.name === "video-gen")!;
  expect(engine.archive.url).toContain("87db56a51758fefb748a359b90a5283bb8ba4837");
  expect(engine.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(MANAGED_RUNTIMES.find((runtime) => runtime.name === "video-gen")!.version).toBe(engine.tag);
  const text = await Bun.file(videoRequirementsFileFor("darwin", "arm64")!).text();
  expect(text).toContain("mlx==0.32.4");
  expect(text).toContain("--hash=sha256:");
  expect(/^torch==/m.test(text)).toBe(false);
  expect(videoRequirementsFileFor("linux", "x64")).toBeNull();
  const p64 = PROFILE_TIERS.find((tier) => tier.id === "p64")!;
  const p32 = PROFILE_TIERS.find((tier) => tier.id === "p32")!;
  expect(p64.onDemand).not.toContain("video");
  expect(p64.notAvailable).toContain("video");
  expect(PROFILE_TIERS.find((tier) => tier.id === "p128")!.onDemand).toContain("video");
  expect(p32.notAvailable).toContain("video");
  expect(PROFILE_TIERS.find((tier) => tier.id === "p16")!.notAvailable).toContain("video");
});

test("the worker always passes aggressive tiling, three steps and no guidance (any other tiling peaks near 112 GB)", async () => {
  const source = await Bun.file(join(import.meta.dir, "../src/video/video_worker.py")).text();
  expect(source).toContain('tiling="aggressive"');
  expect(source).toContain("guide_scale=1.0");
  expect(source).toContain("steps=len(sigmas) - 1");
  expect(source).toContain('os.environ.setdefault("HF_HUB_OFFLINE", "1")');
});

// The real worker's request checks (no model needed), only where a prepared environment is named.
const python = process.env.VIDEO_GEN_PYTHON;
test.skipIf(!python)("the real worker refuses a clip above the limits and a model that is not installed, and stays up", async () => {
  const script = join(import.meta.dir, "../src/video/video_worker.py");
  const child = Bun.spawn([python!, "-s", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONPATH: process.env.VIDEO_GEN_SRC ?? "", HF_HUB_OFFLINE: "1" } });
  const worker = workerHandle(child as never);
  const base = { op: "generate", model_dir: "/nonexistent", tokenizer_dir: "/nonexistent", prompt: "x", negative_prompt: null, image: null, seed: 1, loras: [], output: "/tmp/never.mp4", poster: "/tmp/never.jpg" };
  const big = await worker.send({ id: "1", ...base, width: 1280, height: 704, num_frames: 121 } as WorkerRequest, { deadlineMs: 60_000, onEvent: () => {} });
  expect(big).toMatchObject({ ok: false, code: "bad_request" });
  const frames = await worker.send({ id: "2", ...base, width: 832, height: 480, num_frames: 120 } as WorkerRequest, { deadlineMs: 60_000, onEvent: () => {} });
  expect(frames).toMatchObject({ ok: false, code: "bad_request" });
  const missing = await worker.send({ id: "3", ...base, width: 832, height: 480, num_frames: 121 } as WorkerRequest, { deadlineMs: 60_000, onEvent: () => {} });
  expect(missing).toMatchObject({ ok: false, code: "model_missing" });
  worker.kill();
});
