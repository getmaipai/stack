"""The Stack's LivePortrait worker (TALK-06): still mouth and eye frames from one portrait.

One request per line on stdin (JSON), one reply per line on stdout. Pictures and
frames travel as files the Stack wrote under its own data directory; the worker
opens no socket and logs no picture, ratio or result. It runs offline always.

It does what LivePortrait's own `GradioPipeline.prepare_retargeting_image` and
`execute_image_retargeting` do, without importing gradio: crop and measure the
face once per request, then for each requested ratio move the lips or the eyes
to that openness (head pose untouched, zoom `mov_z` 1) and paste the face back
into the full picture. Frames come back at the input picture's size.

The face rectangle comes from Apple Vision through a helper the Stack compiled
(a system API, no model file), then MediaPipe when Vision finds nothing. The
face finder LivePortrait ships (non-commercial research files) is never
installed; the pinned source is patched to use this one.
"""
import json
import os
import resource
import subprocess
import sys
import tempfile
import time

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Anything a library prints must never reach the protocol stream.
PROTOCOL = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)

MEGAPIXEL = 1_000_000
MAX_MEGAPIXELS = 16
NO_FACE = "No face was found in this picture. Choose a picture where the face is clear."
TOO_LARGE = f"This picture is over {MAX_MEGAPIXELS} megapixels. Choose a smaller picture."
# The 203-point landmark model's layout (landmark.onnx, MIT). The lip groups follow the indices LivePortrait's own retargeting reads: the outer lip loop
# is 48..83 (corners 48 and 66), the inner lip loop is 84..107 (corners 84 and 96, top 90, bottom 102), the same 24-point loop shape as each eye.
# Read off the model's own output on a real face (a plotted run of landmark.onnx on a portrait, 2026-11-10): eyes 0..47, outer lips 48..83 (36),
# inner lips 84..107 (24; 90 and 102 are the inner top and bottom the engine's retargeting uses), face contour 108..144 (jaw and cheeks, left eye
# level round the chin to right eye level), brows 145..184, nose 185..202 (186..195 the sides, 200 to 202 the centre line down to under the tip;
# 185 and 196..199 sit between the eyes and are left out so a caller registering on the nose is not moved by the eyes). `points` (all 203) is
# always returned so a caller can pick any point itself.
LANDMARK_GROUPS = {
    "outerLips": range(48, 84),
    "innerLips": range(84, 108),
    "nose": [*range(186, 196), 200, 201, 202],
    "contour": range(108, 145),
}
MODEL_KEYS = ("landmark", "appearance", "motion", "generator", "warping", "stitching")


def landmark_groups(points):
    """The grouped landmarks as `[x, y]` pairs. `points` is the cropper's `lmk_crop`: the 203 points ALREADY in the input picture's own pixels
    (LivePortrait's LandmarkRunner.run maps its 224 px crop output back through the crop's `M_c2o` before it returns, so `lmk_crop` is a misnomer).
    They must not be mapped through `M_c2o` again: that applied the crop to original transform twice (about 1.32 x + 180 on a 1024 px picture)."""
    pts = [(float(x), float(y)) for x, y in points]
    round2 = lambda rows: [[round(x, 2), round(y, 2)] for x, y in rows]
    groups = {name: round2([pts[i] for i in idx]) if idx is not None else [] for name, idx in LANDMARK_GROUPS.items()}
    groups["points"] = round2(pts)
    return groups


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def emit(value):
    PROTOCOL.write(json.dumps(value, separators=(",", ":")) + "\n")
    PROTOCOL.flush()


def vision_box(helper, rgb, cv2):
    """The largest face Apple Vision sees, as (x, y, w, h) pixels, or None."""
    with tempfile.TemporaryDirectory(prefix="lp-face-") as tmp:
        path = os.path.join(tmp, "face.png")
        cv2.imwrite(path, rgb[..., ::-1])
        done = subprocess.run([helper, path], capture_output=True, text=True, timeout=30)
        if done.returncode != 0:
            return None
        faces = json.loads(done.stdout.strip().splitlines()[-1]).get("faces") or []
        if not faces:
            return None
        f = faces[0]
        return (f["x"], f["y"], f["w"], f["h"])


_mediapipe = {}


def mediapipe_box(rgb):
    """MediaPipe's largest face (Apache-2.0, its detectors ship inside the wheel), or None. The close-range model first (a portrait fills the frame), then the full-range one."""
    try:
        import mediapipe as mp
        detections = []
        for selection in (0, 1):
            if selection not in _mediapipe:
                _mediapipe[selection] = mp.solutions.face_detection.FaceDetection(model_selection=selection, min_detection_confidence=0.4)
            detections = _mediapipe[selection].process(rgb).detections or []
            if detections:
                break
    except Exception:
        return None
    height, width = rgb.shape[:2]
    best = None
    for d in detections:
        b = d.location_data.relative_bounding_box
        box = (b.xmin * width, b.ymin * height, b.width * width, b.height * height)
        if box[2] > 0 and box[3] > 0 and (best is None or box[2] * box[3] > best[2] * best[3]):
            best = box
    return best


class Engine:
    def __init__(self, source, models):
        sys.path.insert(0, source)
        import cv2
        import numpy as np
        import torch
        from src.config.crop_config import CropConfig
        from src.config.inference_config import InferenceConfig
        from src.live_portrait_wrapper import LivePortraitWrapper
        from src.utils import face_finder
        from src.utils.camera import get_rotation_matrix
        from src.utils.crop import paste_back, prepare_paste_back
        from src.utils.cropper import Cropper
        from src.utils.retargeting_utils import calc_eye_close_ratio, calc_lip_close_ratio
        self.cv2, self.np, self.torch = cv2, np, torch
        self.face_finder, self.get_rotation_matrix = face_finder, get_rotation_matrix
        self.paste_back, self.prepare_paste_back = paste_back, prepare_paste_back
        self.calc_eye, self.calc_lip = calc_eye_close_ratio, calc_lip_close_ratio
        inference_cfg = InferenceConfig(checkpoint_F=models["appearance"], checkpoint_M=models["motion"], checkpoint_G=models["generator"], checkpoint_W=models["warping"], checkpoint_S=models["stitching"])
        if not (torch.backends.mps.is_available() or torch.cuda.is_available()):
            raise Refused("engine_unavailable", "The talking-picture engine needs the Mac's graphics chip and it is not available. Restart the computer and try again.")
        self.crop_cfg = CropConfig(landmark_ckpt_path=models["landmark"])
        self.wrapper = LivePortraitWrapper(inference_cfg=inference_cfg)
        self.cropper = Cropper(crop_cfg=self.crop_cfg)
        self.inference_cfg = inference_cfg

    def load_picture(self, path):
        from PIL import Image, ImageOps
        Image.MAX_IMAGE_PIXELS = 400_000_000
        image = Image.open(path)
        width, height = image.size
        if width * height > MAX_MEGAPIXELS * MEGAPIXEL:
            raise Refused("too_large", TOO_LARGE)
        image = ImageOps.exif_transpose(image)
        return self.np.ascontiguousarray(self.np.asarray(image.convert("RGB")))

    def detector(self, helper):
        def detect(rgb):
            box = None
            if helper:
                try:
                    box = vision_box(helper, rgb, self.cv2)
                except Exception:
                    box = None
            return box or mediapipe_box(rgb)
        return detect

    def landmarks_of(self, rgb, crop_cfg=None):
        """The 203 landmarks of the largest face in `rgb`, in that picture's own pixels (grouped), or None when no face is found."""
        crop = self.cropper.crop_source_image(rgb, self.crop_cfg)
        return None if crop is None else self.landmarks_from_crop(crop)

    def landmarks_from_crop(self, crop):
        return landmark_groups(crop["lmk_crop"])

    @property
    def device(self):
        return self.wrapper.device

    def run(self, request):
        started = time.monotonic()
        img_rgb = self.load_picture(request["input"])
        height, width = img_rgb.shape[:2]
        scale = float(request.get("sourceScale") or 2.3)
        self.crop_cfg.scale = scale
        self.face_finder.detect_face = self.detector(request.get("helper"))
        crop = self.cropper.crop_source_image(img_rgb, self.crop_cfg)
        if crop is None:
            raise Refused("no_face", NO_FACE)
        torch = self.torch
        with torch.no_grad():
            wrapper, device = self.wrapper, self.device
            I_s = wrapper.prepare_source(crop["img_crop_256x256"])
            lmk = crop["lmk_crop"]
            mask_ori = self.prepare_paste_back(self.inference_cfg.mask_crop, crop["M_c2o"], dsize=(width, height))
            info = wrapper.get_kp_info(I_s)
            R_s = self.get_rotation_matrix(info["pitch"], info["yaw"], info["roll"])
            f_s = wrapper.extract_feature_3d(I_s).to(device)
            x_s = wrapper.transform_keypoint(info).to(device)
            R_s = R_s.to(device)
            x_c_s, delta, scale_new, t_new = info["kp"].to(device), info["exp"].to(device), info["scale"].to(device), info["t"].to(device)
            source_eye = round(float(self.calc_eye(lmk[None]).mean()), 2)
            source_lip = round(float(self.calc_lip(lmk[None])[0][0]), 2)
            want_landmarks = request.get("landmarks", True)
            source_landmarks = self.landmarks_from_crop(crop) if want_landmarks else None
            # Pose is not changed (pitch, yaw, roll, mov_x, mov_y all 0), so the driving rotation equals the source's. Zoom stays 1: 0 collapses the face.
            mov_z = torch.tensor(1.0).to(device)
            base = mov_z * scale_new * (x_c_s @ R_s + delta) + t_new
            frames = []
            for kind, ratios in (("lip", request.get("lip") or []), ("eye", request.get("eye") or [])):
                for ratio in ratios:
                    t0 = time.monotonic()
                    eye_ratio, lip_ratio = (source_eye, float(ratio)) if kind == "lip" else (float(ratio), source_lip)
                    x_d = base
                    # A ratio equal to the source's own measured ratio is the picture as it is: no retarget for it.
                    if eye_ratio != source_eye:
                        x_d = x_d + wrapper.retarget_eye(x_s, wrapper.calc_combined_eye_ratio([[eye_ratio]], lmk))
                    if lip_ratio != source_lip:
                        x_d = x_d + wrapper.retarget_lip(x_s, wrapper.calc_combined_lip_ratio([[lip_ratio]], lmk))
                    x_d = wrapper.stitching(x_s, x_d)
                    out = wrapper.parse_output(wrapper.warp_decode(f_s, x_s, x_d)["out"])[0]
                    full = self.paste_back(out, crop["M_c2o"], img_rgb, mask_ori)
                    path = os.path.join(request["outdir"], f"frame-{len(frames)}.png")
                    self.cv2.imwrite(path, self.cv2.cvtColor(full, self.cv2.COLOR_RGB2BGR))  # a fresh PNG: no EXIF, no profile
                    entry = {"kind": kind, "ratio": float(ratio), "file": path, "ms": int((time.monotonic() - t0) * 1000)}
                    if want_landmarks:
                        entry["landmarks"] = self.landmarks_of(full)  # None when the face finder sees no face in this frame
                    frames.append(entry)
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # bytes on macOS
        return {"width": width, "height": height, "sourceEye": source_eye, "sourceLip": source_lip, **({"sourceLandmarks": source_landmarks} if want_landmarks else {}), "frames": frames, "ms": int((time.monotonic() - started) * 1000), "peakBytes": int(peak)}


def main():
    engine = None
    emit({"ready": True})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            if engine is None:
                missing = [k for k in MODEL_KEYS if not (request.get("models") or {}).get(k) or not os.path.exists(request["models"][k])]
                if missing:
                    raise Refused("model_missing", "The talking-picture model files are not installed. Install them from Home's Engines page, then try again.")
                engine = Engine(request["source"], request["models"])
            emit({"id": request.get("id"), "ok": True, **engine.run(request)})
        except Refused as refused:
            emit({"id": request.get("id"), "ok": False, "code": refused.code, "error": str(refused)})
        except Exception as error:  # nothing about the picture goes in the message
            print(f"liveportrait worker: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
            emit({"id": request.get("id"), "ok": False, "code": "engine_failed", "error": "The picture could not be prepared for talking frames. Try another picture."})


if __name__ == "__main__":
    main()
