// MAKER-F: the stylised (cartoon) path of shapes_bake. Real-worker tests need IMAGE_TOOLS_PYTHON (opencv, numpy, pillow) and run the op on a drawn
// cartoon: a 320x360 flat-colour face whose mouth is a dark ellipse that gets taller per letter. The chin sits below the mouth box.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerHandle, type ShapesBakeReport } from "@/imagetools/imageTools";

const python = process.env.IMAGE_TOOLS_PYTHON;
const script = join(import.meta.dir, "../src/imagetools/image_tools_worker.py");

// Face 320x360: oval centre (160, 190), 90 x 120, so the chin is at y = 310. Mouth ellipse centre (160, 240), 30 px half width, height per letter.
// The mouth box is [60, 185, 200, 110] (y 185 to 295): the chin (y 310) is outside it.
const FIXTURE = `
import numpy as np, cv2, json, os, sys
from PIL import Image
d = sys.argv[1]; spec = json.loads(sys.argv[2]); W, H = 320, 360
def face(open_px):
    img = np.zeros((H, W, 3), np.uint8); img[:] = (60, 60, 60)
    skin = np.zeros((H, W), np.uint8); cv2.ellipse(skin, (160, 190), (90, 120), 0, 0, 360, 255, -1)
    img[skin > 0] = (110, 150, 210)
    for ex in (125, 195): cv2.circle(img, (ex, 150), 7, (30, 30, 40), -1)
    cv2.ellipse(img, (160, 215), (10, 5), 0, 0, 360, (90, 120, 180), -1)  # a nose
    cv2.ellipse(img, (160, 240), (30, max(1, open_px // 2)), 0, 0, 360, (20, 15, 40), -1)
    return img, skin
rest, skin = face(2)
Image.fromarray(np.dstack([rest[..., ::-1], skin]), "RGBA").save(d + "/rest.png")
for name, letters in spec.items():
    os.makedirs(d + "/frames/" + name, exist_ok=True)
    for letter, open_px in letters.items():
        Image.fromarray(face(open_px)[0][..., ::-1], "RGB").save(d + "/frames/" + name + "/" + letter + ".png")
`;
const CALM = { B: 6, C: 10, D: 18, E: 12, F: 4, G: 6, H: 10 };
const SHOUT = { B: 6, C: 24, D: 40, E: 12, F: 4, H: 56 }; // G is not made: it repeats B
const BOX = [60, 185, 200, 110];
const FACE_H = 160;

function makeFixture(sets: Record<string, Record<string, number>>): string {
  const dir = mkdtempSync(join(tmpdir(), "stylised-real-"));
  const made = Bun.spawnSync([python!, "-I", "-c", FIXTURE, dir, JSON.stringify(sets)]);
  expect(String(made.stderr)).toBe("");
  expect(made.exitCode).toBe(0);
  return dir;
}

async function bake(dir: string, extra: Record<string, unknown> = {}) {
  const child = Bun.spawn([python!, "-I", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const worker = workerHandle(child as never);
  const reply = await worker.send({ id: "1", op: "shapes_bake", input: join(dir, "rest.png"), output: join(dir, "none.png"), params: { path: "stylised", frames_dir: join(dir, "frames"), output_dir: join(dir, "out"), mouth_box: BOX, face_height_px: FACE_H, ...extra }, models: {}, helper: null }, 240_000);
  worker.kill();
  return reply;
}

const CARTOON_META_KEYS = ["base", "box", "cols", "letters", "th", "ts", "tw"];
const pngSize = (path: string) => { const b = readFileSync(path); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

// Reads the atlas back: per slot the count of dark pixels (the mouth hole), the bottom rows' difference to the rest tile, and the alpha border.
const READ = `
import numpy as np, cv2, json, sys
d, name = sys.argv[1], sys.argv[2]
meta = json.load(open(d + "/out/" + name + "/meta.json")); atlas = cv2.imread(d + "/out/" + name + "/atlas.png"); alpha = cv2.imread(d + "/out/" + name + "/alpha.png", 0)
tw, th, cols = meta["tw"], meta["th"], meta["cols"]
def tile(slot): r, c = divmod(slot, cols); return atlas[r * th:(r + 1) * th, c * tw:(c + 1) * tw].astype(int)
dark = lambda t: int((t.max(axis=2) < 60)[th // 4: 3 * th // 4, tw // 4: 3 * tw // 4].sum())
rest = tile(0)
slots = 8 + 64 * 4
out = {"dark": [dark(tile(s)) for s in range(slots)], "bottom": max(int((np.abs(tile(s)[-20:] - rest[-20:]).max(axis=2) * (alpha[-20:] > 2)).max()) for s in range(slots) if (s < 8 or ((s - 8) // 4) % 9 != 0)),
       "alpha_border": int(max(alpha[:3].max(), alpha[-3:].max(), alpha[:, :3].max(), alpha[:, -3:].max())), "alpha_bottom": int(alpha[-6:].max()), "alpha_mid": int(alpha[th // 2, tw // 2]), "alpha_shape": list(alpha.shape),
       "steps": [float(np.abs(tile(8 + (0 * 8 + 3) * 4 + k) - (tile(0) if k == 0 else tile(8 + (0 * 8 + 3) * 4 + k - 1))).mean()) for k in range(4)] + [float(np.abs(tile(3) - tile(8 + 3 * 4 + 3)).mean())]}
print(json.dumps(out))
`;

test.skipIf(!python)("stylised shapes_bake on a drawn cartoon: openings, atlas size, cartoon meta keys, no flow file, seamless alpha, smooth in-betweens, chin untouched", async () => {
  const dir = makeFixture({ calm: CALM, shout: SHOUT });
  try {
    const reply = await bake(dir);
    expect(reply.ok).toBe(true);
    const report = reply.report as unknown as { ok: boolean; reasons: string[]; path: string; mouth_box: number[]; sets: Record<string, any> };
    expect(report.path).toBe("stylised");
    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.mouth_box).toEqual(BOX);
    for (const [set, letters] of Object.entries({ calm: CALM, shout: SHOUT })) {
      const entry = report.sets[set]!;
      expect(entry.ok).toBe(true);
      for (const [letter, px] of Object.entries(letters)) {
        if (set === "shout" && letter === "G") continue;
        expect(Math.abs(entry.letters[letter].opening_px - px)).toBeLessThanOrEqual(2); // measured from the cavity darkness, within 2 px
        expect(Math.abs(entry.letters[letter].opening_pct - (px / FACE_H) * 100)).toBeLessThan(1.3);
      }
      expect(entry.letters.G.opening_px).toBe(set === "shout" ? entry.letters.B.opening_px : entry.letters.G.opening_px);
      expect(entry.made).toEqual(set === "shout" ? ["B", "C", "D", "E", "F", "H"] : ["B", "C", "D", "E", "F", "G", "H"]);
      const folder = join(dir, "out", set);
      const meta = JSON.parse(readFileSync(join(folder, "meta.json"), "utf8"));
      expect(Object.keys(meta).sort()).toEqual(CARTOON_META_KEYS);
      expect(meta).toEqual({ tw: BOX[2], th: BOX[3], cols: 10, box: BOX, letters: "ABCDEFGH", ts: [0.2, 0.4, 0.6, 0.8], base: 8 });
      const slots = meta.base + 64 * 4;
      expect(pngSize(join(folder, "atlas.png"))).toEqual({ width: meta.cols * meta.tw, height: Math.ceil(slots / meta.cols) * meta.th });
      expect(Math.ceil(slots / meta.cols)).toBe(27);
      expect(existsSync(join(folder, "flow.bin"))).toBe(false);
      for (const name of ["atlas.png", "alpha.png", "rest.png", "meta.json"]) expect(existsSync(join(folder, name))).toBe(true);
      expect(pngSize(join(folder, "alpha.png"))).toEqual({ width: meta.tw, height: meta.th });
      expect(entry.edge_alpha_max).toBeLessThan(0.01);
      const read = Bun.spawnSync([python!, "-I", "-c", READ, dir, set]);
      expect(String(read.stderr)).toBe("");
      const tiles = JSON.parse(String(read.stdout)) as { dark: number[]; bottom: number; alpha_border: number; alpha_bottom: number; alpha_mid: number; steps: number[] };
      expect(tiles.alpha_border).toBeLessThanOrEqual(2); // the tile's border is transparent: no seam
      expect(tiles.alpha_bottom).toBeLessThanOrEqual(2);
      expect(tiles.alpha_mid).toBeGreaterThan(250);
      expect(tiles.bottom).toBeLessThanOrEqual(8); // where the tile shows at all near its chin end it is the rest picture's in every tile (the jaw is not displaced)
      // the in-betweens from A to D move monotonically: the dark hole grows step by step, no step larger than a quarter of the whole change
      const path = [...tiles.dark.slice(8 + 3 * 4, 8 + 3 * 4 + 4), tiles.dark[3]!]; // the four in-betweens of A to D, then D (the closed rest line's own thin dissolve is not counted)
      for (let k = 1; k < path.length; k++) expect(path[k]!).toBeGreaterThanOrEqual(path[k - 1]! - 10);
      expect(path[4]!).toBeGreaterThan(path[0]! * 3);
      expect(Math.max(...tiles.steps)).toBeLessThan(10);
      expect(entry.max_inbetween_step).toBeLessThan(15);
    }
    expect(JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf8")).ok).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(!python)("stylised shapes_bake: an opening outside the range fails with a plain reason, in the file and the reply", async () => {
  const dir = makeFixture({ calm: { ...CALM, D: 40 } });
  try {
    const reply = await bake(dir);
    expect(reply.ok).toBe(true);
    const report = reply.report as unknown as ShapesBakeReport;
    expect(report.ok).toBe(false);
    expect(report.reasons.join(" ")).toContain("widest mouth opening");
    expect(report.reasons.join(" ")).toContain("2 to 16");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);

test.skipIf(!python)("stylised shapes_bake refuses in plain words: a missing letter picture, a box outside the picture, no box, a wrong path", async () => {
  const dir = makeFixture({ calm: CALM });
  try {
    const noBox = await bake(dir, { mouth_box: undefined });
    expect(noBox.ok).toBe(false);
    expect(noBox.code).toBe("bad_params");
    expect(noBox.error).toContain("mouth_box");
    const outside = await bake(dir, { mouth_box: [200, 300, 200, 100] });
    expect(outside.code).toBe("bad_params");
    expect(outside.error).toContain("not inside the 320x360 picture");
    const wrong = await bake(dir, { path: "cartoon" });
    expect(wrong.code).toBe("bad_params");
    expect(wrong.error).toContain("stylised");
    rmSync(join(dir, "frames", "calm", "D.png"));
    const missing = await bake(dir);
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("frames_required");
    expect(missing.error).toContain("letter D");
    expect(missing.error).toContain("try again");
    const noSet = await bake(dir, { sets: ["shout"] });
    expect(noSet.code).toBe("frames_required");
    expect(noSet.error).toContain("'shout' subfolder");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);
