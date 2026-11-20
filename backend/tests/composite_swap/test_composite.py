"""Synthetic test, no model and no real people: a warm face under a blue cowl on a dark background, and a bright donor face of the same shape.
Run: <venv python> -m unittest discover -s backend/tests/composite_swap -p test_composite.py -v"""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path
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
        cls.frames, cls.report = cs.composite_swap(cls.src, cls.don, cls.out, start=0, seconds=1.0, edit_region={"box": [80, 180, 140, 180]})
        cls.org = cs.read_frames(cls.src, "fps=24", W, H, N)

    def test_report_has_the_checks(self):
        r = self.report
        for key in ("frames", "mouth_flicker_original", "mouth_flicker_filtered", "flicker_ok", "residual_original_head_frames", "preservation", "edit_region"):
            self.assertIn(key, r)
        self.assertEqual(r["frames"], N)

    def test_nothing_outside_the_mask_changes(self):
        self.assertEqual(self.report["preservation"]["changed_pixels"], 0)

    def test_cowl_pixels_stay_original_and_face_takes_donor_tones(self):
        k = 10; o, c = self.org[k].astype(int), self.frames[k].astype(int); cx, cy = 150 + k, 300
        cowl = (slice(cy - 140, cy - 60), slice(cx - 80, cx + 80))
        self.assertLess(np.abs(o[cowl] - c[cowl]).max(), 2)          # fabric untouched
        face = (slice(cy + 20, cy + 40), slice(cx - 30, cx + 30))
        self.assertGreater(np.abs(o[face] - c[face]).mean(), 3)       # the donor's mouth shows in the composite

    def test_output_video_exists_with_the_source_size(self):
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height,nb_frames", "-of", "csv=p=0", self.out], capture_output=True, text=True).stdout.strip()
        self.assertTrue(p.startswith(f"{W},{H}"), p)


def captioned(path, with_text=True):
    """A plain grey clip with white outlined letters low in the picture (a burned-in caption)."""
    p = subprocess.Popen([os.environ.get("STACK_MEDIA_FFMPEG", "ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", "24", "-i", "-", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
    for k in range(N):
        img = np.full((H, W, 3), (70, 80, 90), np.uint8)
        if with_text:
            for text, y in (("THE NEW HEAD", 400), ("IS NOT HERE", 440)):
                cv2.putText(img, text, (20, y), cv2.FONT_HERSHEY_DUPLEX, 1.0, (0, 0, 0), 7, cv2.LINE_AA)
                cv2.putText(img, text, (20, y), cv2.FONT_HERSHEY_DUPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
        p.stdin.write(img.tobytes())
    p.stdin.close(); p.wait()


class OutsideMaskCheckTest(unittest.TestCase):
    """The check that fails a swap when anything outside the head changed. It must pass untouched pixels and fail edited ones, before and after the encode."""
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(); cls.src = os.path.join(cls.dir, "src.mp4"); cls.don = os.path.join(cls.dir, "don.mp4"); cls.out = os.path.join(cls.dir, "out.mp4")
        make(cls.src, False); make(cls.don, True)
        cls.opts = cs.Options()
        cls.frames, cls.report = cs.composite_swap(cls.src, cls.don, cls.out, start=0, seconds=1.0, options=cls.opts, edit_region={"box": [80, 180, 140, 180]})
        cls.org = cs.read_frames(cls.src, "fps=24", W, H, N)
        cls.regions, _ = cs.declare_edit_region(cls.org, cls.opts, {"box": [80, 180, 140, 180]})

    def test_a_clean_composite_passes_both_checks(self):
        self.assertEqual(self.report["preservation"]["changed_pixels"], 0)
        self.assertEqual(self.report["preservation"]["verdict"], "pass")
        self.assertIsNotNone(self.report["preservation"]["encoded"])

    def test_changing_pixels_outside_the_mask_is_caught_before_the_encode(self):
        edited = [f.copy() for f in self.frames]
        for k in (3, 9):
            edited[k][10:60, 10:120] = (255, 0, 255)          # a patch in the corner, far from the head
        count, bad, _ = cs.pre_encode_check(self.org, edited, self.regions)
        self.assertGreater(count, 0); self.assertEqual(bad, [3, 9])

    def test_changing_pixels_outside_the_mask_is_caught_after_the_encode(self):
        edited = [f.copy() for f in self.frames]
        for k in range(N):
            edited[k][10:80, 10:160] = (255, 0, 255)
        path = os.path.join(self.dir, "edited.mp4"); cs.write_video(edited, path, 24, W, H)
        back = cs.read_frames(path, "fps=24", W, H, N)
        clean = cs.encoded_preservation_check(list(cs.read_frames(self.src, "fps=24", W, H, N)), list(cs.read_frames(self.src, "fps=24", W, H, N)), list(cs.read_frames(self.src, "fps=24", W, H, N)), self.regions, self.opts.encode_halo_px)
        source_only = os.path.join(self.dir, "source-only.mp4"); cs.write_video(self.org, source_only, 24, W, H)
        source_back = list(cs.read_frames(source_only, "fps=24", W, H, N))
        inverted = [np.where(r[..., None], 255 - f, f).astype(np.uint8) for f, r in zip(self.org, self.regions)]
        control = os.path.join(self.dir, "control.mp4"); cs.write_video(inverted, control, 24, W, H)
        edited_check = cs.encoded_preservation_check(source_back, list(back), list(cs.read_frames(control, "fps=24", W, H, N)), self.regions, self.opts.encode_halo_px)
        self.assertEqual(clean["largest_blob_px"], 0)
        self.assertGreaterEqual(edited_check["largest_blob_px"], 50)

    def test_pixels_inside_the_mask_may_change_without_failing(self):
        k = 10; cx, cy = 150 + k, 300
        edited = [f.copy() for f in self.frames]
        edited[k][cy + 20:cy + 40, cx - 30:cx + 30] = (200, 150, 140)      # inside the face, where the donor goes
        count, _, _ = cs.pre_encode_check(self.org, edited, self.regions)
        self.assertEqual(count, 0)

    def test_one_pixel_change_fails_and_skin_has_no_exemption(self):
        edited = [f.copy() for f in self.org]; edited[0][0, 0] = (15, 18, 25)
        count, bad, _ = cs.pre_encode_check(self.org, edited, self.regions)
        self.assertEqual(bad, [0]); self.assertEqual(count, 1)
        edited = [f.copy() for f in self.org]; edited[0][40, 40] = (11, 18, 25)
        count, _, _ = cs.pre_encode_check(self.org, edited, self.regions)
        self.assertEqual(count, 1)

    def test_region_is_independent_and_supplied_boxes_grow_and_hold(self):
        original = cs.find_faces
        try:
            cs.find_faces = lambda frame, *a, **k: ([(30, 30, 20, 20)] if frame[0, 0, 0] else [])
            frames = [np.zeros((100, 100, 3), np.uint8) for _ in range(3)]; frames[1][0, 0, 0] = 1
            regions, source = cs.declare_edit_region(frames, cs.Options())
            self.assertEqual(source, "detected"); self.assertTrue(all(r.any() for r in regions))
        finally: cs.find_faces = original
        regions, source = cs.declare_edit_region(frames, cs.Options(), {"boxes": [[5, 5, 10, 10], None, [40, 40, 10, 10]]})
        self.assertEqual(source, "supplied"); self.assertTrue(regions[0][8, 8]); self.assertFalse(regions[0][0, 0]); self.assertFalse(regions[1].any()); self.assertTrue(regions[2][45, 45])
        original = cs.find_faces
        try:
            cs.find_faces = lambda *a, **k: []
            with self.assertRaises(cs.ReferenceError) as caught: cs.declare_edit_region([np.zeros((50, 50, 3), np.uint8)], cs.Options())
        finally: cs.find_faces = original
        self.assertEqual(caught.exception.code, "no_edit_region"); self.assertEqual(caught.exception.line, cs.NO_EDIT_REGION_LINE)

    def test_recolour_leftover_does_not_touch_outside_region(self):
        frame = np.full((H, W, 3), 40, np.uint8); cv2.ellipse(frame, (150, 280), (55, 70), 0, 0, 360, (90, 70, 65), -1)
        raw = [frame.copy()]; mask = [np.zeros((H, W), np.float32)]; region = [np.zeros((H, W), bool)]; region[0][200:360, 90:210] = True
        cs.recolour_leftover(raw, [frame], mask, cs.Options(), region)
        self.assertTrue(np.array_equal(raw[0][~region[0]], frame[~region[0]]))


class SecondFaceTest(unittest.TestCase):
    """A second warm face outside the declared region: the swap must leave it exactly as it was, and an altered copy of it must fail the check
    (the old check exempted every skin-coloured pixel and compared against the worker's own mask, so it passed this)."""
    SECOND = ((60, 60), (30, 30))

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(); cls.src = os.path.join(cls.dir, "src.mp4"); cls.don = os.path.join(cls.dir, "don.mp4"); cls.out = os.path.join(cls.dir, "out.mp4")
        cls.second_src, cls.second_don = [], []
        for path, donor in ((cls.src, False), (cls.don, True)):
            p = subprocess.Popen([os.environ.get("STACK_MEDIA_FFMPEG", "ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{96 if donor else W}x{144 if donor else H}", "-r", "24", "-i", "-",
                                  "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
            for k in range(N):
                img = scene(donor, k); sc = (96 / W) if donor else 1.0
                cv2.ellipse(img, (int(cls.SECOND[0][0] * sc), int(cls.SECOND[0][1] * sc)), (int(cls.SECOND[1][0] * sc), int(cls.SECOND[1][1] * sc)), 0, 0, 360, (210, 165, 150) if donor else (70, 55, 62), -1)
                p.stdin.write(img.tobytes())
            p.stdin.close(); p.wait()
        cls.org = cs.read_frames(cls.src, "fps=24", W, H, N)
        cls.frames, cls.report = cs.composite_swap(cls.src, cls.don, cls.out, start=0, seconds=1.0, edit_region={"box": [80, 180, 140, 180]})
        cls.regions, _ = cs.declare_edit_region(cls.org, cs.Options(), {"box": [80, 180, 140, 180]})

    def test_the_second_face_is_left_exactly_as_it_was(self):
        (cx, cy), (rx, ry) = self.SECOND
        for k in range(N):
            self.assertTrue(np.array_equal(self.frames[k][cy - ry:cy + ry, cx - rx:cx + rx], self.org[k][cy - ry:cy + ry, cx - rx:cx + rx]), k)
        self.assertEqual(self.report["preservation"]["changed_pixels"], 0); self.assertEqual(self.report["preservation"]["verdict"], "pass")

    def test_a_head_larger_than_the_region_is_clipped_and_the_rest_stays_exact(self):
        frames, report = cs.composite_swap(self.src, self.don, None, start=0, seconds=1.0, edit_region={"box": [120, 250, 60, 60]})
        self.assertGreater(report["mask_clipped_pixels"], 0)
        regions, _ = cs.declare_edit_region(self.org, cs.Options(), {"box": [120, 250, 60, 60]})
        self.assertEqual(cs.pre_encode_check(self.org, frames, regions)[0], 0); self.assertEqual(report["preservation"]["verdict"], "pass")

    def test_an_altered_second_face_fails(self):
        (cx, cy), (rx, ry) = self.SECOND
        edited = [f.copy() for f in self.org]
        for f in edited: f[cy - 10:cy + 10, cx - 10:cx + 10] = (200, 150, 140)      # a recolored patch on skin: the old check exempted this
        count, bad, _ = cs.pre_encode_check(self.org, edited, self.regions)
        self.assertGreater(count, 0); self.assertEqual(len(bad), N)


class EncoderDriftTest(unittest.TestCase):
    """Real footage with a hard-edged caption pill failed falsely: the encoder moves pixels along the pill's edge once an edit inside the region changes its rate
    control, in frames nothing outside the region touched. Flat grained frames, a saturated hard-edged bar outside the region, an edit inside the region only."""
    W, H, N, GRAIN = 360, 640, 96, 8
    REGION = (slice(100, 340), slice(60, 300))

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        base = np.random.default_rng(1).integers(-cls.GRAIN, cls.GRAIN + 1, (cls.H, cls.W, 1))
        cls.src = []
        for k in range(cls.N):
            f = np.clip(np.full((cls.H, cls.W, 3), (120, 130, 125)) + base + np.random.default_rng(k).integers(-cls.GRAIN, cls.GRAIN + 1, (cls.H, cls.W, 1)), 0, 255).astype(np.uint8)
            cv2.rectangle(f, (30, 500), (330, 540), (20, 60, 230), -1); cv2.putText(f, "CAPTION TEXT HERE", (40, 534), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
            cls.src.append(f)
        region = np.zeros((cls.H, cls.W), bool); region[cls.REGION] = True
        cls.regions = [region] * cls.N
        cls.edited = []
        for k, f in enumerate(cls.src):
            g = f.copy(); g[cls.REGION] = np.clip(g[cls.REGION].astype(int) + np.random.default_rng(7 + k).integers(-255, 256, (240, 240, 3)), 0, 255); cls.edited.append(g)
        cls.source_back = cls.encode(cls.src, "s.mp4")
        cls.delivered = cls.encode(cls.edited, "d.mp4")
        cls.control = cls.encode([np.where(r[..., None], 255 - f, f).astype(np.uint8) for f, r in zip(cls.src, cls.regions)], "c.mp4")

    @classmethod
    def encode(cls, frames, name):
        path = os.path.join(cls.dir, name); cs.write_video(frames, path, 24, cls.W, cls.H)
        return list(cs.read_frames(path, "fps=24", cls.W, cls.H, cls.N))

    def check(self, delivered, control):
        return cs.encoded_preservation_check(self.source_back, delivered, control, self.regions, 32)

    def test_without_a_drift_control_the_pill_edge_fails_falsely(self):
        # the old rule: no control, so nothing masks the encoder's drift along the pill
        self.assertGreaterEqual(self.check(self.delivered, self.source_back)["largest_blob_px"], 50)

    def test_the_drift_control_passes_an_edit_that_touched_only_the_region(self):
        result = self.check(self.delivered, self.control)
        self.assertLess(result["largest_blob_px"], 50); self.assertGreater(result["drift_masked_px"], 0)

    def test_a_faint_persistent_change_outside_the_region_still_fails(self):
        changed = [f.copy() for f in self.delivered]
        for f in changed: f[400:440, 10:60] = np.clip(f[400:440, 10:60].astype(int) + 14, 0, 255)      # 14 levels, 40 by 50 pixels, far from the pill and the region
        self.assertGreaterEqual(self.check(self.encode(changed, "faint.mp4"), self.control)["largest_blob_px"], 50)

    def test_an_altered_face_sized_patch_outside_the_region_still_fails(self):
        changed = [f.copy() for f in self.delivered]
        for f in changed: f[380:440, 200:260] = (200, 150, 140)
        self.assertGreaterEqual(self.check(self.encode(changed, "face.mp4"), self.control)["largest_blob_px"], 50)

    def test_a_delivered_file_is_judged_without_the_pre_encode_check(self):
        src = os.path.join(self.dir, "src.mp4"); dl = os.path.join(self.dir, "deliv.mp4"); cs.write_video(self.src, src, 24, self.W, self.H)
        decoded = list(cs.read_frames(src, "fps=24", self.W, self.H, self.N))      # a swap is made from the decoded source, like the file under test
        edited = []
        for k, f in enumerate(decoded):
            g = f.copy()
            if k < 60: g[self.REGION] = np.clip(g[self.REGION].astype(int) + np.random.default_rng(7 + k).integers(-255, 256, (240, 240, 3)), 0, 255)
            edited.append(g)
        cs.write_video(edited, dl, 24, self.W, self.H)
        region = {"boxes": [[60, 100, 240, 240]] * 60 + [None] * (self.N - 60)}       # the target is absent in the last 36 frames: nothing was edited there
        report = cs.verify_delivered(src, dl, seconds=self.N / 24, edit_region=region)
        self.assertEqual(report["preservation"]["pre_encode"], "not_run"); self.assertIsNone(report["preservation"]["changed_pixels"])
        self.assertEqual(report["preservation"]["verdict"], "pass")
        changed = [f.copy() for f in edited]
        for f in changed[:60]: f[570:610, 10:60] = np.clip(f[570:610, 10:60].astype(int) + 40, 0, 255)
        bad = os.path.join(self.dir, "bad.mp4"); cs.write_video(changed, bad, 24, self.W, self.H)
        self.assertEqual(cs.verify_delivered(src, bad, seconds=self.N / 24, edit_region=region)["preservation"]["verdict"], "fail")


class ForeignEncoderTest(unittest.TestCase):
    """A delivered file made by another pipeline (here a bt709 conversion and a light blur, where the worker's own encode is plain) differs from the decoded
    source at saturated hard edges such as a caption pill, in every frame, including frames nothing touched. The worker's own source-only encode cannot predict
    it; the delivered file's own unedited frames can. Each place's ceiling there is how far the file's untouched frames differ from the source."""
    W, H, N, EDITED = 360, 640, 96, 40
    BOX = [60, 100, 240, 240]

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        base = np.random.default_rng(1).integers(-4, 5, (cls.H, cls.W, 1))
        frames = []
        for k in range(cls.N):
            f = np.clip(np.full((cls.H, cls.W, 3), (120, 130, 125)) + base + np.random.default_rng(k).integers(-4, 5, (cls.H, cls.W, 1)), 0, 255).astype(np.uint8)
            cv2.rectangle(f, (30, 500), (330, 540), (20, 60, 230), -1); cv2.putText(f, "CAPTION TEXT HERE", (40, 534), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
            frames.append(f)
        cls.src = os.path.join(cls.dir, "src.mp4"); cs.write_video(frames, cls.src, 24, cls.W, cls.H)
        cls.decoded = list(cs.read_frames(cls.src, "fps=24", cls.W, cls.H, cls.N))

    @classmethod
    def foreign(cls, frames, name):
        path = os.path.join(cls.dir, name)
        p = subprocess.Popen([os.environ.get("STACK_MEDIA_FFMPEG", "ffmpeg"), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{cls.W}x{cls.H}", "-r", "24", "-i", "-",
                              "-vf", "scale=out_color_matrix=bt709:out_range=tv,gblur=sigma=0.6", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", path], stdin=subprocess.PIPE)
        for f in frames: p.stdin.write(f.tobytes())
        p.stdin.close(); p.wait()
        return path

    def edited_frames(self, edited):
        out = []
        for k, f in enumerate(self.decoded):
            g = f.copy()
            if k < edited: g[100:340, 60:300] = np.clip(g[100:340, 60:300].astype(int) + np.random.default_rng(7 + k).integers(-255, 256, (240, 240, 3)), 0, 255)
            out.append(g)
        return out

    def verify(self, delivered, edited):
        return cs.verify_delivered(self.src, delivered, seconds=self.N / 24, edit_region={"boxes": [self.BOX] * edited + [None] * (self.N - edited)})

    def test_the_worker_encode_as_control_fails_this_clean_file_falsely(self):
        # what the first drift control did: judge a foreign file against the worker's own source-only encode
        frames = self.edited_frames(self.EDITED)
        path = self.foreign(frames, "old.mp4"); back = list(cs.read_frames(path, "fps=24", self.W, self.H, self.N))
        regions, _ = cs.declare_edit_region(self.decoded, cs.Options(), {"boxes": [self.BOX] * self.EDITED + [None] * (self.N - self.EDITED)})
        source_only = os.path.join(self.dir, "so.mp4"); cs.write_video(self.decoded, source_only, 24, self.W, self.H)
        so = list(cs.read_frames(source_only, "fps=24", self.W, self.H, self.N))
        inverted = [np.where(r[..., None], 255 - f, f).astype(np.uint8) for f, r in zip(self.decoded, regions)]
        control = os.path.join(self.dir, "ctl.mp4"); cs.write_video(inverted, control, 24, self.W, self.H)
        self.assertGreaterEqual(cs.encoded_preservation_check(so, back, list(cs.read_frames(control, "fps=24", self.W, self.H, self.N)), regions, 32)["largest_blob_px"], 50)

    def test_unedited_frames_of_the_delivered_file_measure_its_own_drift(self):
        report = self.verify(self.foreign(self.edited_frames(self.EDITED), "clean.mp4"), self.EDITED)
        self.assertEqual(report["preservation"]["verdict"], "pass"); self.assertEqual(report["preservation"]["baseline"]["source"], "unedited_frames")
        self.assertEqual(report["preservation"]["pre_encode"], "not_run")

    def test_an_edit_outside_the_region_still_fails_with_that_baseline(self):
        frames = self.edited_frames(self.EDITED)
        for f in frames[:self.EDITED]: f[570:610, 10:60] = np.clip(f[570:610, 10:60].astype(int) + 40, 0, 255)
        report = self.verify(self.foreign(frames, "patch.mp4"), self.EDITED)
        self.assertEqual(report["preservation"]["verdict"], "fail"); self.assertGreaterEqual(report["preservation"]["encoded"]["largest_blob_px"], 1500)

    def test_misaligned_frames_in_the_unedited_stretch_do_not_hide_an_edit(self):
        frames = self.edited_frames(self.EDITED)
        for k in range(60, 65): frames[k] = self.decoded[k + 1].copy()          # five frames of the delivered file are one frame late: they differ from the source everywhere
        for f in frames[:self.EDITED]: f[570:610, 10:60] = np.clip(f[570:610, 10:60].astype(int) + 40, 0, 255)
        report = self.verify(self.foreign(frames, "late.mp4"), self.EDITED)
        self.assertEqual(report["preservation"]["verdict"], "fail"); self.assertGreaterEqual(report["preservation"]["encoded"]["largest_blob_px"], 1500)

    def test_a_short_edited_stretch_is_judged_by_its_own_length(self):
        frames = self.edited_frames(8)
        for f in frames[:8]: f[570:610, 10:60] = np.clip(f[570:610, 10:60].astype(int) + 40, 0, 255)
        self.assertEqual(self.verify(self.foreign(frames, "short.mp4"), 8)["preservation"]["verdict"], "fail")

    def test_without_unedited_frames_a_hard_edge_difference_is_inconclusive_not_a_pass_or_a_fail(self):
        report = self.verify(self.foreign(self.edited_frames(self.N), "all.mp4"), self.N)
        self.assertEqual(report["preservation"]["verdict"], "inconclusive"); self.assertEqual(report["preservation"]["baseline"]["source"], "none")
        self.assertTrue(any("unknown_encoder" in r for r in report["preservation"]["reasons"]))


class RegionShapeTest(unittest.TestCase):
    FRAMES = [np.zeros((200, 300, 3), np.uint8) for _ in range(3)]

    def test_null_means_the_target_is_absent_and_any_edit_in_that_frame_fails(self):
        regions, source = cs.declare_edit_region(self.FRAMES, cs.Options(), {"boxes": [[50, 50, 40, 40], None, [50, 50, 40, 40]]})
        self.assertFalse(regions[1].any()); self.assertTrue(regions[0].any())
        edited = [f.copy() for f in self.FRAMES]; edited[1][10, 10] = (1, 0, 0)
        count, bad, _ = cs.pre_encode_check(self.FRAMES, edited, regions); self.assertEqual((count, bad), (1, [1]))

    def test_ellipse_and_polygon_regions_follow_the_shape_and_grow_by_the_margin(self):
        regions, _ = cs.declare_edit_region(self.FRAMES, cs.Options(region_margin_frac=0.1), {"boxes": [{"ellipse": [150, 100, 40, 60]}, {"polygon": [[100, 50], [200, 50], [150, 150]]}, [10, 10, 20, 20]]})
        self.assertTrue(regions[0][100, 150]); self.assertFalse(regions[0][100, 90])       # 60 px left of centre is outside an ellipse with rx 40 plus a 12 px margin
        self.assertFalse(regions[0][100, 150 + 40 + 20])
        self.assertTrue(regions[1][70, 150]); self.assertFalse(regions[1][140, 105])        # a polygon corner is not filled like its bounding box
        self.assertLess(regions[0].sum(), 90 * 140)                                         # an ellipse covers less than its bounding box

    def test_a_bad_region_entry_says_what_to_fix(self):
        with self.assertRaises(ValueError): cs.declare_edit_region(self.FRAMES, cs.Options(), {"boxes": [{"circle": [1, 2, 3]}, None, None]})
        with self.assertRaises(ValueError): cs.declare_edit_region(self.FRAMES, cs.Options(), {"boxes": [{"polygon": [[1, 2], [3, 4]]}, None, None]})


class CaptionTest(unittest.TestCase):
    def test_a_burned_in_caption_is_found_and_erased(self):
        d = tempfile.mkdtemp(); src = os.path.join(d, "c.mp4"); captioned(src)
        frames = cs.read_frames(src, "fps=24", W, H, N)
        box = cs.detect_caption_box(list(frames[::6]), cs.Options())
        self.assertIsNotNone(box); x, y, w, h = box
        self.assertGreater(y, int(H * 0.45)); self.assertLess(x, 40); self.assertGreater(x + w, 250)
        clean = cs.read_frames(src, "delogo=x=%d:y=%d:w=%d:h=%d,fps=24" % cs.clamp_box(box, W, H), W, H, N)
        self.assertLess(cs.caption_residue(list(frames), list(clean), cs.clamp_box(box, W, H), cs.Options()), cs.Options().max_caption_residue)

    def test_a_caption_that_is_still_there_is_reported_as_residue(self):
        d = tempfile.mkdtemp(); src = os.path.join(d, "c.mp4"); captioned(src)
        frames = cs.read_frames(src, "fps=24", W, H, N)
        self.assertGreater(cs.caption_residue(list(frames), list(frames), (1, 380, 300, 90), cs.Options()), 0.95)

    def test_a_clip_with_no_caption_has_no_box_and_no_residue(self):
        d = tempfile.mkdtemp(); src = os.path.join(d, "n.mp4"); captioned(src, with_text=False)
        frames = cs.read_frames(src, "fps=24", W, H, N)
        self.assertIsNone(cs.detect_caption_box(list(frames[::6]), cs.Options()))
        self.assertIsNone(cs.caption_residue(list(frames), list(frames), (1, 380, 300, 90), cs.Options()))

    def test_a_caption_box_is_kept_inside_the_frame(self):
        self.assertEqual(cs.clamp_box((0, 0, 500, 700), W, H), (1, 1, W - 2, H - 2))
        with self.assertRaises(ValueError): cs.clamp_box((W + 50, 10, 40, 40), W, H)

    def test_the_composite_reports_caption_residue_when_given_a_box(self):
        d = tempfile.mkdtemp(); src, don = (os.path.join(d, n) for n in ("s.mp4", "d.mp4")); make(don, True)
        frames = [scene(False, k) for k in range(N)]
        for f in frames:
            cv2.putText(f, "CAPTION TEXT", (10, 440), cv2.FONT_HERSHEY_DUPLEX, 1.0, (0, 0, 0), 7, cv2.LINE_AA); cv2.putText(f, "CAPTION TEXT", (10, 440), cv2.FONT_HERSHEY_DUPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)
        cs.write_video(frames, src, 24, W, H)
        _, rep = cs.composite_swap(src, don, os.path.join(d, "o.mp4"), seconds=1.0, caption_box=(1, 405, 300, 50), edit_region={"box": [80, 180, 140, 180]})
        self.assertIsNotNone(rep["caption_residue"]); self.assertLess(rep["caption_residue"], cs.Options().max_caption_residue)


class PeopleAndFramingTest(unittest.TestCase):
    def setUp(self):
        self.real = cs.find_faces

    def tearDown(self):
        cs.find_faces = self.real

    def picture(self, name="p.png"):
        path = os.path.join(tempfile.mkdtemp(), name); cv2.imwrite(path, np.full((600, 800, 3), 120, np.uint8)); return path

    def test_one_face_gives_one_square_crop(self):
        cs.find_faces = lambda rgb, *a, **k: [(300, 200, 120, 140)]
        out = tempfile.mkdtemp(); crops = cs.make_reference_crops([self.picture()], out)
        self.assertEqual(len(crops), 1); img = cv2.imread(crops[0]); self.assertEqual(img.shape[:2], (512, 512))

    def test_a_picture_with_no_face_names_the_picture_and_what_to_do(self):
        cs.find_faces = lambda rgb, *a, **k: []
        with self.assertRaises(cs.ReferenceError) as caught: cs.make_reference_crops([self.picture(), self.picture()], tempfile.mkdtemp())
        self.assertEqual(caught.exception.code, "no_face"); self.assertIn("reference picture 1", caught.exception.line); self.assertIn("Use a clear picture", caught.exception.line)

    def test_a_picture_with_several_people_is_refused(self):
        cs.find_faces = lambda rgb, *a, **k: [(100, 100, 100, 100), (400, 100, 100, 100)]
        with self.assertRaises(cs.ReferenceError) as caught: cs.make_reference_crops([self.picture()], tempfile.mkdtemp())
        self.assertEqual(caught.exception.code, "many_people"); self.assertIn("2 people", caught.exception.line); self.assertIn("one person", caught.exception.line)

    def test_more_than_nine_pictures_are_refused_before_any_work(self):
        with self.assertRaises(cs.ReferenceError) as caught: cs.make_reference_crops(["/x.png"] * 10, tempfile.mkdtemp())
        self.assertEqual(caught.exception.code, "too_many_references"); self.assertIn("up to 9", caught.exception.line)

    def test_nine_pictures_are_allowed(self):
        cs.find_faces = lambda rgb, *a, **k: [(300, 200, 120, 140)]
        self.assertEqual(len(cs.make_reference_crops([self.picture(f"p{i}.png") for i in range(9)], tempfile.mkdtemp())), 9)

    def test_a_file_that_is_not_a_picture_is_refused(self):
        path = os.path.join(tempfile.mkdtemp(), "x.png"); Path(path).write_text("not a picture")
        with self.assertRaises(cs.ReferenceError) as caught: cs.make_reference_crops([path], tempfile.mkdtemp())
        self.assertEqual(caught.exception.code, "unreadable")

    def test_the_command_line_reports_a_reference_problem_with_its_code(self):
        r = subprocess.run([sys.executable, cs.__file__, "--mode", "crops", "--references", self.picture(), "--out-dir", tempfile.mkdtemp()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2); body = json.loads(r.stdout.strip().splitlines()[-1]); self.assertEqual(body["code"], "no_face"); self.assertIn("No face was found", body["error"])

    def test_a_head_at_the_side_of_the_frame_needs_canvas_and_a_centered_head_does_not(self):
        o = cs.Options(); at_side = np.zeros((480, 320, 3), np.uint8); centered = np.zeros((480, 320, 3), np.uint8)
        cv2.ellipse(at_side, (5, 200), (70, 95), 0, 0, 360, (200, 160, 140), -1); cv2.ellipse(centered, (160, 200), (70, 95), 0, 0, 360, (200, 160, 140), -1)
        self.assertTrue(cs.head_touches_edge(at_side, o)); self.assertFalse(cs.head_touches_edge(centered, o))

    def test_analyze_reports_framing_per_segment(self):
        d = tempfile.mkdtemp(); src = os.path.join(d, "s.mp4"); make(src, False)
        cs.find_faces = lambda rgb, *a, **k: []
        rep = cs.analyze_clip(src, 0, 1.0, [[0, 0.5], [0.5, 0.5]], cs.Options())
        self.assertEqual(len(rep["segments"]), 2); self.assertEqual(rep["people_max"], 0); self.assertIn("caption_box", rep); self.assertEqual(rep["size"], [W, H])

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
        region = os.path.join(d, "region.json"); Path(region).write_text(json.dumps({"box": [80, 180, 140, 180]}))
        r = subprocess.run([sys.executable, cs.__file__, "--source", src, "--donor", don, "--out", out, "--seconds", "1", "--report", rep, "--edit-region-file", region], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(Path(rep).read_text())
        for k in ("mouth_flicker_original", "mouth_flicker_filtered", "residual_original_head_frames", "preservation", "edit_region", "mask_clipped_pixels"): self.assertIn(k, data)


if __name__ == "__main__":
    unittest.main()
