"""composite_swap_worker (COMPOSITE-SWAP-01): put a donor head into REAL footage and change nothing else. Model-independent; no network.

A guided head-swap generator redraws the whole frame, so its clip is only a donor. This module keeps every original pixel outside a head mask and takes
colour-matched donor pixels inside it. Method, numbers and known imperfections: docs/design/swap-composite-lessons-2026-11-17.md in the Home repo.

Usage (library):
    report = composite_swap(source="in.mp4", donor="donor.mp4", out="out.mp4", start=0.0, seconds=2.333, reference_crops=["a.png"],
                            caption_box=(170, 1540, 740, 135))
Usage (command line):
    python composite_swap.py --source in.mp4 --donor donor.mp4 --out out.mp4 --start 0 --seconds 2.333 [--caption-box x,y,w,h] [--report r.json]

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
FFMPEG = os.environ.get("COMPOSITE_SWAP_FFMPEG", "ffmpeg")      # the Stack passes its own ffmpeg and ffprobe
FFPROBE = os.environ.get("COMPOSITE_SWAP_FFPROBE", "ffprobe")


@dataclass
class Options:
    fps: int = FPS
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


def recolour_leftover(raw, org, masks, o: Options):
    """Original skin the donor did not cover takes the donor's skin tone and keeps the original's light and shadow."""
    tone = None
    for k in range(len(raw)):
        sel = masks[k] > 0.5
        if sel.sum() > 800:
            tone = lab(raw[k])[sel].mean(0)
        if tone is None:
            continue
        res = ((original_skin(org[k], o) > 0) & (masks[k] < 0.5)).astype(np.uint8)
        res = cv2.dilate(res, np.ones((5, 5), np.uint8))
        if res.sum() < 300:
            continue
        lo = lab(org[k]); r = res > 0
        lo[..., 0] = np.where(r, np.clip((lo[..., 0] - lo[..., 0][r].mean()) * 0.8 + tone[0], 0, 255), lo[..., 0])
        lo[..., 1] = np.where(r, tone[1], lo[..., 1]); lo[..., 2] = np.where(r, tone[2], lo[..., 2])
        fill = cv2.cvtColor(np.clip(lo, 0, 255).astype(np.uint8), cv2.COLOR_LAB2RGB).astype(np.float32)
        a = cv2.GaussianBlur(res.astype(np.float32), (0, 0), 1.5)[..., None]
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


def composite_swap(source, donor, out=None, start=0.0, seconds=2.3333, size=None, caption_box=None, reference_crops=(), options: Options | None = None, report_path=None):
    """Returns (frames, report). Writes `out` when given."""
    o = options or Options()
    o.reference_crops = list(reference_crops)
    probe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", source], capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = (int(probe[0]), int(probe[1])) if size is None else size
    n = int(round(seconds * o.fps))
    vf = (f"delogo=x={caption_box[0]}:y={caption_box[1]}:w={caption_box[2]}:h={caption_box[3]}," if caption_box else "") + f"fps={o.fps},scale={w}:{h}"
    org = read_frames(source, vf, w, h, n, ss=start, t=seconds)
    dprobe = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", donor], capture_output=True, text=True, check=True).stdout.strip().split(",")
    dw, dh = int(dprobe[0]), int(dprobe[1])
    don = read_frames(donor, f"fps={o.fps}", dw, dh, n)
    n = min(len(org), len(don)); org, don = org[:n], don[:n]
    masks = frame_masks(org, don, o); state: dict = {}
    raw = [composite_frame(org[k], don[k], masks[k], o, state) for k in range(n)]
    recolour_leftover(raw, org, masks, o)
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
    outside, recoloured = [], []
    for k in range(n):   # pixels farther than 12 px from the mask must be identical to the original, except original skin that was recoloured on purpose
        far = cv2.dilate((masks[k] > 0.001).astype(np.uint8), np.ones((25, 25), np.uint8)) == 0
        skin = cv2.dilate(original_skin(org[k], o), np.ones((15, 15), np.uint8)) > 0
        d = np.abs(org[k].astype(int) - outf[k].astype(int)).max(2) > 0
        outside.append(int((d & far & ~skin).sum())); recoloured.append(int((d & far & skin).sum()))
    report = {"frames": n, "size": [w, h], "mouth_flicker_original": fo, "mouth_flicker_raw": fr, "mouth_flicker_filtered": fa,
              "flicker_ratio": (fa / fo) if fo else None, "flicker_ok": (fa <= o.max_flicker_ratio * fo) if fo else True,
              "residual_original_head_frames": flagged, "outside_mask_pixels_changed": int(sum(outside)), "recoloured_leftover_skin_pixels": int(sum(recoloured)), "options": asdict(o)}
    if out:
        write_video(outf, out, o.fps, w, h)
    if report_path:
        json.dump(report, open(report_path, "w"), indent=1)
    return outf, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True); ap.add_argument("--donor", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--start", type=float, default=0.0); ap.add_argument("--seconds", type=float, default=2.3333)
    ap.add_argument("--caption-box", default=None, help="x,y,w,h of burned-in text to erase first"); ap.add_argument("--report", default=None)
    ap.add_argument("--flow-alpha", type=float, default=0.4); ap.add_argument("--mask-smooth-frames", type=int, default=2)
    a = ap.parse_args(argv)
    try:
        for label, path in (("source clip", a.source), ("donor clip", a.donor)):
            if not os.path.exists(path):
                raise FileNotFoundError(f"The {label} was not found. Check that the swap produced it, then try again.")
        opt = Options(flow_alpha=a.flow_alpha, mask_smooth_frames=a.mask_smooth_frames)
        box = tuple(int(x) for x in a.caption_box.split(",")) if a.caption_box else None
        _, rep = composite_swap(a.source, a.donor, a.out, a.start, a.seconds, caption_box=box, options=opt, report_path=a.report)
    except Exception as e:  # one plain line for the caller: what went wrong, what to do
        print(json.dumps({"error": str(e) or "The composite step could not finish. Try the swap again."}))
        return 2
    print(json.dumps({k: v for k, v in rep.items() if k != "options"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
