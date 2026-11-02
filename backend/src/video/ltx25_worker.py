# The Stack's LTX-2.5 video worker (LTX25-ENGINE-01). Same protocol as video_worker.py and ltx_worker.py (JSON lines on stdin and
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
#   4. the same pipeline object serves every clip while the process lives. The engine runs in its low-memory mode, which gives the
#      transformer and decoders back after each clip: that is the mode the footprints in the table were measured in.
# The engine's disclosure features are left exactly as shipped (licence section 6). Nothing is logged with a prompt: stderr
# carries the failure class and the Python exception name only.
import gc
import json
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
_state = {"id": None, "pipe": None, "model_dir": None, "steps": 0, "patched": False}


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


def classify(error):
    """(code, plain message) for a failure; the message never contains the prompt."""
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
        from ltx_core_mlx.model.transformer.model import X0Model

        original_call = X0Model.__call__

        def counted(self, *args, **kwargs):
            out = original_call(self, *args, **kwargs)
            _state["steps"] += 1
            done = min(_state["steps"], STEPS_TOTAL)
            phase("rendering", 100.0 * done / STEPS_TOTAL)
            stage("motion", done, STEPS_TOTAL)
            return out

        X0Model.__call__ = counted
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


def _pipeline(model_dir, gemma_dir=None):
    key = (model_dir, gemma_dir)
    if _state["pipe"] is not None and _state["model_dir"] == key:
        return _state["pipe"]
    from ltx_pipelines_mlx.distilled import DistilledPipeline

    if gemma_dir:
        # Max: the runtime reads the prompt with the Gemma 4 folder it is given, here. It is checked on the built pipeline too.
        pipe = DistilledPipeline(model_dir=model_dir, gemma_model_id=gemma_dir, low_memory=True)
        encoder = getattr(getattr(pipe, "prompt_encoder", None), "gemma_model_id", None)
        if encoder != gemma_dir:
            raise ValueError("the Max video runtime did not take the text encoder folder")
    else:
        # gemma_model_id is ignored: the pack ships its own text_encoder folder, which the pipeline prefers.
        # DistilledPipeline takes no verbose argument (the base class defaults it to True): silence it after construction.
        pipe = DistilledPipeline(model_dir=model_dir, low_memory=True)
    pipe.verbose = False
    if getattr(pipe, "video_decoder_block", None) is not None:
        pipe.video_decoder_block.verbose = False
    _install_patches(pipe)
    _state["pipe"] = pipe
    _state["model_dir"] = key
    return pipe


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


def generate(request):
    width, height, frames = int(request["width"]), int(request["height"]), int(request["num_frames"])
    width, height = true_size(width, height)
    profile = "max" if request.get("profile") == "max" else None
    problem = refusal(width, height, frames, profile)
    if problem:
        raise ValueError(problem)
    if request.get("image"):
        raise ValueError("this video model starts from words, not from a picture")
    if request.get("loras"):
        raise ValueError("this video model takes no style files yet")
    model_dir = request["model_dir"]
    for needed in (MAX_REQUIRED if profile == "max" else REQUIRED):
        if not os.path.exists(os.path.join(model_dir, needed)):
            raise FileNotFoundError("the LTX-2.5 video model is not installed")
    gemma_dir = max_gemma_dir(model_dir, request.get("text_encoder_dir")) if profile == "max" else None
    ffmpeg = _ffmpeg_on_path(request.get("ffmpeg"))
    _state["steps"] = 0
    started = time.time()
    phase("loading", 0)
    pipe = _pipeline(model_dir, gemma_dir)
    mx.reset_peak_memory()
    work = request["output"] + ".work"
    os.makedirs(work, exist_ok=True)
    engine_out = os.path.join(work, "engine.mp4")
    try:
        pipe.generate_and_save(prompt=request["prompt"], output_path=engine_out, height=height, width=width, num_frames=frames, frame_rate=FPS, seed=int(request["seed"]))
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
    return {"width": real_width or width, "height": real_height or height, "frames": frames, "fps": FPS, "seed": int(request["seed"]), "ms": int((time.time() - started) * 1000), "peak_bytes": int(mx.get_peak_memory()), "audio": bool(has_sound)}


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
            result = generate(request)
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
