# The Stack's video generation worker (VIDEO-GEN-01). One process, JSON lines
# on stdin and stdout, no port. It is started by the Stack on the first video
# job, serves jobs one at a time, and is stopped by the Stack when it has been
# idle for ten minutes or a job is cancelled; it never outlives the Stack.
#
# Runtime: mlx-video (MIT, Blaizzy/mlx-video, commit 87db56a) on Apple's GPU,
# the Wan2.2 TI2V-5B path, with FastWan's 3-step DMD distilled weights. The
# pinned source is used as shipped; this file adds what the Stack needs
# around it without editing it (each is a small runtime substitution):
#   1. the DMD sampler (predict x0, renoise to the next sigma) in place of the
#      stock solver, using the sigmas the weights' own config.json declares;
#   2. the umt5 tokenizer read from the Stack's pinned local copy instead of
#      the Hugging Face lookup mlx-video makes at run time, so the worker needs
#      no network (it runs with HF_HUB_OFFLINE=1);
#   3. progress by phase (loading, rendering, decoding, encoding) from the
#      denoise loop, the tiled VAE decode and the encoder;
#   4. an H.264 yuv420p mp4 with the moov box first, and a JPEG poster of
#      frame 0, both written without metadata.
# Nothing is logged with a prompt or a picture: stderr carries phase and
# size only. A prompt, a reference picture and a clip never leave the files
# the Stack named for this one job.
import gc
import io
import json
import os
import re
import sys
import time
import traceback
import mlx.core as mx

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# Hard ceilings, mirrored in the Stack's service. The worker refuses past them
# even if a caller got that far.
MAX_FRAMES = 121
FPS = 24
MAX_PIXELS = 832 * 480
MAX_REFERENCE_PIXELS = 40_000_000
PREVIEW_SIDE = 480

# 10% of the 44.1 GB measured video footprint in memory-management-2026-10-25 section 4.1.
MLX_CACHE_LIMIT_BYTES = int(4.41 * (1 << 30))
mx.set_cache_limit(MLX_CACHE_LIMIT_BYTES)

_real_out = sys.stdout
_current = {"id": None, "dmd_sigmas": [1.0, 0.757, 0.522, 0.0], "tokenizer_dir": None, "poster": None, "t": 0.0}


def emit(obj):
    _real_out.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _real_out.flush()


def stage(name, n=None, of=None):
    """Where the clip is, for the progress bar: load_text, plan, load_model, motion, frames or save, with "n of of" inside a stage
    (n counts what is already done)."""
    event = {"id": _current["id"], "event": "stage", "stage": name}
    if n is not None and of:
        event["n"] = int(n)
        event["of"] = int(of)
    emit(event)


def phase(name, percent=None):
    event = {"id": _current["id"], "event": "phase", "phase": name}
    if percent is not None:
        event["percent"] = max(0, min(100, int(percent)))
    emit(event)


class _Sink(io.TextIOBase):
    """mlx-video prints coloured progress text. None of it is forwarded (it
    can echo a prompt); only phase boundaries are read from it."""

    def __init__(self):
        self._line = ""

    def write(self, text):
        self._line += text
        while "\n" in self._line:
            line, self._line = self._line.split("\n", 1)
            line = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if line.startswith("Loading T5"):
                phase("loading")
                stage("load_text")
            elif line.startswith("Encoding text") or line.startswith("Encoding input image"):
                phase("loading")
                stage("plan")
            elif line.startswith("Loading transformer"):
                phase("loading")
                stage("load_model")
            elif line.startswith("Decoding with VAE"):
                phase("decoding", 0)
                stage("frames")
        return len(text)

    def flush(self):
        pass


def _install_patches():
    """Applied once, after the first import of mlx-video."""
    import mlx.core as mx
    import mlx_video.models.wan_2.generate as gen
    import mlx_video.models.wan_2.scheduler as sch
    import mlx_video.models.wan_2.tiling as tiling

    class FlowDMDScheduler:
        """FastWan's sampler: x0 = x - sigma * v, then renoise to the next sigma."""

        def __init__(self, num_train_timesteps=1000):
            self.num_train_timesteps = num_train_timesteps

        def set_timesteps(self, num_steps, shift=1.0):
            self._sigmas = list(_current["dmd_sigmas"])
            self.timesteps = mx.array([float(int(s * self.num_train_timesteps)) for s in self._sigmas[:-1]])
            self._index = 0

        def step(self, model_output, timestep, sample):
            sigma = self._sigmas[self._index]
            nxt = self._sigmas[self._index + 1]
            x0 = sample - sigma * model_output
            self._index += 1
            if nxt <= 0.0:
                return x0
            return (1.0 - nxt) * x0 + nxt * mx.random.normal(x0.shape).astype(x0.dtype)

        def reset(self):
            self._index = 0

    # generate_video resolves its solver from this module at call time.
    sch.FlowUniPCScheduler = FlowDMDScheduler

    def progress_tqdm(iterable, *args, **kwargs):
        items = list(iterable)
        total = max(1, len(items))
        for index, item in enumerate(items):
            phase("rendering", 100.0 * index / total)
            stage("motion", index, total)
            yield item
        phase("rendering", 100)

    gen.tqdm = progress_tqdm

    original_decode = tiling.decode_with_tiling

    def tile_count(shape, config, spatial_scale, temporal_scale, causal_temporal):
        _, _, f_latent, h_latent, w_latent = shape
        if config.spatial_config is not None:
            size = config.spatial_config.tile_size_in_pixels // spatial_scale
            overlap = config.spatial_config.tile_overlap_in_pixels // spatial_scale
        else:
            size, overlap = max(h_latent, w_latent), 0
        if config.temporal_config is not None:
            t_size = config.temporal_config.tile_size_in_frames // temporal_scale
            t_overlap = config.temporal_config.tile_overlap_in_frames // temporal_scale
        else:
            t_size, t_overlap = f_latent, 0
        splitter = tiling.split_in_temporal if causal_temporal else tiling.split_in_spatial
        return (
            len(splitter(t_size, t_overlap, f_latent).starts)
            * len(tiling.split_in_spatial(size, overlap, h_latent).starts)
            * len(tiling.split_in_spatial(size, overlap, w_latent).starts)
        )

    def counted_decode(*args, **kwargs):
        decoder_fn = kwargs.get("decoder_fn", args[0] if args else None)
        latents = kwargs.get("latents", args[1] if len(args) > 1 else None)
        config = kwargs.get("tiling_config", args[2] if len(args) > 2 else None)
        try:
            total = max(1, tile_count(latents.shape, config, kwargs.get("spatial_scale", 32), kwargs.get("temporal_scale", 8), kwargs.get("causal_temporal", True)))
        except Exception:
            total = 0
        state = {"n": 0}
        if total:
            stage("frames", 0, total)

        def counting(tile, **kw):
            out = decoder_fn(tile, **kw)
            mx.eval(out)
            state["n"] += 1
            if total:
                phase("decoding", min(99, 100.0 * state["n"] / total))
                stage("frames", min(state["n"], total), total)
            return out

        if "decoder_fn" in kwargs:
            kwargs["decoder_fn"] = counting
        else:
            args = (counting,) + tuple(args[1:])
        return original_decode(*args, **kwargs)

    tiling.decode_with_tiling = counted_decode

    def save_video(frames, output_path, fps=FPS):
        phase("encoding", 0)
        stage("save")
        import imageio
        from PIL import Image

        poster = _current.get("poster")
        if poster:
            Image.fromarray(frames[0]).save(poster, format="JPEG", quality=88, optimize=True)
        writer = imageio.get_writer(
            output_path,
            fps=fps,
            codec="libx264",
            quality=8,
            macro_block_size=16,
            pixelformat="yuv420p",
            output_params=["-movflags", "+faststart", "-map_metadata", "-1", "-an"],
        )
        total = len(frames)
        for index, frame in enumerate(frames):
            writer.append_data(frame)
            if index % 24 == 0:
                phase("encoding", 100.0 * index / total)
        writer.close()
        phase("encoding", 100)
        _current["frames_written"] = total

    gen.save_video = save_video

    original_load_vae_decoder = gen.load_vae_decoder

    def load_vae_decoder_with_preview(*args, **kwargs):
        """The moment the motion is finished and the long decode is about to start, draw the first frame of the clip on its own
        (one latent frame through the same decoder: a picture-sized decode, not a clip-sized one) and write it where the Stack
        serves it as the card's preview. A preview that cannot be drawn is skipped; the clip never depends on it."""
        decoder = original_load_vae_decoder(*args, **kwargs)
        target = _current.get("preview")
        if not target:
            return decoder
        original_tiled = decoder.decode_tiled

        def decode_tiled(z, *a, **k):
            try:
                from PIL import Image

                started = time.time()
                frame = decoder(z[:, :1])
                mx.eval(frame)
                import numpy as np

                array = np.array(frame[0][0])
                array = np.clip((array + 1.0) / 2.0 * 255.0, 0, 255).astype(np.uint8)
                image = Image.fromarray(array)
                image.thumbnail((PREVIEW_SIDE, PREVIEW_SIDE), Image.LANCZOS)
                temp = target + ".tmp"
                image.save(temp, format="JPEG", quality=80)
                os.replace(temp, target)
                emit({"id": _current["id"], "event": "preview", "ms": int((time.time() - started) * 1000)})
                mx.clear_cache()
            except Exception:  # noqa: BLE001
                pass
            return original_tiled(z, *a, **k)

        decoder.decode_tiled = decode_tiled
        return decoder

    gen.load_vae_decoder = load_vae_decoder_with_preview

    from transformers import AutoTokenizer

    original_from_pretrained = AutoTokenizer.from_pretrained.__func__

    def local_tokenizer(cls, name, *args, **kwargs):
        if name == "google/umt5-xxl" and _current["tokenizer_dir"]:
            name = _current["tokenizer_dir"]
            kwargs["local_files_only"] = True
        return original_from_pretrained(cls, name, *args, **kwargs)

    AutoTokenizer.from_pretrained = classmethod(local_tokenizer)
    return gen


_gen = None


def _prepare_reference(path):
    """Opens the reference picture, applies its orientation, drops metadata and
    writes a plain RGB PNG next to it for the pipeline."""
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_REFERENCE_PIXELS
    image = Image.open(path)
    image.load()
    image = ImageOps.exif_transpose(image).convert("RGB")
    cleaned = path + ".rgb.png"
    image.save(cleaned, format="PNG")
    return cleaned


def generate(request):
    global _gen

    width, height, frames = int(request["width"]), int(request["height"]), int(request["num_frames"])
    if frames < 5 or frames > MAX_FRAMES or (frames - 1) % 4:
        raise ValueError("frames must be 4n+1 and at most %d" % MAX_FRAMES)
    if width % 32 or height % 32 or width * height > MAX_PIXELS or width < 256 or height < 256:
        raise ValueError("size must be a multiple of 32 within 832 x 480 of area")
    model_dir = request["model_dir"]
    if not os.path.isfile(os.path.join(model_dir, "model.safetensors")):
        raise FileNotFoundError("the video model is not installed")
    with open(os.path.join(model_dir, "config.json")) as handle:
        sigmas = (json.load(handle).get("fastwan_dmd") or {}).get("sigmas")
    if not sigmas or sigmas[-1] != 0.0:
        raise ValueError("the installed weights are not the FastWan DMD build")
    _current["dmd_sigmas"] = [float(s) for s in sigmas]
    _current["tokenizer_dir"] = request["tokenizer_dir"]
    _current["poster"] = request["poster"]
    _current["preview"] = request.get("preview")
    started = time.time()
    phase("loading", 0)
    if _gen is None:
        _gen = _install_patches()
    image = None
    if request.get("image"):
        image = _prepare_reference(request["image"])
    mx.reset_peak_memory()
    old_stdout = sys.stdout
    sys.stdout = _Sink()
    try:
        _gen.generate_video(
            model_dir=model_dir,
            prompt=request["prompt"],
            negative_prompt=request.get("negative_prompt") or "",
            image=image,
            width=width,
            height=height,
            num_frames=frames,
            steps=len(sigmas) - 1,
            guide_scale=1.0,
            seed=int(request["seed"]),
            output_path=request["output"],
            scheduler="unipc",
            loras=[(path, float(strength)) for path, strength in request.get("loras", [])] or None,
            tiling="aggressive",
        )
    finally:
        sys.stdout = old_stdout
        if image and os.path.exists(image):
            os.remove(image)
        gc.collect()
        mx.clear_cache()
    peak = mx.get_peak_memory()
    return {"width": width, "height": height, "frames": frames, "fps": FPS, "seed": int(request["seed"]), "ms": int((time.time() - started) * 1000), "peak_bytes": int(peak)}


def classify(error):
    text = str(error)
    lowered = text.lower()
    if isinstance(error, MemoryError) or "out of memory" in lowered or "insufficient memory" in lowered or "kiogpucommandbuffercallbackerror" in lowered:
        return "out_of_memory", "The computer ran out of memory while making the clip. Close other big apps and try again."
    if isinstance(error, FileNotFoundError):
        return "model_missing", "The video model is not installed. Install it from the Stack, then try again."
    if isinstance(error, ValueError):
        return "bad_request", text
    return "failed", "The clip could not be made (%s). Try again; if it keeps failing, restart the Stack." % type(error).__name__


def main():
    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        if request.get("op") == "quit":
            break
        _current["id"] = request.get("id")
        try:
            result = generate(request)
            emit({"id": request["id"], "ok": True, **result})
        except BaseException as error:  # noqa: BLE001 - every failure becomes a reply, the process stays up
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code, message = classify(error)
            # Phase, type and code only: the traceback can carry a prompt.
            sys.stderr.write("video worker: %s (%s)\n" % (code, type(error).__name__))
            sys.stderr.flush()
            if os.environ.get("VIDEO_WORKER_DEBUG") == "1":
                traceback.print_exc()
            emit({"id": request.get("id"), "ok": False, "code": code, "error": message})


if __name__ == "__main__":
    main()
