"""composite_swap_worker: put donor pixels inside a declared head region and preserve every source pixel outside it. Model-independent; no network.

A guided head-swap generator redraws the whole frame, so its clip is only a donor. This module keeps every original pixel outside a head mask and takes
colour-matched donor pixels inside it. Method, numbers and known imperfections: docs/design/swap-composite-lessons-2026-11-17.md in the Home repo.

Usage (library):
    report = composite_swap(source="in.mp4", donor="donor.mp4", out="out.mp4", start=0.0, seconds=2.333, reference_crops=["a.png"],
                            caption_box=(170, 1540, 740, 135))
Usage (command line):
    python composite_swap_worker.py --source in.mp4 --donor donor.mp4 --out out.mp4 --start 0 --seconds 2.333 [--caption-box x,y,w,h] [--report r.json]
    python composite_swap_worker.py --mode analyze --source in.mp4 --start 0 --seconds 8 --segments 0:2.33,2.33:2.33   (caption box, people, head leaving the frame)
    python composite_swap_worker.py --mode crops --references a.png,b.jpg --out-dir dir                                (one face per crop, up to nine)

The donor clip covers the same time span as source[start:start+seconds] at any size with the same aspect ratio; it is scaled to the source size.
Needs numpy, OpenCV (cv2) and ffmpeg. Returns (and optionally writes) a report: per-frame mouth-area flicker for original, raw composite and filtered
composite, frames where original skin is left unchanged, and the pixel difference outside the mask (must be 0 apart from the feathered edge).
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys
from dataclasses import dataclass, field, asdict
import cv2
import numpy as np

FPS = 24
# The Stack hands over the media tools it resolved as STACK_MEDIA_FFMPEG and STACK_MEDIA_FFPROBE (the names the whole Stack uses);
# the older COMPOSITE_SWAP_* names still work, and a bare name on PATH is the last resort (a bench run by hand).
FFMPEG = os.environ.get("STACK_MEDIA_FFMPEG") or os.environ.get("COMPOSITE_SWAP_FFMPEG") or "ffmpeg"
FFPROBE = os.environ.get("STACK_MEDIA_FFPROBE") or os.environ.get("COMPOSITE_SWAP_FFPROBE") or "ffprobe"


@dataclass
class Options:
    fps: float = FPS                  # the source's own frame rate; the donor is resampled to it
    bare_threshold: float = 0.2       # original skin share of the frame above which the whole donor head is used (cowl off)
    ring_px: int = 61                 # bare head: donor head is limited to this kernel around the original's skin
    mask_smooth_frames: int = 2       # mask is averaged over +-this many frames (use 4 for fast head motion)
    feather_sigma: float = 1.2        # px, never a gradient into fabric
    flow_alpha: float = 0.4           # weight of the new frame in the flow-driven temporal blend (0.7 for fast motion)
    colour_lock: float = 0.25         # share of the new frame in the LAB match parameters (rest is the previous frame)
    bare_colour_strength: float = 0.55
    grain: float = 0.8                # share of the original's high-frequency noise added to the donor skin
    fabric_blue_minus_red: float = 11.0   # blue minus red at or above this (after a 2.5 px blur) is cowl, cape or collar fabric
    skin_blue_minus_red: float = 11.0     # below this and red above 20 counts as skin in the original
    flag_share: float = 0.15          # a frame is flagged when more than this share of the original's skin pixels is unchanged
    max_flicker_ratio: float = 1.25   # composite mouth flicker must stay at or below this times the original's
    region_head_scale: float = 2.4
    region_margin_frac: float = 0.25
    encode_halo_px: int = 32
    caption_edge_threshold: float = 120.0     # Sobel strength that counts as a text edge when judging caption residue
    max_caption_residue: float = 0.5  # the share of the caption's edges that may survive the erase
    reference_crops: list = field(default_factory=list)


def read_frames(path, vf, w, h, n, ss=None, t=None):
    """n RGB frames of `path` through ffmpeg filter `vf`, scaled to w x h by the caller's filter."""
    cmd = [FFMPEG, "-v", "error"]
    if ss is not None:
        cmd += ["-ss", str(ss)]
    if t is not None:
        cmd += ["-t", str(t)]
    cmd += ["-i", path, "-vf", vf, "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def write_video(frames, out, fps, w, h):
    p = subprocess.Popen([FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                          "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()


def lab(x):
    return cv2.cvtColor(np.clip(x, 0, 255).astype(np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)


def blue_minus_red(img):
    f = cv2.GaussianBlur(img.astype(np.float32), (0, 0), 2.5)
    return f[..., 2] - f[..., 0], f


def original_skin(img, o: Options):
    """Warm pixels are skin; cowl, cape and suit are blue-tinted. Holes inside a face-sized region (the mouth opening) are filled."""
    br, f = blue_minus_red(img)
    s = ((br < o.skin_blue_minus_red) & (f[..., 0] > 20)).astype(np.uint8)
    s = cv2.morphologyEx(s, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    s = cv2.morphologyEx(s, cv2.MORPH_CLOSE, np.ones((31, 31), np.uint8))
    cs, _ = cv2.findContours(s, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(s)
    for c in cs:
        if cv2.contourArea(c) > 3000:
            cv2.drawContours(out, [c], -1, 1, -1)
    return out


def donor_head(d):
    """Donor skin and hair against a dark background (low luminance floor: a shadowed cheek must not drop out of its own mask)."""
    ycc = cv2.cvtColor(d, cv2.COLOR_RGB2YCrCb)
    s = ((ycc[..., 1] > 110) & (ycc[..., 0] > 28)).astype(np.uint8)
    s = cv2.morphologyEx(s, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    s = cv2.morphologyEx(s, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    nl, lab_, st, _ = cv2.connectedComponentsWithStats(s)
    out = np.zeros_like(s)
    for c in range(1, nl):
        if st[c, cv2.CC_STAT_AREA] > 200:
            out[lab_ == c] = 1
    return out


def frame_masks(org, don, o: Options):
    """Per-frame float masks 0..1 at source size."""
    h, w = org.shape[1:3]
    raw = []
    for k in range(len(org)):
        ds = cv2.resize(donor_head(don[k]).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR) > 0.5
        sk = original_skin(org[k], o)
        if sk.mean() > o.bare_threshold:  # cowl off: whole donor head, only near the original's skin, never over fabric or empty background
            m = cv2.dilate(ds.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (17, 17)))
            m[int(h * 0.9):] = 0
            m = m & cv2.dilate(sk, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (o.ring_px, o.ring_px)))
            br, f = blue_minus_red(org[k])
            fab = ((br >= o.fabric_blue_minus_red) & (f.mean(2) >= 12)).astype(np.uint8)
            m = m & (1 - cv2.dilate(fab, np.ones((5, 5), np.uint8)))
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
        else:     # cowl on: donor skin only where the original shows skin; eye openings and fabric stay original
            m = (ds & (sk > 0)).astype(np.uint8)
        nl, lab_, st, _ = cv2.connectedComponentsWithStats(m)
        if nl > 1:
            m = (lab_ == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
        raw.append(m.astype(np.float32))
    out = []
    n = len(raw)
    for k in range(n):
        a = np.mean([raw[j] for j in range(max(0, k - o.mask_smooth_frames), min(n, k + o.mask_smooth_frames + 1))], axis=0)
        out.append(cv2.GaussianBlur((a > 0.5).astype(np.float32), (0, 0), o.feather_sigma))
    return out


def composite_frame(org, don_small, m, o: Options, state: dict):
    h, w = org.shape[:2]
    du = cv2.resize(don_small, (w, h), interpolation=cv2.INTER_CUBIC)
    sel = m > 0.5
    if sel.sum() < 800:
        return org
    lo, ld = lab(org), lab(du)
    so_ = sel & (lo[..., 0] >= np.median(lo[..., 0][sel]))   # match the brighter half (face tones) so hair and shadow stay out of the statistics
    sd_ = sel & (ld[..., 0] >= np.median(ld[..., 0][sel]))
    bare = sel.mean() > 0.10
    g = o.bare_colour_strength if bare else 1.0
    for c in range(3):
        mo, so, md, sd = lo[..., c][so_].mean(), lo[..., c][so_].std() + 1e-3, ld[..., c][sd_].mean(), ld[..., c][sd_].std() + 1e-3
        if c in state:
            mo, so, md, sd = [o.colour_lock * a + (1 - o.colour_lock) * b for a, b in zip((mo, so, md, sd), state[c])]
        state[c] = (mo, so, md, sd)
        ld[..., c] = (ld[..., c] - md) / sd * (g * so + (1 - g) * sd) + (g * mo + (1 - g) * md)
    dm = cv2.cvtColor(np.clip(ld, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
    f = org.astype(np.float32)
    gs = (f - cv2.GaussianBlur(f, (0, 0), 2))[sel].std()
    dm = dm + np.random.default_rng(1).normal(0, gs * o.grain, dm.shape).astype(np.float32)   # the donor is smooth; the footage has grain
    mm = m[..., None]
    return (org * (1 - mm) + dm * mm).clip(0, 255).astype(np.uint8)


def recolour_leftover(raw, org, masks, o: Options, regions=None):
    """Original skin the donor did not cover takes the donor's skin tone and keeps the original's light and shadow."""
    tone = None
    for k in range(len(raw)):
        sel = masks[k] > 0.5
        if sel.sum() > 800:
            tone = lab(raw[k])[sel].mean(0)
        if tone is None:
            continue
        region = regions[k] if regions is not None else np.ones(org[k].shape[:2], bool)
        res = ((original_skin(org[k], o) > 0) & (masks[k] < 0.5) & region).astype(np.uint8)
        res = cv2.dilate(res, np.ones((5, 5), np.uint8))
        if res.sum() < 300:
            continue
        lo = lab(org[k]); r = res > 0
        lo[..., 0] = np.where(r, np.clip((lo[..., 0] - lo[..., 0][r].mean()) * 0.8 + tone[0], 0, 255), lo[..., 0])
        lo[..., 1] = np.where(r, tone[1], lo[..., 1]); lo[..., 2] = np.where(r, tone[2], lo[..., 2])
        fill = cv2.cvtColor(np.clip(lo, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
        a = (cv2.GaussianBlur(res.astype(np.float32), (0, 0), 1.5) * region.astype(np.float32))[..., None]   # the feather never reaches outside the declared region
        raw[k] = (raw[k].astype(np.float32) * (1 - a) + fill * a).clip(0, 255).astype(np.uint8)


def flow_back(g_t, g_p):
    h, w = g_t.shape
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)); s = (max(8, w // 2), max(8, h // 2))
    f = cv2.calcOpticalFlowFarneback(clahe.apply(cv2.resize(g_t, s)), clahe.apply(cv2.resize(g_p, s)), None, 0.5, 4, 25, 3, 7, 1.5, 0)
    return cv2.resize(f, (w, h)) * (w / s[0])


def warp(img, flow):
    h, w = img.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def flicker(frames, masks, org):
    """Mean |frame_t - warp(frame_t-1)| inside the mask, warping with flow measured on the ORIGINAL footage (lower is steadier)."""
    vals = []
    for t in range(1, len(frames)):
        m = masks[t] > 0.5
        if m.sum() < 500:
            continue
        fl = flow_back(cv2.cvtColor(org[t], cv2.COLOR_RGB2GRAY), cv2.cvtColor(org[t - 1], cv2.COLOR_RGB2GRAY))
        vals.append(np.abs(frames[t].astype(np.float32) - warp(frames[t - 1].astype(np.float32), fl))[m].mean())
    return float(np.mean(vals)) if vals else 0.0


MAX_REFERENCES = 9
FACE_CASCADES = ("haarcascade_frontalface_default.xml", "haarcascade_frontalface_alt2.xml")


class ReferenceError(Exception):
    """A problem a person can fix, carried with a short code the caller maps to its own wording."""
    def __init__(self, code, line):
        super().__init__(line); self.code = code; self.line = line


def probe_size(path):
    probe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip().split(",")
    return int(probe[0]), int(probe[1])


def _iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    ix, iy = max(0, min(ax + aw, bx + bw) - max(ax, bx)), max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter / float(aw * ah + bw * bh - inter) if inter else 0.0


def find_faces(rgb, min_fraction=0.06):
    """Frontal face boxes (x, y, w, h), overlapping detections of the two bundled cascades merged. Face finding is OpenCV's own cascades (no model download);
    a profile or heavily covered face is not found, which the callers treat as 'no face' only for reference pictures."""
    gray = cv2.equalizeHist(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY))
    h, w = gray.shape
    size = max(24, int(min(w, h) * min_fraction))
    boxes = []
    for name in FACE_CASCADES:
        cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, name))
        for b in cascade.detectMultiScale(gray, 1.1, 5, minSize=(size, size)):
            boxes.append(tuple(int(v) for v in b))
    boxes.sort(key=lambda b: -b[2] * b[3])
    kept = []
    for b in boxes:
        if all(_iou(b, k) < 0.3 for k in kept):
            kept.append(b)
    return kept


def head_crop(rgb, face, out_size=512):
    """A square around one face with room for hair and chin, inside the picture."""
    h, w = rgb.shape[:2]
    x, y, fw, fh = face
    side = int(min(max(fw, fh) * 2.4, w, h))
    cx, cy = x + fw / 2.0, y + fh / 2.0 - fh * 0.1
    x0 = int(min(max(0, cx - side / 2.0), w - side)); y0 = int(min(max(0, cy - side / 2.0), h - side))
    crop = rgb[y0:y0 + side, x0:x0 + side]
    return cv2.resize(crop, (out_size, out_size), interpolation=cv2.INTER_AREA if side > out_size else cv2.INTER_CUBIC)


def make_reference_crops(paths, out_dir, out_size=512):
    """One crop per reference picture, each of exactly one face. More than nine pictures, a picture with no face and a picture with several people are each
    refused with the number of the picture and what to do."""
    if len(paths) > MAX_REFERENCES:
        raise ReferenceError("too_many_references", f"You sent {len(paths)} reference pictures and the swap takes up to {MAX_REFERENCES}. Send fewer.")
    os.makedirs(out_dir, exist_ok=True)
    crops = []
    for number, path in enumerate(paths, 1):
        bgr = cv2.imread(path)
        if bgr is None:
            raise ReferenceError("unreadable", f"Reference picture {number} could not be read. Send a PNG, JPEG or WebP picture.")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        faces = find_faces(rgb)
        if not faces:
            raise ReferenceError("no_face", f"No face was found in reference picture {number}. Use a clear picture of one person looking toward the camera.")
        if len(faces) > 1:
            raise ReferenceError("many_people", f"Reference picture {number} shows {len(faces)} people. Use a picture of one person, or crop the picture to one person first.")
        target = os.path.join(out_dir, f"reference-crop-{number}.png")
        cv2.imwrite(target, cv2.cvtColor(head_crop(rgb, faces[0], out_size), cv2.COLOR_RGB2BGR))
        crops.append(target)
    return crops


def detect_caption_box(frames, o: Options):
    """Burned-in captions: bright, outlined letters low in the picture, in a box that holds still while the words change. Returns (x, y, w, h) or None.
    A heuristic: it looks for bright pixels beside dark ones in the lower 55 percent, merges them into lines, and keeps lines found in at least 40 percent of
    the sampled frames."""
    boxes, hits = [], 0
    for f in frames:
        h, w = f.shape[:2]
        lo = int(h * 0.45)
        part = f[lo:]
        bright = (part.min(2) >= 215).astype(np.uint8)
        dark = (part.max(2) <= 60).astype(np.uint8)
        text = bright & cv2.dilate(dark, np.ones((5, 5), np.uint8))
        text = cv2.morphologyEx(text, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, w // 40), 5)))
        nl, _, st, _ = cv2.connectedComponentsWithStats(text)
        found = [(st[c, 0], st[c, 1] + lo, st[c, 2], st[c, 3]) for c in range(1, nl) if st[c, 4] >= 0.0015 * w * h and st[c, 2] >= 1.5 * st[c, 3] and st[c, 2] >= 0.08 * w]
        if found:
            hits += 1
            boxes += found
    if not boxes or hits < max(1, int(np.ceil(0.4 * len(frames)))):
        return None
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[0] + b[2] for b in boxes), max(b[1] + b[3] for b in boxes)
    pad_x, pad_y = int(0.02 * w), int(0.01 * h)
    box = (max(1, x0 - pad_x), max(1, y0 - pad_y), min(w - 2, x1 + pad_x) - max(1, x0 - pad_x), min(h - 2, y1 + pad_y) - max(1, y0 - pad_y))
    return box if box[2] * box[3] <= 0.35 * w * h else None


def head_touches_edge(frame, o: Options, ring=0.01):
    """True when the largest warm region (the head) reaches the left, top or right edge, so the head leaves the frame and the donor needs canvas around it.
    The bottom edge is ignored: a neck and shoulders always leave there."""
    skin = original_skin(frame, o)
    nl, labels, st, _ = cv2.connectedComponentsWithStats(skin)
    if nl < 2:
        return False
    c = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, bw, bh = st[c, 0], st[c, 1], st[c, 2], st[c, 3]
    h, w = skin.shape
    return bool(x <= ring * w or y <= ring * h or x + bw >= (1 - ring) * w)


def analyze_clip(source, start, seconds, segments, o: Options, frames_per_segment=3):
    """Before any model runs: the caption box (or None), how many people appear, and per segment whether the head leaves the frame.
    `segments` is a list of [start, seconds] in the source's own time."""
    w, h = probe_size(source)
    everything, flags = [], []
    for seg_start, seg_seconds in segments or [[start, seconds]]:
        count = frames_per_segment
        got = read_frames(source, f"fps={count / max(seg_seconds, 0.05):.4f},scale={w}:{h}", w, h, count, ss=seg_start, t=seg_seconds)
        everything += list(got)
        flags.append({"edge_contact": bool(len(got) and sum(head_touches_edge(f, o) for f in got) * 2 >= len(got))})
    caption = detect_caption_box(everything, o)
    scale = 480.0 / max(w, h)
    many = 0
    people_max = 0
    for f in everything:
        small = cv2.resize(f, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else f
        faces = [b for b in find_faces(small, 0.08)]
        people_max = max(people_max, len(faces))
        many += 1 if len(faces) > 1 else 0
    return {"caption_box": list(caption) if caption else None, "size": [w, h], "people_max": people_max, "many_people_share": (many / len(everything)) if everything else 0.0, "segments": flags}


def clamp_box(box, w, h):
    """A caption box kept strictly inside the frame (the erase filter refuses a box that touches or leaves the edge)."""
    x, y, bw, bh = [int(v) for v in box]
    x, y = max(1, x), max(1, y)
    bw, bh = min(bw, w - 1 - x), min(bh, h - 1 - y)
    if bw < 4 or bh < 4:
        raise ValueError("The caption box is outside the picture. Check the box and try again.")
    return x, y, bw, bh


NO_EDIT_REGION_LINE = "No face was found to define the area the swap may change. Use a clip where the person's face is visible, then try again."

def _shape_mask(entry, h, w, options: Options, grow):
    """One frame's region from a box [x, y, w, h], {"ellipse": [cx, cy, rx, ry]} or {"polygon": [[x, y], ...]}, grown by the margin. None (the target is absent
    in this frame) gives an empty region: any edit in that frame fails."""
    mask = np.zeros((h, w), np.uint8)
    if entry is None:
        return mask.astype(bool)
    if isinstance(entry, dict):
        if "ellipse" in entry:
            cx, cy, rx, ry = [float(v) for v in entry["ellipse"]]
            cv2.ellipse(mask, (int(round(cx)), int(round(cy))), (max(1, int(round(rx))), max(1, int(round(ry)))), 0, 0, 360, 1, -1); extent = 2 * max(rx, ry)
        elif "polygon" in entry:
            pts = np.array([[int(round(float(px))), int(round(float(py)))] for px, py in entry["polygon"]], np.int32)
            if len(pts) < 3: raise ValueError("A polygon in the edit region file needs at least three points.")
            cv2.fillPoly(mask, [pts], 1); extent = float(max(pts[:, 0].max() - pts[:, 0].min(), pts[:, 1].max() - pts[:, 1].min()))
        else:
            raise ValueError("An edit region entry must be a box [x, y, w, h], an ellipse, a polygon or null.")
        margin = int(round(options.region_margin_frac * extent))
        if margin > 0: mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * margin + 1, 2 * margin + 1)))
        return mask.astype(bool)
    x, y, fw, fh = [float(v) for v in entry]; side = max(fw, fh)
    bw, bh = fw * grow, fh * grow
    mx = my = options.region_margin_frac * side
    x0, y0 = max(0, int(np.floor(x + fw / 2 - bw / 2 - mx))), max(0, int(np.floor(y + fh / 2 - bh / 2 - my)))
    x1, y1 = min(w, int(np.ceil(x + fw / 2 + bw / 2 + mx))), min(h, int(np.ceil(y + fh / 2 + bh / 2 + my)))
    if x1 > x0 and y1 > y0: mask[y0:y1, x0:x1] = 1
    return mask.astype(bool)


def declare_edit_region(org_frames, options: Options, supplied=None):
    """Build independent per-frame allowed-change regions from supplied shapes or source face detections. A supplied file is {"box": [x, y, w, h]} for every
    frame, or {"boxes": [...]} with one entry per frame; each entry is a box [x, y, w, h], {"ellipse": [cx, cy, rx, ry]}, {"polygon": [[x, y], ...]} or null.
    null means the target is absent in that frame: the region is empty and any edit in that frame fails."""
    n = len(org_frames)
    if supplied is not None:
        if isinstance(supplied, dict):
            boxes = [supplied["box"]] * n if "box" in supplied else supplied.get("boxes", [])
        else: boxes = supplied
        if isinstance(boxes, (list, tuple)) and len(boxes) == 4 and all(isinstance(v, (int, float)) for v in boxes): boxes = [boxes] * n
        if len(boxes) != n: raise ValueError("The edit region file must provide one entry per frame or one static box.")
        source = "supplied"
    else:
        boxes = []; last = None; first = None; source = "detected"
        for frame in org_frames:
            h, w = frame.shape[:2]; scale = min(1.0, 480.0 / max(w, h))
            small = cv2.resize(frame, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA) if scale < 1 else frame
            faces = find_faces(small)
            face = max(faces, key=lambda b: b[2] * b[3]) if faces else None
            if face:
                last = tuple(int(round(v / scale)) for v in face); first = first or last
            boxes.append(last)
        if first is None: raise ReferenceError("no_edit_region", NO_EDIT_REGION_LINE)
        first_index = next(i for i, b in enumerate(boxes) if b is not None)
        boxes[:first_index] = [first] * first_index
    grow = options.region_head_scale if source == "detected" else 1.0   # a face box is grown to a head; a supplied shape is already the caller's head area
    regions = [_shape_mask(box, *frame.shape[:2], options, grow) for frame, box in zip(org_frames, boxes)]
    return regions, source

def pre_encode_check(org, out, regions):
    counts, frames = [], []
    for i, (a, b, region) in enumerate(zip(org, out, regions)):
        changed = np.any(a != b, axis=2) & ~region
        count = int(changed.sum()); counts.append(count)
        if count: frames.append(i)
    return int(sum(counts)), frames, counts

def halo_outside(region, halo):
    """Pixels farther than `halo` px from the declared region (the encoder spreads an edit a few macroblocks)."""
    return cv2.dilate(region.astype(np.uint8), np.ones((2 * halo + 1, 2 * halo + 1), np.uint8)) == 0

DRIFT_REACH_PX = 15        # how far from the control's persistent drift a delivered area may sit and still count as the same drifting edge
DRIFT_OVERLAP = 0.5        # share of a persistent area that must lie on the control's drift for the whole area to be called encoder drift


def persistent_votes(a_frames, b_frames, outside, minimum):
    """Pixels where the two encodes differ by more than 8 levels in at least `minimum` frames at the same place."""
    votes = np.zeros(outside[0].shape, np.int32)
    for a, b, o in zip(a_frames, b_frames, outside):
        votes += ((np.abs(a.astype(np.int16) - b.astype(np.int16)).max(2) > 8) & o).astype(np.int32)
    return votes >= minimum


def judge_areas(delivered_votes, control_votes):
    """Splits the delivered file's persistent areas into those a control explains (at least half of the area lies within 15 px of where the control is
    persistently moved too: encoder drift) and those it does not. Returns (the mask that counts, the number of pixels explained)."""
    near_drift = cv2.dilate(control_votes.astype(np.uint8), np.ones((2 * DRIFT_REACH_PX + 1, 2 * DRIFT_REACH_PX + 1), np.uint8)) > 0
    joined = cv2.dilate(delivered_votes.astype(np.uint8), np.ones((5, 5), np.uint8))
    count, labels, _, _ = cv2.connectedComponentsWithStats(joined, 8)
    counted = np.zeros_like(delivered_votes); masked = 0
    for c in range(1, count):
        area = (labels == c) & delivered_votes
        pixels = int(area.sum())
        if pixels == 0: continue
        if int((area & near_drift).sum()) >= DRIFT_OVERLAP * pixels: masked += pixels
        else: counted |= area
    return counted, masked


def encoded_preservation_check(source_encoded, delivered, control_encoded, regions, halo):
    """Delivered file against a source-only encode made with the same settings, outside the region plus a halo. A pixel is persistent when it differs by more
    than 8 levels in at least max(5, 10 percent of the frames) frames at the same place (a real edit stays put, encoder drift flickers). A persistent area is
    judged as a whole: when at least half of it lies within 15 px of where the drift control (the source with a violent edit inside the region only, encoded
    the same way) is persistently moved too, it is encoder drift, the kind a hard-edged caption or logo shows even in frames nothing touched, and it does not
    count. A persistent area of 50 pixels or more that the control does not explain fails the clip. This is not a tolerance: a faint change or an altered
    face outside the region is not where the control drifts. Limit: an edit that sits on a drifting edge is explained by it; the exact pre-encode check, which
    the worker runs on its own composite, is the guard for that case."""
    outside = [halo_outside(r, halo) for r in regions]
    if not source_encoded: return dict(persistent_pixels=0, largest_blob_px=0, share_gt8=0.0, max_diff=0, drift_masked_px=0)
    minimum = max(5, int(np.ceil(0.1 * len(source_encoded))))
    delivered_votes = persistent_votes(source_encoded, delivered, outside, minimum)
    control_votes = persistent_votes(source_encoded, control_encoded, outside, minimum)
    counted, masked = judge_areas(delivered_votes, control_votes)
    n2, _, stats, _ = cv2.connectedComponentsWithStats(counted.astype(np.uint8), 8)
    sizes = stats[1:, cv2.CC_STAT_AREA] if n2 > 1 else []
    diffs = [np.abs(a.astype(np.int16) - b.astype(np.int16)).max(2) for a, b in zip(source_encoded, delivered)]
    total = sum(int(o.sum()) for o in outside)
    changed = sum(int(((d > 8) & o).sum()) for d, o in zip(diffs, outside))
    return dict(persistent_pixels=int(counted.sum()), largest_blob_px=int(max(sizes) if len(sizes) else 0), share_gt8=changed / max(1, total), max_diff=int(max(d.max() for d in diffs)),
                drift_masked_px=int(masked))


def caption_edge_count(frame, box, o: Options):
    x, y, bw, bh = box
    g = cv2.cvtColor(frame[y:y + bh, x:x + bw], cv2.COLOR_RGB2GRAY).astype(np.float32)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3), cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return int((np.hypot(gx, gy) > o.caption_edge_threshold).sum())


def caption_residue(before, after, box, o: Options):
    """Mean over the frames that had caption edges of (edges left after the erase / edges before). 0 is clean, 1 is untouched. None when no frame had text."""
    ratios = []
    for b, a in zip(before, after):
        eb = caption_edge_count(b, box, o)
        if eb >= 20:
            ratios.append(min(1.0, caption_edge_count(a, box, o) / eb))
    return float(np.mean(ratios)) if ratios else None


STRONG_LEVELS = 24      # a change this strong, in one frame, in a compact blob is not encoder drift whatever the pipeline
STRONG_BLOB_PX = 100    # compact: survives a 3x3 opening, at least this many pixels


def strong_blob(source_encoded, delivered, outside):
    """The largest compact blob of strong change (more than 24 levels, after a 3x3 opening) outside the region in any single frame, against the source-only encode."""
    kernel = np.ones((3, 3), np.uint8); largest = 0
    for a, b, x in zip(source_encoded, delivered, outside):
        mask = cv2.morphologyEx((((np.abs(a.astype(np.int16) - b.astype(np.int16)).max(2) > STRONG_LEVELS) & x)).astype(np.uint8), cv2.MORPH_OPEN, kernel)
        count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        if count > 1: largest = max(largest, int(stats[1:, cv2.CC_STAT_AREA].max()))
    return largest


def encoded_check_on_file(org, back, regions, o: Options, base, w, h):
    """The post-encode check for a delivered file read back as `back`: a source-only encode and a drift control with the same encoder settings, the persistence
    rule, the strong-change gate, and a changed-pixel map written beside `base`. Returns (encoded numbers, map path)."""
    n = len(org)
    srcenc, ctl = base + ".srcenc.mp4", base + ".ctl.mp4"
    try:
        write_video(org, srcenc, o.fps, w, h)       # the same encoder settings on the untouched source: the delivered file is judged against this, not against a fixed tolerance
        inverted = [np.where(r[..., None], 255 - f, f).astype(np.uint8) for f, r in zip(org, regions)]
        write_video(inverted, ctl, o.fps, w, h)     # the drift control: a violent edit inside the region only, to see where the encoder moves untouched pixels
        srcback = list(read_frames(srcenc, f"fps={o.fps}", w, h, n)); ctlback = list(read_frames(ctl, f"fps={o.fps}", w, h, n))
    finally:
        for path in (srcenc, ctl):
            try: os.unlink(path)
            except OSError: pass
    outside = [halo_outside(r, o.encode_halo_px) for r in regions[:len(back)]]
    encoded = encoded_preservation_check(srcback, back, ctlback, regions[:len(back)], o.encode_halo_px)
    encoded["strong_blob_px"] = strong_blob(srcback, back, outside)
    map_path = base + ".changedmap.png"
    original = org[0].copy(); overlay = original.copy()
    for a, b, x in zip(srcback, back, outside):
        overlay[(np.abs(a.astype(np.int16) - b.astype(np.int16)).max(2) > 8) & x] = (255, 0, 0)   # the same pixels the verdict counts
    contours, _ = cv2.findContours(regions[0].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(overlay, contours, -1, (0, 255, 0), 2)
    cv2.imwrite(map_path, cv2.cvtColor(np.hstack([original, overlay]), cv2.COLOR_RGB2BGR))
    return encoded, map_path


COLOR_MATRIX_BOUND = 0.15     # how far each entry of the fitted 3x3 may be from the identity
COLOR_SHIFT_BOUND = 10.0      # levels the transform may move the colors present in the clip (99th percentile)
FAIL_PERSISTENT_PX = 500      # a persistent unexplained area this large is an edit, not an encoder's ringing


def fit_color_transform(org, back, outside, seed=0, per_frame=6000):
    """A global transform between the decoded source and the delivered file: delivered = M * source + offset (a 3x3 and an offset), fitted over pixels outside the
    declared region (null-region frames: the whole frame), robustly (iteratively reweighted, residuals above four median deviations are dropped). A different color
    path (matrix, range) is exactly this, the same in every frame; a local edit is not, so it survives as a residual. Returns (matrix 3x3, offset 3, within bounds)."""
    rng = np.random.default_rng(seed); xs, ys = [], []
    for k in range(0, len(org), 3):
        idx = np.flatnonzero(outside[k].ravel())
        if idx.size == 0: continue
        pick = rng.choice(idx, min(idx.size, per_frame), replace=False)
        xs.append(org[k].reshape(-1, 3)[pick]); ys.append(back[k].reshape(-1, 3)[pick])
    if not xs: return np.eye(3), np.zeros(3), False
    x = np.concatenate(xs).astype(np.float64); y = np.concatenate(ys).astype(np.float64); x1 = np.hstack([x, np.ones((len(x), 1))])
    weight = np.ones(len(x)); coef = np.vstack([np.eye(3), np.zeros((1, 3))])
    # a ridge toward "no change" keeps the fit sane when the clip has few distinct colors (the data alone cannot pin a 3x3 down); real footage's colors outweigh it
    prior = np.sqrt(0.01 * len(x) * 400.0) * np.hstack([np.eye(3), np.zeros((3, 1))]); prior_target = np.sqrt(0.01 * len(x) * 400.0) * np.eye(3)
    with np.errstate(all="ignore"):
        for _ in range(6):
            root = np.sqrt(weight)[:, None]
            coef = np.linalg.lstsq(np.vstack([x1 * root, prior]), np.vstack([y * root, prior_target]), rcond=None)[0]
            residual = np.abs(x1 @ coef - y).max(1); spread = float(np.median(residual)) + 1e-6
            weight = (residual < 4 * spread + 2).astype(np.float64)
    matrix, offset = coef[:3].T, coef[3]          # delivered = matrix @ source + offset
    # The size that matters is what the transform does to the colors actually present, so it is bounded there (a clip with few distinct colors cannot pin the
    # matrix down, but the colors it has are explained or not): at most 10 levels at the 99th percentile, and no wild matrix.
    with np.errstate(all="ignore"):
        shift = np.abs(x @ matrix.T + offset - x).max(1)
    ok = bool(np.all(np.isfinite(matrix)) and np.abs(matrix - np.eye(3)).max() <= COLOR_MATRIX_BOUND and float(np.percentile(shift, 99)) <= COLOR_SHIFT_BOUND)
    return matrix, offset, ok


def apply_color_transform(frame, matrix, offset):
    with np.errstate(all="ignore"):
        out = frame.reshape(-1, 3).astype(np.float64) @ matrix.T + offset
    return np.clip(np.rint(out), 0, 255).astype(np.uint8).reshape(frame.shape)


def foreign_check(org, back, regions, o: Options, base, w, h):
    """The post-encode check for a delivered file another tool encoded. Nothing is learned from the delivered file's own pixels as a tolerance: a tolerance taken
    from frames not shown to match the source would excuse exactly the edits this check exists to catch. What is modeled is what a different pipeline really
    does, a global color transform (fitted robustly, bounded; out of bounds is `inconclusive`). The source is corrected by it, encoded here with the worker's
    settings, and the delivered file is judged against that by the same persistence rule, drift control and strong-change gate as the worker's own composites.
    Frames whose region is empty (the target was absent) have no declared edit and are checked over the whole frame. A persistent unexplained area of 500 pixels
    or more, or a strong compact change, fails; 50 to 499 pixels is `inconclusive` (`unknown_encoder`); below that it passes. Returns (encoded numbers, baseline,
    verdict, reasons, map path)."""
    outside = [halo_outside(r, o.encode_halo_px) for r in regions]
    matrix, offset, ok = fit_color_transform(org, back, outside)
    baseline = {"source": "global_color_transform", "matrix": np.round(matrix, 4).tolist(), "offset": np.round(offset, 2).tolist(), "within_bounds": ok}
    if not ok:
        return ({"persistent_pixels": 0, "largest_blob_px": 0, "share_gt8": 0.0, "max_diff": 0, "drift_masked_px": 0, "strong_blob_px": 0}, baseline, "inconclusive",
                ["unknown_encoder: the delivered clip's colors differ from the source by more than a different color conversion would explain, so no change can be told from a color path. Check it by eye."], None)
    corrected = [apply_color_transform(f, matrix, offset) for f in org]
    encoded, map_path = encoded_check_on_file(corrected, back, regions, o, base, w, h)
    reasons = []
    if encoded["strong_blob_px"] >= STRONG_BLOB_PX or encoded["largest_blob_px"] >= FAIL_PERSISTENT_PX:
        verdict = "fail"; reasons.append("A change was found outside the declared edit region.")
    elif encoded["largest_blob_px"] >= 50:
        verdict = "inconclusive"
        reasons.append("unknown_encoder: this clip was encoded by another tool, and a small persistent difference of "
                       f"{encoded['largest_blob_px']} pixels outside the declared region cannot be told from that tool's own edge handling. Check it by eye, or run the swap through this worker so it makes the one encode.")
    else:
        verdict = "pass"
    return encoded, baseline, verdict, reasons, map_path


def verify_delivered(source, delivered, start=0.0, seconds=2.3333, caption_box=None, edit_region=None, options: Options | None = None, base=None):
    """Judge a delivered file that this worker did not make (a swap from another tool). The pre-encode exact check cannot run on a file, so the report says
    `pre_encode: not_run`. The delivered file is compared with the decoded source, and the file's own frames that the swap did not touch measure its encoder's
    drift (see foreign_check); the verdict is pass, fail or inconclusive."""
    o = options or Options()
    w, h = probe_size(delivered)
    n = int(round(seconds * o.fps))
    vf = (f"delogo=x={caption_box[0]}:y={caption_box[1]}:w={caption_box[2]}:h={caption_box[3]}," if caption_box else "") + f"fps={o.fps},scale={w}:{h}"
    org = read_frames(source, vf, w, h, n, ss=start, t=seconds)
    back = read_frames(delivered, f"fps={o.fps}", w, h, len(org))
    compared = min(len(org), len(back)); mismatch = abs(len(org) - len(back)) > 1
    org, back = org[:compared], back[:compared]
    regions, region_source = declare_edit_region(list(org), o, edit_region)
    if caption_box:
        x, y, bw, bh = caption_box
        for r in regions: r[y:y + bh, x:x + bw] = True
    encoded, baseline, verdict, reasons, map_path = foreign_check(list(org), list(back), regions, o, base or delivered, w, h)
    if mismatch:
        verdict = "fail"; reasons.append("The delivered clip and the source differ in length by more than one frame, so they cannot be compared.")
    return {"frames": len(org), "size": [w, h], "frames_compared": compared,
            "edit_region": {"source": region_source, "head_scale": o.region_head_scale, "margin_frac": o.region_margin_frac, "frames_with_region": sum(bool(r.any()) for r in regions)},
            "preservation": {"verdict": verdict, "pre_encode": "not_run", "changed_pixels": None, "violating_frames": [], "baseline": baseline, "encoded": encoded, "map_path": map_path, "reasons": reasons}}


def composite_swap(source, donor, out=None, start=0.0, seconds=2.3333, size=None, caption_box=None, reference_crops=(), options: Options | None = None, report_path=None, edit_region=None):
    """Returns (frames, report). Writes `out` when given."""
    o = options or Options()
    o.reference_crops = list(reference_crops)
    probe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", source], capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = (int(probe[0]), int(probe[1])) if size is None else size
    n = int(round(seconds * o.fps))
    if caption_box:
        caption_box = clamp_box(caption_box, w, h)
    vf = (f"delogo=x={caption_box[0]}:y={caption_box[1]}:w={caption_box[2]}:h={caption_box[3]}," if caption_box else "") + f"fps={o.fps},scale={w}:{h}"
    org = read_frames(source, vf, w, h, n, ss=start, t=seconds)
    with_text = read_frames(source, f"fps={o.fps},scale={w}:{h}", w, h, n, ss=start, t=seconds) if caption_box else None
    dprobe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", donor], capture_output=True, text=True, check=True).stdout.strip().split(",")
    dw, dh = int(dprobe[0]), int(dprobe[1])
    don = read_frames(donor, f"fps={o.fps}", dw, dh, n)
    n = min(len(org), len(don)); org, don = org[:n], don[:n]
    regions, region_source = declare_edit_region(org, o, edit_region)
    if caption_box:
        x, y, bw, bh = caption_box
        for r in regions: r[y:y + bh, x:x + bw] = True
    masks = frame_masks(org, don, o); clipped = sum(int(np.count_nonzero((m > 0) & ~r)) for m, r in zip(masks, regions))
    masks = [m * r.astype(np.float32) for m, r in zip(masks, regions)]; state: dict = {}
    raw = [composite_frame(org[k], don[k], masks[k], o, state) for k in range(n)]
    recolour_leftover(raw, org, masks, o, regions)
    outf = [raw[0]]
    for t in range(1, n):   # flow measured on the ORIGINAL carries the filtered donor texture, so the donor's own jitter cannot show
        fl = flow_back(cv2.cvtColor(org[t], cv2.COLOR_RGB2GRAY), cv2.cvtColor(org[t - 1], cv2.COLOR_RGB2GRAY))
        m = masks[t][..., None]
        blend = o.flow_alpha * raw[t].astype(np.float32) + (1 - o.flow_alpha) * warp(outf[t - 1].astype(np.float32), fl)
        outf.append((org[t] * (1 - m) + blend * m).clip(0, 255).astype(np.uint8))
    fo, fr, fa = flicker(list(org), masks, org), flicker(raw, masks, org), flicker(outf, masks, org)
    flagged = []
    for k in range(n):
        head = cv2.erode(original_skin(org[k], o), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))) > 0
        if head.sum() >= 2000:
            share = float(((np.abs(org[k].astype(int) - outf[k].astype(int)).max(2) <= 4) & head).sum() / head.sum())
            if share > o.flag_share:
                flagged.append([k, round(share, 3)])
    changed, violating, _ = pre_encode_check(org, outf, regions)
    preservation = {"verdict": "fail" if changed else "pass", "pre_encode": "run", "changed_pixels": changed, "violating_frames": violating,
                    "encoded": None, "map_path": None, "reasons": (["Pixels outside the declared edit region changed before encoding."] if changed else [])}
    report = {"frames": n, "size": [w, h], "mouth_flicker_original": fo, "mouth_flicker_raw": fr, "mouth_flicker_filtered": fa,
              "flicker_ratio": (fa / fo) if fo else None, "flicker_ok": (fa <= o.max_flicker_ratio * fo) if fo else True,
              "residual_original_head_frames": flagged, "edit_region": {"source": region_source, "head_scale": o.region_head_scale, "margin_frac": o.region_margin_frac, "frames_with_region": sum(bool(r.any()) for r in regions)}, "mask_clipped_pixels": clipped, "preservation": preservation,
              "caption_box": list(caption_box) if caption_box else None,
              "caption_residue": caption_residue(with_text, outf, caption_box, o) if caption_box else None,
              "options": asdict(o)}
    if out:
        write_video(outf, out, o.fps, w, h)
        back = read_frames(out, f"fps={o.fps}", w, h, n)
        encoded, map_path = encoded_check_on_file(org, list(back), regions, o, out, w, h)
        preservation["encoded"] = encoded; preservation["map_path"] = map_path
        if encoded["largest_blob_px"] >= 50 or encoded["strong_blob_px"] >= STRONG_BLOB_PX:
            preservation["verdict"] = "fail"; preservation["reasons"].append("A changed area was found outside the declared edit region.")
    if report_path:
        with open(report_path, "w") as handle:
            json.dump(report, handle, indent=1)
    return outf, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=("composite", "analyze", "crops", "verify"), default="composite")
    ap.add_argument("--source"); ap.add_argument("--donor"); ap.add_argument("--out"); ap.add_argument("--delivered", help="verify: the delivered clip to judge")
    ap.add_argument("--start", type=float, default=0.0); ap.add_argument("--seconds", type=float, default=2.3333)
    ap.add_argument("--caption-box", default=None, help="x,y,w,h of burned-in text to erase first"); ap.add_argument("--report", default=None)
    ap.add_argument("--flow-alpha", type=float, default=0.4); ap.add_argument("--mask-smooth-frames", type=int, default=2); ap.add_argument("--fps", type=float, default=FPS)
    ap.add_argument("--edit-region-file", default=None)
    ap.add_argument("--segments", default=None, help="analyze: start:seconds pairs in source time, comma separated")
    ap.add_argument("--references", default=None, help="crops: reference picture paths, comma separated"); ap.add_argument("--out-dir", default=None)
    a = ap.parse_args(argv)
    try:
        if a.mode == "crops":
            if not a.references or not a.out_dir:
                raise ValueError("The crops step needs --references and --out-dir.")
            result = {"crops": make_reference_crops([x for x in a.references.split(",") if x], a.out_dir)}
        elif a.mode == "verify":
            for label, path in (("source clip", a.source), ("delivered clip", a.delivered)):
                if not path or not os.path.exists(path):
                    raise FileNotFoundError(f"The {label} was not found. Check the path, then try again.")
            box = tuple(int(x) for x in a.caption_box.split(",")) if a.caption_box else None
            supplied = json.load(open(a.edit_region_file)) if a.edit_region_file else None
            result = verify_delivered(a.source, a.delivered, a.start, a.seconds, box, supplied, Options(fps=a.fps))
        elif a.mode == "analyze":
            if not a.source or not os.path.exists(a.source):
                raise FileNotFoundError("The source clip was not found. Check that the swap produced it, then try again.")
            segs = [[float(v) for v in pair.split(":")] for pair in a.segments.split(",")] if a.segments else None
            result = analyze_clip(a.source, a.start, a.seconds, segs, Options())
        else:
            for label, path in (("source clip", a.source), ("donor clip", a.donor)):
                if not path or not os.path.exists(path):
                    raise FileNotFoundError(f"The {label} was not found. Check that the swap produced it, then try again.")
            if not a.out:
                raise ValueError("The composite step needs --out.")
            opt = Options(flow_alpha=a.flow_alpha, mask_smooth_frames=a.mask_smooth_frames, fps=a.fps)
            box = tuple(int(x) for x in a.caption_box.split(",")) if a.caption_box else None
            supplied = json.load(open(a.edit_region_file)) if a.edit_region_file else None
            _, rep = composite_swap(a.source, a.donor, a.out, a.start, a.seconds, caption_box=box, options=opt, report_path=a.report, edit_region=supplied)
            result = {k: v for k, v in rep.items() if k != "options"}
    except ReferenceError as e:
        print(json.dumps({"error": e.line, "code": e.code}))
        return 2
    except Exception as e:  # one plain line for the caller: what went wrong, what to do
        print(json.dumps({"error": str(e) or "The composite step could not finish. Try the swap again."}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
