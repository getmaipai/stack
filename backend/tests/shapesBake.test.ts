// MAKER-B: the shapes_bake op. The service tests use a scripted worker; the real-worker tests need IMAGE_TOOLS_PYTHON (a Python with
// opencv, numpy and pillow, the image-tools environment) and run the op on a drawn face: an oval with eyes, a nose and a lip band that
// opens by a known number of pixels per letter frame, drifting the way engine frames drift (nose and upper lip move up) and dropping
// the jaw by half the opening.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_TOOLS_OPERATIONS, ImageToolsService, workerHandle, type ImageToolsDeps, type ShapesBakeReport, type WorkerHandle, type WorkerReply, type WorkerRequest } from "@/imagetools/imageTools";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const requests: WorkerRequest[] = [];
afterEach(() => { requests.length = 0; });

function deps(reply: (request: WorkerRequest) => WorkerReply): ImageToolsDeps {
  const dir = mkdtempSync(join(tmpdir(), "shapes-test-"));
  return {
    requirements: () => "requirements.txt", ensureEnvironment: async () => {}, ensureHelper: async () => null, modelPath: () => null, tmpDir: () => dir,
    hold: async () => ({ release: () => {} }),
    spawn: async (): Promise<WorkerHandle> => {
      let end!: (code: number) => void;
      const exited = new Promise<number>((done) => { end = done; });
      return { exited, kill: () => end(143), send: async (request) => { requests.push(request); return reply(request); } };
    },
  };
}

test("shapes_bake: the service sends the frames folder, the landmarks and the rest picture, needs no model, and returns the report without a picture", async () => {
  const report = { ok: true, reasons: [], picture: [320, 360], face_height_px: 160, region: [13, 128, 294, 215], tile: [85, 160, 149, 96], sets: {} } as ShapesBakeReport;
  const service = new ImageToolsService(deps((request) => ({ id: request.id, ok: true, report, width: 320, height: 360, engine: "dis", model: "none", ms: 4 })));
  const params = { frames_dir: "/frames", output_dir: "/out", landmarks: { rest: { outerLips: [], innerLips: [], nose: [], contour: [] } } };
  const result = await service.run({ operation: "shapes_bake", image: PNG, params });
  expect(requests[0]!.op).toBe("shapes_bake");
  expect(requests[0]!.params).toEqual(params);
  expect(result.shapes).toEqual(report);
  expect(result.png.length).toBe(0);
  service.stop();
});

test("shapes_bake: a worker refusal keeps its code and its plain message", async () => {
  const service = new ImageToolsService(deps((request) => ({ id: request.id, ok: false, code: "landmarks_required", error: "The rest picture has no usable 'contour' landmarks." })));
  const error = (await service.run({ operation: "shapes_bake", image: PNG, params: {} }).catch((caught) => caught)) as { code: string; status: number; message: string };
  expect(error.code).toBe("landmarks_required");
  expect(error.status).toBe(422);
  service.stop();
});

test("shapes_bake is not an operation the picture upload route accepts", () => {
  expect((IMAGE_TOOLS_OPERATIONS as readonly string[]).includes("shapes_bake")).toBe(false);
});

const python = process.env.IMAGE_TOOLS_PYTHON;
const script = join(import.meta.dir, "../src/imagetools/image_tools_worker.py");

// The drawn face. 320x360 picture, face height (eye line to chin) 160 px. open_px is the gap between the lips, so the opening in
// percent of the face height is open_px / 1.6. Each letter frame also drifts: the nose 2 px up and the upper lip 2 px more.
const FIXTURE = `
import numpy as np, cv2, json, os, sys
from PIL import Image
d = sys.argv[1]; W, H = 320, 360
rng = np.random.default_rng(3)
tex = cv2.GaussianBlur(rng.random((H, W)).astype(np.float32), (0, 0), 2.0); tex = (tex - tex.min()) / (tex.max() - tex.min())
CX, TOP, CHIN, U0 = 160, 120, 280, 225
def face(open_px, dn=0, dup=0, wide=60, jaw=0):
    img = np.zeros((H, W, 3), np.uint8); img[:] = (0, 255, 0)
    skin = np.zeros((H, W), np.uint8); cv2.ellipse(skin, (CX, 190 + dn + jaw // 2), (80, 90 + jaw // 2), 0, 0, 360, 255, -1)
    cv2.rectangle(skin, (CX - 45, 250 + dn), (CX + 45, 340 + dn), 255, -1)  # a neck, so the silhouette goes on under the chin
    t = np.roll(tex, dn, axis=0)
    base = np.stack([185 + 60 * t, 135 + 60 * t, 105 + 60 * t], -1).astype(np.uint8)
    img[skin > 0] = base[skin > 0]
    cv2.ellipse(img, (CX, 190 + dn + jaw // 2), (80, 90 + jaw // 2), 0, 20, 160, (90, 60, 50), 2)  # the jaw line
    for ex in (130, 190): cv2.circle(img, (ex, 135 + dn), 6, (30, 30, 40), -1)
    cv2.line(img, (CX, 150 + dn), (CX, 200 + dn), (120, 80, 60), 3); cv2.ellipse(img, (CX, 205 + dn), (12, 4), 0, 0, 360, (110, 70, 55), -1)
    top = U0 + dn + dup
    cv2.rectangle(img, (CX - wide, top), (CX + wide - 1, top + 7), (170, 60, 70), -1)
    cv2.rectangle(img, (CX - wide, top + 8), (CX + wide - 1, top + 7 + open_px), (40, 15, 20), -1)
    lower = top + 8 + open_px
    cv2.rectangle(img, (CX - wide, lower), (CX + wide - 1, lower + 7), (170, 60, 70), -1)
    bot = lower + 8
    it, ib = top + 8, top + 8 + open_px
    lm = {"outerLips": [[CX - wide, top], [CX - wide / 2, top], [CX + wide / 2, top], [CX + wide, top], [CX + wide, bot], [CX + wide / 2, bot], [CX - wide / 2, bot], [CX - wide, bot]],
          "innerLips": [[CX - wide + 6, it], [CX, it], [CX + wide - 6, it], [CX + wide - 6, ib], [CX, ib], [CX - wide + 6, ib]],
          "nose": [[CX - 12, 205 + dn], [CX, 208 + dn], [CX + 12, 205 + dn]]}
    return img, skin, lm
rest, skin, rest_lm = face(0)
rest_lm["contour"] = [[CX - 80, TOP], [CX - 78, 170], [CX - 60, 240], [CX, CHIN], [CX + 60, 240], [CX + 78, 170], [CX + 80, TOP]]
Image.fromarray(np.dstack([rest, skin]), "RGBA").save(d + "/rest.png")
spec = json.loads(sys.argv[2]); lms = {"rest": rest_lm}
for name, letters in spec.items():
    os.makedirs(d + "/frames/" + name, exist_ok=True); lms[name] = {}
    for letter, open_px in letters.items():
        img, _, lm = face(open_px, dn=-2, dup=-2, jaw=open_px // 2)  # the jaw drops with the mouth
        Image.fromarray(img, "RGB").save(d + "/frames/" + name + "/" + letter + ".png"); lms[name][letter] = lm
json.dump(lms, open(d + "/lm.json", "w"))
`;

const CALM = { B: 4, C: 6, D: 10, E: 6, F: 2, G: 4, H: 6 };
const SHOUT = { B: 2, C: 12, D: 20, E: 4, F: 2, H: 28 }; // G is not made: it repeats B

function makeFixture(sets: Record<string, Record<string, number>>): string {
  const dir = mkdtempSync(join(tmpdir(), "shapes-real-"));
  const made = Bun.spawnSync([python!, "-I", "-c", FIXTURE, dir, JSON.stringify(sets)]);
  expect(String(made.stderr)).toBe("");
  expect(made.exitCode).toBe(0);
  return dir;
}

async function bake(dir: string, extra: Record<string, unknown> = {}, mutate?: (landmarks: Record<string, unknown>) => void) {
  const landmarks = JSON.parse(readFileSync(join(dir, "lm.json"), "utf8")) as Record<string, unknown>;
  mutate?.(landmarks);
  const child = Bun.spawn([python!, "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const worker = workerHandle(child as never);
  const reply = await worker.send({ id: "1", op: "shapes_bake", input: join(dir, "rest.png"), output: join(dir, "none.png"), params: { frames_dir: join(dir, "frames"), output_dir: join(dir, "out"), landmarks, ...extra }, models: {}, helper: null }, 240_000);
  worker.kill();
  return reply;
}

const DEMO_META_KEYS = ["tx", "ty", "tw", "th", "cols", "base", "ts", "nt", "region", "flowHalf", "flowScale", "letters"].sort();
const pngSize = (path: string) => { const b = readFileSync(path); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

test.skipIf(!python)("shapes_bake on a drawn face: openings, registration, atlas layout, meta keys, flow length and a static chin", async () => {
  const dir = makeFixture({ calm: CALM, shout: SHOUT });
  try {
    const reply = await bake(dir);
    expect(reply.ok).toBe(true);
    const report = reply.report as ShapesBakeReport;
    expect(report.face_height_px).toBe(160);
    expect(report.ok).toBe(true);
    expect(report.reasons).toEqual([]);
    for (const [set, letters] of Object.entries({ calm: CALM, shout: SHOUT }) as ["calm" | "shout", Record<string, number>][]) {
      const entry = report.sets[set]!;
      expect(entry.ok).toBe(true);
      // openings measured equal the injected ones within 0.5 percent of the face height
      for (const [letter, px] of Object.entries(letters)) {
        if (set === "shout" && letter === "G") continue;
        expect(Math.abs(entry.letters[letter]!.opening_pct - (px / 160) * 100)).toBeLessThan(0.5);
        // the upper lip is held where the rest picture has it (within 1 percent of the face height), although the frame drifted
        expect(entry.letters[letter]!.upper_lip_error_pct).toBeLessThan(1);
        expect(entry.letters[letter]!.raw.nose_drift_px).toBeCloseTo(-2, 1);
        expect(entry.letters[letter]!.raw.upper_lip_drift_px).toBeCloseTo(-4, 1);
      }
      expect(entry.made).toEqual(set === "shout" ? ["B", "C", "D", "E", "F", "H"] : ["B", "C", "D", "E", "F", "G", "H"]);
      expect(entry.chin_peak_px_480).toBeLessThan(1.5);
      expect(entry.neck_peak_px_480).toBeLessThan(1.5);
      // the drawn jaw really drops in the frames: without the hold the chin would move well past the limit (the report says what the hold saved)
      expect(entry.without_chin_hold.chin_peak_px_480).toBeGreaterThan(3);
      expect(entry.min_jacobian).toBeGreaterThan(0.05);
      // the files: atlas size from the meta, the demo's meta keys, flow length from the half-size region
      const folder = join(dir, "out", set);
      const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")) as ShapesBakeSet["meta"];
      expect(Object.keys(meta).sort()).toEqual(DEMO_META_KEYS);
      expect(meta.letters).toBe("ABCDEFGH");
      expect(meta.base).toBe(8);
      expect(meta.ts).toEqual([0.2, 0.4, 0.6, 0.8]);
      expect(meta.flowScale).toBe(64);
      const slots = meta.base + 64 * meta.nt;
      expect(pngSize(join(folder, "atlas.png"))).toEqual({ width: meta.cols * meta.tw, height: Math.ceil(slots / meta.cols) * meta.th });
      expect(readFileSync(join(folder, "flow.bin")).length).toBe(8 * meta.flowHalf[0]! * meta.flowHalf[1]! * 2 * 2);
      expect(meta.flowHalf).toEqual([Math.floor(meta.region[2]! / 2), Math.floor(meta.region[3]! / 2)]);
      for (const name of ["weight.png", "samples.png", "rest.png", "meta.json"]) expect(existsSync(join(folder, name))).toBe(true);
      const size = pngSize(join(folder, "weight.png"));
      expect(size).toEqual({ width: meta.region[2]!, height: meta.region[3]! });
    }
    expect(JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8")).ok).toBe(true);
    // G repeats B when the set did not make it
    expect(report.sets.shout!.letters.G!.opening_pct).toBeCloseTo(report.sets.shout!.letters.B!.opening_pct, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);

const READ_ATLAS = `
import numpy as np, cv2, json, sys
d = sys.argv[1]; name = sys.argv[2]
meta = json.load(open(d + "/out/" + name + "/meta.json")); atlas = cv2.imread(d + "/out/" + name + "/atlas.png", cv2.IMREAD_UNCHANGED)
tw, th, cols, tx, ty = meta["tw"], meta["th"], meta["cols"], meta["tx"], meta["ty"]
col = 160 - tx; out = []
for slot in range(8):
    r, c = divmod(slot, cols); tile = atlas[r * th:(r + 1) * th, c * tw:(c + 1) * tw, :3].astype(int)[:, col - 3:col + 4].mean(axis=1)  # BGR, mean of 7 columns
    red = (tile[:, 2] - tile[:, 1]) > 60; dark = (tile.max(axis=1) < 80) & (np.arange(th) + ty < 265)  # the mouth rows only, not the jaw line below
    top = int(np.argmax(red)) + ty if red.any() else -1
    out.append({"top": top, "dark_rows": int(dark.sum())})
print(json.dumps(out))
`;

test.skipIf(!python)("shapes_bake: the baked atlas tiles hold the upper lip on the rest picture's row and show the injected opening", async () => {
  const dir = makeFixture({ calm: CALM });
  try {
    const reply = await bake(dir);
    expect(reply.ok).toBe(true);
    const read = Bun.spawnSync([python!, "-I", "-c", READ_ATLAS, dir, "calm"]);
    expect(String(read.stderr)).toBe("");
    const tiles = JSON.parse(String(read.stdout)) as { top: number; dark_rows: number }[];
    const letters = ["A", "B", "C", "D", "E", "F", "G", "H"];
    expect(tiles[0]!.top).toBe(225); // the rest picture's own upper lip row
    for (let i = 1; i < 8; i++) {
      // measured from the pixels, independent of the landmarks: registered upper lip within 1 percent of the face height (1.6 px), opening within 1 px
      expect(Math.abs(tiles[i]!.top - tiles[0]!.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(tiles[i]!.dark_rows - (CALM as Record<string, number>)[letters[i]!]!)).toBeLessThanOrEqual(1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(!python)("shapes_bake: a set outside the design's opening range fails with a plain reason and the chin hold can be seen in the report", async () => {
  const dir = makeFixture({ calm: { ...CALM, D: 24 } });
  try {
    const reply = await bake(dir);
    expect(reply.ok).toBe(true);
    const report = reply.report as ShapesBakeReport;
    expect(report.ok).toBe(false);
    expect(report.reasons.join(" ")).toContain("widest mouth opening");
    expect(report.reasons.join(" ")).toContain("percent of the face height");
    expect(report.sets.calm!.chin_hold).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(!python)("shapes_bake refuses with a plain message when a letter frame, a set folder, the frames folder or the landmarks are missing", async () => {
  const dir = makeFixture({ calm: CALM });
  try {
    rmSync(join(dir, "frames", "calm", "D.png"));
    const missing = await bake(dir);
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("frames_required");
    expect(missing.error).toContain("letter D");
    expect(missing.error).toContain("try again");
    const noSet = await bake(dir, { sets: ["shout"] });
    expect(noSet.code).toBe("frames_required");
    expect(noSet.error).toContain("'shout' subfolder");
    const noFolder = await bake(dir, { frames_dir: join(dir, "nowhere") });
    expect(noFolder.code).toBe("frames_required");
    expect(noFolder.error).toContain("frames_dir");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const again = makeFixture({ calm: CALM });
  try {
    const noLandmark = await bake(again, {}, (landmarks) => { delete (landmarks.calm as Record<string, unknown>).C; });
    expect(noLandmark.ok).toBe(false);
    expect(noLandmark.code).toBe("landmarks_required");
    expect(noLandmark.error).toContain("calm frame C");
    const noRest = await bake(again, {}, (landmarks) => { delete landmarks.rest; });
    expect(noRest.code).toBe("landmarks_required");
    expect(noRest.error).toContain("rest picture");
  } finally { rmSync(again, { recursive: true, force: true }); }
}, 240_000);

type ShapesBakeSet = NonNullable<ShapesBakeReport["sets"]["calm"]>;
