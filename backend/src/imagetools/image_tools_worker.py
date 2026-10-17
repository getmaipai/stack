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
import json
import os
import subprocess
import sys
import time

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


def erase_people(request, params):
    """Erase the chosen people (params.people: a list of numbers from find_people, or "all"), filling with LaMa."""
    src = load(request["input"], "erase_in")
    rgba = np.asarray(src.convert("RGBA"))
    rgb = np.ascontiguousarray(rgba[..., :3])
    height, width = rgb.shape[:2]
    labels, boxes = people_labels(request, rgb)
    wanted = params.get("people", "all")
    ids = [b["id"] for b in boxes] if wanted == "all" else [int(v) for v in wanted]
    unknown = [v for v in ids if v not in [b["id"] for b in boxes]]
    if not ids or unknown:
        raise Refused("people_required", "Say which person to remove by the number from find_people, or all of them.")
    person = np.isin(labels, ids).astype(np.uint8) * 255
    # Cover the soft edge, hair, shadows at the feet and a hand-held object: a margin proportional to the picture.
    k = max(5, int(round(max(height, width) * 0.018)) | 1)
    mask = cv2.dilate(person, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if mask.mean() / 255 > 0.5:
        raise Refused("mask_too_big", "The people to remove cover more than half of the picture.")
    sess = session("lama", request["models"].get("lama"))
    filled, crop = lama_fill(sess, rgb, mask)
    out = np.dstack([filled, rgba[..., 3]]) if "A" in src.getbands() else filled
    save_png(out, request["output"])
    return {"width": width, "height": height, "engine": "apple-vision+lama", "model": "VNGeneratePersonInstanceMaskRequest+big-lama-onnx", "crop_px": crop, "people": boxes}


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


OPS = {"remove_background": remove_background, "erase": erase, "upscale": upscale, "resize": resize, "find_people": find_people, "erase_people": erase_people}


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
                raise Refused("bad_operation", "That operation is not one of remove_background, erase, upscale, resize, find_people or erase_people.")
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
