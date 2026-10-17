# The Stack's Detailed video worker (VIDEO-LTX-01). Same protocol as video_worker.py (JSON lines on stdin and stdout, no
# port, one clip at a time, started on the first Detailed clip and stopped by the Stack when idle) and the same mlx-video
# environment (Blaizzy/mlx-video, MIT, commit 87db56a), but the LTX-2.3 22B distilled model: 8 + 3 denoise steps, a spatial
# x2 upscaler, and a sound track made in the same pass as the picture, speech included. The weights are Lightricks'
# (LTX-2.x Community License) read from the Stack's own model folder; the text encoder is Gemma 3 12B (Gemma Terms of Use)
# read from its own folder. Nothing is fetched at run time (HF_HUB_OFFLINE=1).
#
# The pinned source is used as shipped; this file adds what the Stack needs around it, each a small runtime substitution:
#   1. the text encoder's attention mask: the shipped one fills masked positions with the bfloat16 minimum, and with the
#      pinned mlx-vlm the sum overflows to -inf and the whole prompt becomes NaN (black picture, silent track, measured
#      2026-10-17); a large finite value (-1e9) is what the reference implementation effectively uses;
#   2. community LoRAs (merged into the transformer as it loads, strength by strength);
#   3. progress by stage (motion steps, frame tiles, saving) in place of the engine's console bars;
#   4. the picture encoder (picture to video): the shipped vae/encoder/config.json says the last "compress_all_res" block
#      doubles the channels (1024 to 2048) but the shipped weights keep 1024 (the conv writes 128 x 8 = 1024), so the
#      pinned source builds a 2048-wide block and fails with `broadcast_shapes (1,1024,...) and (1,2048,...)` (measured
#      2026-10-17). The multiplier of every "_res" down-sampling block is read from its own weights instead of the config;
#   5. the finished file: the engine's frames are written once as H.264 yuv420p with the moov box first, the sound track
#      the engine decoded is added as AAC without any other change, and a JPEG poster of frame 0 is written; no metadata.
# The engine's disclosure features (watermark, latent disclosure) are left exactly as shipped: this file never removes
# or disables one (licence section 6). Nothing is logged with a prompt or a picture; stderr carries phase and size only.
import gc
import os
import subprocess
import sys
import time

import video_worker as base
from video_worker import FPS, emit, phase, stage

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# Hard ceilings, mirrored in the Stack's service. The worker refuses past them even if a caller got that far.
MAX_SECONDS = 10
MAX_FRAMES = MAX_SECONDS * FPS + 1
MAX_PIXELS = 768 * 448
SIZE_STEP = 64
UPSCALER = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
PREVIEW_SIDE = 480

_state = {"gen": None, "loras": [], "steps_done": 0, "steps_total": 11}


class _Sink(base._Sink):
    """The engine prints coloured progress text; none of it is forwarded, only the boundaries are read."""

    def write(self, text):
        self._line += text
        while "\n" in self._line:
            line, self._line = self._line.split("\n", 1)
            line = base.re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if "Text encoder loaded" in line or line.startswith("Prompt:"):
                phase("loading")
                stage("plan")
            elif "Transformer loaded" in line:
                phase("loading")
                stage("load_model")
            elif line.startswith("Decoding video") or "Decoding video" in line:
                phase("decoding", 0)
                stage("frames")
        return len(text)


def _install_patches():
    import mlx.core as mx
    import mlx_video.models.ltx_2.generate as gen
    import mlx_video.models.ltx_2.text_encoder as te
    import mlx_video.models.ltx_2.video_vae.decoder as vae_decoder_module
    from mlx_video.models.ltx_2.ltx_2 import LTXModel

    def attention_mask(self, seq_len, attention_mask, dtype):
        causal = mx.tril(mx.ones((seq_len, seq_len), dtype=mx.bool_))
        if attention_mask is not None:
            causal = causal[None, :, :] & attention_mask.astype(mx.bool_)[:, None, :]
            masked = mx.where(causal, mx.zeros(causal.shape, dtype=dtype), mx.full(causal.shape, -1e9, dtype=dtype))
            return masked[:, None, :, :]
        masked = mx.where(causal, mx.zeros((seq_len, seq_len), dtype=dtype), mx.full((seq_len, seq_len), -1e9, dtype=dtype))
        return masked[None, None, :, :]

    te.LanguageModel._create_causal_mask_with_padding = attention_mask

    # Motion progress: the engine counts steps with a rich progress bar; count them ourselves.
    class StepCounter:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def add_task(self, *args, **kwargs):
            return 0

        def advance(self, *args, **kwargs):
            _state["steps_done"] += 1
            total = max(1, _state["steps_total"])
            phase("rendering", 100.0 * _state["steps_done"] / total)
            stage("motion", min(_state["steps_done"], total), total)

        def update(self, *args, **kwargs):
            pass

        def start(self):
            pass

        def stop(self):
            pass

    gen.Progress = StepCounter

    # Community LoRAs: merged into the transformer right after it loads.
    original_from_pretrained = LTXModel.from_pretrained.__func__

    def from_pretrained_with_loras(cls, *args, **kwargs):
        model = original_from_pretrained(cls, *args, **kwargs)
        for path, strength in _state["loras"]:
            gen.load_and_merge_lora(model, path, strength=float(strength))
        mx.eval(model.parameters())
        return model

    LTXModel.from_pretrained = classmethod(from_pretrained_with_loras)

    # Frame tiles: count them for the progress bar; draw the first frame on its own for the card's preview.
    original_decode = vae_decoder_module.decode_with_tiling

    def counted_decode(*args, **kwargs):
        decoder_fn = kwargs.get("decoder_fn", args[0] if args else None)
        latents = kwargs.get("latents", args[1] if len(args) > 1 else None)
        config = kwargs.get("tiling_config", args[2] if len(args) > 2 else None)
        target = base._current.get("preview")
        if target and latents is not None:
            try:
                from PIL import Image
                import numpy as np

                started = time.time()
                # The same call the tiles get (this decoder is conditioned on a timestep; without it the call fails and no preview is drawn).
                frame = decoder_fn(latents[:, :, :1], causal=kwargs.get("causal", False), timestep=kwargs.get("timestep"), debug=False, chunked_conv=kwargs.get("chunked_conv", False))
                mx.eval(frame)
                array = np.array(frame[0][:, 0]).transpose(1, 2, 0)
                array = np.clip((array + 1.0) / 2.0 * 255.0, 0, 255).astype(np.uint8)
                image = Image.fromarray(array)
                image.thumbnail((PREVIEW_SIDE, PREVIEW_SIDE), Image.LANCZOS)
                temp = target + ".tmp"
                image.save(temp, format="JPEG", quality=80)
                os.replace(temp, target)
                emit({"id": base._current["id"], "event": "preview", "ms": int((time.time() - started) * 1000)})
                mx.clear_cache()
            except Exception as error:  # noqa: BLE001 - the clip never depends on its preview
                sys.stderr.write("video worker: no preview (%s)\n" % type(error).__name__)
                sys.stderr.flush()
        total = 0
        try:
            tiling = sys.modules["mlx_video.models.ltx_2.video_vae.tiling"]
            _, _, f_latent, h_latent, w_latent = latents.shape
            spatial = config.spatial_config.tile_size_in_pixels // 32 if config.spatial_config is not None else max(h_latent, w_latent)
            overlap = config.spatial_config.tile_overlap_in_pixels // 32 if config.spatial_config is not None else 0
            t_size = config.temporal_config.tile_size_in_frames // 8 if config.temporal_config is not None else f_latent
            t_overlap = config.temporal_config.tile_overlap_in_frames // 8 if config.temporal_config is not None else 0
            total = len(tiling.split_in_temporal(t_size, t_overlap, f_latent).starts) * len(tiling.split_in_spatial(spatial, overlap, h_latent).starts) * len(tiling.split_in_spatial(spatial, overlap, w_latent).starts)
        except Exception:  # noqa: BLE001
            total = 0
        done = {"n": 0}
        if total:
            stage("frames", 0, total)

        def counting(tile, *a, **k):
            out = decoder_fn(tile, *a, **k)
            mx.eval(out)
            done["n"] += 1
            if total:
                phase("decoding", min(99, 100.0 * done["n"] / total))
                stage("frames", min(done["n"], total), total)
            return out

        if "decoder_fn" in kwargs:
            kwargs["decoder_fn"] = counting
        else:
            args = (counting,) + tuple(args[1:])
        return original_decode(*args, **kwargs)

    vae_decoder_module.decode_with_tiling = counted_decode

    # Picture to video: build the encoder from the shape the weights really have (see the header, item 4).
    import json
    from pathlib import Path

    import mlx_video.models.ltx_2.video_vae.video_vae as vae_module
    from mlx_video.models.ltx_2.config import VideoEncoderModelConfig

    ratio = {"compress_space_res": 4, "compress_time_res": 2, "compress_all_res": 8}

    def encoder_from_pretrained(cls, model_path):
        from safetensors import safe_open

        model_path = Path(model_path)
        config_dict = json.loads((model_path / "config.json").read_text())
        files = sorted(model_path.glob("*.safetensors"))
        if not files:
            raise FileNotFoundError("the picture encoder is not installed")
        shapes = {}
        for file in files:
            with safe_open(str(file), "np") as handle:
                for key in handle.keys():
                    if key.startswith("down_blocks.") and key.endswith(".conv.conv.weight"):
                        shapes[key] = handle.get_slice(key).get_shape()
        blocks = []
        for index, (name, params) in enumerate(config_dict.get("encoder_blocks", [])):
            shape = shapes.get("down_blocks.%d.conv.conv.weight" % index)
            if name in ratio and shape:
                params = dict(params) if isinstance(params, dict) else {}
                params["multiplier"] = max(1, round(shape[0] * ratio[name] / shape[-1]))
            blocks.append([name, params])
        config_dict["encoder_blocks"] = blocks
        model = cls(VideoEncoderModelConfig(**config_dict))
        weights = {}
        for file in files:
            weights.update(mx.load(str(file)))
        model.load_weights(list(model.sanitize(weights).items()), strict=False)
        return model

    vae_module.VideoEncoder.from_pretrained = classmethod(encoder_from_pretrained)

    # The engine joins picture and sound with an `ffmpeg` found on PATH; the Stack names its bundled one instead.
    gen.mux_video_audio = lambda video_path, audio_path, output_path: False
    _state["steps_total"] = (len(gen.STAGE_1_SIGMAS) - 1) + (len(gen.STAGE_2_SIGMAS) - 1)
    return gen


def _finish(frames, wav, output, poster, ffmpeg):
    """H.264 yuv420p, moov first, no metadata, plus the engine's sound track as AAC. Returns whether the clip has sound."""
    import imageio
    from PIL import Image

    phase("encoding", 0)
    stage("save")
    Image.fromarray(frames[0]).save(poster, format="JPEG", quality=88, optimize=True)
    silent = output + ".silent.mp4"
    writer = imageio.get_writer(silent, fps=FPS, codec="libx264", quality=8, macro_block_size=16, pixelformat="yuv420p", output_params=["-movflags", "+faststart", "-map_metadata", "-1", "-an"])
    total = len(frames)
    for index, frame in enumerate(frames):
        writer.append_data(frame)
        if index % 24 == 0:
            phase("encoding", 90.0 * index / total)
    writer.close()
    has_sound = os.path.isfile(wav) and os.path.getsize(wav) > 1024
    if has_sound and ffmpeg:
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", silent, "-i", wav, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "-map_metadata", "-1", output]
        if subprocess.run(command, capture_output=True).returncode != 0 or not os.path.isfile(output):
            has_sound = False
    if not has_sound:
        os.replace(silent, output)
    else:
        os.remove(silent)
    for stray in (wav,):
        if os.path.exists(stray):
            os.remove(stray)
    phase("encoding", 100)
    return has_sound


def generate(request):
    import mlx.core as mx

    width, height, frames = int(request["width"]), int(request["height"]), int(request["num_frames"])
    if frames < 9 or frames > MAX_FRAMES or (frames - 1) % 8:
        raise ValueError("frames must be 8n+1 and at most %d" % MAX_FRAMES)
    if width % SIZE_STEP or height % SIZE_STEP or width * height > MAX_PIXELS or width < 256 or height < 256:
        raise ValueError("size must be a multiple of %d within 768 x 448 of area" % SIZE_STEP)
    model_dir = request["model_dir"]
    text_dir = request["text_encoder_dir"]
    for needed in ("transformer", "vae", "audio_vae", "vocoder", "text_projections", UPSCALER):
        if not os.path.exists(os.path.join(model_dir, needed)):
            raise FileNotFoundError("the Detailed video model is not installed")
    if not os.path.isdir(text_dir):
        raise FileNotFoundError("the text encoder is not installed")
    base._current["poster"] = request["poster"]
    base._current["preview"] = request.get("preview")
    _state["loras"] = [(path, float(strength)) for path, strength in request.get("loras", [])]
    _state["steps_done"] = 0
    started = time.time()
    phase("loading", 0)
    stage("load_text")
    if _state["gen"] is None:
        _state["gen"] = _install_patches()
    gen = _state["gen"]
    image = None
    if request.get("image"):
        image = base._prepare_reference(request["image"])
    mx.reset_peak_memory()
    work = request["output"] + ".work"
    os.makedirs(work, exist_ok=True)
    wav = os.path.join(work, "sound.wav")
    old_stdout = sys.stdout
    sys.stdout = _Sink()
    try:
        result = gen.generate_video(
            model_repo=model_dir,
            text_encoder_repo=text_dir,
            prompt=request["prompt"],
            pipeline=gen.PipelineType.DISTILLED,
            height=height,
            width=width,
            num_frames=frames,
            seed=int(request["seed"]),
            fps=FPS,
            output_path=os.path.join(work, "engine.mp4"),
            tiling="aggressive",
            audio=True,
            output_audio_path=wav,
            image=image,
            spatial_upscaler=UPSCALER,
            verbose=False,
        )
    finally:
        sys.stdout = old_stdout
        if image and os.path.exists(image):
            os.remove(image)
        gc.collect()
        mx.clear_cache()
    video = result[0] if isinstance(result, tuple) else result
    has_sound = _finish(video, wav, request["output"], request["poster"], request.get("ffmpeg"))
    for name in os.listdir(work):
        os.remove(os.path.join(work, name))
    os.rmdir(work)
    peak = mx.get_peak_memory()
    return {"width": width, "height": height, "frames": frames, "fps": FPS, "seed": int(request["seed"]), "ms": int((time.time() - started) * 1000), "peak_bytes": int(peak), "audio": bool(has_sound)}


def main():
    emit({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = base.json.loads(line)
        except ValueError:
            continue
        if request.get("op") == "quit":
            break
        base._current["id"] = request.get("id")
        try:
            result = generate(request)
            emit({"id": request["id"], "ok": True, **result})
        except BaseException as error:  # noqa: BLE001 - every failure becomes a reply, the process stays up
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code, message = base.classify(error)
            sys.stderr.write("video worker: %s (%s)\n" % (code, type(error).__name__))
            sys.stderr.flush()
            if os.environ.get("VIDEO_WORKER_DEBUG") == "1":
                base.traceback.print_exc()
            emit({"id": request.get("id"), "ok": False, "code": code, "error": message})


if __name__ == "__main__":
    main()
