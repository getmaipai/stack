import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { IMAGE_TOOLS_OPERATIONS, ImageToolsService, workerHandle, type ImageToolsDeps, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/imagetools/imageTools";

// MAKER-C: emotion_bake and pack_assemble. The scripted-worker tests run anywhere; the real-worker tests need IMAGE_TOOLS_PYTHON (OpenCV, NumPy, Pillow).
const python = process.env.IMAGE_TOOLS_PYTHON;
const script = join(import.meta.dir, "../src/imagetools/image_tools_worker.py");
const fixture = join(import.meta.dir, "helpers/emotion_fixture.py");

function scripted(reply: WorkerReply) {
  const requests: WorkerRequest[] = [];
  const dir = mkdtempSync(join(tmpdir(), "emotion-svc-"));
  const deps: ImageToolsDeps = {
    requirements: () => "requirements.txt", ensureEnvironment: async () => {}, ensureHelper: async () => null, modelPath: () => null, tmpDir: () => dir,
    hold: async () => ({ release: () => {} }),
    spawn: async (): Promise<WorkerHandle> => { let end!: (code: number) => void; const exited = new Promise<number>((done) => { end = done; }); return { exited, kill: () => end(143), send: async (request) => { requests.push(request); return { ...reply, id: request.id }; } }; },
  };
  return { service: new ImageToolsService(deps), requests };
}

test("emotion_bake and pack_assemble go through the service as internal operations and return their report without a picture", async () => {
  const { service, requests } = scripted({ id: "", ok: true, data: { ok_all: true }, width: 256, height: 256, engine: "opencv", model: "none", ms: 3 });
  for (const operation of ["emotion_bake", "pack_assemble"] as const) {
    const result = await service.run({ operation, image: new Uint8Array([1]), params: { out_dir: "/x" } });
    expect(result.data).toEqual({ ok_all: true });
    expect(result.png.length).toBe(0);
  }
  expect(requests.map((r) => r.op)).toEqual(["emotion_bake", "pack_assemble"]);
  expect((IMAGE_TOOLS_OPERATIONS as readonly string[]).includes("emotion_bake")).toBe(false);
  expect((IMAGE_TOOLS_OPERATIONS as readonly string[]).includes("pack_assemble")).toBe(false);
  service.stop();
});

function worker() {
  const child = Bun.spawn([python!, "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return workerHandle(child as never);
}
function fixtures(kind: "face" | "staging", big = false): string {
  const dir = mkdtempSync(join(tmpdir(), `emotion-${kind}-`));
  const run = Bun.spawnSync([python!, "-I", fixture, kind, dir, ...(big ? ["big"] : [])]);
  expect(String(run.stderr)).toBe("");
  expect(run.exitCode).toBe(0);
  return dir;
}
const bakeParams = (dir: string, out: string, over: Record<string, unknown> = {}) => ({
  landmarks: JSON.parse(readFileSync(join(dir, "landmarks.json"), "utf8")),
  poses: Object.fromEntries(["angry", "excited", "alarmed", "sad"].map((k) => [k, [join(dir, `${k}.png`)]])),
  out_dir: out, ...over,
});
const request = (id: string, op: string, input: string, params: Record<string, unknown>): WorkerRequest => ({ id, op: op as never, input, output: "/dev/null", params, models: {}, helper: null });

test.skipIf(!python)("emotion_bake on a drawn face: brows travel the right way, monotone, symmetric, flow and residual files written", async () => {
  const dir = fixtures("face");
  const out = join(dir, "emotion");
  const w = worker();
  const reply = await w.send(request("1", "emotion_bake", join(dir, "rest.png"), bakeParams(dir, out)), 120_000);
  expect(reply.ok).toBe(true);
  const data = reply.data as { ok_all: boolean; region: number[]; kinds: Record<string, any> };
  const [, , rw, rh] = data.region as [number, number, number, number];
  for (const kind of ["angry", "excited", "alarmed", "sad"]) {
    const k = data.kinds[kind];
    expect(k.ok, JSON.stringify(k.reasons)).toBe(true);
    expect(k.monotone).toBe(true);
    expect(k.maxStepPx).toBeLessThan(3);
    expect(k.symmetryPx).toBeLessThan(1.5);
    expect(Math.abs(k.browTravelPx.w1)).toBeGreaterThan(2);
    expect(k.browTravelPx["w0.5"]).toBeCloseTo(k.browTravelPx.w1 / 2, 0);
    expect(statSync(join(out, `${kind}.flow.bin`)).size).toBe(rw * rh * 4);
    expect(existsSync(join(out, `${kind}.png`))).toBe(true);
  }
  expect(data.kinds.angry.browTravelPx.w1).toBeGreaterThan(0); // content moves down
  expect(data.kinds.excited.browTravelPx.w1).toBeLessThan(0); // content moves up
  expect(data.kinds.angry.eyeOpenChangePx[0]).toBeLessThan(0); // the eyes narrow
  expect(data.kinds.alarmed.eyeOpenChangePx[0]).toBeGreaterThan(0); // the eyes widen
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
  expect(meta.flowScale).toBe(64);
  expect(Object.keys(meta.kinds)).toEqual(["angry", "excited", "alarmed", "sad"]);
  expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8")).ok_all).toBe(true);
  w.kill();
});

test.skipIf(!python)("emotion_bake refuses with plain words: a missing pose, a wrong-sized pose, missing landmarks", async () => {
  const dir = fixtures("face");
  const w = worker();
  const noPose = bakeParams(dir, join(dir, "o1")); delete (noPose.poses as Record<string, unknown>).sad;
  const a = await w.send(request("1", "emotion_bake", join(dir, "rest.png"), noPose), 60_000);
  expect(a.code).toBe("pose_missing");
  expect(a.error).toContain("sad");
  const small = bakeParams(dir, join(dir, "o2"));
  Bun.spawnSync([python!, "-I", "-c", `from PIL import Image\nImage.new("RGBA",(100,100)).save("${dir}/small.png")`]);
  (small.poses as Record<string, string[]>).angry = [join(dir, "small.png")];
  const b = await w.send(request("2", "emotion_bake", join(dir, "rest.png"), small), 60_000);
  expect(b.code).toBe("size_mismatch");
  expect(b.error).toContain("256x256");
  const c = await w.send(request("3", "emotion_bake", join(dir, "rest.png"), bakeParams(dir, join(dir, "o3"), { landmarks: {} })), 60_000);
  expect(c.code).toBe("landmarks_required");
  w.kill();
});

test.skipIf(!python)("emotion_bake is mirror symmetric: the left and right flows are mirror images", async () => {
  const dir = fixtures("face");
  const out = join(dir, "emotion");
  const w = worker();
  const reply = await w.send(request("1", "emotion_bake", join(dir, "rest.png"), bakeParams(dir, out)), 120_000);
  const [, , rw, rh] = (reply.data as { region: number[] }).region as [number, number, number, number];
  const raw = new Int16Array(readFileSync(join(out, "angry.flow.bin")).buffer.slice(0));
  // the face is symmetric about x=128; the region centre is at its mid, so column c and (rw-1-c) mirror up to a fraction of a pixel
  let total = 0, count = 0;
  for (let y = 0; y < rh; y += 7) for (let c = 8; c < rw / 2; c += 5) {
    const l = raw.slice((y * rw + c) * 2, (y * rw + c) * 2 + 2), r = raw.slice((y * rw + (rw - 1 - c)) * 2, (y * rw + (rw - 1 - c)) * 2 + 2);
    total += Math.abs(l[1]! - r[1]!) / 64; count += 1;
  }
  expect(total / count).toBeLessThan(0.3); // mean difference; the midline sits between pixels so single samples can differ by a pixel's slope
  w.kill();
});

/** The validator from the commons spec checkout (tag spec-v0.1.360 or later), found from MAIPAI_SPEC_DIR or by walking up to commons-tags. */
function specValidator(): string | null {
  const has = (d: string) => existsSync(join(d, "companion", "ts", "validateCompanionPack.ts"));
  if (process.env.MAIPAI_SPEC_DIR && has(process.env.MAIPAI_SPEC_DIR)) return join(process.env.MAIPAI_SPEC_DIR, "companion", "ts", "validateCompanionPack.ts");
  for (let d = import.meta.dir; dirname(d) !== d; d = dirname(d)) {
    const found = ["spec-spec-v0.1.360", "spec-spec-v0.1.361", "spec-spec-v0.1.362"].map((t) => join(d, "commons-tags", t, "spec")).find(has);
    if (found) return join(found, "companion", "ts", "validateCompanionPack.ts");
  }
  return null;
}
const walk = (dir: string, base = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))]);
const descriptor = { id: "tiny", name: "Tiny", tile: { desktop: 480, phone: 320 }, provenance: { source: "generated" }, mouth: { anchor: { x: 0.4, y: 0.55, w: 0.15, h: 0.14 } }, life: { nod: 1.2 } };

test.skipIf(!python)("pack_assemble on a tiny staging folder writes a pack the spec's validateCompanionPack accepts, with WebP alpha exact and flows deflated", async () => {
  const dir = fixtures("staging");
  const out = join(dir, "pack");
  for (const name of ["idle1", "idle2", "listen", "think"]) Bun.spawnSync(["cp", join(dir, "clips", `${name}.mp4`), join(dir, "clips", `${name}.phone.mp4`)]);
  const w = worker();
  const reply = await w.send(request("1", "pack_assemble", join(dir, "rest.png"), { staging: dir, out_dir: out, descriptor }), 120_000);
  expect(reply.ok, reply.error).toBe(true);
  const pack = JSON.parse(readFileSync(join(out, "pack.json"), "utf8"));
  expect(pack.emotion.kinds).toEqual(["angry", "excited", "alarmed", "sad"]);
  expect(pack.mouth.shout.dir).toBe("mouth/shout");
  expect(pack.states.speak[0].trackFile).toBe("clips/speak.track.json");
  expect(pack.states.idle[0].frames).toBe(6);
  expect(pack.states.speak[0].file).toBe("clips/idle1.mp4"); // the speak clip repeats idle1's bytes: stored once
  expect(pack.states.idle[1].file).toBe("clips/idle2.mp4");
  const files = Object.fromEntries(walk(out).filter((f) => f !== "build-report.json").map((f) => [f, statSync(join(out, f)).size]));
  expect(Object.keys(files)).toContain("emotion/angry.flow.bin.z");
  expect(Object.keys(files).some((f) => f.endsWith(".flow.bin"))).toBe(false);
  expect(Object.keys(files).some((f) => f.endsWith(".png"))).toBe(false);
  const validator = specValidator();
  if (validator) {
    const { validateCompanionPack } = await import(validator);
    expect(validateCompanionPack(pack, files)).toEqual([]);
  }
  // alpha exact on a lossy picture, and the clip that repeats idle1's bytes is stored once
  const check = Bun.spawnSync([python!, "-I", "-c", `
import numpy as np
from PIL import Image
a = np.asarray(Image.open("${dir}/mouth/calm/atlas.png").convert("RGBA"))[..., 3]
b = np.asarray(Image.open("${out}/mouth/calm/atlas.webp").convert("RGBA"))[..., 3]
print(int(np.abs(a.astype(int) - b.astype(int)).max()))`]);
  expect(String(check.stdout).trim()).toBe("0");
  w.kill();
});

test.skipIf(!python)("pack_assemble refuses an over-budget pack by naming the largest files, and a clip whose track disagrees with its frames", async () => {
  const big = fixtures("staging", true);
  for (const name of ["idle1", "idle2", "listen", "think"]) Bun.spawnSync(["cp", join(big, "clips", `${name}.mp4`), join(big, "clips", `${name}.phone.mp4`)]);
  const w = worker();
  const over = await w.send(request("1", "pack_assemble", join(big, "rest.png"), { staging: big, out_dir: join(big, "pack"), descriptor }), 120_000);
  expect(over.code).toBe("over_budget");
  expect(over.error).toContain("head/flow.bin.z");
  expect(over.error).toContain("12582912");
  expect(over.error).toContain("nothing was cut silently");
  expect(existsSync(join(big, "pack"))).toBe(false);
  const dir = fixtures("staging");
  Bun.spawnSync([python!, "-I", "-c", `import json\np="${dir}/clips/think.track.json"\nd=json.load(open(p))\nd["res"]=d["res"][:4]\njson.dump(d,open(p,"w"))`]);
  const bad = await w.send(request("2", "pack_assemble", join(dir, "rest.png"), { staging: dir, out_dir: join(dir, "pack"), descriptor: { ...descriptor, tile: { desktop: 480 } } }), 120_000);
  expect(bad.code).toBe("clip_mismatch");
  expect(bad.error).toContain("think");
  const none = await w.send(request("3", "pack_assemble", join(dir, "rest.png"), { staging: join(dir, "nowhere"), out_dir: join(dir, "p2"), descriptor }), 30_000);
  expect(none.code).toBe("frames_required");
  w.kill();
});
