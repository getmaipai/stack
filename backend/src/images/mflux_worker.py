#!/usr/bin/env python3
"""IMGGEN-STACK-01: the image worker. One process, one request at a time, JSON lines.

stdin  : {"id", "op": "generate" | "edit", ...} one per line, or {"op": "cancel", "id"} at any time.
stdout : {"ready": true}; then per request {"id", "event": "phase", "phase", "percent"} and
         {"id", "event": "image", "index", ...}; then one {"id", "ok": true | false, ...}.
stderr : never read for content by the Stack (prompts are never logged).

The model stays loaded between requests and is rebuilt only when the family, the
quantization, the mode (text to picture or reference edit) or the LoRA set changes.
LoRAs are applied unbaked (about 0.6 s a picture slower, 8 GB less peak, no rebuild
to change a scale). A cancel interrupts the main thread, which mflux turns into a
StopImageGenerationException between steps. Nothing here opens a network
connection: the Stack starts the worker with HF_HUB_OFFLINE=1 and hands it a local
snapshot folder.
"""
import _thread
import gc
import json
import os
import queue
import sys
import threading
import time
import traceback

PROTO = sys.stdout
sys.stdout = sys.stderr  # stray prints must never corrupt the protocol channel


def send(message):
    PROTO.write(json.dumps(message) + "\n")
    PROTO.flush()


import mlx.core as mx  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402

from mflux.models.common.config.model_config import ModelConfig  # noqa: E402
from mflux.utils.exceptions import StopImageGenerationException  # noqa: E402

# 10% of the 29 GB planned picture-pool peak in memory-management-2026-10-25 section 4.1.
MLX_CACHE_LIMIT_BYTES = int(2.9 * (1 << 30))
mx.set_cache_limit(MLX_CACHE_LIMIT_BYTES)

THUMB_SIDE = 384
PREVIEW_SIDE = 256

state = {"models": {}, "family": None, "steps": 0, "on_step": None, "preview": None, "prev": None}
inbox: "queue.Queue[dict]" = queue.Queue()
running = {"id": None}


class Cancelled(Exception):
    pass


def pooled_preview(model, family, x0, config):
    """A small RGB array (uint8) of an estimate of the finished picture, decoded from latents pooled down so the
    decoder works on about a 256 px picture: a few milliseconds, not a full-size decode."""
    import numpy as np

    height, width = int(config.height), int(config.width)
    k = max(1, int(round(max(height, width) / float(PREVIEW_SIDE))))
    if family == "flux2-klein-4b":
        lh, lw = height // 16, width // 16
        grid = x0.reshape(x0.shape[0], lh, lw, x0.shape[-1])
        lh2, lw2 = (lh // k) * k, (lw // k) * k
        grid = grid[:, :lh2, :lw2, :]
        grid = grid.reshape(grid.shape[0], lh2 // k, k, lw2 // k, k, grid.shape[-1]).mean(axis=(2, 4))
        packed = grid.transpose(0, 3, 1, 2)
        decoded = model.vae.decode_packed_latents(packed, tiling_config=None)
    else:
        from mflux.models.z_image.latent_creator.z_image_latent_creator import ZImageLatentCreator
        from mflux.models.common.vae.vae_util import VAEUtil

        plain = ZImageLatentCreator.unpack_latents(x0, config.height, config.width)
        lh, lw = plain.shape[-2], plain.shape[-1]
        lh2, lw2 = (lh // k) * k, (lw // k) * k
        plain = plain[..., :lh2, :lw2]
        plain = plain.reshape(plain.shape[0], plain.shape[1], lh2 // k, k, lw2 // k, k).mean(axis=(3, 5))
        decoded = VAEUtil.decode(vae=model.vae, latent=plain, tiling_config=None)
    array = np.array(mx.clip(decoded[0] / 2 + 0.5, 0, 1).transpose(1, 2, 0).astype(mx.float32))
    return (array * 255).astype(np.uint8)


def write_preview(out_dir, array):
    path = os.path.join(out_dir, "preview.jpg")
    temp = path + ".tmp"
    Image.fromarray(array).save(temp, "JPEG", quality=72)
    os.replace(temp, path)


class Progress:
    """An mflux in-loop callback: reports the step, and (when the request asks) a small preview of where the picture is heading.

    The preview is the straight-line estimate of the finished picture: mflux's schedulers are Euler steps along
    x(s) = (1 - s) * picture + s * noise, so two consecutive latents and their sigmas give the point at sigma 0.
    """

    def call_before_loop(self, seed, prompt, latents, config, **_):
        state["prev"] = latents
        started = state.get("on_start")
        if started:
            started(int(config.num_inference_steps))

    def call_in_loop(self, t, seed, prompt, latents, config, time_steps):
        previous, state["prev"] = state.get("prev"), latents
        total = config.num_inference_steps
        settings = state.get("preview")
        if settings and previous is not None:
            try:
                sigmas = config.scheduler.sigmas
                s_now, s_next = float(sigmas[t]), float(sigmas[t + 1])
                x0 = previous - s_now * (latents - previous) / (s_next - s_now) if s_next != s_now else latents
                write_preview(settings["dir"], pooled_preview(settings["model"], state["family"], x0, config))
                settings["on_preview"](t + 1, total)
            except Exception:  # noqa: BLE001 - a preview never fails a picture
                state["preview"] = None
        callback = state.get("on_step")
        if callback:
            callback(t + 1, total)


def reader():
    for line in sys.stdin:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("op") == "cancel":
            if running["id"] is not None and running["id"] == message.get("id"):
                _thread.interrupt_main()
            continue
        inbox.put(message)
    inbox.put({"op": "exit"})


def free_model():
    state["models"].clear()
    gc.collect()
    mx.clear_cache()


def build(request, mode):
    family = request.get("create_family" if mode == "gen" else "edit_family", request["family"])
    quantize = request.get("quantize")
    loras = [(path, float(scale)) for path, scale in request.get("loras", [])]
    key = (family, mode, quantize, tuple(loras), request["model_dir"])
    role = "create" if mode == "gen" else "edit"
    if request.get("pool_strategy") == "single":
        other = "edit" if role == "create" else "create"
        state["models"].pop(other, None)
        gc.collect()
        mx.clear_cache()
    cached = state["models"].get(role)
    if cached and cached[0] == key:
        state["family"] = family
        return cached[1]
    state["models"].pop(role, None)
    gc.collect()
    mx.clear_cache()
    lora_paths = [path for path, _ in loras] or None
    lora_scales = [scale for _, scale in loras] or None
    common = dict(quantize=quantize, model_path=request["model_dir"], lora_paths=lora_paths, lora_scales=lora_scales, bake_lora=False)
    if family == "flux2-klein-4b":
        if mode == "edit":
            from mflux.models.flux2.variants import Flux2KleinEdit

            model = Flux2KleinEdit(model_config=ModelConfig.flux2_klein_4b(), **common)
        else:
            from mflux.models.flux2.variants import Flux2Klein

            model = Flux2Klein(model_config=ModelConfig.flux2_klein_4b(), **common)
    elif family == "ernie-image-turbo":
        if mode == "edit":
            raise ValueError("unsupported_edit")
        from mflux.models.ernie_image.variants.txt2img.ernie_image import ErnieImage

        # mflux 0.23.0 (the pin) has the config on ModelConfig; ConfigResolution is not in that release.
        ernie_config = ModelConfig.ernie_image_turbo()
        model = ErnieImage(model_config=ernie_config, **common)
    elif family == "z-image-turbo":
        if mode == "edit":
            raise ValueError("unsupported_edit")
        from mflux.models.z_image.variants.z_image import ZImage

        model = ZImage(model_config=ModelConfig.z_image_turbo(), **common)
    else:
        raise ValueError("unknown_family")
    model.callbacks.register(Progress())
    state["models"][role] = (key, model)
    state["family"] = family
    return model


def thumbnail(image, path):
    thumb = image.convert("RGB")
    thumb.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.LANCZOS)
    thumb.save(path, "JPEG", quality=84)


def save_pair(image, out_dir, index):
    os.makedirs(out_dir, exist_ok=True)
    png = os.path.join(out_dir, f"{index}.png")
    clean = Image.new("RGB", image.size)
    clean.paste(image.convert("RGB"))
    clean.save(png, "PNG")  # a fresh PNG: no EXIF, no profile, no generation parameters
    thumbnail(clean, os.path.join(out_dir, f"{index}.thumb.jpg"))
    return png


def phase(request_id, name, percent):
    send({"id": request_id, "event": "phase", "phase": name, "percent": int(percent)})


def stage(request_id, name, n=None, of=None):
    """Where the request is, for the progress bar: load, plan, steps (n of of) or decode."""
    event = {"id": request_id, "event": "stage", "stage": name}
    if n is not None:
        event["n"] = int(n)
        event["of"] = int(of)
    send(event)


def generate(request):
    rid = request["id"]
    count = int(request.get("count", 1))
    steps = int(request["steps"])
    width, height = int(request["width"]), int(request["height"])
    phase(rid, "loading", 0)
    stage(rid, "load")
    model = build(request, "gen")
    phase(rid, "loading", 100)
    mx.reset_peak_memory()
    started = time.time()
    want_preview = bool(request.get("preview"))
    seeds = []
    for index in range(count):
        seed = int(request["seed"]) + index
        seeds.append(seed)

        def on_step(done, total, index=index):
            overall = (index + (done / total) * 0.97) / count * 100
            phase(rid, "decoding" if done >= total else "rendering", overall)
            stage(rid, "decode" if done >= total else "steps", *(() if done >= total else (done, total)))

        state["on_step"] = on_step
        state["on_start"] = lambda total: stage(rid, "steps", 0, total)
        if want_preview:
            def on_preview(step, total, index=index):
                send({"id": rid, "event": "preview", "index": index, "step": step, "steps": total})

            state["preview"] = {"dir": request["out_dir"], "model": model, "on_preview": on_preview}
        else:
            state["preview"] = None
        stage(rid, "plan")
        kwargs = dict(seed=seed, prompt=request["prompt"], num_inference_steps=steps, width=width, height=height)
        if request.get("family") == "ernie-image-turbo":
            kwargs["guidance"] = 1.0
        if request.get("init_image"):
            kwargs["image_path"] = request["init_image"]
            kwargs["image_strength"] = float(request.get("strength", 0.6))
        result = model.generate_image(**kwargs)
        save_pair(result.image, request["out_dir"], index)
        send({"id": rid, "event": "image", "index": index, "seed": seed})
    state["on_step"] = None
    state["on_start"] = None
    state["preview"] = None
    state["prev"] = None
    return {"seeds": seeds, "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory())}


def round16(value):
    return max(16, int(round(value / 16.0)) * 16)


def edit(request):
    rid = request["id"]
    steps = int(request["steps"])
    seed = int(request["seed"])
    feather = max(0, int(request.get("feather", 12)))
    phase(rid, "loading", 0)
    model = build(request, "edit")
    phase(rid, "loading", 100)
    mx.reset_peak_memory()
    started = time.time()
    source = Image.open(request["image"]).convert("RGB")
    width, height = source.size
    mask = Image.open(request["mask"]).convert("L").resize((width, height), Image.LANCZOS) if request.get("mask") else None
    mask = mask.point(lambda v: 255 if v > 127 else 0) if mask is not None else None
    region = request.get("region")
    box = (0, 0, width, height)
    if region:
        rx, ry, rw, rh = [float(v) for v in region]
        left, top = int(rx * width), int(ry * height)
        right, bottom = int((rx + rw) * width), int((ry + rh) * height)
        pad = int(max(right - left, bottom - top) * 0.25) + 32
        box = (max(0, left - pad), max(0, top - pad), min(width, right + pad), min(height, bottom + pad))
    elif mask is not None:
        bounds = mask.getbbox()
        if bounds is None:
            raise ValueError("mask_empty")
        # Edit the masked area with context around it when it is a small part of the picture.
        if (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) < 0.25 * width * height:
            pad = int(max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.25) + 32
            box = (max(0, bounds[0] - pad), max(0, bounds[1] - pad), min(width, bounds[2] + pad), min(height, bounds[3] + pad))
    # IMGEDIT-01: with a reference picture (a person to add) the model needs the whole scene to place them, not a crop of it.
    extra = request.get("references") or []
    if extra:
        box = (0, 0, width, height)
    crop = source.crop(box)
    cw, ch = crop.size
    scale = min(1.0, 1024.0 / max(cw, ch))
    ew, eh = round16(cw * scale), round16(ch * scale)
    work = request["out_dir"]
    os.makedirs(work, exist_ok=True)
    reference = os.path.join(work, "reference.png")
    crop.resize((ew, eh), Image.LANCZOS).save(reference, "PNG")
    reference_paths = [reference]
    for index, path in enumerate(extra):
        extra_image = Image.open(path).convert("RGB")
        extra_scale = min(1.0, 1024.0 / max(extra_image.size))
        extra_path = os.path.join(work, f"reference{index + 1}.png")
        extra_image.resize((max(16, round16(extra_image.width * extra_scale)), max(16, round16(extra_image.height * extra_scale))), Image.LANCZOS).save(extra_path, "PNG")
        reference_paths.append(extra_path)

    def on_step(done, total):
        phase(rid, "decoding" if done >= total else "rendering", done / total * 95)

    state["on_step"] = on_step
    state["preview"] = None
    result = model.generate_image(seed=seed, prompt=request["prompt"], num_inference_steps=steps, width=ew, height=eh, image_paths=reference_paths)
    state["on_step"] = None
    for path in reference_paths:
        os.remove(path)
    edited = result.image.convert("RGB")
    if edited.size != crop.size:
        edited = edited.resize(crop.size, Image.LANCZOS)
    alpha = None
    if mask is not None:
        alpha = mask.crop(box)
    elif region:
        alpha = Image.new("L", crop.size, 0)
        alpha.paste(255, (int(float(region[0]) * width) - box[0], int(float(region[1]) * height) - box[1], int((float(region[0]) + float(region[2])) * width) - box[0], int((float(region[1]) + float(region[3])) * height) - box[1]))
    if alpha is not None:
        if feather > 0:
            alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
        edited = Image.composite(edited, crop, alpha)
    output = source.copy()
    output.paste(edited, box[:2])
    save_pair(output, work, 0)
    send({"id": rid, "event": "image", "index": 0, "seed": seed})
    return {"seeds": [seed], "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory()), "width": width, "height": height}


# Exception types whose message names a missing module, file or attribute, never a value the person typed.
SAFE_MESSAGE_TYPES = ("ImportError", "ModuleNotFoundError", "AttributeError", "FileNotFoundError", "NotADirectoryError", "PermissionError")


def diagnostics(error, request):
    """What the Stack may log about a failure so it can be diagnosed later: the exception type, the last frames as file:line in function
    (never the source line, never local values), and the message only for the types above, with the prompt blanked out. Rule 6a: a
    prompt never reaches a log."""
    frames = [f"{os.path.basename(frame.filename)}:{frame.lineno} in {frame.name}" for frame in traceback.extract_tb(error.__traceback__)[-8:]]
    name = type(error).__name__
    note = None
    if name in SAFE_MESSAGE_TYPES:
        note = str(error)[:200]
        prompt = request.get("prompt")
        if isinstance(prompt, str) and prompt:
            note = note.replace(prompt, "[prompt]")
    return {"type": name, "frames": frames, "message": note}


CODES = {"unknown_family": "bad_request", "unsupported_edit": "unsupported_edit", "mask_empty": "mask_empty"}


def handle(request):
    rid = request["id"]
    running["id"] = rid
    try:
        body = edit(request) if request["op"] == "edit" else generate(request)
        send({"id": rid, "ok": True, **body})
    except (KeyboardInterrupt, StopImageGenerationException):
        state["on_step"] = None
        state["preview"] = None
        send({"id": rid, "ok": False, "code": "cancelled", "error": "Cancelled."})
    except MemoryError:
        free_model()
        send({"id": rid, "ok": False, "code": "out_of_memory", "error": "There was not enough memory for that picture. Try a smaller size."})
    except Exception as error:  # noqa: BLE001
        state["on_step"] = None
        state["preview"] = None
        text = str(error)
        code = CODES.get(text)
        if code is None and ("memory" in text.lower() or "metal" in text.lower() and "alloc" in text.lower()):
            code = "out_of_memory"
            free_model()
        sys.stderr.write(traceback.format_exc())
        send({"id": rid, "ok": False, "code": code or "failed", "error": text if code else "The picture engine failed on that request.", "diag": diagnostics(error, request)})
    finally:
        running["id"] = None
        state.update(on_step=None, on_start=None, preview=None, prev=None)
        gc.collect()
        mx.clear_cache()


def main():
    threading.Thread(target=reader, daemon=True).start()
    send({"ready": True})
    while True:
        try:
            request = inbox.get()
        except KeyboardInterrupt:
            continue
        if request.get("op") == "exit":
            return
        if request.get("op") in ("generate", "edit"):
            try:
                handle(request)
            except KeyboardInterrupt:
                send({"id": request.get("id"), "ok": False, "code": "cancelled", "error": "Cancelled."})


if __name__ == "__main__":
    main()
