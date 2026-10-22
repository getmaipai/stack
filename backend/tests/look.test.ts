import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { dataDir } from "@/lib/paths";
import { LOOK_MAX_IMAGE_BYTES, LOOK_RATE_PER_MINUTE, LOOK_TRACK_TTL_S, LookService, type LookDeps, type LookWorker, type WorkerReply } from "@/look/look";
import { overlap } from "@/look/lookTracker";
import { STACK_IMAGE_TOOL_MODELS } from "@/lib/modelCatalog";

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
const COUCH = { label: "couch", score: 0.81, box: [0.1, 0.2, 0.5, 0.4] };
const goodReply = (detections = [COUCH]): WorkerReply => ({ ok: true, detections, light: "bright", colours: ["white wall"], tags: [{ label: "bright", score: 1 }, { label: "lights on", score: 1 }], ms: 12 });

let now = 1_000_000;
let released = 0;
let spawned = 0;
afterEach(() => { now = 1_000_000; released = 0; spawned = 0; });

function build(over: Partial<LookDeps> = {}, reply: () => WorkerReply = () => goodReply()) {
  const logs: string[] = [];
  const sent: Uint8Array[] = [];
  const deps: LookDeps = {
    supported: () => true,
    ensureEnvironment: async () => {},
    modelPath: () => "/verified/model.onnx",
    hold: async () => ({ release: () => { released += 1; } }),
    spawn: async (): Promise<LookWorker> => {
      spawned += 1;
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), request: async (_model, jpeg) => { sent.push(jpeg); return reply(); } };
    },
    now: () => now,
    log: (message, ...values) => { let i = 0; logs.push(message.replace(/%d/g, () => String(values[i++] ?? ""))); },
    ...over,
  };
  return { service: new LookService(deps), logs, sent };
}

test("a look sends the JPEG bytes to the worker, answers the spec LookResult shape and leaves nothing on disk", async () => {
  const { service, sent } = build();
  const before = readdirSync(dataDir, { recursive: true }).map(String).sort();
  const result = await service.look("robot-a", JPEG);
  expect(sent[0]).toEqual(JPEG);
  expect(result.expires_in_s).toBe(LOOK_TRACK_TTL_S);
  expect(result.objects[0]).toMatchObject({ label: "couch", count: 1, score: 0.81, uncertain: false });
  expect(result.scene.tags.map((tag) => tag.label)).toEqual(["couch", "bright", "lights on"]);
  expect(result.cost).toEqual({ ms: 12, tier: "fast" });
  expect(readdirSync(dataDir, { recursive: true }).map(String).sort()).toEqual(before);
  service.stop();
  expect(released).toBe(1);
});

test("the answer validates against the spec's look-result schema when the pinned spec checkout is present", async () => {
  const schemaPath = join(import.meta.dir, "..", "..", "..", "commons-tags", "spec-spec-v0.1.208", "spec", "schemas", "look-result.schema.json");
  if (!existsSync(schemaPath)) return;
  const { service } = build();
  const { expires_in_s: _unused, ...record } = await service.look("robot-a", JPEG);
  const ajv = new Ajv2020({ strict: false });
  expect(ajv.validate(await Bun.file(schemaPath).json(), record)).toBe(true);
  service.stop();
});

test("no label, colour or tag reaches a log line", async () => {
  const { service, logs } = build();
  await service.look("robot-a", JPEG);
  const text = logs.join(" ");
  expect(text).not.toContain("couch");
  expect(text).not.toContain("white wall");
  expect(text).not.toContain("lights on");
  expect(text).toContain("look: 1 objects in 12 ms");
  service.stop();
});

test("pictures that are too big, not JPEG, detailed or too frequent are refused before the worker runs", async () => {
  const { service, sent } = build();
  await expect(Promise.resolve().then(() => service.look("a", new Uint8Array(LOOK_MAX_IMAGE_BYTES + 1)))).rejects.toMatchObject({ code: "too_large", status: 413 });
  await expect(Promise.resolve().then(() => service.look("a", new Uint8Array([1, 2, 3, 4])))).rejects.toMatchObject({ code: "not_jpeg", status: 415 });
  await expect(Promise.resolve().then(() => service.look("a", JPEG, "detailed"))).rejects.toMatchObject({ code: "detail_unavailable", status: 422 });
  expect(sent).toHaveLength(0);
  for (let i = 0; i < LOOK_RATE_PER_MINUTE; i++) await service.look("a", JPEG);
  await expect(Promise.resolve().then(() => service.look("a", JPEG))).rejects.toMatchObject({ code: "too_fast", status: 429 });
  await service.look("b", JPEG); // another source has its own allowance
  now += 61_000;
  await service.look("a", JPEG); // and a minute later this one is allowed again
  service.stop();
});

test("a missing model, a refused memory hold and an unsupported computer each say what to do", async () => {
  await expect(build({ modelPath: () => null }).service.look("a", JPEG)).rejects.toMatchObject({ code: "model_missing", status: 503 });
  await expect(build({ hold: async () => "memory is full" }).service.look("a", JPEG)).rejects.toMatchObject({ code: "no_memory", status: 503 });
  await expect(build({ supported: () => false }).service.look("a", JPEG)).rejects.toMatchObject({ code: "unsupported", status: 503 });
});

test("a failing worker reply is a 500 that does not leak anything and the next look still works", async () => {
  let fail = true;
  const { service } = build({}, () => (fail ? { ok: false, code: "failed" } : goodReply()));
  await expect(service.look("a", JPEG)).rejects.toMatchObject({ code: "failed", status: 500 });
  fail = false;
  expect((await service.look("a", JPEG)).objects).toHaveLength(1);
  expect(spawned).toBe(1);
  service.stop();
});

test("one worker serves several looks and holds its memory only while it lives", async () => {
  const { service } = build();
  await Promise.all([service.look("a", JPEG), service.look("b", JPEG)]);
  expect(spawned).toBe(1);
  expect(released).toBe(0);
  expect(service.stopIfIdle()).toBe(true);
  expect(released).toBe(1);
  expect(service.stopIfIdle()).toBe(false);
});

test("tracks live 90 seconds after the object was last seen and are then forgotten", async () => {
  let frame = 0;
  const { service } = build({}, () => goodReply(frame++ === 0 ? [COUCH] : []));
  expect((await service.look("a", JPEG)).objects).toHaveLength(1);
  now += 89_000;
  const stale = await service.look("a", JPEG);
  expect(stale.objects[0]).toMatchObject({ label: "couch", stale: true });
  now += 2_000;
  expect((await service.look("a", JPEG)).objects).toHaveLength(0);
  service.stop();
});

test("a moved object matches its track by overlap and two of a label are counted", async () => {
  const frames = [[COUCH], [{ ...COUCH, box: [0.12, 0.2, 0.5, 0.4] }], [{ ...COUCH, box: [0.12, 0.2, 0.5, 0.4] }, { label: "couch", score: 0.6, box: [0.8, 0.7, 0.15, 0.2] }]];
  let i = 0;
  const { service } = build({}, () => goodReply(frames[i++]));
  expect((await service.look("a", JPEG)).objects[0]!.count).toBe(1);
  const moved = await service.look("a", JPEG);
  expect(moved.objects[0]).toMatchObject({ count: 1 });
  expect(moved.objects[0]!.stale).toBeUndefined();
  expect((await service.look("a", JPEG)).objects[0]!.count).toBe(2);
  expect(overlap([0, 0, 0.5, 0.5], [0.5, 0.5, 0.2, 0.2])).toBe(0);
  service.stop();
});

test("the YOLOX pin is the Look part and matches the spec digest", () => {
  const pin = STACK_IMAGE_TOOL_MODELS.find((candidate) => candidate.id === "image-tool-yolox-nano")!;
  expect(pin.component).toBe("tool-look");
  expect(pin.download?.hub_file).toBeUndefined();
  expect(pin.download?.sha256).toBe("c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d");
  expect(pin.download?.approx_bytes).toBe(3_659_407);
  const assets = join(import.meta.dir, "..", "..", "..", "commons-tags", "spec-spec-v0.1.208", "spec", "assets", "robot-assets.json");
  if (!existsSync(assets)) return;
  const spec = (JSON.parse(require("node:fs").readFileSync(assets, "utf8")) as { id: string; sha256: string }[]).find((row) => row.id === "yolox-nano-0_1_1rc0");
  expect(spec?.sha256).toBe(pin.download?.sha256);
});

// The real worker, only where the Stack's own image-tools environment and the pinned model are on this machine.
const REAL_PYTHON = "/usr/local/maipai-home/stack/data/engines/image-tools/1.0.0/venv/bin/python";
const REAL_MODEL = process.env.LOOK_TEST_MODEL ?? "";
test("the real worker answers over the framing with the pinned model", async () => {
  if (!existsSync(REAL_PYTHON) || !REAL_MODEL || !existsSync(REAL_MODEL)) return;
  const { workerHandle } = await import("@/look/look");
  const child = Bun.spawn([REAL_PYTHON, "-I", join(import.meta.dir, "..", "src", "look", "look_worker.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const worker = workerHandle(child);
  const jpeg = new Uint8Array(await Bun.file(join(import.meta.dir, "fixtures", "look-blue-wall.jpg")).arrayBuffer());
  const reply = await worker.request(REAL_MODEL, jpeg);
  expect(reply.ok).toBe(true);
  expect(reply.colours).toEqual(["blue wall"]);
  worker.kill();
});
