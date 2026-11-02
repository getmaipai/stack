// ADULT-LOCK-04: an adult job is reported as state and progress only, unless
// Home asks for the full view with its credential. Video and picture jobs run
// on scripted workers (no model, no GPU), the same way videoGen.test.ts and
// imageGen.test.ts drive them.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetAdultViewForTests, homeViewToken } from "@/lib/adultView";
import { __resetGovernorForTests, __setGovernorTuningForTestsOnly } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { __resetEventsForTests, emit } from "@/lib/events";
import { registerVideoJobs, videoTracker } from "@/video/jobs";
import { registerImageJobs } from "@/images/jobs";
import { importLora } from "@/video/loras";
import { __resetProvenanceForTests } from "@/video/provenance";
import { videoGen, type VideoGenDeps, type WorkerEvent as VideoEvent, type WorkerHandle as VideoHandle, type WorkerReply as VideoReply, type WorkerRequest as VideoRequest } from "@/video/videoGen";
import { imageGen, type ImageGenDeps, type WorkerEvent as ImageEvent, type WorkerHandle as ImageHandle, type WorkerReply as ImageReply, type WorkerRequest as ImageRequest } from "@/images/imageEngine";
import { __setInstalledFamiliesForTests } from "@/images/models";
import { __resetGenHistoryForTests } from "@/lib/genProgress";
import { dataDir, keysDir } from "@/lib/paths";

const GB = 1_073_741_824;
const TOKEN = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "gggg", "hhhh"].join("-"); // a made-up test value
const FULL = { "x-maipai-view": "full", "x-maipai-home-token": TOKEN };
const SECRET = "a zebra on a unicycle at dusk";

let videoRequests: VideoRequest[] = [];
let imageRequests: ImageRequest[] = [];

function pngBytes(width: number, height: number, tail = "x"): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(tail)]);
}
type VideoScript = (request: VideoRequest, emit: (event: VideoEvent) => void) => Promise<VideoReply> | VideoReply;
const videoOk = (request: VideoRequest): VideoReply => ({ id: request.id, ok: true, width: request.width, height: request.height, frames: request.num_frames, fps: 24, seed: request.seed, ms: 1234, peak_bytes: 44_000_000_000 });
function videoDeps(script: VideoScript = videoOk): VideoGenDeps {
  return {
    supported: () => true, ensureEnvironment: async () => {}, paths: () => ({ modelDir: "/models/video", tokenizerDir: "/models/tok" }),
    spawn: async (): Promise<VideoHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited, kill: () => end(143),
        send: async (request, options) => {
          videoRequests.push(request);
          const reply = await Promise.race([script(request, options.onEvent), exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "stopped" }) as VideoReply)]);
          if (reply.ok) { writeFileSync(request.output, "MP4DATA-0123456789"); writeFileSync(request.poster, "JPEGDATA"); }
          return reply;
        },
      };
    },
  };
}
type ImageScript = (request: ImageRequest, emit: (event: ImageEvent) => void) => Promise<ImageReply> | ImageReply;
const imageOk = (request: ImageRequest): ImageReply => ({ id: request.id, ok: true, seeds: [request.seed], ms: 4100, peak_bytes: 13_500_000_000, width: request.width, height: request.height });
function imageDeps(script: ImageScript = imageOk): ImageGenDeps {
  return {
    supported: () => true, ensureEnvironment: async () => {}, snapshot: (family) => `/models/${family}`,
    spawn: async (): Promise<ImageHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return {
        exited, kill: () => end(143), cancel: () => {},
        send: async (request, options) => {
          imageRequests.push(request);
          const reply = await Promise.race([script(request, options.onEvent), exited.then(() => ({ id: request.id, ok: false, code: "worker_stopped", error: "stopped" }) as ImageReply)]);
          if (reply.ok) { writeFileSync(join(request.out_dir, "0.png"), pngBytes(request.width ?? 640, request.height ?? 480, "PNG0")); writeFileSync(join(request.out_dir, "0.thumb.jpg"), "JPG0"); }
          return reply;
        },
      };
    },
  };
}

function clean(): void {
  videoGen.useDeps(null); imageGen.useDeps(null);
  __resetJobsForTests(); __resetGovernorForTests(); __resetProvenanceForTests(); __resetEventsForTests(); __resetAdultViewForTests();
  __setInstalledFamiliesForTests(null);
  for (const path of ["video", "tmp/video", "images", "tmp/images"]) rmSync(join(dataDir, path), { recursive: true, force: true });
}
beforeEach(() => {
  videoRequests = []; imageRequests = [];
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  clean();
  __setGovernorTuningForTestsOnly({ totalMemoryBytes: 128 * GB, freeMemoryBytes: 90 * GB, tier: "p128" });
  __setInstalledFamiliesForTests(["flux2-klein-4b", "z-image-turbo"]);
  registerVideoJobs(); registerImageJobs();
});
afterEach(() => { delete process.env.STACK_HOME_VIEW_TOKEN; clean(); });

const postVideo = (body: Record<string, unknown>) => app.request("/v1/videos/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const postImage = (body: Record<string, unknown>) => app.request("/v1/images/generations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const text = async (path: string, headers: Record<string, string> = {}) => (await get(path, headers)).text();

function loraFile(name: string): string {
  const header: Record<string, unknown> = {};
  for (let i = 0; i < 3; i++) {
    header[`diffusion_model.blocks.${i}.self_attn.q.lora_A.weight`] = { dtype: "F16", shape: [16, 3072], data_offsets: [0, 0] };
    header[`diffusion_model.blocks.${i}.self_attn.q.lora_B.weight`] = { dtype: "F16", shape: [3072, 16], data_offsets: [0, 0] };
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const path = join(mkdtempSync(join(tmpdir(), "lora-")), `${name}.safetensors`);
  writeFileSync(path, Buffer.concat([length, json, Buffer.from(name)]));
  return path;
}

/** The event feed as text: replay everything in the ring, then stop. */
async function feed(headers: Record<string, string> = {}): Promise<string> {
  const response = await app.request("/stack/v1/events", { headers: { ...headers, "last-event-id": "0" } });
  if (response.status !== 200) return `status ${response.status}`;
  const reader = response.body!.getReader();
  let out = "";
  for (;;) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)]);
    if (!chunk || chunk.done) break;
    out += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  return out;
}

const stageEvent = (request: { id: string }, stage: string, n?: number, of?: number): VideoEvent => ({ id: request.id, event: "stage", stage, ...(n !== undefined ? { n, of } : {}) }) as VideoEvent;

async function runningClip(audience: "adult" | "all-ages"): Promise<{ job: string; release: () => void; loraId: string }> {
  __resetGenHistoryForTests();
  const record = await importLora({ path: loraFile("zebra-style"), name: "zebra-style", licence: "apache-2.0", classification: audience === "adult" ? "adult-only" : "all-ages" });
  let release!: (reply: VideoReply) => void;
  const gate = new Promise<VideoReply>((resolve) => { release = resolve; });
  videoGen.useDeps(videoDeps((request, emit) => {
    emit(stageEvent(request, "load_text")); emit(stageEvent(request, "plan")); emit(stageEvent(request, "load_model")); emit(stageEvent(request, "motion", 1, 3));
    return gate;
  }));
  const { job } = await (await postVideo({ prompt: SECRET, audience, loras: [{ id: record.id }], seed: 424242, timeout_ms: 20 })).json() as { job: string };
  await Bun.sleep(40);
  const tracker = videoTracker(job)!;
  writeFileSync(videoRequests[0]!.preview!, "FIRSTFRAME");
  tracker.enter("frames", 3, 12);
  tracker.setPreview(null, null);
  return { job, release: () => release(videoOk(videoRequests[0]!)), loraId: record.id };
}

test("an adult clip in progress shows state and progress only in the list, detail, status, events and preview", async () => {
  const { job, release, loraId } = await runningClip("adult");
  // Without the full view: nothing that names content.
  const list = await text("/stack/v1/jobs");
  const detail = await text(`/stack/v1/jobs/${job}`);
  const status = await text(`/v1/videos/generations/${job}`);
  const events = await feed();
  for (const body of [list, detail, status, events]) {
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(loraId);
    expect(body).not.toContain("zebra");
    expect(body).not.toContain("424242");
    expect(body).not.toContain("preview.jpg");
  }
  const listed = (JSON.parse(list) as { jobs: Array<Record<string, unknown>> }).jobs.find((entry) => entry.id === job)!;
  expect(listed).toMatchObject({ kind: "video_generation", state: "running", input: { audience: "adult" }, result: null });
  expect(typeof listed.percent).toBe("number");
  const live = JSON.parse(status) as Record<string, unknown>;
  expect(live).toMatchObject({ state: "running", stage_label: null, step: null, steps: null, preview_url: null, data: [] });
  expect(typeof live.progress).toBe("number");
  expect(events).toContain("job.progress");
  expect((await get(`/v1/videos/generations/${job}/preview.jpg`)).status).toBe(404);
  // With Home's full view: the whole record, the stage words and the preview.
  const fullDetail = JSON.parse(await text(`/stack/v1/jobs/${job}`, FULL)) as { job: { input: { lora_ids: string[]; seed: number } } };
  expect(fullDetail.job.input).toMatchObject({ lora_ids: [loraId], seed: 424242 });
  const fullStatus = JSON.parse(await text(`/v1/videos/generations/${job}`, FULL)) as { stage_label: string; preview_url: string };
  expect(fullStatus.stage_label).toContain("Putting the frames together");
  const preview = await get(fullStatus.preview_url, FULL);
  expect(preview.status).toBe(200);
  expect(await preview.text()).toBe("FIRSTFRAME");
  // A progress or done event of the job that names content is cut down to state and percent without the full view.
  emit({ id: "job.progress", data: { job, kind: "video_generation", state: "running", percent: 42, completed_bytes: 0, total_bytes: 0, status: "Drawing the zebra scene", position: null, items: [{ id: "x", label: "zebra-style.safetensors", completedBytes: 1, totalBytes: 2, state: "running" }] } });
  emit({ id: "job.done", data: { job, kind: "video_generation", ok: false, reason: "The zebra-style file was refused" } });
  const redactedFeed = await feed();
  expect(redactedFeed).not.toContain("zebra");
  expect(redactedFeed).toContain('"percent":42');
  const fullFeed = await feed(FULL);
  expect(fullFeed).toContain("Drawing the zebra scene");
  expect(fullFeed).toContain("The zebra-style file was refused");
  release();
  await Bun.sleep(60);
  // Finished: the result, its files and the failure text stay behind the full view.
  const done = JSON.parse(await text(`/v1/videos/generations/${job}`)) as { state: string; progress: number; data: unknown[] };
  expect(done).toMatchObject({ state: "done", progress: 100, data: [] });
  const doneList = (JSON.parse(await text("/stack/v1/jobs")) as { jobs: Array<{ id: string; result: unknown }> }).jobs.find((entry) => entry.id === job)!;
  expect(doneList.result).toBeNull();
  for (const file of ["video.mp4", "poster.jpg", "messages.mp4"]) expect((await get(`/v1/videos/generations/${job}/${file}`)).status).toBe(404);
  expect((await get(`/v1/videos/generations/${job}/video.mp4`, FULL)).status).toBe(200);
  expect((await get(`/v1/videos/generations/${job}/poster.jpg`, FULL)).status).toBe(200);
  const fullDone = JSON.parse(await text(`/v1/videos/generations/${job}`, FULL)) as { data: Array<{ lora_ids: string[] }> };
  expect(fullDone.data[0]!.lora_ids).toEqual([loraId]);
  expect(await feed()).not.toContain("zebra");
  // The log never carries the prompt, the seed's request or the style's name.
  const log = existsSync(join(dataDir, "logs", "stack.log")) ? readFileSync(join(dataDir, "logs", "stack.log"), "utf8") : "";
  expect(log).not.toContain(SECRET);
  expect(log).not.toContain("zebra");
});

test("the redaction holds after a restart, from the result on disk", async () => {
  const { job, release } = await runningClip("adult");
  release();
  await Bun.sleep(60);
  __resetJobsForTests(); __resetAdultViewForTests();
  process.env.STACK_HOME_VIEW_TOKEN = TOKEN;
  const status = JSON.parse(await text(`/v1/videos/generations/${job}`)) as { state: string; data: unknown[] };
  expect(status).toMatchObject({ state: "done", data: [] });
  expect((await get(`/v1/videos/generations/${job}/video.mp4`)).status).toBe(404);
  expect((await get(`/v1/videos/generations/${job}/video.mp4`, FULL)).status).toBe(200);
});

test("a job that is not for adults is unaffected: the same answer with or without the full view", async () => {
  const { job, release, loraId } = await runningClip("all-ages");
  const plain = JSON.parse(await text(`/v1/videos/generations/${job}`)) as Record<string, unknown>;
  const full = JSON.parse(await text(`/v1/videos/generations/${job}`, FULL)) as Record<string, unknown>;
  delete plain.eta_seconds; delete full.eta_seconds; // the estimate moves with the clock
  expect(plain).toEqual(full);
  expect(plain.preview_url).toMatch(/preview\.jpg/);
  expect(plain.stage_label).toContain("Putting the frames together");
  expect((await get(plain.preview_url as string)).status).toBe(200);
  const detail = JSON.parse(await text(`/stack/v1/jobs/${job}`)) as { job: { input: { lora_ids: string[] } } };
  expect(detail.job.input.lora_ids).toEqual([loraId]);
  emit({ id: "job.progress", data: { job, kind: "video_generation", state: "running", percent: 42, completed_bytes: 0, total_bytes: 0, status: "Drawing the zebra scene", position: null } });
  expect(await feed()).toContain("Drawing the zebra scene");
  release();
  await Bun.sleep(60);
  expect((await get(`/v1/videos/generations/${job}/video.mp4`)).status).toBe(200);
});

test("a full-view ask without Home's credential is refused everywhere, adult job or not", async () => {
  const { job, release } = await runningClip("adult");
  const wrong = { "x-maipai-view": "full", "x-maipai-home-token": ["xxxx", "yyyy", "zzzz", "wwww", "vvvv", "uuuu", "tttt", "ssss"].join("-") };
  const missing = { "x-maipai-view": "full" };
  const tokenOnly = { "x-maipai-home-token": TOKEN };
  for (const headers of [wrong, missing]) {
    for (const path of ["/stack/v1/jobs", `/stack/v1/jobs/${job}`, "/stack/v1/jobs/job-unknown", "/stack/v1/events", `/v1/videos/generations/${job}`, `/v1/videos/generations/${job}/preview.jpg`, `/v1/images/generations/job-unknown`]) {
      const response = await get(path, headers);
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("full_view_forbidden");
    }
  }
  // The token alone, without the ask, is just the standard view.
  expect((await get(`/stack/v1/jobs/${job}`, tokenOnly)).status).toBe(200);
  expect(await text(`/stack/v1/jobs/${job}`, tokenOnly)).not.toContain("zebra");
  release();
  await Bun.sleep(60);
});

test("an adult picture job is redacted the same way: status, preview and files", async () => {
  __resetGenHistoryForTests();
  let release!: (reply: ImageReply) => void;
  const gate = new Promise<ImageReply>((resolve) => { release = resolve; });
  imageGen.useDeps(imageDeps((request, emit) => {
    emit({ id: request.id, event: "stage", stage: "steps", n: 1, of: 4 } as ImageEvent);
    writeFileSync(join(request.out_dir, "preview.jpg"), "PREVIEW-1");
    emit({ id: request.id, event: "preview", index: 0, step: 1, steps: 4 } as ImageEvent);
    return gate;
  }));
  const { job } = await (await postImage({ prompt: SECRET, audience: "adult", seed: 515151, timeout_ms: 20 })).json() as { job: string };
  await Bun.sleep(40);
  const status = JSON.parse(await text(`/v1/images/generations/${job}`)) as Record<string, unknown>;
  expect(status).toMatchObject({ state: "running", preview_url: null, preview_step: null, stage_label: null, step: null, data: [] });
  const fullStatus = JSON.parse(await text(`/v1/images/generations/${job}`, FULL)) as { preview_url: string };
  expect(fullStatus.preview_url).toMatch(/preview\.jpg/);
  expect((await get(`/v1/images/generations/${job}/preview.jpg`)).status).toBe(404);
  expect(await (await get(fullStatus.preview_url, FULL)).text()).toBe("PREVIEW-1");
  const listed = JSON.parse(await text("/stack/v1/jobs")) as { jobs: Array<{ id: string; input: Record<string, unknown> }> };
  expect(listed.jobs.find((entry) => entry.id === job)!.input).toEqual({ audience: "adult" });
  release(imageOk(imageRequests[0]!));
  await Bun.sleep(60);
  const done = JSON.parse(await text(`/v1/images/generations/${job}`)) as { state: string; data: unknown[] };
  expect(done).toMatchObject({ state: "done", data: [] });
  for (const file of ["0.png", "0.thumb.jpg"]) {
    expect((await get(`/v1/images/generations/${job}/${file}`)).status).toBe(404);
    expect((await get(`/v1/images/generations/${job}/${file}`, FULL)).status).toBe(200);
  }
  const log = existsSync(join(dataDir, "logs", "stack.log")) ? readFileSync(join(dataDir, "logs", "stack.log"), "utf8") : "";
  expect(log).not.toContain(SECRET);
});

test("a picture job that is not for adults is unaffected", async () => {
  imageGen.useDeps(imageDeps());
  const body = await (await postImage({ prompt: "a boat", timeout_ms: 5000 })).json() as { job: string; data: Array<{ url: string }> };
  expect((await get(body.data[0]!.url)).status).toBe(200);
  expect(((await (await get(`/v1/images/generations/${body.job}`)).json()) as { data: unknown[] }).data).toHaveLength(1);
});

test("the credential is kept in data/keys/home-view-token (mode 600) when no variable sets it, and stays the same", () => {
  delete process.env.STACK_HOME_VIEW_TOKEN;
  rmSync(join(keysDir, "home-view-token"), { force: true });
  __resetAdultViewForTests();
  const first = homeViewToken();
  expect(first.length).toBeGreaterThanOrEqual(32);
  expect(statSync(join(keysDir, "home-view-token")).mode & 0o777).toBe(0o600);
  __resetAdultViewForTests();
  expect(homeViewToken()).toBe(first);
  rmSync(join(keysDir, "home-view-token"), { force: true });
});
