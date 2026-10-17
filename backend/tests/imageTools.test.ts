import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_TOOL_MODEL_IDS, ImageToolError, ImageToolsService, imageToolsRequirementsFileFor, keepResult, stashInput, takeResult, unstashInput, type ImageToolsDeps, type WorkerHandle, type WorkerRequest, type WorkerReply } from "@/imagetools/imageTools";
import { STACK_IMAGE_TOOL_MODELS, STACK_MODELS } from "@/lib/modelCatalog";
import { buildInstallPlan } from "@/lib/installPlan";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
let released = 0;
let spawned = 0;
const requests: WorkerRequest[] = [];

function deps(over: Partial<ImageToolsDeps> = {}, reply: (request: WorkerRequest) => WorkerReply = (request) => ({ id: request.id, ok: true, width: 10, height: 20, engine: "lama", model: "m", ms: 5 })): ImageToolsDeps {
  const dir = mkdtempSync(join(tmpdir(), "imagetools-test-"));
  return {
    requirements: () => "requirements.txt",
    ensureEnvironment: async () => {},
    ensureHelper: async () => null,
    modelPath: () => "/models/x.onnx",
    tmpDir: () => dir,
    hold: async () => ({ release: () => { released += 1; } }),
    spawn: async (): Promise<WorkerHandle> => {
      spawned += 1;
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request) => { requests.push(request); writeFileSync(request.output, PNG); return reply(request); } };
    },
    ...over,
  };
}
afterEach(() => { released = 0; spawned = 0; requests.length = 0; });

test("an erase request reaches the worker with the mask and the installed model, and the temporary files are gone afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "imagetools-dir-"));
  const service = new ImageToolsService(deps({ tmpDir: () => dir }));
  const result = await service.run({ operation: "erase", image: PNG, mask: PNG });
  expect(result.png).toEqual(PNG);
  expect(requests[0]!.op).toBe("erase");
  expect(requests[0]!.mask).toContain(".mask");
  expect(requests[0]!.models.lama).toBe("/models/x.onnx");
  expect(readdirSync(dir)).toHaveLength(0);
  service.stop();
  expect(released).toBe(1);
});

test("one worker serves several edits and requests run one at a time", async () => {
  const service = new ImageToolsService(deps());
  await Promise.all([service.run({ operation: "resize", image: PNG, params: { width: 5 } }), service.run({ operation: "resize", image: PNG, params: { factor: 2 } })]);
  expect(spawned).toBe(1);
  expect(requests.map((request) => request.params)).toEqual([{ width: 5 }, { factor: 2 }]);
  service.stop();
});

test("a missing model is a 503 that says to install the tools, and nothing is sent to the worker", async () => {
  const service = new ImageToolsService(deps({ modelPath: () => null }));
  const error = await service.run({ operation: "upscale", image: PNG, params: { scale: 2 } }).catch((caught) => caught as ImageToolError);
  expect(error).toBeInstanceOf(ImageToolError);
  expect((error as ImageToolError).status).toBe(503);
  expect((error as ImageToolError).message).toContain("Install the image tools");
  expect(requests).toHaveLength(0);
  service.stop();
});

test("resize needs no model; Apple's finder needs no ONNX model", async () => {
  const service = new ImageToolsService(deps({ modelPath: () => null, ensureHelper: async () => "/helper/fgmask" }));
  await service.run({ operation: "resize", image: PNG, params: { width: 5 } });
  await service.run({ operation: "remove_background", image: PNG });
  expect(requests[1]!.helper).toBe("/helper/fgmask");
  service.stop();
});

test("a refusal from the worker keeps its code and status (a picture over the limit is 413)", async () => {
  const service = new ImageToolsService(deps({}, (request) => ({ id: request.id, ok: false, code: "too_large", error: "This picture is 30.0 megapixels; this tool takes up to 25. Resize it first." })));
  const error = await service.run({ operation: "erase", image: PNG, mask: PNG }).catch((caught) => caught as ImageToolError);
  expect((error as ImageToolError).code).toBe("too_large");
  expect((error as ImageToolError).status).toBe(413);
  service.stop();
});

test("no free memory is a 503 in plain words and no worker is started", async () => {
  const service = new ImageToolsService(deps({ hold: async () => "The current memory budget cannot admit the request." }));
  const error = await service.run({ operation: "resize", image: PNG, params: { width: 5 } }).catch((caught) => caught as ImageToolError);
  expect((error as ImageToolError).code).toBe("no_memory");
  expect(spawned).toBe(0);
});

test("a failed environment build says what to check, and a platform with no requirements file is unsupported", async () => {
  const failing = new ImageToolsService(deps({ ensureEnvironment: async () => { throw new Error("uv exited 2: network unreachable"); } }));
  const error = await failing.run({ operation: "resize", image: PNG, params: { width: 5 } }).catch((caught) => caught as ImageToolError);
  expect((error as ImageToolError).message).toContain("internet connection");
  const none = new ImageToolsService(deps({ requirements: () => null }));
  expect(none.status().state).toBe("unsupported");
  const refused = await none.run({ operation: "resize", image: PNG, params: { width: 5 } }).catch((caught) => caught as ImageToolError);
  expect((refused as ImageToolError).code).toBe("unsupported");
});

test("cancelling a running edit stops the worker and gives the memory back", async () => {
  let kill = () => {};
  const service = new ImageToolsService(deps({ spawn: async () => { let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; }); kill = () => end(143); return { exited, kill, send: () => new Promise<WorkerReply>(() => {}) }; } }));
  const controller = new AbortController();
  const running = service.run({ operation: "resize", image: PNG, params: { width: 5 } }, { signal: controller.signal }).catch((caught) => caught as ImageToolError);
  await Bun.sleep(30);
  controller.abort();
  expect(((await running) as ImageToolError).code).toBe("cancelled");
  expect(released).toBe(1);
});

test("an idle worker exits by itself", async () => {
  process.env.IMAGE_TOOLS_IDLE_MS = "20";
  const service = new ImageToolsService(deps());
  await service.run({ operation: "resize", image: PNG, params: { width: 5 } });
  delete process.env.IMAGE_TOOLS_IDLE_MS;
  expect(service.status().state).toBe("idle");
  await Bun.sleep(120);
  expect(released).toBe(1);
  expect(service.status().state).toBe("needs-setup");
});

test("pictures wait in memory only between the route and the runner, and results are kept briefly", () => {
  stashInput("t1", { operation: "resize", image: PNG });
  expect(unstashInput("t1")?.operation).toBe("resize");
  expect(unstashInput("t1")).toBeNull();
  for (let i = 0; i < 8; i++) keepResult(`r${i}`, { png: PNG, width: 1, height: 1, engine: "e", model: "m", ms: 1, operation: "resize" });
  expect(takeResult("r0")).toBeNull();
  expect(takeResult("r7")).not.toBeNull();
});

test("the three pins are verified components of the image role with licences, never a selectable image model", () => {
  expect(STACK_IMAGE_TOOL_MODELS.map((pin) => pin.id).sort()).toEqual(Object.values(IMAGE_TOOL_MODEL_IDS).sort());
  for (const pin of STACK_IMAGE_TOOL_MODELS) {
    expect(pin.role).toBe("image");
    expect(pin.component).toBeTruthy();
    expect(pin.engine).toBe("image-tools");
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.download!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.download!.hub_file).toBeTruthy();
    expect(["MIT", "Apache-2.0", "BSD-3-Clause"]).toContain(pin.license!);
    expect(STACK_MODELS).toContain(pin);
  }
});

test("every tier's install plan carries the image tools and the requirements file is hashed", async () => {
  const plan = buildInstallPlan({ platform: "darwin", arch: "arm64", totalMemoryBytes: 128 * 1_073_741_824, unifiedMemory: true, freeDiskBytes: 1e12, cudaDevices: [] } as never, { vramOverrideGb: 64 });
  expect(plan.models.filter((model) => model.id.startsWith("image-tool-"))).toHaveLength(3);
  const text = await Bun.file(imageToolsRequirementsFileFor("darwin", "arm64")!).text();
  expect(text).toContain("onnxruntime==1.31.0");
  expect(text).toContain("--hash=sha256:");
  expect(imageToolsRequirementsFileFor("linux", "x64")).toBeNull();
});

test("IMGEDIT-01: find_people and erase_people reach the worker with the person finder, needing the eraser model only for the erase, and the boxes come back", async () => {
  const people = [{ id: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.6, area: 0.1 }, { id: 2, x: 0.6, y: 0.2, w: 0.2, h: 0.5, area: 0.07 }];
  const service = new ImageToolsService(deps({ ensurePeopleHelper: async () => "/helper/personmask", modelPath: () => null }, (request) => ({ id: request.id, ok: true, width: 10, height: 20, engine: "apple-vision", model: "m", ms: 5, people })));
  const found = await service.run({ operation: "find_people", image: PNG });
  expect(found.people).toEqual(people);
  expect(requests[0]!.people_helper).toBe("/helper/personmask");
  // The eraser needs its model; finding people does not.
  const refused = await service.run({ operation: "erase_people", image: PNG, params: { people: [2] } }).catch((caught) => caught as ImageToolError);
  expect((refused as ImageToolError).code).toBe("model_missing");
  service.stop();
  const withModel = new ImageToolsService(deps({ ensurePeopleHelper: async () => "/helper/personmask" }, (request) => ({ id: request.id, ok: true, width: 10, height: 20, engine: "apple-vision+lama", model: "m", ms: 5, people })));
  await withModel.run({ operation: "erase_people", image: PNG, params: { people: [2] } });
  expect(requests.at(-1)!.params).toEqual({ people: [2] });
  expect(requests.at(-1)!.models.lama).toBe("/models/x.onnx");
  withModel.stop();
});

test("IMGEDIT-01: people_mask needs no model and reaches the worker with the chosen people", async () => {
  const service = new ImageToolsService(deps({ ensurePeopleHelper: async () => "/helper/personmask", modelPath: () => null }));
  await service.run({ operation: "people_mask", image: PNG, params: { people: [2] } });
  expect(requests[0]).toMatchObject({ op: "people_mask", people_helper: "/helper/personmask", params: { people: [2] } });
  service.stop();
});

test("IMGEDIT-01: a Mac without the person finder answers people_unavailable as a 422 that points to the eraser", async () => {
  const service = new ImageToolsService(deps({ ensurePeopleHelper: async () => null }, (request) => ({ id: request.id, ok: false, code: "people_unavailable", error: "Finding people needs Apple's person finder. Paint over the person with the eraser instead." })));
  const error = await service.run({ operation: "find_people", image: PNG }).catch((caught) => caught as ImageToolError);
  expect((error as ImageToolError).status).toBe(422);
  expect((error as ImageToolError).message).toContain("eraser");
  service.stop();
});

// The real worker on real pixels, only where a prepared environment is named (the scratch run sets IMAGE_TOOLS_PYTHON).
const python = process.env.IMAGE_TOOLS_PYTHON;
test.skipIf(!python)("the real worker resizes, strips metadata and applies orientation", async () => {
  const { workerHandle } = await import("@/imagetools/imageTools");
  const dir = mkdtempSync(join(tmpdir(), "imagetools-real-"));
  const script = join(import.meta.dir, "../src/imagetools/image_tools_worker.py");
  const child = Bun.spawn([python!, "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const worker = workerHandle(child as never);
  const make = Bun.spawnSync([python!, "-c", `from PIL import Image\nim=Image.new("RGB",(60,30),(200,10,10)); e=Image.Exif(); e[0x0112]=6; e[0x010F]="Cam"; im.save("${dir}/in.jpg",exif=e.tobytes())`]);
  expect(make.exitCode).toBe(0);
  const reply = await worker.send({ id: "1", op: "resize", input: `${dir}/in.jpg`, output: `${dir}/out.png`, params: { factor: 2 }, models: {}, helper: null }, 30_000);
  expect(reply.ok).toBe(true);
  expect([reply.width, reply.height]).toEqual([60, 120]);
  const check = Bun.spawnSync([python!, "-c", `from PIL import Image\nim=Image.open("${dir}/out.png"); print(len(im.getexif()), list(im.info.keys()))`]);
  expect(String(check.stdout).trim()).toBe("0 []");
  const bad = await worker.send({ id: "2", op: "erase", input: `${dir}/in.jpg`, output: `${dir}/o2.png`, params: {}, models: {}, helper: null }, 30_000);
  expect(bad.code).toBe("mask_required");
  expect(existsSync(`${dir}/o2.png`)).toBe(false);
  worker.kill();
});

test.skipIf(!python)("IMGEDIT-01: person labels keep each person's main blob and what touches it, drop a stray piece across the room, and the boxes follow what is kept", () => {
  const script = join(import.meta.dir, "../src/imagetools");
  const code = `import sys\nsys.path.insert(0, ${JSON.stringify(script)})\nimport numpy as np, image_tools_worker as w\nl=np.zeros((100,200),np.uint8)\nl[20:80,20:40]=1\nl[40:50,41:50]=1\nl[10:30,150:190]=1\nkept,boxes=w.clean_labels(l,200,100)\nprint(int((kept==1).sum()), len(boxes), round(boxes[0]['x'],3), round(boxes[0]['w'],3))`;
  const run = Bun.spawnSync([python!, "-I", "-c", code]);
  expect(run.exitCode).toBe(0);
  // 60x20 main blob + the 10x9 piece that touches it; the 20x40 blob far away is dropped.
  expect(String(run.stdout).trim()).toBe(`${60 * 20 + 10 * 9} 1 0.1 0.15`);
});
