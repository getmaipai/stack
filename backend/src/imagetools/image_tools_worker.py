"""The Stack's image tools worker (IMAGETOOLS-01): background removal, erase
(inpainting), upscale and resize on images the person already has.

One request per line on stdin (JSON), one reply per line on stdout. The
images travel as files the Stack wrote under its own data directory; the
worker never opens a socket and never reads a path it was not given. It
runs offline always: the models are ONNX files the Stack placed and
verified, and onnxruntime asks nobody for anything.

Every output is a freshly encoded PNG with no metadata (no EXIF, no GPS,
no colour profile): the input is decoded, its orientation applied, and only
the pixels travel on. Models load on demand and one at a time (the previous
session is dropped first), so the worker's memory is the largest single
model, not the sum. The Stack stops the worker when it has been idle.
"""
import gc
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import zlib

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 120_000_000
ort.set_default_logger_severity(3)

MEGAPIXEL = 1_000_000
# What each operation accepts, in megapixels. The Stack tells the person
# these numbers; a bigger picture is refused with the limit, never run.
LIMITS = {"remove_background_in": 25, "erase_in": 25, "upscale_in": 6, "upscale_out": 36, "resize_out": 36}
THREADS = int(os.environ.get("IMAGE_TOOLS_THREADS", "6"))

_sessions = {}


class Refused(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def session(name, path):
    """The one live session; asking for another model drops the first."""
    if name in _sessions:
        return _sessions[name]
    _sessions.clear()
    gc.collect()
    if not path or not os.path.exists(path):
        raise Refused("model_missing", f"The {name} model file is not installed. Install the image tools from Home's Engines page.")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = THREADS
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    _sessions[name] = ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])
    return _sessions[name]


def load(path, limit_name):
    image = Image.open(path)
    width, height = image.size
    if width * height > LIMITS[limit_name] * MEGAPIXEL:
        raise Refused("too_large", f"This picture is {width * height / MEGAPIXEL:.1f} megapixels; this tool takes up to {LIMITS[limit_name]}. Resize it first.")
    image = ImageOps.exif_transpose(image)
    return image.convert("RGBA") if "A" in image.getbands() or image.mode == "P" else image.convert("RGB")


def save_png(array, path):
    mode = "RGBA" if array.shape[2] == 4 else "RGB"
    Image.fromarray(array, mode).save(path, format="PNG", optimize=False)  # no exif, no icc


def foreground_colors(rgb, alpha, radius):
    """Blur-fusion foreground estimate (Forte and Pitie): takes the background colour out of edge pixels."""
    a = alpha.astype(np.float32)[..., None]
    image = rgb.astype(np.float32)
    k = (2 * radius + 1, 2 * radius + 1)
    ba = cv2.blur(a[..., 0], k)[..., None] + 1e-5
    f = cv2.blur(image * a, k) / ba
    b = cv2.blur(image * (1 - a), k) / (cv2.blur(1 - a[..., 0], k)[..., None] + 1e-5)
    f = f + a * (image - a * f - (1 - a) * b)
    return np.clip(f, 0, 255).astype(np.uint8)


def remove_background(request, params):
    src = load(request["input"], "remove_background_in")
    rgb = np.asarray(src.convert("RGB"))
    height, width = rgb.shape[:2]
    engine = params.get("engine", "auto")
    helper = request.get("helper")
    used = None
    if engine in ("auto", "vision") and helper and os.path.exists(helper):
        # Apple's on-device foreground mask through the small helper the Stack built; the helper reads the
        # decoded, oriented pixels from a temporary PNG and writes a cut-out PNG.
        prepared = request["output"] + ".prepared.png"
        Image.fromarray(rgb, "RGB").save(prepared, format="PNG")
        try:
            run = subprocess.run([helper, prepared, request["output"]], capture_output=True, timeout=120)
        finally:
            try:
                os.remove(prepared)
            except OSError:
                pass
        if run.returncode == 0:
            cut = np.asarray(Image.open(request["output"]).convert("RGBA"))
            used = {"engine": "apple-vision", "model": "VNGenerateForegroundInstanceMaskRequest"}
            save_png(cut, request["output"])  # re-encode: nothing from the helper's file survives
        elif engine == "vision" and run.returncode != 5:
            raise Refused("engine_failed", "Apple's foreground finder failed on this picture. Try the other engine.")
        elif engine == "vision":
            raise Refused("no_subject", "No clear subject was found in this picture. Try the other engine.")
    if used is None:
        if engine == "vision":
            raise Refused("engine_unavailable", "Apple's foreground finder is not available on this computer. Use the default engine.")
        sess = session("isnet", request["models"].get("isnet"))
        size = 1024
        x = np.asarray(Image.fromarray(rgb, "RGB").resize((size, size), Image.BILINEAR), dtype=np.float32) / 255.0
        x = ((x - 0.5) / 1.0).transpose(2, 0, 1)[None].astype(np.float32)
        y = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0].astype(np.float32)
        y = (y - y.min()) / (y.max() - y.min() + 1e-8)
        alpha = np.clip(cv2.resize(y, (width, height), interpolation=cv2.INTER_CUBIC), 0, 1)
        if float(alpha.max()) < 0.2:
            raise Refused("no_subject", "No clear subject was found in this picture.")
        fg = foreground_colors(rgb, alpha, max(3, min(width, height) // 300))
        save_png(np.dstack([fg, (alpha * 255 + 0.5).astype(np.uint8)]), request["output"])
        used = {"engine": "isnet-general-use", "model": "isnet-general-onnx"}
    return {"width": width, "height": height, **used}


def lama_fill(sess, image, mask):
    """Crop around the hole with context, fill it at 512 with LaMa, blend back over the original."""
    height, width = mask.shape
    k = max(3, int(round(max(height, width) * 0.012)) | 1)
    hole = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    ys, xs = np.where(hole > 127)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    side = int(max(y1 - y0, x1 - x0) * 2.2)
    side = min(max(side, 256), max(height, width))
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    pad = side
    big = cv2.copyMakeBorder(image, pad, pad, pad, pad, cv2.BORDER_REFLECT_101)
    big_mask = cv2.copyMakeBorder(hole, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    top = int(np.clip(cy - side // 2, -pad // 2, height - side + pad // 2)) + pad
    left = int(np.clip(cx - side // 2, -pad // 2, width - side + pad // 2)) + pad
    crop = big[top:top + side, left:left + side]
    crop_mask = big_mask[top:top + side, left:left + side]
    small = cv2.resize(crop, (512, 512), interpolation=cv2.INTER_AREA)
    small_mask = cv2.resize(crop_mask, (512, 512), interpolation=cv2.INTER_NEAREST)
    x = (small.astype(np.float32) / 255).transpose(2, 0, 1)[None]
    m = (small_mask > 127).astype(np.float32)[None, None]
    out = sess.run(None, {"image": x, "mask": m})[0][0].transpose(1, 2, 0)
    out = np.clip(out * 255 if out.max() <= 1.5 else out, 0, 255).astype(np.uint8)
    up = cv2.resize(out, (side, side), interpolation=cv2.INTER_CUBIC if side > 512 else cv2.INTER_AREA)
    hard = (crop_mask > 127)[..., None].astype(np.float32)
    soft = np.maximum(cv2.GaussianBlur(hard[..., 0], (0, 0), max(1.0, side / 300))[..., None], hard)
    blended = (crop.astype(np.float32) * (1 - soft) + up.astype(np.float32) * soft).astype(np.uint8)
    result = big.copy()
    result[top:top + side, left:left + side] = blended
    return result[pad:pad + height, pad:pad + width], int(side)


def erase(request, params):
    src = load(request["input"], "erase_in")
    rgba = np.asarray(src.convert("RGBA"))
    rgb = np.ascontiguousarray(rgba[..., :3])
    height, width = rgb.shape[:2]
    if not request.get("mask"):
        raise Refused("mask_required", "Paint over what to remove first; there is no mask.")
    mask_image = Image.open(request["mask"])
    if mask_image.size != (width, height):
        mask_image = mask_image.resize((width, height), Image.NEAREST)
    mask = np.asarray(mask_image.convert("L"))
    mask = np.where(mask > 127, 255, 0).astype(np.uint8)
    if mask.sum() == 0:
        raise Refused("mask_empty", "Nothing is painted. Paint over what to remove first.")
    if mask.mean() / 255 > 0.5:
        raise Refused("mask_too_big", "More than half of the picture is painted. Paint just the thing to remove.")
    sess = session("lama", request["models"].get("lama"))
    filled, crop = lama_fill(sess, rgb, mask)
    out = np.dstack([filled, rgba[..., 3]]) if "A" in src.getbands() else filled
    save_png(out, request["output"])
    return {"width": width, "height": height, "engine": "lama", "model": "big-lama-onnx", "crop_px": crop}


def people_labels(request, rgb):
    """Apple's person instance finder on the decoded, oriented pixels: a label image (0 none, 1..N a person) and a box for each."""
    helper = request.get("people_helper")
    if not helper or not os.path.exists(helper):
        raise Refused("people_unavailable", "Finding people in a picture needs Apple's on-device person finder, which this computer does not have. Paint over the person with the eraser instead.")
    prepared = request["output"] + ".people.png"
    labels_path = request["output"] + ".labels.png"
    Image.fromarray(rgb, "RGB").save(prepared, format="PNG")
    try:
        run = subprocess.run([helper, prepared, labels_path], capture_output=True, timeout=120)
        if run.returncode == 5 or (run.returncode == 0 and not run.stdout.strip()):
            raise Refused("no_people", "No people were found in this picture.")
        if run.returncode != 0:
            raise Refused("people_unavailable", "Apple's person finder failed on this picture. Paint over the person with the eraser instead.")
        labels = np.asarray(Image.open(labels_path).convert("L"))
        boxes = [json.loads(line) for line in run.stdout.decode().splitlines() if line.startswith("{")]
    finally:
        for path in (prepared, labels_path):
            try:
                os.remove(path)
            except OSError:
                pass
    if not boxes:
        raise Refused("no_people", "No people were found in this picture.")
    if labels.shape[:2] != rgb.shape[:2]:
        labels = cv2.resize(labels, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
    return clean_labels(labels, rgb.shape[1], rgb.shape[0])


def clean_labels(labels, width, height):
    """Apple's instance masks carry stray bits (a chair, a far-off figure, speckle). Keep each person's main blob (and any piece at least a quarter its size), then take the boxes from what is kept."""
    kept = np.zeros_like(labels)
    boxes = []
    for pid in [int(v) for v in np.unique(labels) if v != 0]:
        mask = (labels == pid).astype(np.uint8)
        count, comp, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if count <= 1:
            continue
        areas = stats[1:, cv2.CC_STAT_AREA]
        main = 1 + int(areas.argmax())
        reach = cv2.dilate((comp == main).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(5, int(max(width, height) * 0.03)) | 1,) * 2))
        for index in range(1, count):
            # The main blob, and a piece that touches its neighbourhood (a hand, a bag, a detached arm); not a chair across the room.
            if index == main or (reach[comp == index].any() and stats[index, cv2.CC_STAT_AREA] >= 0.002 * width * height):
                kept[comp == index] = pid
        ys, xs = np.where(kept == pid)
        if len(xs) < 0.0005 * width * height:
            kept[kept == pid] = 0
            continue
        boxes.append({"id": pid, "x": float(xs.min()) / width, "y": float(ys.min()) / height, "w": float(xs.max() - xs.min() + 1) / width, "h": float(ys.max() - ys.min() + 1) / height, "area": float(len(xs)) / (width * height)})
    if not boxes:
        raise Refused("no_people", "No people were found in this picture.")
    return kept, boxes


def find_people(request, params):
    """The people in the picture, numbered, with a boxed and numbered copy of it the caller can show a reader that picks one."""
    src = load(request["input"], "erase_in")
    rgb = np.ascontiguousarray(np.asarray(src.convert("RGB")))
    height, width = rgb.shape[:2]
    _, boxes = people_labels(request, rgb)
    shown = rgb.copy()
    thick = max(2, round(max(height, width) / 300))
    for box in boxes:
        x0, y0 = int(box["x"] * width), int(box["y"] * height)
        x1, y1 = int((box["x"] + box["w"]) * width), int((box["y"] + box["h"]) * height)
        cv2.rectangle(shown, (x0, y0), (x1, y1), (255, 0, 0), thick)
        scale = max(1.0, max(height, width) / 700)
        label = str(box["id"])
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
        cv2.rectangle(shown, (x0, y0), (x0 + tw + 12, y0 + th + 14), (255, 0, 0), -1)
        cv2.putText(shown, label, (x0 + 6, y0 + th + 6), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thick, cv2.LINE_AA)
    save_png(shown, request["output"])
    return {"width": width, "height": height, "engine": "apple-vision", "model": "VNGeneratePersonInstanceMaskRequest", "people": boxes}


def chosen_people_mask(request, params, rgb):
    """The mask of the chosen people (params.people: numbers from find_people, or "all"), grown to cover the soft edge, hair, shadows at the feet and a hand-held object."""
    height, width = rgb.shape[:2]
    labels, boxes = people_labels(request, rgb)
    wanted = params.get("people", "all")
    ids = [b["id"] for b in boxes] if wanted == "all" else [int(v) for v in wanted]
    unknown = [v for v in ids if v not in [b["id"] for b in boxes]]
    if not ids or unknown:
        raise Refused("people_required", "Say which person to remove by the number from find_people, or all of them.")
    person = np.isin(labels, ids).astype(np.uint8) * 255
    k = max(5, int(round(max(height, width) * 0.018)) | 1)
    mask = cv2.dilate(person, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if mask.mean() / 255 > 0.5:
        raise Refused("mask_too_big", "The people to remove cover more than half of the picture.")
    return mask, boxes


def people_mask(request, params):
    """The chosen people as a mask picture (white), for the picture engine's masked edit to fill; nothing is erased here."""
    src = load(request["input"], "erase_in")
    rgb = np.ascontiguousarray(np.asarray(src.convert("RGB")))
    mask, boxes = chosen_people_mask(request, params, rgb)
    save_png(np.dstack([mask, mask, mask]), request["output"])
    return {"width": rgb.shape[1], "height": rgb.shape[0], "engine": "apple-vision", "model": "VNGeneratePersonInstanceMaskRequest", "people": boxes}


def erase_people(request, params):
    """Erase the chosen people (params.people: a list of numbers from find_people, or "all"), filling with LaMa."""
    src = load(request["input"], "erase_in")
    rgba = np.asarray(src.convert("RGBA"))
    rgb = np.ascontiguousarray(rgba[..., :3])
    height, width = rgb.shape[:2]
    mask, boxes = chosen_people_mask(request, params, rgb)
    sess = session("lama", request["models"].get("lama"))
    filled, crop = lama_fill(sess, rgb, mask)
    out = np.dstack([filled, rgba[..., 3]]) if "A" in src.getbands() else filled
    save_png(out, request["output"])
    return {"width": width, "height": height, "engine": "apple-vision+lama", "model": "VNGeneratePersonInstanceMaskRequest+big-lama-onnx", "crop_px": crop, "people": boxes}


def subjects_labels(request, rgb):
    """Foreground instance mask with cleaned masks and boxes."""
    helper = request.get("subjects_helper")
    if not helper or not os.path.exists(helper):
        raise Refused("subjects_unavailable", "Finding subjects needs Apple's on-device Vision finder on macOS 14 or later. Try a clearer picture or paint over the subject with the eraser instead.")
    prepared = request["output"] + ".subjects.png"
    labels_path = request["output"] + ".subject-labels.png"
    Image.fromarray(rgb, "RGB").save(prepared, format="PNG")
    try:
        run = subprocess.run([helper, prepared, labels_path], capture_output=True, timeout=120)
        if run.returncode == 5 or (run.returncode == 0 and not run.stdout.strip()):
            raise Refused("no_subjects", "No subjects were found in this picture. Try a clearer picture.")
        if run.returncode != 0:
            raise Refused("subjects_unavailable", "Apple's subject finder failed on this picture. Try a clearer picture or paint over the subject with the eraser instead.")
        labels = np.asarray(Image.open(labels_path).convert("L"))
        raw_boxes = [json.loads(line) for line in run.stdout.decode().splitlines() if line.startswith("{")]
    finally:
        for path in (prepared, labels_path):
            try: os.remove(path)
            except OSError: pass
    if labels.shape[:2] != rgb.shape[:2]:
        labels = cv2.resize(labels, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
    cleaned = np.zeros_like(labels)
    boxes = []
    for item in raw_boxes:
        sid = int(item["id"])
        one, found = clean_labels((labels == sid).astype(np.uint8), rgb.shape[1], rgb.shape[0])
        if not found:
            continue
        cleaned[one > 0] = sid
        box = found[0]
        boxes.append(box)
    if not boxes:
        raise Refused("no_subjects", "No subjects were found in this picture. Try a clearer picture.")
    boxes.sort(key=lambda item: item["id"])
    return cleaned, boxes


def draw_subject_boxes(rgb, boxes):
    shown = rgb.copy()
    height, width = shown.shape[:2]
    thick = max(2, round(max(height, width) / 300))
    for box in boxes:
        x0, y0 = int(box["x"] * width), int(box["y"] * height)
        x1, y1 = int((box["x"] + box["w"]) * width), int((box["y"] + box["h"]) * height)
        cv2.rectangle(shown, (x0, y0), (x1, y1), (255, 0, 0), thick)
        scale = max(1.0, max(height, width) / 700)
        label = str(box["id"])
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
        cv2.rectangle(shown, (x0, y0), (x0 + tw + 12, y0 + th + 14), (255, 0, 0), -1)
        cv2.putText(shown, label, (x0 + 6, y0 + th + 6), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thick, cv2.LINE_AA)
    return shown


def find_subjects(request, params):
    src = load(request["input"], "erase_in")
    rgb = np.ascontiguousarray(np.asarray(src.convert("RGB")))
    height, width = rgb.shape[:2]
    _, boxes = subjects_labels(request, rgb)
    save_png(draw_subject_boxes(rgb, boxes), request["output"])
    return {"width": width, "height": height, "engine": "apple-vision", "model": "VNGenerateForegroundInstanceMaskRequest", "subjects": boxes}


def chosen_subjects_mask(request, params, rgb):
    height, width = rgb.shape[:2]
    labels, boxes = subjects_labels(request, rgb)
    wanted = params.get("subjects", "all")
    ids = [b["id"] for b in boxes] if wanted == "all" else [int(v) for v in wanted]
    unknown = [v for v in ids if v not in [b["id"] for b in boxes]]
    if not ids or unknown:
        raise Refused("subjects_required", "Choose subject numbers from find_subjects, or all, before erasing.")
    mask = np.isin(labels, ids).astype(np.uint8) * 255
    k = max(5, int(round(max(height, width) * 0.018)) | 1)
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if mask.mean() / 255 > 0.5:
        raise Refused("mask_too_big", "The subjects to remove cover more than half of the picture. Choose fewer subjects and try again.")
    return mask, boxes


def erase_subjects(request, params):
    src = load(request["input"], "erase_in")
    rgba = np.asarray(src.convert("RGBA"))
    rgb = np.ascontiguousarray(rgba[..., :3])
    height, width = rgb.shape[:2]
    mask, boxes = chosen_subjects_mask(request, params, rgb)
    sess = session("lama", request["models"].get("lama"))
    filled, crop = lama_fill(sess, rgb, mask)
    out = np.dstack([filled, rgba[..., 3]]) if "A" in src.getbands() else filled
    save_png(out, request["output"])
    return {"width": width, "height": height, "engine": "apple-vision+lama", "model": "VNGenerateForegroundInstanceMaskRequest+big-lama-onnx", "crop_px": crop, "subjects": boxes}


def tile_upscale(sess, array, tile=256, pad=12):
    height, width = array.shape[:2]
    name = sess.get_inputs()[0].name
    x = (array.astype(np.float32) / 255).transpose(2, 0, 1)[None]
    out = np.zeros((1, 3, height * 4, width * 4), np.float32)
    for ty in range(0, height, tile):
        for tx in range(0, width, tile):
            y0, y1 = max(ty - pad, 0), min(ty + tile + pad, height)
            x0, x1 = max(tx - pad, 0), min(tx + tile + pad, width)
            piece = x[:, :, y0:y1, x0:x1]
            ph, pw = (-piece.shape[2]) % 8, (-piece.shape[3]) % 8
            if ph or pw:
                piece = np.pad(piece, ((0, 0), (0, 0), (0, ph), (0, pw)), mode="reflect")
            got = sess.run(None, {name: piece})[0]
            got = got[:, :, :(y1 - y0) * 4, :(x1 - x0) * 4]
            oy, ox = (ty - y0) * 4, (tx - x0) * 4
            hh, ww = min(tile, height - ty) * 4, min(tile, width - tx) * 4
            out[:, :, ty * 4:ty * 4 + hh, tx * 4:tx * 4 + ww] = got[:, :, oy:oy + hh, ox:ox + ww]
    return (np.clip(out[0].transpose(1, 2, 0), 0, 1) * 255 + 0.5).astype(np.uint8)


def upscale(request, params):
    scale = int(params.get("scale", 2))
    if scale not in (2, 4):
        raise Refused("bad_scale", "Upscale by 2 or by 4.")
    src = load(request["input"], "upscale_in")
    width, height = src.size
    if width * height * scale * scale > LIMITS["upscale_out"] * MEGAPIXEL:
        raise Refused("too_large", f"{scale}x of this picture would be {width * height * scale * scale / MEGAPIXEL:.0f} megapixels; the limit is {LIMITS['upscale_out']}. Try 2x or a smaller picture.")
    sess = session("esrgan", request["models"].get("esrgan"))
    array = np.asarray(src.convert("RGB"))
    big = tile_upscale(sess, array)
    if scale == 2:
        big = cv2.resize(big, (width * 2, height * 2), interpolation=cv2.INTER_AREA)
    if "A" in src.getbands():
        alpha = cv2.resize(np.asarray(src.getchannel("A")), (width * scale, height * scale), interpolation=cv2.INTER_LANCZOS4)
        big = np.dstack([big, alpha])
    save_png(big, request["output"])
    return {"width": width * scale, "height": height * scale, "engine": "real-esrgan-general-x4v3", "model": "realesr-general-x4v3"}


def resize(request, params):
    src = load(request["input"], "erase_in")
    width, height = src.size
    new_w, new_h = params.get("width"), params.get("height")
    factor = params.get("factor")
    if factor:
        new_w, new_h = round(width * float(factor)), round(height * float(factor))
    elif new_w and not new_h:
        new_h = round(height * int(new_w) / width)
    elif new_h and not new_w:
        new_w = round(width * int(new_h) / height)
    if not new_w or not new_h:
        raise Refused("size_required", "Say the new width or height, or a factor.")
    new_w, new_h = int(new_w), int(new_h)
    if new_w < 1 or new_h < 1 or new_w * new_h > LIMITS["resize_out"] * MEGAPIXEL:
        raise Refused("too_large", f"The new size must be at least 1 pixel and at most {LIMITS['resize_out']} megapixels.")
    array = np.asarray(src)
    shrink = new_w * new_h < width * height
    out = cv2.resize(array, (new_w, new_h), interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LANCZOS4)
    save_png(out, request["output"])
    return {"width": new_w, "height": new_h, "engine": "lanczos", "model": "none"}


# ---- clip_track (MAKER-A): where the head went in every frame of a clip ----
CLIP_TRACK_MAX_FRAMES = 300
CLIP_TRACK_MAX_PIXELS = 4 * MEGAPIXEL


def track_grey(rgba, hole=None):
    """The picture the tracker compares: grey, with everything transparent (and the mouth hole, which moves on its own) set to mid grey and a soft blur."""
    rgb = rgba[..., :3]
    grey = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    grey = np.where(rgba[..., 3] > 128, grey, 128.0).astype(np.float32)
    if hole:
        x0, y0, x1, y1 = [int(v) for v in hole]
        grey[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = 128.0
    return cv2.GaussianBlur(grey, (0, 0), 1.5)


def ecc_multiscale(template, image, start, motion):
    """Coarse to fine ECC (scales 4, 2, 1). Returns (correlation, 2x3 warp mapping template coordinates to image coordinates), or (-1, start) when it does not converge."""
    warp = start.copy().astype(np.float32)
    cc = -1.0
    for scale in (4, 2, 1):
        t = cv2.resize(template, None, fx=1 / scale, fy=1 / scale, interpolation=cv2.INTER_AREA) if scale > 1 else template
        i = cv2.resize(image, None, fx=1 / scale, fy=1 / scale, interpolation=cv2.INTER_AREA) if scale > 1 else image
        scaled = warp.copy()
        scaled[:, 2] /= scale
        try:
            cc, scaled = cv2.findTransformECC(t, i, scaled, motion, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-6), None, 5)
        except cv2.error:
            return -1.0, start.astype(np.float32)
        warp = scaled.copy()
        warp[:, 2] *= scale
    return float(cc), warp


def clip_track(request, params):
    """Per-frame head transform of a clip against its rest picture, the way the demo's track.json is made: multi-scale ECC
    (rigid first, then an affine refinement whose scale is clamped), started from the previous frame, the one before it and
    the identity, keeping the best correlation so one diverged start cannot poison later frames.
    request.input is the rest picture (PNG with alpha); params.frames_dir holds the frames as PNG files (sorted by name).
    Optional params: scale_clamp (default 0.02), confidence (default 0.5), box [x0,y0,x1,y1] to track inside, hole [x0,y0,x1,y1] to ignore.
    Replies m (one [a, b, tx, c, d, ty] per frame, mapping rest-picture pixels to frame pixels), res (mean absolute grey
    difference left after the warp, brightness-centred, inside the rest picture's opaque area), cc (the correlation) and low (frame numbers under the confidence)."""
    rest = np.asarray(load(request["input"], "erase_in").convert("RGBA"))
    height, width = rest.shape[:2]
    if width * height > CLIP_TRACK_MAX_PIXELS:
        raise Refused("too_large", f"The rest picture is {width * height / MEGAPIXEL:.1f} megapixels; the tracker takes up to {CLIP_TRACK_MAX_PIXELS // MEGAPIXEL}. Resize the clip first.")
    folder = params.get("frames_dir")
    if not folder or not os.path.isdir(folder):
        raise Refused("frames_required", "Say where the clip frames are (frames_dir), as a folder of PNG files.")
    names = sorted(name for name in os.listdir(folder) if name.lower().endswith(".png"))
    if not names:
        raise Refused("frames_required", "The frames folder has no PNG files. Write the clip frames as PNG files and try again.")
    if len(names) > CLIP_TRACK_MAX_FRAMES:
        raise Refused("too_large", f"The clip has {len(names)} frames; the tracker takes up to {CLIP_TRACK_MAX_FRAMES}. Use a shorter clip.")
    try:
        clamp = float(params.get("scale_clamp", 0.02))
        confidence = float(params.get("confidence", 0.5))
    except (TypeError, ValueError):
        raise Refused("bad_params", "scale_clamp and confidence must be numbers.")
    if not 0 <= clamp <= 0.5 or not -1 <= confidence <= 1:
        raise Refused("bad_params", "scale_clamp must be between 0 and 0.5, and confidence between -1 and 1.")
    box = params.get("box") or [0, 0, width, height]
    x0, y0, x1, y1 = [int(v) for v in box]
    if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
        raise Refused("bad_params", "The tracking box must sit inside the rest picture: [x0, y0, x1, y1] in pixels.")
    hole = params.get("hole")
    template = track_grey(rest, hole)[y0:y1, x0:x1]
    solid = (rest[..., 3] > 250)[y0:y1, x0:x1]
    offset = np.array([x0, y0], np.float32)
    identity = np.eye(2, 3, dtype=np.float32)
    previous = [identity, identity]
    out, residuals, correlations, low = [], [], [], []
    for index, name in enumerate(names):
        frame = np.asarray(load(os.path.join(folder, name), "erase_in").convert("RGBA"))
        if frame.shape[:2] != (height, width):
            raise Refused("size_mismatch", f"Frame {name} is {frame.shape[1]}x{frame.shape[0]} but the rest picture is {width}x{height}. Write every frame at the rest picture's size.")
        grey = track_grey(frame, hole)[y0:y1, x0:x1]
        best = (-2.0, previous[0])
        for start in (previous[0], previous[1], identity):
            cc, warp = ecc_multiscale(template, grey, start, cv2.MOTION_EUCLIDEAN)
            if cc > best[0]:
                best = (cc, warp)
        cc, warp = best
        if clamp > 0 and cc > -1.0:
            # A small isotropic scale change (the head moving toward or away from the camera), clamped.
            cc2, affine = ecc_multiscale(template, grey, warp, cv2.MOTION_AFFINE)
            if cc2 > cc:
                det = float(np.linalg.det(affine[:, :2]))
                scale = float(np.sqrt(abs(det))) if det > 0 else 0.0
                if scale > 0:
                    limited = min(max(scale, 1 - clamp), 1 + clamp)
                    affine = affine.copy()
                    affine[:, :2] *= limited / scale
                    # the clamped linear part drifts slightly; keep it only if it still correlates at least as well
                    warped = cv2.warpAffine(grey, affine, (grey.shape[1], grey.shape[0]), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
                    if float(np.corrcoef(warped.ravel(), template.ravel())[0, 1]) >= cc - 1e-4:
                        warp, cc = affine, cc2
        previous = [warp, previous[0]]
        linear = warp[:, :2]
        shift = warp[:, 2] + offset - linear @ offset  # the warp was found inside the box; express it in picture coordinates
        matrix = [float(linear[0, 0]), float(linear[0, 1]), float(shift[0]), float(linear[1, 0]), float(linear[1, 1]), float(shift[1])]
        aligned = cv2.warpAffine(grey, warp, (grey.shape[1], grey.shape[0]), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
        inside = cv2.warpAffine((frame[..., 3] > 250)[y0:y1, x0:x1].astype(np.float32), warp, (grey.shape[1], grey.shape[0]), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP) > 0.99
        selected = inside & solid
        if selected.sum() >= 50:
            difference = (aligned - template)[selected]
            residuals.append(round(float(np.abs(difference - np.median(difference)).mean()), 3))
        else:
            residuals.append(0.0)
        correlations.append(round(float(cc), 4))
        if cc < confidence:
            low.append(index)
        out.append([round(value, 5) for value in matrix])
    return {"m": out, "res": residuals, "cc": correlations, "low": low, "frames": len(out), "width": width, "height": height, "engine": "ecc", "model": "none"}


# ---- emotion_bake and pack_assemble (MAKER-C): the upper-face emotion layers and the companion pack, ported from the demo's emotion_build.py and the PACK-02 builder ----
EMOTION_KINDS = ("angry", "excited", "alarmed", "sad")
EMOTION_STRENGTH = 0.65  # the flow travels about this share of the pose picture's brow travel
EMOTION_STEPS = 21
EMOTION_STEP_LIMIT_PX = 3.0
EMOTION_SYMMETRY_PX = 1.5
EMOTION_MIN_TRAVEL_PX = 1.0
# Blobs per brow: (d outward from the midline, dy relative to the brow line, sx, sy, content dy (+ down), content dx toward the midline), all in eye widths.
EMOTION_BLOBS = {
    "angry": [(0.55, 0.0, .34, .34, +0.30, 0.20), (1.15, 0.0, .42, .34, +0.20, 0.08), (1.80, 0.0, .42, .34, +0.09, 0.0), (0.10, -0.3, .25, .34, +0.06, 0.0), (1.0, 1.05, .70, .35, -0.06, 0.0)],
    "excited": [(0.55, 0.0, .35, .30, -0.22, 0.0), (1.15, 0.0, .40, .30, -0.28, 0.0), (1.80, 0.0, .40, .30, -0.22, 0.0), (1.0, 1.05, .70, .35, -0.06, 0.0)],
    "alarmed": [(0.55, 0.0, .30, .30, -0.26, 0.12), (1.15, 0.0, .40, .30, -0.22, 0.04), (1.80, 0.0, .40, .30, -0.12, 0.0)],
    "sad": [(0.55, 0.0, .30, .30, -0.22, 0.10), (1.15, 0.0, .40, .30, -0.04, 0.0), (1.80, 0.0, .40, .30, +0.08, 0.0)],
}
EMOTION_LID = {"angry": (0.13, 0.05), "excited": (-0.06, 0.0), "alarmed": (-0.08, 0.0), "sad": (0.05, 0.0)}  # content dy of the upper and lower lid skin (+ down), in eye widths
EMOTION_RES_EASE = [0.15, 0.95]


def smoothstep(t):
    return t * t * (3 - 2 * t)


def read_bgr(path, what):
    try:
        image = Image.open(path)
        image.load()
    except Exception:
        raise Refused("pose_missing" if what == "pose" else "failed", f"The {what} picture {os.path.basename(str(path))} is missing or is not a picture. Make it again and try once more.")
    rgba = np.asarray(ImageOps.exif_transpose(image).convert("RGBA"))
    return cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2BGR), rgba[..., 3]


class EmotionFace:
    """Everything the demo derives from the rest picture and its landmarks: the eye scale u, midline, brow line, the cut-out region and the soft masks."""

    def __init__(self, bgr, alpha, landmarks):
        try:
            left = np.array(landmarks["leftEye"], np.float32).reshape(-1, 2)
            right = np.array(landmarks["rightEye"], np.float32).reshape(-1, 2)
            if len(left) < 3 or len(right) < 3:
                raise ValueError
        except Exception:
            raise Refused("landmarks_required", "Give the eye landmarks as leftEye and rightEye, each a list of [x, y] points in rest-picture pixels (the face detector's answer).")
        if left.mean(0)[0] > right.mean(0)[0]:
            left, right = right, left
        self.eL, self.eR = left, right
        self.cL, self.cR = left.mean(0), right.mean(0)
        self.mid = float((self.cL[0] + self.cR[0]) / 2)
        self.eyeY = float((self.cL[1] + self.cR[1]) / 2)
        self.u = float((np.ptp(left[:, 0]) + np.ptp(right[:, 0])) / 2)
        u = self.u
        if u < 8:
            raise Refused("bad_landmarks", "The eye landmarks are too small to work from (under 8 px wide). Check the landmarks belong to this picture.")
        self.bgr = bgr
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
        self.gray = gray
        ys = np.arange(int(self.eyeY - 1.2 * u), int(self.eyeY - 0.4 * u))
        height, width = gray.shape
        if ys[0] < 0 or ys[-1] >= height:
            raise Refused("bad_landmarks", "The brows would sit outside the picture. Check the landmarks belong to this picture.")
        prof = np.zeros(len(ys))
        for c in (self.cL, self.cR):
            prof += np.array([gray[y, max(0, int(c[0] - 0.8 * u)): int(c[0] + 0.8 * u)].mean() for y in ys])
        self.by = float(ys[np.argmin(np.convolve(prof, np.ones(5) / 5, "same"))])
        self.X0, self.X1 = int(self.mid - 2.6 * u), int(self.mid + 2.6 * u)
        self.Y0, self.Y1 = int(self.eyeY - 2.7 * u), int(self.eyeY + 1.5 * u)
        X0, X1, Y0, Y1 = self.X0, self.X1, self.Y0, self.Y1
        if X0 < 0 or Y0 < 0 or X1 > width or Y1 > height:
            raise Refused("bad_landmarks", f"The face is too close to the picture edge: the brow and eye block needs x {X0} to {X1} and y {Y0} to {Y1} inside {width}x{height}. Use a picture with more room round the face.")
        W, H = X1 - X0, Y1 - Y0
        self.W, self.H = W, H
        xq, yq = np.meshgrid(np.arange(X0, X1, dtype=np.float32), np.arange(Y0, Y1, dtype=np.float32))
        self.xq, self.yq = xq, yq
        self.xq0, self.yq0 = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
        mid, eyeY, cL, cR = self.mid, self.eyeY, self.cL, self.cR
        ell = lambda cx, cy, a, b: ((xq - cx) / a) ** 2 + ((yq - cy) / b) ** 2
        sm = smoothstep
        band = sm(np.clip((yq - Y0) / (0.3 * u), 0, 1)) * sm(np.clip((Y1 - 1 - yq) / (0.5 * u), 0, 1)) * sm(np.clip((X1 - 1 - xq) / (0.4 * u), 0, 1)) * sm(np.clip((xq - X0) / (0.4 * u), 0, 1))
        self.band = band
        hole = np.minimum(ell(cL[0], cL[1], .8 * u, .55 * u), ell(cR[0], cR[1], .8 * u, .55 * u))
        hole_in = 1 - sm(np.clip((hole - 0.8) / 0.7, 0, 1))
        self.eyeTop = float(min(left[:, 1].min(), right[:, 1].min()))
        self.eyeBot = float(max(left[:, 1].max(), right[:, 1].max()))
        ramp = sm(np.clip((self.eyeTop - 0.04 * u - yq) / (0.38 * u), 0, 1))
        self.conf = band * (1 - hole_in * (1 - ramp))
        both = np.minimum(ell(cL[0], cL[1], .68 * u, .5 * u), ell(cR[0], cR[1], .68 * u, .5 * u))
        self.ringm = (both > 1.25) & (both < 3.2) & (yq > eyeY + 0.15 * u) & (np.abs(xq - mid) > 0.3 * u)
        pts = np.argwhere(self.ringm[::3, ::3]) * 3
        self.ringpts = [[int(x), int(y)] for y, x in pts]
        silhouette = alpha[Y0:Y1, X0:X1]
        sil = sm(np.clip(cv2.distanceTransform((silhouette > 200).astype(np.uint8), cv2.DIST_L2, 3) / 14.0, 0, 1))
        e_ = 0.8 * u
        hx, ytop, ybot = 2.1 * u, self.by - 1.35 * u, eyeY + 0.62 * u
        self.boxal = sm(np.clip(np.minimum.reduce([(hx - np.abs(xq - mid)), (yq - ytop), (ybot - yq)]) / e_, 0, 1)) * sil
        self.exw = sm(np.clip((1.2 * u - np.minimum(np.abs(xq - cL[0]), np.abs(xq - cR[0]))) / (0.35 * u), 0, 1))
        blur = lambda a: cv2.GaussianBlur(a.astype(np.float32), (0, 0), 0.17 * u)
        zone = np.zeros((H, W), np.uint8)
        for pts_ in (left, right):
            cv2.fillPoly(zone, [np.round(pts_ - [X0, Y0]).astype(np.int32)], 1)
        zone = cv2.dilate(zone, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(0.26 * u) | 1, int(0.22 * u) | 1)))
        self.zeye = np.clip(blur(zone) * 1.5, 0, 1)
        self.zglab = np.clip(1.6 * (1 - ell(mid, self.by + 0.25 * u, 0.30 * u, 0.75 * u)), 0, 1)
        self.zfore = np.clip(2.0 * np.minimum.reduce([(1.8 * u - np.abs(xq - mid)) / (0.4 * u), (yq - (self.by - 1.25 * u)) / (0.3 * u), ((self.by - 0.45 * u) - yq) / (0.3 * u)]), 0, 1)
        self.zlow = np.clip(1.6 * (1 - ell(mid, eyeY + 0.6 * u, 1.9 * u, 0.55 * u)), 0, 1) * (1 - self.zeye)
        self.rest_reg = bgr.astype(np.float32)[Y0:Y1, X0:X1]

    def remap(self, image, flow):
        return cv2.remap(image, self.xq0 + flow[..., 0], self.yq0 + flow[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def flow(self, kind, gain=1.0):
        """The sampling-offset field of one emotion: landmark-relative brow blobs plus the lid skin, nothing over the eyeballs."""
        u, xq, yq, mid, by = self.u, self.xq, self.yq, self.mid, self.by
        F = np.zeros((self.H, self.W, 2), np.float32)
        for s in (-1, 1):
            for d, dyr, sx, sy, mdy, mdx in EMOTION_BLOBS[kind]:
                cx = mid + s * d * u
                cy = by + dyr * u + 0.5 * mdy * u
                b = np.exp(-(((xq - cx) / (sx * u)) ** 2 + ((yq - cy) / (sy * u)) ** 2) / 2)
                F[..., 0] -= (-s * mdx * u) * b
                F[..., 1] -= (mdy * u) * b
        F = F * self.conf[..., None]
        F[..., 1] = F[..., 1] * (1 - self.exw) + np.minimum(F[..., 1], np.maximum(0, self.eyeTop - 0.1 * u - yq)) * self.exw  # never sample the eyeball into the skin above it
        lid = EMOTION_LID[kind]
        for c in (self.cL, self.cR):
            upper = np.exp(-(((xq - c[0]) / (0.55 * u)) ** 2 + ((yq - (self.eyeTop + 0.08 * u)) / (0.20 * u)) ** 2) / 2)
            lower = np.exp(-(((xq - c[0]) / (0.5 * u)) ** 2 + ((yq - (self.eyeBot - 0.02 * u)) / (0.16 * u)) ** 2) / 2)
            F[..., 1] -= lid[0] * u * upper * self.band
            F[..., 1] += lid[1] * u * lower * self.band
        return F * gain

    def tops(self, gray, side):
        """Per column, the brow's top edge (first dark pixel scanning down from above the brow); {x: y} for one side of the midline."""
        u = self.u
        ya, yb = int(self.by - 0.95 * u), int(self.eyeY - 0.05 * u)
        found = {}
        for x in range(int(self.mid + side * 0.1 * u), int(self.mid + side * 2.5 * u), side):
            col = gray[ya:yb, x]
            skin = np.median(gray[ya - int(0.25 * u): ya + 2, x])
            threshold = skin - 42
            hits = np.where(col < threshold)[0]
            if len(hits):
                i = int(hits[0])
                # sub-pixel: the threshold crossing between the pixel above (lighter) and this one
                found[x] = ya + i if i == 0 or col[i - 1] <= col[i] else ya + i - 1 + float(col[i - 1] - threshold) / float(col[i - 1] - col[i])
        return found

    @staticmethod
    def peak_shift(shift):
        """The largest column shift after a 7-column average (signed)."""
        smooth = np.convolve(np.pad(shift, 3, mode="edge"), np.ones(7) / 7, "valid")
        return float(smooth[int(np.argmax(np.abs(smooth)))])

    def brow_travel(self, flow, w):
        """Peak brow movement in px (+ down) per side at weight w, read from the flow along the brow band (the content moves by minus the sampling offset)."""
        u = self.u
        rows = (self.yq[:, 0] > self.by - 0.5 * u) & (self.yq[:, 0] < self.by + 0.5 * u)
        out = {}
        for side, name in ((-1, "left"), (1, "right")):
            columns = np.where((side * (self.xq[0] - self.mid) > 0.3 * u) & (side * (self.xq[0] - self.mid) < 2.3 * u))[0]
            block = -w * flow[rows][:, columns, 1]
            shift = block[np.argmax(np.abs(block), axis=0), np.arange(len(columns))]
            out[name] = self.peak_shift(shift.astype(np.float32))
        return out

    def fold_margin(self, flow):
        """The smallest Jacobian determinant of the warp x + w*flow(x) over w = 0..1 in 21 steps; reported, not enforced (the demo's own clay flows dip below zero in places and look right; a negative value means a local fold)."""
        dx = np.gradient(flow[..., 0], axis=1), np.gradient(flow[..., 0], axis=0)
        dy = np.gradient(flow[..., 1], axis=1), np.gradient(flow[..., 1], axis=0)
        low = 1.0
        for step in range(EMOTION_STEPS):
            w = step / (EMOTION_STEPS - 1)
            low = min(low, float(((1 + w * dx[0]) * (1 + w * dy[1]) - (w * dx[1]) * (w * dy[0])).min()))
        return low

    def eye_opening_change(self, flow):
        """How much the eye opening changes at w=1: the landmark points ride the flow (content moves by minus the sampling offset)."""
        result = []
        for pts in (self.eL, self.eR):
            xs = np.clip(pts[:, 0] - self.X0, 0, self.W - 1).astype(int)
            ys = np.clip(pts[:, 1] - self.Y0, 0, self.H - 1).astype(int)
            moved = pts - flow[ys, xs]
            result.append(float(np.ptp(moved[:, 1]) - np.ptp(pts[:, 1])))
        return result


def emotion_bake(request, params):
    """Bake the four upper-face emotion layers from a rest picture, its eye landmarks and the edit pictures made for each emotion.
    request.input is the rest picture (PNG with alpha). params: landmarks {leftEye, rightEye} (lists of [x, y]), poses {kind: [path, ...]} (one or two
    edit pictures per kind, the rest picture's size), out_dir (written: <kind>.flow.bin, <kind>.png and meta.json), optional kinds (default all four),
    strength (default 0.65), calibrate (default false, the demo's hand-fitted constants: when true scale each flow so the brow travels about `strength` of the pose picture's brow travel).
    Replies report{kind: {...}} and ok: the brow travel in px at w=0.5 and 1, the eye opening change, the monotone check over 21 steps, the left/right symmetry
    and reasons when a kind is not ok. This op never calls an engine: the pictures are made earlier through the image edit route."""
    rest, alpha = read_bgr_alpha(request["input"])
    height, width = rest.shape[:2]
    if width * height > LIMITS["erase_in"] * MEGAPIXEL:
        raise Refused("too_large", f"The rest picture is {width * height / MEGAPIXEL:.1f} megapixels; this tool takes up to {LIMITS['erase_in']}. Resize it first.")
    kinds = params.get("kinds") or list(EMOTION_KINDS)
    if not isinstance(kinds, list) or any(k not in EMOTION_KINDS for k in kinds):
        raise Refused("bad_params", "kinds must be a list made of angry, excited, alarmed and sad.")
    out_dir = params.get("out_dir")
    if not out_dir:
        raise Refused("bad_params", "Say where to write the emotion folder (out_dir).")
    poses = params.get("poses") or {}
    missing = [k for k in kinds if not poses.get(k)]
    if missing:
        raise Refused("pose_missing", f"There is no pose picture for {', '.join(missing)}. Make one edit picture for each of those emotions (the face with that emotion, same size and framing as the rest picture) and try again.")
    try:
        strength = float(params.get("strength", EMOTION_STRENGTH))
    except (TypeError, ValueError):
        raise Refused("bad_params", "strength must be a number.")
    if not 0.2 <= strength <= 1.0:
        raise Refused("bad_params", "strength must be between 0.2 and 1.")
    calibrate = bool(params.get("calibrate", False))
    face = EmotionFace(rest, alpha, params.get("landmarks") or {})
    pictures = {}
    for kind in kinds:
        names = poses[kind] if isinstance(poses[kind], list) else [poses[kind]]
        if not 1 <= len(names) <= 2:
            raise Refused("bad_params", f"Give one or two pose pictures for {kind}.")
        loaded = []
        for name in names:
            bgr, _ = read_bgr(name, "pose")
            if bgr.shape[:2] != (height, width):
                raise Refused("size_mismatch", f"The pose picture {os.path.basename(str(name))} for {kind} is {bgr.shape[1]}x{bgr.shape[0]} but the rest picture is {width}x{height}. Make it at the rest picture's size.")
            loaded.append(bgr.astype(np.float32))
        pictures[kind] = loaded
    os.makedirs(out_dir, exist_ok=True)
    rest_tops = {-1: face.tops(face.gray, -1), 1: face.tops(face.gray, 1)}
    meta = {"doc": "v2: out(x)=live(x+w*flow(x)) (flow already scaled by strength); then out += (patch.rgb-128)*2 * patch.alpha * smoothstep((w-lo)/(hi-lo)) (resEase). flow.bin int16 (dx,dy)*64 over region W*H.",
            "region": [face.X0, face.Y0, face.W, face.H], "mid": face.mid, "eyeY": face.eyeY, "u": face.u, "browY": face.by,
            "centres": [face.cL.tolist(), face.cR.tolist()], "ring": face.ringpts, "flowScale": 64, "kinds": {}}
    report, all_ok = {}, True
    for kind in kinds:
        flow = face.flow(kind)
        reasons = []
        pose_travel = None
        gain = 1.0
        measured = []
        for pose in pictures[kind]:
            gp = cv2.cvtColor(pose, cv2.COLOR_BGR2GRAY)
            sides = []
            for side in (-1, 1):
                tops = face.tops(gp, side)
                common = sorted(set(rest_tops[side]) & set(tops))
                if len(common) >= 10:
                    sides.append(face.peak_shift(np.array([tops[x] - rest_tops[side][x] for x in common], np.float32)))
            if sides:
                measured.append(float(np.mean(sides)))
        if measured:
            pose_travel = float(np.mean(measured))
        own = face.brow_travel(flow, 1.0)
        own_values = [v for v in own.values() if v is not None]
        own_mean = float(np.mean(own_values)) if own_values else None
        ratio = None if pose_travel is None or own_mean is None or abs(pose_travel) < 1e-6 else own_mean / pose_travel
        if calibrate:
            if ratio is not None and abs(own_mean) >= 1 and abs(pose_travel) >= 1 and ratio > 0:
                gain = float(np.clip(strength / ratio, 0.5, 2.0))
                flow = flow * gain
            else:
                reasons.append("The flow could not be matched to the pose picture's brow travel (one of them is under 1 px or moves the other way), so the standard strength was kept.")
        D = np.mean([p[face.Y0:face.Y1, face.X0:face.X1] for p in pictures[kind]], axis=0) - face.rest_reg
        if face.ringm.sum() > 50:
            D = D - D[face.ringm].mean(0)
        zones = ([face.zeye] if kind == "angry" else []) + [face.zlow] + ([face.zglab, face.zfore] if kind == "angry" else [face.zglab] if kind in ("sad", "alarmed") else [])
        R = strength * D * np.maximum.reduce(zones)[..., None]
        R = cv2.GaussianBlur(R, (0, 0), 0.8)
        rgb = np.clip(128 + R / 2, 0, 255).astype(np.uint8)
        cv2.imwrite(os.path.join(out_dir, f"{kind}.png"), np.dstack([rgb, (face.boxal * 255).astype(np.uint8)]))
        np.round(flow * 64).astype(np.int16).tofile(os.path.join(out_dir, f"{kind}.flow.bin"))
        # checks: brow travel read from the flow at 21 weights, the fold margin (no tearing between weights), and left/right symmetry
        positions = [face.brow_travel(flow, step / (EMOTION_STEPS - 1)) for step in range(EMOTION_STEPS)]
        series = np.array([[p["left"], p["right"]] for p in positions])
        mean = series.mean(axis=1)
        full, half = positions[-1], positions[EMOTION_STEPS // 2]
        sign = 1.0 if mean[-1] >= 0 else -1.0
        monotone = bool(np.all(np.diff(sign * mean) >= -0.05))
        max_step = float(np.abs(np.diff(mean)).max())
        asym = abs(full["left"] - full["right"])
        margin = face.fold_margin(flow)
        travel = {"w0.5": round(float(np.mean(list(half.values()))), 2), "w1": round(float(np.mean(list(full.values()))), 2)}
        if abs(travel["w1"]) < EMOTION_MIN_TRAVEL_PX:
            reasons.append(f"The brows move only {abs(travel['w1']):.1f} px at full weight; the {kind} layer would not show. Check the landmarks and the pose picture.")
        if not monotone:
            reasons.append("The brow does not move steadily as the weight goes from 0 to 1 (it steps back). Check the landmarks.")
        if max_step >= EMOTION_STEP_LIMIT_PX:
            reasons.append(f"The brow jumps {max_step:.1f} px between two neighbouring weights (the limit is {EMOTION_STEP_LIMIT_PX:g}), which would show as a pop.")
        if asym >= EMOTION_SYMMETRY_PX:
            reasons.append(f"The left and right brows differ by {asym:.1f} px at full weight (the limit is {EMOTION_SYMMETRY_PX:g}). Check both eyes' landmarks.")
        change = face.eye_opening_change(flow)
        kind_ok = not reasons
        all_ok = all_ok and kind_ok
        report[kind] = {"browTravelPx": travel, "poseBrowTravelPx": None if pose_travel is None else round(pose_travel, 2), "flowToPoseRatio": None if ratio is None else round(ratio, 3), "gain": round(gain, 3),
                        "eyeOpenChangePx": [round(v, 2) for v in change], "monotone": monotone, "maxStepPx": round(max_step, 2),
                        "symmetryPx": round(asym, 2), "foldMargin": round(margin, 3), "ok": kind_ok, "reasons": reasons}
        meta["kinds"][kind] = {"strength": strength, "peakFlowPx": float(np.abs(flow).max()), "resPeak": float(np.abs(R * face.boxal[..., None]).max()), "flowFull": 1.0, "resEase": EMOTION_RES_EASE}
    with open(os.path.join(out_dir, "meta.json"), "w") as handle:
        json.dump(meta, handle, separators=(",", ":"))
    result = {"ok_all": all_ok, "kinds": report, "region": meta["region"]}
    with open(os.path.join(out_dir, "report.json"), "w") as handle:
        json.dump(result, handle, indent=1)
    return {"data": result, "width": width, "height": height, "engine": "opencv", "model": "none"}


def read_bgr_alpha(path):
    try:
        image = Image.open(path)
        image.load()
    except Exception:
        raise Refused("failed", "The rest picture could not be read. Send a PNG with a transparent background.")
    rgba = np.asarray(ImageOps.exif_transpose(image).convert("RGBA"))
    return cv2.cvtColor(rgba[..., :3], cv2.COLOR_RGB2BGR), rgba[..., 3]


PACK_BUDGET = 12_582_912
PACK_MIN_PSNR = 38.0
PACK_LOSSY = {"quality": 92, "alpha_quality": 100, "method": 6}
PACK_STATES = {"idle": ["idle1", "idle2"], "listen": ["listen"], "think": ["think"], "speak": ["speak"]}
PACK_LETTERS = "ABCDEFGH"
PACK_LIFE_KEYS = ["nod", "brow", "gazeL", "gazeR", "gazeU", "eyeWide", "eyeSquint", "eyeClosed", "eyeHalf", "mCorner", "mAsymL", "mAsymR", "mUpper", "mPress", "mNostril", "mWrinkle", "smile", "mBrow"]


class PackBuilder:
    def __init__(self, staging, out, descriptor):
        self.staging, self.out, self.d = staging, out, descriptor
        self.converted, self.flows = [], []

    def rel(self, path):
        return os.path.relpath(path, self.out).replace(os.sep, "/")

    def need(self, rel):
        path = os.path.join(self.staging, rel)
        if not os.path.exists(path):
            raise Refused("staging_incomplete", f"The staging folder has no {rel}. Add it (see the pack layout in the integration guide) and try again.")
        return path

    def lossy(self, png, stem):
        """Lossy WebP (q92, alpha lossless, method 6); steps the quality up to 95, 98, then lossless when the picture is under 38 dB; verifies alpha exact and PSNR."""
        with Image.open(png) as image:
            image.load()
            rgba = image.convert("RGBA")
        a = np.asarray(rgba)
        visible = a[..., 3] > 0
        webp = stem + ".webp"
        for quality in (92, 95, 98, None):
            if quality is None:
                rgba.save(webp, "WEBP", lossless=True, exact=True, method=6)
            else:
                rgba.save(webp, "WEBP", **{**PACK_LOSSY, "quality": quality})
            with Image.open(webp) as back:
                b = np.asarray(back.convert("RGBA"))
            alpha_err = int(np.abs(a[..., 3].astype(int) - b[..., 3].astype(int)).max())
            diff = (a[..., :3].astype(np.float64) - b[..., :3].astype(np.float64))[visible]
            mse = float((diff * diff).mean()) if diff.size else 0.0
            psnr = 99.0 if mse == 0 else 10 * float(np.log10(255.0 * 255.0 / mse))
            if quality is None or (psnr >= PACK_MIN_PSNR and alpha_err <= 1):
                break
        self.converted.append({"file": self.rel(webp), "png": os.path.getsize(png), "webp": os.path.getsize(webp), "quality": quality or "lossless", "psnr": round(psnr, 2), "alphaErr": alpha_err})
        return webp

    def lossless(self, png, stem):
        """Lossless WebP when pixel-identical and smaller, else the PNG itself."""
        webp = stem + ".webp"
        with Image.open(png) as image:
            image.load()
            image.save(webp, "WEBP", lossless=True, exact=True, quality=100, method=6)
            a = np.asarray(image.convert("RGBA"))
        with Image.open(webp) as back:
            same = np.array_equal(a, np.asarray(back.convert("RGBA")))
        if same and os.path.getsize(webp) < os.path.getsize(png):
            self.converted.append({"file": self.rel(webp), "png": os.path.getsize(png), "webp": os.path.getsize(webp)})
            return webp
        os.remove(webp)
        shutil.copyfile(png, stem + ".png")
        self.converted.append({"file": self.rel(stem + ".png"), "png": os.path.getsize(png), "webp": None, "kept": "png", "pixelsEqual": same})
        return stem + ".png"

    def flow(self, src, dst):
        raw = open(src, "rb").read()
        packed = zlib.compress(raw, 9)
        assert zlib.decompress(packed) == raw
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst + ".z", "wb") as handle:
            handle.write(packed)
        self.flows.append({"file": self.rel(dst + ".z"), "raw": len(raw), "deflated": len(packed)})

    def folder(self, rel, lossy_stems=()):
        """Convert one staging folder: flows to .z, listed pictures to lossy WebP, other pictures lossless, anything else copied."""
        src, dst = os.path.join(self.staging, rel), os.path.join(self.out, rel)
        os.makedirs(dst, exist_ok=True)
        for name in sorted(os.listdir(src)):
            path = os.path.join(src, name)
            if os.path.isdir(path):
                continue
            stem, ext = os.path.splitext(name)
            if name.endswith(".flow.bin") or name == "flow.bin":
                self.flow(path, os.path.join(dst, name))
            elif ext.lower() == ".png":
                (self.lossy if stem in lossy_stems else self.lossless)(path, os.path.join(dst, stem))
            elif ext.lower() == ".json":
                with open(os.path.join(dst, name), "w") as handle:
                    json.dump(json.load(open(path)), handle, separators=(",", ":"))
            else:
                shutil.copyfile(path, os.path.join(dst, name))

    def video_frames(self, path):
        capture = cv2.VideoCapture(path)
        try:
            return int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))), float(capture.get(cv2.CAP_PROP_FPS))
        finally:
            capture.release()

    def clips(self):
        want = self.d.get("states") or PACK_STATES
        stored, states, phone_needed = {}, {}, bool((self.d.get("tile") or {}).get("phone"))
        for state, names in want.items():
            states[state] = []
            for name in names:
                video = self.need(f"clips/{name}.mp4")
                track_path = self.need(f"clips/{name}.track.json")
                digest = hashlib.sha256(open(video, "rb").read()).hexdigest()
                first = next((other for (key, other_state), other in stored.items() if key == digest and other_state != state), None)  # identical bytes in another state are stored once; never inside one state (each clip in a state needs its own file)
                keep = first or name
                phone_src = os.path.join(self.staging, "clips", f"{name}.phone.mp4")
                if not first:
                    stored[(digest, state)] = name
                    os.makedirs(os.path.join(self.out, "clips"), exist_ok=True)
                    shutil.copyfile(video, os.path.join(self.out, "clips", f"{name}.mp4"))
                    if os.path.exists(phone_src):
                        shutil.copyfile(phone_src, os.path.join(self.out, "clips", f"{name}.phone.mp4"))
                if phone_needed and not os.path.exists(os.path.join(self.out, "clips", f"{keep}.phone.mp4")):
                    raise Refused("staging_incomplete", f"The phone twin clips/{name}.phone.mp4 (320x640) is missing from the staging folder. Make it, or drop the phone tile from the descriptor.")
                track = json.load(open(track_path))
                frames, fps = self.video_frames(video)
                if not (len(track.get("res", [])) == len(track.get("m", [])) == track.get("frames") == frames):
                    raise Refused("clip_mismatch", f"The clip {name} has {frames} frames but its track file has {track.get('frames')} frames, {len(track.get('res', []))} residuals and {len(track.get('m', []))} transforms. Track the clip again so all four agree.")
                if abs(float(track.get("fps", fps)) - fps) > 0.01:
                    raise Refused("clip_mismatch", f"The clip {name} runs at {fps:g} fps but its track file says {track.get('fps')}. Track the clip again.")
                with open(os.path.join(self.out, "clips", f"{name}.track.json"), "w") as handle:  # the sidecar the player reads: fps, frames, residuals and transforms only
                    json.dump({"fps": fps, "frames": frames, "res": track["res"], "m": track["m"]}, handle, separators=(",", ":"))
                entry = {"id": f"{self.d['id']}-{name}", "file": f"clips/{keep}.mp4", "fps": fps, "frames": frames, "rest": {"first": 0, "last": frames - 1},
                         "track": track["res"], "trackFile": f"clips/{name}.track.json", "encoding": "stacked-alpha-h264"}
                if phone_needed:
                    entry["phone"] = f"clips/{keep}.phone.mp4"
                states[state].append(entry)
        return states

    def build(self):
        d = self.d
        for key in ("id", "name", "provenance"):
            if not d.get(key):
                raise Refused("bad_params", f"The companion descriptor needs {key}.")
        os.makedirs(self.out, exist_ok=True)
        states = self.clips()
        mouth_cfg = d.get("mouth") or {}
        if not mouth_cfg.get("anchor"):
            raise Refused("bad_params", "The companion descriptor needs mouth.anchor {x, y, w, h}.")
        for name in ("calm", "shout"):
            if os.path.isdir(os.path.join(self.staging, "mouth", name)):
                self.need(f"mouth/{name}/meta.json")
                self.folder(f"mouth/{name}", lossy_stems=("atlas",))
        self.need("mouth/calm/meta.json")
        self.need("head/meta.json")
        self.folder("head")
        self.folder("eyes")
        emo_meta = json.load(open(self.need("emotion/meta.json")))
        kinds = list(emo_meta["kinds"])
        self.folder("emotion", lossy_stems=tuple(kinds))
        rest = self.lossless(self.need("rest.png") if os.path.exists(os.path.join(self.staging, "rest.png")) else self.rest_input, os.path.join(self.out, "rest"))
        mouth = {"letters": {**{k: i for i, k in enumerate(PACK_LETTERS)}, "wide": len(PACK_LETTERS)}, "anchor": mouth_cfg["anchor"], "calm": {"dir": "mouth/calm"}}
        if os.path.isdir(os.path.join(self.staging, "mouth", "shout")):
            mouth["shout"] = {"dir": "mouth/shout"}
        if os.path.exists(os.path.join(self.staging, "mouth", "calm", "flow.bin")):
            mouth["warp"] = True
        mouth["flowEncoding"] = "int16-deflate"
        life = {k: float((d.get("life") or {}).get(k, 1.0)) for k in PACK_LIFE_KEYS}
        provenance = {"maker": "MaiPai", "makerVersion": "stack", "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **d["provenance"]}
        pack = {"version": 1, "id": d["id"], "name": d["name"], "tile": d.get("tile") or {"desktop": 480, "phone": 320}, "states": states, "mouth": mouth,
                "head": {"dir": "head", "flowEncoding": "int16-deflate"}, "eyes": {"dir": "eyes"}, "emotion": {"dir": "emotion", "kinds": kinds, "flowEncoding": "int16-deflate"},
                "rest": self.rel(rest), "life": life, "budget": {"bytes": 0}, "provenance": provenance}
        pack_json = os.path.join(self.out, "pack.json")
        with open(pack_json, "w") as handle:
            json.dump(pack, handle, indent=1)
        sizes = self.sizes()
        desktop, phone = sum(v for k, v in sizes.items() if not k.endswith(".phone.mp4")), sum(v for k, v in sizes.items() if k.endswith(".phone.mp4"))
        if desktop > PACK_BUDGET:
            biggest = sorted(((k, v) for k, v in sizes.items() if not k.endswith(".phone.mp4")), key=lambda kv: -kv[1])[:5]
            raise Refused("over_budget", f"The pack is {desktop} bytes on the desktop tier; the limit is {PACK_BUDGET}. The largest files are " + ", ".join(f"{k} ({v} bytes)" for k, v in biggest) + ". Make those smaller at the source (shorter clips or fewer in-between tiles); nothing was cut silently.")
        pack["budget"] = {"bytes": min(PACK_BUDGET, -(-(desktop + 16384) // 1024) * 1024), "phoneBytes": phone}
        with open(pack_json, "w") as handle:
            json.dump(pack, handle, indent=1)
        self.loader_check(pack)
        sizes = self.sizes()
        desktop = sum(v for k, v in sizes.items() if not k.endswith(".phone.mp4"))
        report = {"desktopBytes": desktop, "phoneBytes": phone, "converted": self.converted, "flows": self.flows, "files": sorted(sizes)}
        with open(os.path.join(self.out, "build-report.json"), "w") as handle:
            json.dump(report, handle, indent=1)
        return {"pack": {"id": pack["id"], "desktopBytes": desktop, "phoneBytes": phone, "budgetBytes": pack["budget"]["bytes"], "files": len(sizes), "lossyChecks": [c for c in self.converted if "psnr" in c]}}

    def sizes(self):
        found = {}
        for root, _, names in os.walk(self.out):
            for name in names:
                rel = self.rel(os.path.join(root, name))
                if rel != "build-report.json":
                    found[rel] = os.path.getsize(os.path.join(root, name))
        return found

    def loader_check(self, pack):
        """What the player does on load: every named file exists and decodes; frame counts equal track lengths."""
        def exists(rel):
            if not os.path.exists(os.path.join(self.out, rel)):
                raise Refused("loader_check", f"pack.json names {rel} but it is not in the folder. Add the file and build again.")
        exists(pack["rest"])
        for clips in pack["states"].values():
            for clip in clips:
                for key in ("file", "trackFile", "phone"):
                    if key in clip:
                        exists(clip[key])
                if len(clip["track"]) != clip["frames"]:
                    raise Refused("loader_check", f"Clip {clip['id']} has {clip['frames']} frames but a track of {len(clip['track'])} values. Track the clip again.")
        for folder in [pack["mouth"]["calm"]["dir"], *( [pack["mouth"]["shout"]["dir"]] if "shout" in pack["mouth"] else []), pack["head"]["dir"], pack["eyes"]["dir"], pack["emotion"]["dir"]]:
            exists(f"{folder}/meta.json")
        for root, _, names in os.walk(self.out):
            for name in names:
                path = os.path.join(root, name)
                if name.endswith(".webp") or name.endswith(".png"):
                    try:
                        with Image.open(path) as image:
                            image.load()
                    except Exception:
                        raise Refused("loader_check", f"{self.rel(path)} does not decode as a picture. Make the source picture again.")
                elif name.endswith(".flow.bin.z") or name == "flow.bin.z":
                    try:
                        raw = zlib.decompress(open(path, "rb").read())
                    except zlib.error:
                        raise Refused("loader_check", f"{self.rel(path)} is not a valid deflated flow file. Build again.")
                    if len(raw) % 4:
                        raise Refused("loader_check", f"{self.rel(path)} does not hold whole int16 pairs. Rebuild the flow.")
        for kind in pack["emotion"]["kinds"]:
            exists(f"emotion/{kind}.flow.bin.z")
            exists(f"emotion/{kind}.webp")


def pack_assemble(request, params):
    """Turn a staging folder into a companion pack. request.input is the rest picture (used when staging has no rest.png).
    params: staging (folder with clips/, mouth/calm, mouth/shout, head/, eyes/, emotion/ as emotion_bake writes it), out_dir (the pack folder, replaced),
    descriptor {id, name, provenance {source, maker?, makerVersion?, created?}, tile?, life?, mouth {anchor {x, y, w, h}}, states? {state: [clip names]}}.
    PNG becomes lossy WebP (atlases and emotion pictures, q92 and steps up when under 38 dB) or lossless WebP, flows become zlib level 9 .z, pack.json is written
    for the CompanionPack schema, the desktop budget (12,582,912 bytes) is enforced with a refusal that names the largest files, and a loader check runs."""
    staging, out_dir, descriptor = params.get("staging"), params.get("out_dir"), params.get("descriptor")
    if not staging or not os.path.isdir(staging):
        raise Refused("frames_required", "Say where the staging folder is (staging), a folder holding clips, mouth, head, eyes and emotion.")
    if not out_dir or not isinstance(descriptor, dict):
        raise Refused("bad_params", "Say where to write the pack (out_dir) and give the companion descriptor.")
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    builder = PackBuilder(staging, out_dir, descriptor)
    builder.rest_input = request["input"]
    try:
        result = builder.build()
    except Refused:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    return {"data": result, "engine": "pillow", "model": "none"}


OPS = {"remove_background": remove_background, "erase": erase, "upscale": upscale, "resize": resize, "find_people": find_people, "people_mask": people_mask, "erase_people": erase_people, "find_subjects": find_subjects, "erase_subjects": erase_subjects, "clip_track": clip_track, "emotion_bake": emotion_bake, "pack_assemble": pack_assemble}


def main():
    print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.time()
        reply = {"id": None}
        try:
            request = json.loads(line)
            reply["id"] = request.get("id")
            op = OPS.get(request.get("op"))
            if op is None:
                raise Refused("bad_operation", "That operation is not one of remove_background, erase, upscale, resize, find_people, erase_people, find_subjects, erase_subjects, clip_track, emotion_bake or pack_assemble.")
            reply.update(op(request, request.get("params") or {}))
            reply["ok"] = True
        except Refused as refused:
            reply.update({"ok": False, "code": refused.code, "error": str(refused)})
        except MemoryError:
            _sessions.clear()
            reply.update({"ok": False, "code": "out_of_memory", "error": "This picture needs more memory than is free. Try a smaller picture."})
        except Exception as error:  # a picture that will not decode, a model that will not run
            reply.update({"ok": False, "code": "failed", "error": f"The picture could not be processed ({type(error).__name__}). Try a different file."})
        reply["ms"] = round((time.time() - started) * 1000)
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
