# The Stack's LTX-2.5 video worker (LTX25-ENGINE-01). Same protocol as video_worker.py (JSON lines on stdin and
# stdout, no port, one clip at a time, started on the first clip and stopped by the Stack when idle or cancelled), but it runs the
# LTX-2.5 distilled q8 model through the ltx-2-mlx fork (MIT, MrMoferFRAN branch ltx25, commit 5795228) that the judged clips were
# made with: the Gemma 4 text encoder that ships in the pack, an 8 + 3 step distilled schedule with the x2 spatial upscaler, and a
# sound track (speech included) made in the same pass. The weights are Lightricks' (LTX-2.x Community License) read from the
# Stack's own model folder; nothing is fetched at run time (HF_HUB_OFFLINE=1, and any socket that is not a local file is refused).
#
# The pinned source is used as shipped; this file only adds what the Stack needs around it:
#   1. a table of the sizes and lengths that were measured (mirrored from video/ltx25.ts); anything else is refused, never tried;
#   2. progress by stage (text, plan, model, motion step, frames, save) in place of the engine's console output;
#   3. the Stack's own ffmpeg on PATH (the engine muxes sound with `ffmpeg` found on PATH) and a JPEG poster of frame 0;
#   4. VIDEO-INPUTS-01: a start picture (and an optional end picture) fitted to the true clip size by ffmpeg and passed as the runtime's
#      image conditioning (frame 0 replaces the first latent, the end picture guides the last frame), on both runtimes;
#   5. the same pipeline object serves every clip while the process lives. The engine runs in its low-memory mode, which gives the
#      transformer and decoders back after each clip: that is the mode the footprints in the table were measured in.
#   6. LTX25-EDIT-01: two more modes on the Max runtime, `extend` (ExtendDistilledPipeline: append latent frames after a source clip) and `retake`
#      (RetakePipeline(distilled=True): regenerate the source from a latent frame to its end). Both keep the source in latent form and decode the
#      whole clip again; both are refused unless the source is a measured size and length and the Gemma guard passes, like every Max run.
#   7. VIDEO-LORA-05: LoRAs on a generated clip. The request's `loras` ([path, strength] pairs, at most 2) are handed to the runtime the way its
#      own `generate --lora PATH STRENGTH` does it (`pipe._pending_loras`, read when the transformer is loaded) and `lora_mode` ("fused" or
#      "unfused") is put in LTX2_LORA_MODE BEFORE the pipeline is built (the 0.18.0 runtime parses it at construction; the pinned fork has no
#      unfused mode and is only ever asked for fused). The runtime skips every tensor it cannot map WITHOUT AN ERROR, so each file's header is read
#      first and a file with no ComfyUI-style lora_A/lora_B pair (a kohya file, or the wrong layers) is refused with a plain message, never run.
# The engine's disclosure features are left exactly as shipped (licence section 6). Nothing is logged with a prompt: stderr
# carries the failure class and the Python exception name only.
import gc
import json
import struct
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import traceback

import mlx.core as mx

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

FPS = 24
# Mirrored in the Stack's service (video/ltx25.ts, LTX25_MEASURED): size -> longest measured clip in seconds.
# True sizes: the engine rounds each side down to a multiple of 64 (512x288 comes out 512x256, 640x352 comes out 640x320).
MEASURED = {(512, 256): 10, (640, 320): 5, (768, 448): 5}
# LTX25-MAX-01: the Max profile runs on the dgrauet runtime (0.18.0) and its bf16 pack, one size, measured at 48.6 GB (mirrored from
# video/ltx25.ts, LTX25_MAX_MEASURED). A request says `profile: "max"`; every other request is the Standard/Boost table above.
MEASURED_MAX = {(1024, 576): 10}
# LTX25-EDIT-01: the sizes an extend or a retake was measured at (mirrored from video/ltx25Edit.ts, LTX25_MAX_EDIT_MEASURED) and the source
# limits: the runtime carries the last 25 pixel frames of a source, and the longest source measured is 10 s (241 frames).
MEASURED_EDIT = {(768, 448), (1024, 576)}
# VIDEO-LORA-05 (mirrored from video/ltx25.ts, LTX25_LORAS_PER_CLIP and LTX25_LORA_MAX_STRENGTH).
MAX_LORAS = 2
MAX_LORA_STRENGTH = 2.0
LORA_MODE_ENV = "LTX2_LORA_MODE"
EDIT_MIN_SOURCE_FRAMES = 25
EDIT_MAX_SOURCE_FRAMES = 241


def true_size(width, height):
    return (width // 64) * 64, (height // 64) * 64
STEPS_TOTAL = 11  # 8 stage-one steps and 3 stage-two steps of the distilled schedule
# The Max pack keeps its Gemma 4 text encoder in its own folder and names the x2 upscaler by version.
MAX_GEMMA_FOLDER = "gemma4-12b-ltx-v1"
MAX_REQUIRED = ["transformer-distilled.safetensors", "connector.safetensors", "vae_decoder.safetensors", "vae_encoder.safetensors", "audio_vae.safetensors", "vocoder.safetensors", "spatial_upscaler_x2_v1_1.safetensors", MAX_GEMMA_FOLDER + "/model.safetensors", MAX_GEMMA_FOLDER + "/tokenizer.json", MAX_GEMMA_FOLDER + "/config.json", "config.json", "embedded_config.json"]
REQUIRED = ["transformer-distilled.safetensors", "connector.safetensors", "vae_decoder.safetensors", "vae_encoder.safetensors", "audio_vae.safetensors", "vocoder.safetensors", "spatial_upscaler_x2.safetensors", "text_encoder/model.safetensors", "text_encoder/tokenizer.json", "config.json", "embedded_config.json"]

# 10% of the 44.1 GB video footprint, as every long-lived MLX worker (memory-management-2026-10-25 section 4.1). The footprints in
# the table were measured without a limit, so this can only lower them.
MLX_CACHE_LIMIT_BYTES = int(4.41 * (1 << 30))
mx.set_cache_limit(MLX_CACHE_LIMIT_BYTES)

_real_out = sys.stdout
_state = {"loras": (), "lora_mode": "fused", "id": None, "pipe": None, "model_dir": None, "steps": 0, "steps_total": 11, "patched": False, "x0_patched": False}


def emit(obj):
    _real_out.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _real_out.flush()


def stage(name, n=None, of=None):
    event = {"id": _state["id"], "event": "stage", "stage": name}
    if n is not None and of:
        event["n"] = int(n)
        event["of"] = int(of)
    emit(event)


def phase(name, percent=None):
    event = {"id": _state["id"], "event": "phase", "phase": name}
    if percent is not None:
        event["percent"] = max(0, min(100, int(percent)))
    emit(event)


def forbid_network():
    """Generation reads local files only. Any connection that is not a unix socket is refused before it starts."""
    original = socket.socket.connect

    def guarded(self, address, *args, **kwargs):
        if self.family == getattr(socket, "AF_UNIX", -1):
            return original(self, address, *args, **kwargs)
        raise OSError("the video engine makes no network connection")

    socket.socket.connect = guarded
    socket.create_connection = lambda *a, **k: (_ for _ in ()).throw(OSError("the video engine makes no network connection"))


class LoraRefusal(ValueError):
    """A LoRA the worker will not run: carries its own code and a plain sentence that says what to do (no path, no prompt)."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def classify(error):
    """(code, plain message) for a failure; the message never contains the prompt."""
    if isinstance(error, LoraRefusal):
        return error.code, str(error)
    text = str(error).lower()
    if isinstance(error, MemoryError) or "out of memory" in text or "insufficient memory" in text or "metal" in text and "memory" in text:
        return "out_of_memory", "There was not enough free memory for this clip. Try a smaller size or a shorter clip."
    if isinstance(error, FileNotFoundError):
        return "model_missing", "The LTX-2.5 video model is not installed. An admin can install it in Settings, Models and storage, then try again."
    if isinstance(error, ValueError):
        return "bad_request", str(error)
    return "failed", "The clip could not be made. Try again."


def refusal(width, height, frames, profile=None):
    width, height = true_size(width, height)
    table = MEASURED_MAX if profile == "max" else MEASURED
    seconds = table.get((width, height))
    if seconds is None:
        return "size must be one of " + ", ".join("%dx%d" % size for size in table)
    if frames < 9 or (frames - 1) % 8:
        return "frames must be 8n+1"
    if frames > seconds * FPS + 1:
        return "a clip at %dx%d is at most %d seconds" % (width, height, seconds)
    return None


def _install_patches(pipe):
    """Progress hooks, applied once per process. A hook that cannot be installed leaves the clip unaffected (it only loses a stage)."""
    try:
        if _state["x0_patched"]:
            raise StopIteration  # the class is patched once per process; a second pipeline only gets its own hooks
        from ltx_core_mlx.model.transformer.model import X0Model

        original_call = X0Model.__call__

        def counted(self, *args, **kwargs):
            out = original_call(self, *args, **kwargs)
            _state["steps"] += 1
            total = _state["steps_total"]
            done = min(_state["steps"], total)
            phase("rendering", 100.0 * done / total)
            stage("motion", done, total)
            return out

        X0Model.__call__ = counted
        _state["x0_patched"] = True
    except StopIteration:
        pass
    except Exception as error:  # noqa: BLE001
        sys.stderr.write("video worker: no motion progress (%s)\n" % type(error).__name__)

    def before(owner, name, action):
        original = getattr(owner, name, None)
        if original is None:
            return

        def wrapper(*args, **kwargs):
            action()
            return original(*args, **kwargs)

        try:
            setattr(owner, name, wrapper)
        except Exception:  # noqa: BLE001
            pass

    before(pipe, "_load_text_encoder", lambda: (phase("loading", 0), stage("load_text")))
    before(pipe, "_encode_text", lambda: stage("plan"))
    before(pipe, "load", lambda: stage("load_model"))
    before(pipe, "_decode_and_save_video", lambda: (phase("decoding", 0), stage("frames")))
    _state["patched"] = True


def max_gemma_dir(model_dir, gemma_dir):
    """The Gemma folder the Max runtime must be given, or a ValueError. Without it the 0.18.0 runtime loads, ignores the prompt and
    makes an unrelated clip with garbled speech (measured 2026-11-02), so a request that does not name the pack's own folder is refused."""
    wanted = os.path.join(model_dir, MAX_GEMMA_FOLDER)
    if not gemma_dir or os.path.normpath(gemma_dir) != os.path.normpath(wanted):
        raise ValueError("the Max video model must be run with its own text encoder folder")
    for needed in ("model.safetensors", "tokenizer.json", "config.json"):
        if not os.path.isfile(os.path.join(gemma_dir, needed)):
            raise FileNotFoundError("the LTX-2.5 Max video model is not installed")
    return gemma_dir


def lora_pairs(path):
    """(pairs, kohya) of a LoRA file's header: the modules with both a ComfyUI-style `lora_A.weight` and `lora_B.weight` tensor, and the tensors in
    kohya form (`lora_down`/`lora_up`). Only the JSON header is read. The runtime's key match is `<module>.lora_A.weight` after stripping
    `diffusion_model.`; a key it cannot place is ignored silently, so a file with no pair would make a clip with no style."""
    with open(path, "rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        head = handle.read(8)
        if len(head) != 8:
            raise LoraRefusal("bad_request", "A style file could not be read. Add it again.")
        (length,) = struct.unpack("<Q", head)
        if length <= 2 or length > 64 * 1024 * 1024 or 8 + length > size:
            raise LoraRefusal("bad_request", "A style file could not be read. Add it again.")
        try:
            header = json.loads(handle.read(length).decode("utf-8"))
        except ValueError:
            raise LoraRefusal("bad_request", "A style file could not be read. Add it again.")
    down, up, kohya = set(), set(), 0
    for key in header:
        if key == "__metadata__":
            continue
        if key.endswith(".lora_down.weight") or key.endswith(".lora_up.weight"):
            kohya += 1
        elif key.endswith(".lora_A.weight"):
            down.add(key[: -len(".lora_A.weight")])
        elif key.endswith(".lora_B.weight"):
            up.add(key[: -len(".lora_B.weight")])
    return len(down & up), kohya


def check_loras(loras, lora_mode, profile):
    """The request's LoRAs as a tuple of (path, strength), or a refusal. Refuses: more than MAX_LORAS, a strength outside 0 to 2, a missing file,
    a file with no pair the runtime reads (kohya or the wrong layer names) with a sentence that says what to do, and a mode the profile cannot run."""
    if not loras:
        return ()
    if not isinstance(loras, list) or len(loras) > MAX_LORAS:
        raise LoraRefusal("too_many_loras", "A clip can use at most %d styles." % MAX_LORAS)
    if lora_mode not in ("fused", "unfused"):
        raise LoraRefusal("bad_request", "the LoRA mode must be fused or unfused")
    out = []
    for entry in loras:
        try:
            path, strength = entry[0], float(entry[1])
        except (TypeError, ValueError, IndexError, KeyError):
            raise LoraRefusal("bad_request", "a LoRA needs a file and a strength")
        if not (0.0 <= strength <= MAX_LORA_STRENGTH):
            raise LoraRefusal("bad_strength", "A style's strength must be between 0 and %d." % MAX_LORA_STRENGTH)
        if not isinstance(path, str) or not os.path.isfile(path):
            raise LoraRefusal("lora_missing", "A style file is missing. Add it again.")
        pairs, kohya = lora_pairs(path)
        if pairs == 0 and kohya > 0:
            raise LoraRefusal("lora_keys_unsupported", "A style file uses the kohya tensor names (lora_down and lora_up), which this video model does not read, so it would change nothing. Use a copy saved for ComfyUI or diffusers, or pick another style.")
        if pairs == 0:
            raise LoraRefusal("lora_keys_unsupported", "A style file has no tensors this video model can use (it needs diffusion_model...lora_A.weight and lora_B.weight pairs), so it would change nothing. Pick a LoRA made for LTX-2.5.")
        out.append((path, strength))
    if lora_mode == "unfused" and profile != "max":
        raise LoraRefusal("bad_request", "the Standard and Boost video engine has no unfused LoRA mode")
    return tuple(out)


def apply_loras(pipe, loras, lora_mode):
    """Hands the LoRAs to the runtime the way its command line does. A runtime without the hook, or one that did not take the mode, would make the
    clip without the style: refuse instead."""
    if not hasattr(type(pipe), "_fuse_pending_loras"):
        raise LoraRefusal("bad_request", "this video runtime cannot apply styles")
    runtime_mode = getattr(pipe, "lora_mode", None)
    if runtime_mode is None and lora_mode == "unfused":
        raise LoraRefusal("bad_request", "this video runtime has no unfused style mode")
    if runtime_mode is not None and runtime_mode != lora_mode:
        raise LoraRefusal("bad_request", "the video runtime did not take the style mode")
    pipe._pending_loras = [(path, strength) for path, strength in loras]


def _release_pipeline():
    """One pipeline lives at a time: a different mode (generate, extend, retake) gives the old one's weights back first."""
    _state["pipe"] = None
    _state["model_dir"] = None
    gc.collect()
    mx.clear_cache()


def _lora_key(loras):
    """Identity of a LoRA set for the pipeline cache: the file, its size and time, and the strength."""
    key = []
    for path, strength in loras:
        stat = os.stat(path)
        key.append((path, stat.st_size, int(stat.st_mtime), strength))
    return tuple(key)


def _pipeline(model_dir, gemma_dir=None, mode="generate", loras=(), lora_mode="fused"):
    key = (mode, model_dir, gemma_dir) + ((_lora_key(loras), lora_mode) if loras else ())
    if _state["pipe"] is not None and _state["model_dir"] == key:
        return _state["pipe"]
    if _state["pipe"] is not None:
        _release_pipeline()
    if loras:
        # The 0.18.0 runtime parses LTX2_LORA_MODE when the pipeline is built, so it is set before; the fork ignores it.
        os.environ[LORA_MODE_ENV] = lora_mode
    else:
        os.environ.pop(LORA_MODE_ENV, None)
    if mode == "ic_lora":
        from ltx_pipelines_mlx.ic_lora import ICLoraPipeline

        pipe = ICLoraPipeline(model_dir=model_dir, lora_paths=list(loras), gemma_model_id=gemma_dir, low_memory=True)
    elif mode == "extend":
        from ltx_pipelines_mlx.extend_distilled import ExtendDistilledPipeline

        pipe = ExtendDistilledPipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True)
    elif mode == "retake":
        from ltx_pipelines_mlx.retake import RetakePipeline

        pipe = RetakePipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True, distilled=True)
    elif gemma_dir:
        from ltx_pipelines_mlx.distilled import DistilledPipeline

        # Max: the runtime reads the prompt with the Gemma 4 folder it is given, here. It is checked on the built pipeline too.
        pipe = DistilledPipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True)
    else:
        from ltx_pipelines_mlx.distilled import DistilledPipeline

        # gemma_model_id is ignored: the pack ships its own text_encoder folder, which the pipeline prefers.
        # DistilledPipeline takes no verbose argument (the base class defaults it to True): silence it after construction.
        pipe = DistilledPipeline(model_dir=model_dir, low_memory=True)
    if gemma_dir:
        encoder = getattr(getattr(pipe, "prompt_encoder", None), "gemma_model_id", None)
        if encoder != gemma_dir:
            raise ValueError("the Max video runtime did not take the text encoder folder")
    if loras and mode != "ic_lora":
        apply_loras(pipe, loras, lora_mode)
    pipe.verbose = False
    if getattr(pipe, "video_decoder_block", None) is not None:
        pipe.video_decoder_block.verbose = False
    _install_patches(pipe)
    _state["pipe"] = pipe
    _state["model_dir"] = key
    return pipe


def prepare_ic_reference(ffmpeg, source, target, conditioning, width=1024, height=576, frames=121):
    """Fit a bounded source to the IC-LoRA contract (8n+1 frames) and produce grayscale or edge conditioning."""
    if conditioning not in ("source", "edges"):
        raise ValueError("conditioning must be source or edges")
    if frames > 241 or frames < 9 or (frames - 1) % 8:
        raise ValueError("IC-LoRA reference must be at most 10 seconds and 8n+1 frames")
    filters = "fps=24,scale=%d:%d:force_original_aspect_ratio=increase:flags=lanczos,crop=%d:%d" % (width, height, width, height)
    filters += ",trim=end_frame=%d,tpad=stop_mode=clone:stop=%d" % (frames, frames)
    filters += ",format=gray" if conditioning == "source" else ",edgedetect=mode=colormix:high=0.12:low=0.04,format=gray"
    done = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-an", "-vf", filters, "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-map_metadata", "-1", target], capture_output=True)
    if done.returncode or not os.path.isfile(target) or os.path.getsize(target) == 0:
        raise ValueError("the source could not be prepared for IC-LoRA; send a readable video clip")
    return target


def _ffmpeg_on_path(ffmpeg):
    if ffmpeg and os.path.isfile(ffmpeg):
        folder = os.path.dirname(ffmpeg)
        # The engine looks for a binary called `ffmpeg`; the bundled file may carry a platform suffix.
        link = os.path.join(folder, "ffmpeg")
        if not os.path.exists(link):
            try:
                os.symlink(os.path.basename(ffmpeg), link)
            except OSError:
                pass
        os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
    if not shutil.which("ffmpeg"):
        raise FileNotFoundError("the video tools are not installed")
    return shutil.which("ffmpeg")


def _probe(ffmpeg, path):
    """(has sound, width, height) of the engine's file. The engine rounds the height to a multiple of 64 (288 comes out 256), so the reply reports what the file really is."""
    text = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True).stderr or ""
    size = re.search(r"Stream #\S+: Video:.*?, (\d{2,5})x(\d{2,5})", text)
    return bool(re.search(r"Stream #\S+: Audio:", text)), (int(size.group(1)) if size else None), (int(size.group(2)) if size else None)


def prepare_picture(ffmpeg, source, width, height, target):
    """VIDEO-INPUTS-01: the picture at the clip's true size, as a plain RGB PNG with no metadata. It is scaled to fill and centre-cropped
    (aspect fit, never stretched) by the Stack's own ffmpeg, which also applies the file's orientation, so the runtime gets exactly the
    pixels it will condition on and no resampling of its own. A file ffmpeg cannot read is a ValueError (a bad_request, never a crash)."""
    filters = "scale=%d:%d:force_original_aspect_ratio=increase:flags=lanczos,crop=%d:%d,format=rgb24" % (width, height, width, height)
    done = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", "-vf", filters, "-map_metadata", "-1", target], capture_output=True)
    if done.returncode != 0 or not os.path.isfile(target) or os.path.getsize(target) == 0:
        raise ValueError("the picture could not be read")
    return target


def conditioning_images(start, end, frames):
    """The runtime's image conditioning list: `start` replaces the first latent (frame 0, strength 1.0) and `end` guides the last pixel
    frame. The 0.18.0 runtime (Max) builds them with ImageConditioningInput.at/.guide; the pinned fork (Standard, Boost) takes the
    plain (path, frame_idx, strength) tuple of ltx_pipelines_mlx.utils.args. Both accept an absolute frame index."""
    try:
        from ltx_pipelines_mlx.utils import types as pipeline_types
        cls = getattr(pipeline_types, "ImageConditioningInput", None)
    except ImportError:  # the fork has no utils/types.py
        cls = None
    if cls is None or not hasattr(cls, "guide"):
        from ltx_pipelines_mlx.utils.args import ImageConditioningInput as cls  # the fork's NamedTuple
        make_start = lambda path: cls(path=path, frame_idx=0, strength=1.0)
        make_end = lambda path: cls(path=path, frame_idx=frames - 1, strength=1.0)
    else:
        make_start = lambda path: cls.at(path, 0, 1.0)
        make_end = lambda path: cls.guide(path, frames - 1, 1.0)
    images = [make_start(start)]
    if end:
        images.append(make_end(end))
    return images


def require_images_support(pipe):
    """A runtime whose generate_and_save takes no `images` would make the clip from words and silently drop the picture: refuse instead."""
    import inspect

    if "images" not in inspect.signature(pipe.generate_and_save).parameters:
        raise ValueError("this video runtime cannot start from a picture")


def generate(request):
    width, height, frames = int(request["width"]), int(request["height"]), int(request["num_frames"])
    width, height = true_size(width, height)
    profile = "max" if request.get("profile") == "max" else None
    problem = refusal(width, height, frames, profile)
    if problem:
        raise ValueError(problem)
    if request.get("end_image") and not request.get("image"):
        raise ValueError("a last picture needs a first picture")
    lora_mode = request.get("lora_mode") or "fused"
    loras = check_loras(request.get("loras"), lora_mode, profile)
    model_dir = request["model_dir"]
    for needed in (MAX_REQUIRED if profile == "max" else REQUIRED):
        if not os.path.exists(os.path.join(model_dir, needed)):
            raise FileNotFoundError("the LTX-2.5 video model is not installed")
    gemma_dir = max_gemma_dir(model_dir, request.get("text_encoder_dir")) if profile == "max" else None
    ffmpeg = _ffmpeg_on_path(request.get("ffmpeg"))
    _state["steps"] = 0
    _state["steps_total"] = STEPS_TOTAL
    started = time.time()
    phase("loading", 0)
    pipe = _pipeline(model_dir, gemma_dir, "generate", loras, lora_mode)
    mx.reset_peak_memory()
    work = request["output"] + ".work"
    os.makedirs(work, exist_ok=True)
    engine_out = os.path.join(work, "engine.mp4")
    try:
        extra = {}
        if request.get("image"):
            require_images_support(pipe)
            start = prepare_picture(ffmpeg, request["image"], width, height, os.path.join(work, "start.png"))
            end = prepare_picture(ffmpeg, request["end_image"], width, height, os.path.join(work, "end.png")) if request.get("end_image") else None
            extra["images"] = conditioning_images(start, end, frames)
        pipe.generate_and_save(prompt=request["prompt"], output_path=engine_out, height=height, width=width, num_frames=frames, frame_rate=FPS, seed=int(request["seed"]), **extra)
        phase("encoding", 0)
        stage("save")
        if not os.path.isfile(engine_out):
            raise RuntimeError("the engine wrote no file")
        poster = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", engine_out, "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", request["poster"]], capture_output=True)
        if poster.returncode != 0 or not os.path.isfile(request["poster"]):
            raise RuntimeError("no poster")
        has_sound, real_width, real_height = _probe(ffmpeg, engine_out)
        os.replace(engine_out, request["output"])
        phase("encoding", 100)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        gc.collect()
        mx.clear_cache()
    return {"width": real_width or width, "height": real_height or height, "frames": frames, "fps": FPS, "seed": int(request["seed"]), "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory()), "audio": bool(has_sound), "loras": len(loras), "lora_mode": lora_mode if loras else None}


# ---- LTX25-EDIT-01: extend and retake ----

def tools_on_path(ffmpeg, ffprobe, work):
    """The runtime probes the source with `ffprobe` and muxes with `ffmpeg`, both found on PATH. The Stack names the two files it owns; they are
    linked under those exact names in a private folder placed first on PATH, so a bundled file with a platform suffix and a system ffprobe
    of another version never decide the result."""
    folder = os.path.join(work, "bin")
    os.makedirs(folder, exist_ok=True)
    for name, source in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)):
        if not source or not os.path.isfile(source):
            raise FileNotFoundError("the video tools are not installed")
        link = os.path.join(folder, name)
        if os.path.lexists(link):
            os.remove(link)
        os.symlink(os.path.abspath(source), link)
    os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
    return shutil.which("ffmpeg")


def latent_frames(frames):
    """Latent frames of a source of `frames` pixel frames (the runtime encodes 8k + 1 of them): 241 gives 31."""
    k = max(1, (frames - 1) // 8)
    return k + 1


def edit_refusal(mode, width, height, frames, extend_frames, start_latent):
    """The plain refusal for an edit outside what was measured, or None. Mirrors video/ltx25Edit.ts (planSource, checkEdit)."""
    if (width, height) not in MEASURED_EDIT:
        return "the source must be one of " + ", ".join("%dx%d" % size for size in sorted(MEASURED_EDIT))
    if frames < EDIT_MIN_SOURCE_FRAMES:
        return "the source needs at least %d frames" % EDIT_MIN_SOURCE_FRAMES
    if frames > EDIT_MAX_SOURCE_FRAMES:
        return "the source is at most %d frames" % EDIT_MAX_SOURCE_FRAMES
    if mode == "extend":
        if not isinstance(extend_frames, int) or extend_frames < 1 or extend_frames > 18:
            return "extend_frames must be 1 to 18 latent frames"
    else:
        if not isinstance(start_latent, int) or start_latent < 1 or start_latent >= latent_frames(frames):
            return "the retake start must be inside the clip"
    return None


def edit(request):
    """Extend or retake a source clip (op `extend` or `retake`). The reply has the same shape as a generated clip."""
    mode = request["op"]
    if request.get("profile") != "max":
        raise ValueError("extend and retake run on the Max video model only")
    source = request.get("source_video")
    if not source or not os.path.isfile(source):
        raise ValueError("the source clip is missing")
    if request.get("image") or request.get("end_image"):
        raise ValueError("an extend or a retake takes no picture")
    if request.get("loras"):
        raise ValueError("this video model takes no style files yet")
    model_dir = request["model_dir"]
    for needed in MAX_REQUIRED:
        if not os.path.exists(os.path.join(model_dir, needed)):
            raise FileNotFoundError("the LTX-2.5 video model is not installed")
    gemma_dir = max_gemma_dir(model_dir, request.get("text_encoder_dir"))
    work = request["output"] + ".work"
    os.makedirs(work, exist_ok=True)
    started = time.time()
    try:
        ffmpeg = tools_on_path(request.get("ffmpeg"), request.get("ffprobe"), work)
        from ltx_core_mlx.utils.ffmpeg import probe_video_info

        info = probe_video_info(source)
        if abs(info.fps - FPS) > 0.05:
            raise ValueError("the source must be 24 frames a second")
        problem = edit_refusal(mode, int(info.width), int(info.height), int(info.num_frames), request.get("extend_frames"), request.get("retake_start_latent"))
        if problem:
            raise ValueError(problem)
        _state["steps"] = 0
        _state["steps_total"] = 11 if mode == "extend" else 8
        phase("loading", 0)
        stage("source")
        pipe = _pipeline(model_dir, gemma_dir, mode)
        mx.reset_peak_memory()
        engine_out = os.path.join(work, "engine.mp4")
        seed = int(request["seed"])
        if mode == "extend":
            video_latent, audio_latent = pipe.extend_from_video(prompt=request["prompt"], video_path=source, extend_frames=int(request["extend_frames"]), seed=seed)
        else:
            end = latent_frames(int(info.num_frames))
            video_latent, audio_latent = pipe.retake_from_video(prompt=request["prompt"], video_path=source, start_frame=int(request["retake_start_latent"]), end_frame=end, seed=seed, regenerate_audio=True)
        # The same decode and save the runtime's command line does: give the transformer and the text encoder back, load the decoders, decode the whole clip.
        phase("decoding", 0)
        stage("frames")
        pipe.dit = None
        pipe.text_encoder = None
        pipe.feature_extractor = None
        pipe._loaded = False
        gc.collect()
        mx.clear_cache()
        if pipe.source_frame_rate is None:
            raise RuntimeError("the source frame rate was not recorded")
        pipe._load_decoders()
        pipe._decode_and_save_video(video_latent, audio_latent, engine_out, frame_rate=pipe.source_frame_rate)
        phase("encoding", 0)
        stage("save")
        if not os.path.isfile(engine_out):
            raise RuntimeError("the engine wrote no file")
        poster = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", engine_out, "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", request["poster"]], capture_output=True)
        if poster.returncode != 0 or not os.path.isfile(request["poster"]):
            raise RuntimeError("no poster")
        has_sound, real_width, real_height = _probe(ffmpeg, engine_out)
        frames = _count_frames(ffmpeg, engine_out)
        os.replace(engine_out, request["output"])
        phase("encoding", 100)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        gc.collect()
        mx.clear_cache()
    return {"width": real_width or int(info.width), "height": real_height or int(info.height), "frames": frames, "fps": FPS, "seed": seed, "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory()), "audio": bool(has_sound)}


def ic_lora(request):
    """Render with the fork's ICLoraPipeline and restore the source audio after generation."""
    if request.get("profile") != "max":
        raise ValueError("IC-LoRA video runs on the Max video model only")
    if (request.get("width"), request.get("height")) != (1024, 576):
        raise ValueError("IC-LoRA video makes 1024x576 only")
    source, lora = request.get("source_video"), request.get("ic_lora_path")
    if not source or not os.path.isfile(source):
        raise ValueError("the source clip is missing")
    if not lora or not os.path.isfile(lora):
        raise ValueError("the IC-LoRA file is missing; install or choose a readable IC-LoRA file")
    strength = float(request.get("ic_lora_strength", 1.0))
    if not 0 <= strength <= 2:
        raise ValueError("IC-LoRA strength must be between 0 and 2")
    model_dir = request["model_dir"]
    gemma_dir = max_gemma_dir(model_dir, request.get("text_encoder_dir"))
    work = request["output"] + ".work"
    os.makedirs(work, exist_ok=True)
    started = time.time()
    try:
        ffmpeg = tools_on_path(request.get("ffmpeg"), request.get("ffprobe"), work)
        from ltx_core_mlx.utils.ffmpeg import probe_video_info
        info = probe_video_info(source)
        source_frames = min(241, max(9, int(info.num_frames)))
        frames = 1 + ((source_frames - 1) // 8) * 8
        reference = prepare_ic_reference(ffmpeg, source, os.path.join(work, "reference.mp4"), request.get("conditioning", "source"), frames=frames)
        _state["steps"] = 0
        _state["steps_total"] = 11
        stage("source")
        phase("loading", 0)
        pipe = _pipeline(model_dir, gemma_dir, "ic_lora", ((lora, strength),))
        mx.reset_peak_memory()
        engine_out = os.path.join(work, "engine.mp4")
        pipe.generate_and_save(prompt=request["prompt"], output_path=engine_out, video_conditioning=[(reference, 1.0)], height=576, width=1024, num_frames=frames, frame_rate=24.0, seed=int(request["seed"]))
        phase("encoding", 0)
        stage("save")
        # Keep source audio and metadata. No -shortest: source duration is the audio authority.
        muxed = os.path.join(work, "with-audio.mp4")
        mux = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", engine_out, "-i", source, "-map", "0:v:0", "-map", "1:a?", "-c:v", "copy", "-c:a", "aac", "-map_metadata", "0", muxed], capture_output=True)
        if mux.returncode or not os.path.isfile(muxed):
            raise RuntimeError("the generated clip could not keep the source sound")
        poster = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", muxed, "-frames:v", "1", "-q:v", "3", "-map_metadata", "-1", request["poster"]], capture_output=True)
        if poster.returncode or not os.path.isfile(request["poster"]):
            raise RuntimeError("no poster")
        has_sound, real_width, real_height = _probe(ffmpeg, muxed)
        out_frames = _count_frames(ffmpeg, muxed)
        os.replace(muxed, request["output"])
        phase("encoding", 100)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        gc.collect()
        mx.clear_cache()
    return {"width": real_width or 1024, "height": real_height or 576, "frames": out_frames, "fps": FPS, "seed": int(request["seed"]), "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory()), "audio": bool(has_sound)}


def _count_frames(ffmpeg, path):
    """Pixel frames of the engine's file (the reply reports what the file really holds): ffmpeg's own count of the decoded video stream (a stream copy counts one more than the file holds)."""
    text = subprocess.run([ffmpeg, "-hide_banner", "-i", path, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"], capture_output=True, text=True).stderr or ""
    found = re.findall(r"frame=\s*(\d+)", text)
    return int(found[-1]) if found else 0


def main():
    forbid_network()
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
        _state["id"] = request.get("id")
        try:
            result = edit(request) if request.get("op") in ("extend", "retake") else ic_lora(request) if request.get("op") == "ic_lora" else generate(request)
            emit({"id": request["id"], "ok": True, **result})
        except BaseException as error:  # noqa: BLE001 - every failure becomes a reply, the process stays up
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code, message = classify(error)
            sys.stderr.write("video worker: %s (%s)\n" % (code, type(error).__name__))
            sys.stderr.flush()
            if os.environ.get("VIDEO_WORKER_DEBUG") == "1":
                traceback.print_exc()
                message = "%s [%s: %s]" % (message, type(error).__name__, str(error)[:300])
            emit({"id": request.get("id"), "ok": False, "code": code, "error": message})


if __name__ == "__main__":
    main()
