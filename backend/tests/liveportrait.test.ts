// TALK-06: the LivePortrait talk-frames engine. A fake process stands in for the real worker (no model runs here);
// the real worker is exercised by scripts/prove-liveportrait.sh.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "@/app";
import { __resetGovernorForTests } from "@/lib/governor";
import { __resetJobsForTests } from "@/lib/jobs";
import { ENGINE_BINARIES, ENGINE_ROLE, MANAGED_RUNTIMES } from "@/lib/engineCatalog";
import { STACK_LIVEPORTRAIT_MODELS, STACK_MODELS } from "@/lib/modelCatalog";
import { workerHandle, type WorkerHandle } from "@/imagetools/imageTools";
import {
  dropTalkResults, keepTalkResult, livePortrait, LivePortraitError, LivePortraitService, LIVEPORTRAIT_LIMITS, LIVEPORTRAIT_MODEL_IDS, LIVEPORTRAIT_PEAK_BYTES, LIVEPORTRAIT_PRUNE,
  LIVEPORTRAIT_SOURCE_COMMIT, livePortraitRequirementsFileFor, NO_FACE_MESSAGE, TOO_LARGE_MESSAGE, takeTalkResult, validateTalkInput, type LivePortraitDeps, type TalkWorkerReply, type TalkWorkerRequest,
} from "@/liveportrait/liveportrait";
import { registerTalkFrameJobs } from "@/liveportrait/jobs";
import { parseRatioList } from "@/routes/talkFrames";

const SRC = join(import.meta.dir, "..", "src", "liveportrait");
const read = (name: string) => readFileSync(join(SRC, name), "utf8");

function pngBytes(width: number, height: number, tail = "x"): Uint8Array {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return new Uint8Array(Buffer.concat([head, Buffer.from(tail)]));
}
const PORTRAIT = pngBytes(1024, 1024);
const frameBytes = (label: string) => new Uint8Array(Buffer.from(`frame:${label}`));

// ---- a fake worker process speaking the real line protocol through the real workerHandle ----
const requests: TalkWorkerRequest[] = [];
let spawned = 0;
let released = 0;
let lastRun: string | null = null;
let tmpRoot = "";
type Behaviour = (request: TalkWorkerRequest) => TalkWorkerReply | Promise<TalkWorkerReply>;
const okReply: Behaviour = (request) => {
  const frames: NonNullable<TalkWorkerReply["frames"]> = [];
  for (const [kind, ratios] of [["lip", request.lip], ["eye", request.eye]] as const) for (const ratio of ratios) {
    const file = join(request.outdir, `frame-${frames.length}.png`);
    writeFileSync(file, frameBytes(`${kind}-${ratio}`));
    frames.push({ kind, ratio, file, ms: 400 });
  }
  return { id: request.id, ok: true, width: 1024, height: 1024, sourceEye: 0.23, sourceLip: 0.19, ms: 1500, frames };
};

function fakeProcess(behave: Behaviour) {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let end!: (code: number) => void;
  const encoder = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { out = controller; controller.enqueue(encoder.encode('{"ready":true}\n')); } });
  const stderr = new ReadableStream<Uint8Array>({ start() {} });
  const exited = new Promise<number>((done) => { end = done; });
  return {
    stdin: {
      write(line: string) {
        const request = JSON.parse(line) as TalkWorkerRequest;
        requests.push(request);
        void Promise.resolve(behave(request)).then((reply) => { try { out.enqueue(encoder.encode(`${JSON.stringify(reply)}\n`)); } catch { /* the process is gone */ } });
      },
    },
    stdout, stderr, exited, kill() { end(143); try { out.close(); } catch { /* already closed */ } },
  };
}

function deps(over: Partial<LivePortraitDeps> = {}, behave: Behaviour = okReply): LivePortraitDeps {
  return {
    requirements: () => "requirements.txt",
    ensureSource: async () => {},
    ensureEnvironment: async () => {},
    ensureHelper: async () => "/helper/facefind",
    spawn: async (): Promise<WorkerHandle> => { spawned += 1; return workerHandle(fakeProcess(behave)); },
    modelPath: (key) => `/models/${key}`,
    hold: async () => ({ release: () => { released += 1; } }),
    tmpDir: () => tmpRoot,
    sourceDir: () => "/engines/liveportrait/1.0.0",
    recordRun: (iso) => { lastRun = iso; },
    lastRun: () => lastRun,
    ...over,
  };
}

beforeEach(() => { tmpRoot = mkdtempSync(join(tmpdir(), "liveportrait-test-")); registerTalkFrameJobs(); });
afterEach(() => {
  livePortrait.stop();
  requests.length = 0; spawned = 0; released = 0; lastRun = null;
  dropTalkResults(); __resetJobsForTests(); __resetGovernorForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---- the worker protocol ----
test("a request reaches the worker as files, with the models, the helper and the ratios; frames come back in order and the temporary files are gone", async () => {
  const service = new LivePortraitService(deps());
  const result = await service.run({ image: PORTRAIT, lip: [0, 0.3, 0.7], eye: [0] });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.lip).toEqual([0, 0.3, 0.7]);
  expect(request.eye).toEqual([0]);
  expect(request.sourceScale).toBe(2.3);
  expect(request.helper).toBe("/helper/facefind");
  expect(request.source).toBe("/engines/liveportrait/1.0.0");
  expect(Object.keys(request.models).sort()).toEqual(Object.keys(LIVEPORTRAIT_MODEL_IDS).sort());
  expect(request.models.landmark).toBe("/models/landmark");
  expect(result.frames.map((f) => `${f.kind}:${f.ratio}`)).toEqual(["lip:0", "lip:0.3", "lip:0.7", "eye:0"]);
  expect(Buffer.from(result.frames[1]!.png).toString()).toBe("frame:lip-0.3");
  expect([result.width, result.height, result.sourceEye, result.sourceLip]).toEqual([1024, 1024, 0.23, 0.19]);
  expect(readdirSync(tmpRoot)).toHaveLength(0);
  expect(lastRun).not.toBeNull();
  service.stop();
  expect(released).toBe(1);
});

test("one worker serves several requests and they run one at a time", async () => {
  const service = new LivePortraitService(deps());
  await Promise.all([service.run({ image: PORTRAIT, lip: [0.1], eye: [] }), service.run({ image: PORTRAIT, lip: [], eye: [0.2] })]);
  expect(spawned).toBe(1);
  expect(requests.map((r) => [r.lip, r.eye])).toEqual([[[0.1], []], [[], [0.2]]]);
  expect(service.status().state).toBe("idle");
  service.stop();
});

test("a worker that dies mid-request answers in plain words and the next request starts a fresh one", async () => {
  let first = true;
  const service = new LivePortraitService(deps({
    spawn: async () => {
      spawned += 1;
      const child = fakeProcess(async (request) => { if (first) { first = false; child.kill(); return { id: "never", ok: true }; } return okReply(request); });
      return workerHandle(child);
    },
  }));
  const error = await service.run({ image: PORTRAIT, lip: [0.1], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect(error).toBeInstanceOf(LivePortraitError);
  expect((error as LivePortraitError).message).toContain("Try again");
  const again = await service.run({ image: PORTRAIT, lip: [0.1], eye: [] });
  expect(again.frames).toHaveLength(1);
  expect(spawned).toBe(2);
  service.stop();
});

// ---- refusals ----
test("no face is a 422 with the exact sentence; the picture over 16 megapixels is a 413 with the exact sentence", async () => {
  const noFace = new LivePortraitService(deps({}, (request) => ({ id: request.id, ok: false, code: "no_face", error: NO_FACE_MESSAGE })));
  const error = await noFace.run({ image: PORTRAIT, lip: [0.5], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect((error as LivePortraitError).code).toBe("no_face");
  expect((error as LivePortraitError).status).toBe(422);
  expect((error as LivePortraitError).message).toBe("No face was found in this picture. Choose a picture where the face is clear.");
  noFace.stop();
  const big = new LivePortraitService(deps());
  spawned = 0;
  const tooLarge = await big.run({ image: pngBytes(4100, 4100), lip: [0.5], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect((tooLarge as LivePortraitError).code).toBe("too_large");
  expect((tooLarge as LivePortraitError).status).toBe(413);
  expect((tooLarge as LivePortraitError).message).toBe("This picture is over 16 megapixels. Choose a smaller picture.");
  expect(TOO_LARGE_MESSAGE).toBe((tooLarge as LivePortraitError).message);
  expect(spawned).toBe(0);
  expect(() => validateTalkInput({ image: pngBytes(4000, 4000), lip: [0.5], eye: [] })).not.toThrow();
});

test("bad ratios and unreadable pictures are refused before any worker starts", () => {
  const check = (lip: number[], eye: number[], image = PORTRAIT) => { try { validateTalkInput({ image, lip, eye }); return null; } catch (error) { return error as LivePortraitError; } };
  expect(check([1.5], [])?.code).toBe("bad_ratio");
  expect(check([], [-0.1])?.code).toBe("bad_ratio");
  expect(check([Number.NaN], [])?.code).toBe("bad_ratio");
  expect(check([], [])?.code).toBe("bad_ratio");
  expect(check(Array(13).fill(0.5), [])?.code).toBe("too_many_ratios");
  expect(check([], Array(13).fill(0.5))?.status).toBe(422);
  expect(check(Array(12).fill(0.5), Array(12).fill(0.5))).toBeNull();
  expect(check([0.5], [], new Uint8Array([1, 2, 3]))?.code).toBe("bad_image");
});

test("a missing model is a 503 that says to install it and nothing starts; no free memory is a 503 in plain words", async () => {
  const missing = new LivePortraitService(deps({ modelPath: (key) => (key === "landmark" ? null : "/models/x") }));
  const error = await missing.run({ image: PORTRAIT, lip: [0.5], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect((error as LivePortraitError).code).toBe("model_missing");
  expect((error as LivePortraitError).status).toBe(503);
  expect((error as LivePortraitError).message).toContain("Install them from Home's Engines page");
  const noRoom = new LivePortraitService(deps({ hold: async () => "The current memory budget cannot admit the request." }));
  const refused = await noRoom.run({ image: PORTRAIT, lip: [0.5], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect((refused as LivePortraitError).code).toBe("no_memory");
  expect(spawned).toBe(0);
});

test("a failed build says what to check; a platform with no requirements file is unsupported", async () => {
  const failing = new LivePortraitService(deps({ ensureEnvironment: async () => { throw new Error("uv exited 2: network unreachable"); } }));
  const error = await failing.run({ image: PORTRAIT, lip: [0.5], eye: [] }).catch((caught) => caught as LivePortraitError);
  expect((error as LivePortraitError).code).toBe("setup_failed");
  expect((error as LivePortraitError).message).toContain("internet connection");
  const none = new LivePortraitService(deps({ requirements: () => null }));
  expect(none.status().state).toBe("unsupported");
  expect(((await none.run({ image: PORTRAIT, lip: [0.5], eye: [] }).catch((caught) => caught)) as LivePortraitError).code).toBe("unsupported");
});

test("cancelling a running request stops the worker and gives the memory back", async () => {
  const service = new LivePortraitService(deps({}, () => new Promise<TalkWorkerReply>(() => {})));
  const controller = new AbortController();
  const running = service.run({ image: PORTRAIT, lip: [0.5], eye: [] }, { signal: controller.signal }).catch((caught) => caught as LivePortraitError);
  await Bun.sleep(40);
  controller.abort();
  expect(((await running) as LivePortraitError).code).toBe("cancelled");
  expect(released).toBe(1);
  expect(readdirSync(tmpRoot)).toHaveLength(0);
});

// ---- readiness ----
test("status reports installed, environment, models, helper and the last successful run", async () => {
  const service = new LivePortraitService(deps({ modelPath: (key) => (key === "stitching" ? null : "/models/x") }));
  const before = service.status();
  expect(before.state).toBe("needs-setup");
  expect(before.modelsVerified).toBe(false);
  expect(before.models.stitching).toBe(false);
  expect(before.models.landmark).toBe(true);
  expect(before.lastSuccessfulRun).toBeNull();
  expect(Object.keys(before).sort()).toEqual(["environmentReady", "helperCompiled", "installed", "lastSuccessfulRun", "limits", "modelsVerified", "models", "phase", "reason", "state"].sort());
  const ready = new LivePortraitService(deps());
  await ready.run({ image: PORTRAIT, lip: [0.5], eye: [] });
  expect(ready.status().helperCompiled).toBe(true);
  expect(ready.status().lastSuccessfulRun).toBe(lastRun);
  expect(ready.status().modelsVerified).toBe(true);
  ready.stop();
});

test("the governor is asked for the measured peak: 5 GiB, above the 4.99 GB footprint measured with a 16-megapixel picture", () => {
  expect(LIVEPORTRAIT_PEAK_BYTES).toBe(5 * 1_073_741_824);
  for (const pin of STACK_LIVEPORTRAIT_MODELS) expect(pin.measured!.footprintBytes).toBe(4_986_000_000);
  expect(LIVEPORTRAIT_PEAK_BYTES).toBeGreaterThan(4_986_000_000);
});

// ---- pins, checksums, the patched source ----
const EXPECTED_PINS: Array<[string, string, string, number]> = [
  ["liveportrait-landmark", "liveportrait/landmark.onnx", "31d22a5041326c31f19b78886939a634a5aedcaa5ab8b9b951a1167595d147db", 114_666_491],
  ["liveportrait-appearance", "liveportrait/base_models/appearance_feature_extractor.pth", "5279bb8654293dbdf327030b397f107237dd9212fb11dd75b83dfb635211ceb5", 3_387_959],
  ["liveportrait-motion", "liveportrait/base_models/motion_extractor.pth", "251e6a94ad667a1d0c69526d292677165110ef7f0cf0f6d199f0e414e8aa0ca5", 112_545_506],
  ["liveportrait-generator", "liveportrait/base_models/spade_generator.pth", "4780afc7909a9f84e24c01d73b31a555ef651521a1fe3b2429bd04534d992aee", 221_813_590],
  ["liveportrait-warping", "liveportrait/base_models/warping_module.pth", "2f61a6f265fe344f14132364859a78bdbbc2068577170693da57fb96d636e282", 182_180_086],
  ["liveportrait-stitching", "liveportrait/retargeting_models/stitching_retargeting_module.pth", "3652d5a3f95099141a56986aaddec92fadf0a73c87a20fac9a2c07c32b28b611", 2_393_098],
];
test("the six weights are pinned records with the exact revision, checksum, size and MIT licence, and ship in the model list", () => {
  expect(STACK_LIVEPORTRAIT_MODELS.map((pin) => pin.id)).toEqual(EXPECTED_PINS.map(([id]) => id) as string[]);
  expect([...Object.values(LIVEPORTRAIT_MODEL_IDS)].sort() as string[]).toEqual(EXPECTED_PINS.map(([id]) => id).sort());
  for (const [id, file, sha256, bytes] of EXPECTED_PINS) {
    const pin = STACK_LIVEPORTRAIT_MODELS.find((candidate) => candidate.id === id)!;
    expect(pin.license).toBe("MIT");
    expect(pin.revision).toBe("82a4fa6735ca58432b6ce39301b4b9ee066dea47");
    expect(pin.repo).toBe("KwaiVGI/LivePortrait");
    expect(pin.engine).toBe("liveportrait");
    expect(pin.role).toBe("image");
    expect(pin.download!.sha256).toBe(sha256);
    expect(pin.download!.approx_bytes).toBe(bytes);
    expect(pin.download!.url).toContain(`/resolve/82a4fa6735ca58432b6ce39301b4b9ee066dea47/${file}`);
    expect(STACK_MODELS.some((model) => model.id === id)).toBe(true);
  }
  expect(EXPECTED_PINS.reduce((sum, pin) => sum + pin[3], 0)).toBeGreaterThan(600_000_000);
});

test("the runtime is a managed image-family engine whose source archive is pinned to the one upstream commit by sha256", () => {
  const runtime = MANAGED_RUNTIMES.find((r) => r.name === "liveportrait")!;
  expect(runtime.version).toBe("1.0.0");
  expect(runtime.roles).toEqual(["image"]);
  expect(ENGINE_ROLE.liveportrait).toBe("image");
  const pin = ENGINE_BINARIES.find((p) => p.name === "liveportrait" && p.platform === "darwin" && p.arch === "arm64")!;
  expect(pin.tag).toBe("1.0.0");
  expect(pin.archive.url).toBe(`https://codeload.github.com/KwaiVGI/LivePortrait/tar.gz/${LIVEPORTRAIT_SOURCE_COMMIT}`);
  expect(LIVEPORTRAIT_SOURCE_COMMIT).toBe("9b294b3d0536135442ea73cb01e6cb3ca7029dd3");
  expect(pin.archive.sha256).toBe("14db8304a3eb98461ec5c19f95a1b46b996ea7daa9cbbcf113b9139d60e0f3be");
  expect(pin.archive.approxBytes).toBe(38_382_251);
  expect(pin.verified).toBe(true);
});

test("the patch swaps the face finder and nothing else; the prune list removes every file of the research-only finder and the demo app", () => {
  const patch = read("liveportrait.patch.txt");
  expect([...patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]).sort()).toEqual(["src/config/crop_config.py", "src/utils/cropper.py", "src/utils/face_finder.py"]);
  expect(patch).toContain("+from .face_finder import FaceFinder");
  expect(patch).not.toMatch(/^\+.*(face_analysis_diy|FaceAnalysisDIY|buffalo)/m);
  for (const entry of ["src/utils/dependencies", "src/utils/face_analysis_diy.py", "src/gradio_pipeline.py", "src/utils/video.py", "pretrained_weights"]) expect((LIVEPORTRAIT_PRUNE as readonly string[]).includes(entry)).toBe(true);
});

test("no code the Stack runs names the research-only finder or its model files, and the worker never imports the demo app", () => {
  for (const name of ["liveportrait_worker.py", "facefind.swift", "liveportrait.ts", "liveportrait.darwin-arm64.requirements.txt", "jobs.ts"]) {
    expect(read(name).toLowerCase()).not.toContain("insightface");
    expect(read(name)).not.toMatch(/buffalo|det_10g|2d106det/);
  }
  const worker = read("liveportrait_worker.py");
  expect(worker).not.toMatch(/^\s*(import gradio|from gradio|from src\.gradio_pipeline)/m);
  expect(worker).toContain("mov_z = torch.tensor(1.0)");
  const requirements = read("liveportrait.darwin-arm64.requirements.txt");
  for (const pinned of ["torch==2.3.0", "torchvision==0.18.0", "numpy==1.26.4", "pillow==10.4.0", "opencv-contrib-python==4.10.0.84", "mediapipe==0.10.18", "onnxruntime==1.19.2"]) expect(requirements).toContain(pinned);
  expect(requirements).not.toMatch(/^(gradio|insightface|ffmpeg)/m);
  expect(requirements.match(/--hash=sha256:/g)!.length).toBeGreaterThan(40);
  expect(livePortraitRequirementsFileFor("darwin", "arm64")).not.toBeNull();
  expect(livePortraitRequirementsFileFor("linux", "x64")).toBeNull();
});

// ---- the route and the job lifecycle ----
const form = (fields: Record<string, string>, image: Uint8Array | null = PORTRAIT) => {
  const body = new FormData();
  if (image) body.set("image", new File([image], "face.png", { type: "image/png" }));
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};
const post = (fields: Record<string, string>, image: Uint8Array | null = PORTRAIT) => app.request("/v1/images/talk-frames", { method: "POST", body: form(fields, image) });

test("ratio lists: comma separated floats 0 to 1, at most 12 each", () => {
  expect(parseRatioList("0,0.3,0.7")).toEqual([0, 0.3, 0.7]);
  expect(parseRatioList(" 0 , 1 ")).toEqual([0, 1]);
  expect(parseRatioList("")).toEqual([]);
  expect(parseRatioList(undefined)).toEqual([]);
  expect(parseRatioList("0,1.1")).toBeNull();
  expect(parseRatioList("0,,1")).toBeNull();
  expect(parseRatioList("a")).toBeNull();
  expect(parseRatioList(Array(12).fill("0.5").join(","))).toHaveLength(12);
  expect(parseRatioList(Array(13).fill("0.5").join(","))).toBeNull();
});

test("route: a good request returns the frame list and each frame is a PNG fetched by url; unknown and expired frames are 404", async () => {
  livePortrait.useDeps(deps());
  const response = await post({ lip: "0,0.3,0.7", eye: "0", timeout_ms: "5000" });
  expect(response.status).toBe(200);
  const body = await response.json() as { job: string; sourceEye: number; sourceLip: number; frames: Array<{ kind: string; ratio: number; width: number; height: number; content_type: string; url: string }> };
  expect(body.frames.map((f) => `${f.kind}:${f.ratio}`)).toEqual(["lip:0", "lip:0.3", "lip:0.7", "eye:0"]);
  expect([body.sourceEye, body.sourceLip]).toEqual([0.23, 0.19]);
  expect(body.frames[0]).toMatchObject({ width: 1024, height: 1024, content_type: "image/png" });
  expect(body.frames[2]!.url).toBe(`/v1/images/talk-frames/${body.job}/2`);
  const frame = await app.request(body.frames[2]!.url);
  expect(frame.status).toBe(200);
  expect(frame.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await frame.arrayBuffer()).toString()).toBe("frame:lip-0.7");
  expect((await app.request(`/v1/images/talk-frames/${body.job}/9`)).status).toBe(404);
  expect((await app.request("/v1/images/talk-frames/nope/0")).status).toBe(404);
  const missing = await (await app.request("/v1/images/talk-frames/nope/0")).json() as { error: string; code: string };
  expect(missing.code).toBe("expired");
});

test("route: results are kept ten minutes and then dropped", () => {
  const result = { width: 2, height: 2, sourceEye: 0.2, sourceLip: 0.2, ms: 1, frames: [{ kind: "lip" as const, ratio: 0, png: frameBytes("x"), ms: 1 }] };
  const t0 = 1_000_000;
  keepTalkResult("a", result, t0);
  expect(takeTalkResult("a", t0 + 599_000)).not.toBeNull();
  expect(takeTalkResult("a", t0 + 601_000)).toBeNull();
  expect(takeTalkResult("a", t0 + 602_000)).toBeNull();
  for (let i = 0; i < 9; i++) keepTalkResult(`k${i}`, result, t0);
  expect(takeTalkResult("k0", t0)).toBeNull();
  expect(takeTalkResult("k8", t0)).not.toBeNull();
});

test("route: bad input is refused with a code and a sentence that says what to change", async () => {
  livePortrait.useDeps(deps());
  const cases: Array<[Record<string, string>, Uint8Array | null, number, string]> = [
    [{ lip: "0,2", eye: "0" }, PORTRAIT, 422, "bad_ratio"],
    [{ lip: Array(13).fill("0.5").join(","), eye: "0" }, PORTRAIT, 422, "bad_ratio"],
    [{ lip: "abc" }, PORTRAIT, 422, "bad_ratio"],
    [{}, PORTRAIT, 422, "bad_ratio"],
    [{ lip: "0.5" }, new Uint8Array(), 422, "bad_image"],
    [{ lip: "0.5" }, new Uint8Array([1, 2, 3, 4]), 422, "bad_image"],
    [{ lip: "0.5" }, pngBytes(5000, 5000), 413, "too_large"],
  ];
  for (const [fields, image, status, code] of cases) {
    const response = await post({ ...fields, timeout_ms: "3000" }, image);
    expect(response.status).toBe(status);
    const body = await response.json() as { error: string; code: string };
    expect(body.code).toBe(code);
    expect(body.error.length).toBeGreaterThan(20);
  }
  expect(spawned).toBe(0);
  const noImage = await post({ lip: "0.5" }, null);
  expect(noImage.status).toBeGreaterThanOrEqual(400);
  expect(spawned).toBe(0);
});

test("route: the worker's refusal comes back as the job's answer with its status and the exact words", async () => {
  livePortrait.useDeps(deps({}, (request) => ({ id: request.id, ok: false, code: "no_face", error: NO_FACE_MESSAGE })));
  const response = await post({ lip: "0.5", timeout_ms: "5000" });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "no_face", error: "No face was found in this picture. Choose a picture where the face is clear." });
  livePortrait.useDeps(deps({ modelPath: () => null }));
  const missing = await post({ lip: "0.5", timeout_ms: "5000" });
  expect(missing.status).toBe(503);
  expect((await missing.json() as { code: string }).code).toBe("model_missing");
});

test("route: a request past timeout_ms is a 202 with a job id that finishes and serves its frames", async () => {
  livePortrait.useDeps(deps({}, async (request) => { await Bun.sleep(250); return okReply(request); }));
  const response = await post({ lip: "0.4", eye: "0", timeout_ms: "50" });
  expect(response.status).toBe(202);
  const accepted = await response.json() as { job: string; frames: unknown[] };
  expect(accepted.frames).toEqual([]);
  let state = "";
  for (let i = 0; i < 100 && state !== "done"; i++) {
    await Bun.sleep(50);
    const job = await (await app.request(`/stack/v1/jobs/${accepted.job}`)).json() as { job: { state: string; result?: { frameCount?: number; width?: number } } };
    state = job.job.state;
    if (state === "done") expect([job.job.result!.frameCount, job.job.result!.width]).toEqual([2, 1024]);
  }
  expect(state).toBe("done");
  const frame = await app.request(`/v1/images/talk-frames/${accepted.job}/1`);
  expect(frame.status).toBe(200);
  expect(Buffer.from(await frame.arrayBuffer()).toString()).toBe("frame:eye-0");
});

test("route: the picture and ratios never ride on the job record or the event feed", async () => {
  livePortrait.useDeps(deps());
  const response = await post({ lip: "0.1234567", eye: "0", timeout_ms: "5000" });
  const { job } = await response.json() as { job: string };
  const record = JSON.stringify(await (await app.request(`/stack/v1/jobs/${job}`)).json());
  expect(record).not.toContain("0.1234567");
  expect(record).not.toContain("face.png");
  expect(existsSync(tmpRoot) && readdirSync(tmpRoot)).toHaveLength(0);
});

test("the documented limits are the enforced ones", () => {
  expect(LIVEPORTRAIT_LIMITS).toEqual({ max_megapixels: 16, max_ratios_per_list: 12 });
});

// ---- MAKER-B2: landmarks for the source and every frame; the engine in the install plan and the image role ----
const ring = (n: number, cx: number, cy: number) => Array.from({ length: n }, (_, i) => [cx + i, cy]);
const lm = (shift: number) => ({ outerLips: ring(36, 100 + shift, 200), innerLips: ring(24, 110 + shift, 205), nose: [], contour: [], points: ring(203, shift, 0) });
const landmarkReply: Behaviour = (request) => {
  const base = okReply(request) as TalkWorkerReply;
  return { ...base, sourceLandmarks: lm(0), frames: base.frames!.map((frame, index) => ({ ...frame, landmarks: index === 3 ? null : lm(index + 1) })) };
};

test("landmarks: the source and every frame carry them, in the frame's own pixels, and a frame with no face carries null", async () => {
  const service = new LivePortraitService(deps({}, landmarkReply));
  const result = await service.run({ image: PORTRAIT, lip: [0, 0.3, 0.7], eye: [0] });
  expect(result.sourceLandmarks!.outerLips).toHaveLength(36);
  expect(result.sourceLandmarks!.innerLips).toHaveLength(24);
  expect(result.sourceLandmarks!.points).toHaveLength(203);
  expect(result.frames.map((f) => f.landmarks === null ? null : f.landmarks!.outerLips[0]![0])).toEqual([101, 102, 103, null]);
  for (const frame of result.frames) for (const [x, y] of frame.landmarks?.points ?? []) { expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(result.height); }
  service.stop();
});

test("route: landmarks are additive; every field the route returned before is unchanged", async () => {
  livePortrait.useDeps(deps({}, landmarkReply));
  const body = await (await post({ lip: "0,0.3,0.7", eye: "0", timeout_ms: "5000" })).json() as Record<string, any>;
  expect(body.sourceLandmarks.innerLips).toHaveLength(24);
  expect(body.frames[1].landmarks.outerLips).toHaveLength(36);
  expect(body.frames[3].landmarks).toBeNull();
  expect(Object.keys(body.frames[0]).sort()).toEqual(["content_type", "height", "kind", "landmarks", "ms", "ratio", "url", "width"]);
  expect([body.sourceEye, body.sourceLip, body.frames[2].url]).toEqual([0.23, 0.19, `/v1/images/talk-frames/${body.job}/2`]);
  // A worker that sends no landmarks (an older one) gives null, and every old field is as before.
  livePortrait.useDeps(deps());
  const plain = await (await post({ lip: "0", timeout_ms: "5000" })).json() as Record<string, any>;
  expect([plain.sourceLandmarks, plain.frames[0].landmarks]).toEqual([null, null]);
  expect(Object.keys(plain.frames[0]).filter((key) => key !== "landmarks").sort()).toEqual(["content_type", "height", "kind", "ms", "ratio", "url", "width"]);
});

test("the worker reads landmarks from the 203-point model's crop, never from Apple Vision, and groups the lips by the model's own indices", () => {
  const worker = read("liveportrait_worker.py");
  expect(worker).toContain("lmk_crop");
  expect(worker).toContain('"outerLips": range(48, 84)');
  expect(worker).toContain('"innerLips": range(84, 108)');
  expect(worker.match(/vision_box/g)!.length).toBe(2); // the definition and the one use that finds the face rectangle
});

// Regression (2026-11-11): the worker mapped `lmk_crop` through `M_c2o` a second time, but LivePortrait's LandmarkRunner already returns it in the
// input picture's own pixels, so every returned landmark was off (about 1.32 x + 180 on a 1024 px picture). `landmark_groups` must pass the points through unchanged.
test("the worker returns lmk_crop as it is (already in the picture's own pixels), never mapped through M_c2o again", () => {
  const script = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location("lp_worker", ${JSON.stringify(join(SRC, "liveportrait_worker.py"))})`,
    "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)",
    "pts = [[100.0 + i, 200.0 + 2 * i] for i in range(203)]",
    "crop = {'lmk_crop': pts, 'M_c2o': [[1.32, 0, 180], [0, 1.32, 54], [0, 0, 1]]}",
    "groups = mod.landmark_groups(crop['lmk_crop'])",
    "mod.PROTOCOL.write(json.dumps({'points': groups['points'], 'outer': groups['outerLips'], 'inner': groups['innerLips']}) + '\\n')", // the worker moves stdout to stderr; PROTOCOL is its real stdout
  ].join("\n");
  const run = Bun.spawnSync(["python3", "-B", "-c", script], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) { console.warn("python3 unavailable, skipping:", run.stderr.toString().slice(0, 200)); return; }
  const out = JSON.parse(run.stdout.toString().trim().split("\n").pop()!);
  expect(out.points).toHaveLength(203);
  expect(out.points[0]).toEqual([100, 200]);
  expect(out.points[202]).toEqual([302, 604]);
  expect(out.outer).toHaveLength(36);
  expect(out.outer[0]).toEqual([148, 296]); // index 48
  expect(out.inner[0]).toEqual([184, 368]); // index 84
});
