"""Synthetic test, no model and no real people: a warm face under a blue cowl on a dark background, and a bright donor face of the same shape.
Run: <venv python> -m unittest test_composite_swap -v"""
import os, subprocess, sys, tempfile, unittest
import cv2, numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "src", "video"))
import composite_swap_worker as cs

W, H, N = 320, 480, 24


def scene(donor, k):
    w, h = (96, 144) if donor else (W, H); s = w / W
    img = np.zeros((h, w, 3), np.uint8); img[:] = (10, 17, 24)
    cx, cy = int((150 + k) * s), int(300 * s)
    if donor:
        cv2.ellipse(img, (cx, cy), (int(70 * s), int(95 * s)), 0, 0, 360, (210, 165, 150), -1)   # bright donor face
        cv2.line(img, (cx - int(30 * s), cy + int(30 * s)), (cx + int(30 * s), cy + int(30 * s)), (110, 50, 50), max(1, int(8 * s)))   # the donor's mouth line
        cv2.circle(img, (cx, cy + int(5 * s)), max(2, int(10 * s)), (150, 105, 95), -1)             # a nose
    else:
        cv2.ellipse(img, (cx, cy), (70, 95), 0, 0, 360, (70, 55, 62), -1)                          # warm, dark original face
        cv2.rectangle(img, (cx - 90, cy - 150), (cx + 90, cy - 20), (14, 22, 30), -1)              # blue-tinted cowl over the top of the face
    return img


def make(path, donor):
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{96 if donor else W}x{144 if donor else H}", "-r", "24", "-i", "-",
                          "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    for k in range(N):
        p.stdin.write(scene(donor, k).tobytes())
    p.stdin.close(); p.wait()


class CompositeSwapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(); cls.src = os.path.join(cls.dir, "src.mp4"); cls.don = os.path.join(cls.dir, "don.mp4"); cls.out = os.path.join(cls.dir, "out.mp4")
        make(cls.src, False); make(cls.don, True)
        cls.frames, cls.report = cs.composite_swap(cls.src, cls.don, cls.out, start=0, seconds=1.0)
        cls.org = cs.read_frames(cls.src, "fps=24", W, H, N)

    def test_report_has_the_checks(self):
        r = self.report
        for key in ("frames", "mouth_flicker_original", "mouth_flicker_filtered", "flicker_ok", "residual_original_head_frames", "outside_mask_pixels_changed"):
            self.assertIn(key, r)
        self.assertEqual(r["frames"], N)

    def test_nothing_outside_the_mask_changes(self):
        self.assertEqual(self.report["outside_mask_pixels_changed"], 0)

    def test_cowl_pixels_stay_original_and_face_takes_donor_tones(self):
        k = 10; o, c = self.org[k].astype(int), self.frames[k].astype(int); cx, cy = 150 + k, 300
        cowl = (slice(cy - 140, cy - 60), slice(cx - 80, cx + 80))
        self.assertLess(np.abs(o[cowl] - c[cowl]).max(), 2)          # fabric untouched
        face = (slice(cy + 20, cy + 40), slice(cx - 30, cx + 30))
        self.assertGreater(np.abs(o[face] - c[face]).mean(), 3)       # the donor's mouth shows in the composite

    def test_output_video_exists_with_the_source_size(self):
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", self.out], capture_output=True, text=True).stdout.strip()
        self.assertTrue(p.startswith(f"{W},{H}"), p)


class MathTest(unittest.TestCase):
    def test_flicker_is_zero_for_identical_frames_and_positive_for_a_changing_one(self):
        org = [np.full((64, 64, 3), 40, np.uint8) for _ in range(4)]; masks = [np.ones((64, 64), np.float32) for _ in range(4)]
        self.assertEqual(cs.flicker(list(org), masks, org), 0.0)
        shaky = [f.copy() for f in org]; shaky[2][...] = 90
        self.assertGreater(cs.flicker(shaky, masks, org), 10)

    def test_a_missing_input_gives_one_plain_line_and_exit_2(self):
        r = subprocess.run([sys.executable, cs.__file__, "--source", "/nonexistent.mp4", "--donor", "/nonexistent.mp4", "--out", "/tmp/x.mp4"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2); self.assertIn("was not found", r.stdout)

    def test_command_line_writes_a_report_with_the_listed_fields(self):
        d = tempfile.mkdtemp(); src, don, out, rep = (os.path.join(d, n) for n in ("s.mp4", "d.mp4", "o.mp4", "r.json")); make(src, False); make(don, True)
        r = subprocess.run([sys.executable, cs.__file__, "--source", src, "--donor", don, "--out", out, "--seconds", "1", "--report", rep], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        import json; data = json.load(open(rep))
        for k in ("mouth_flicker_original", "mouth_flicker_filtered", "residual_original_head_frames", "outside_mask_pixels_changed", "recoloured_leftover_skin_pixels"): self.assertIn(k, data)


if __name__ == "__main__":
    unittest.main()
