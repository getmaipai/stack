# The Stack's sound effects worker (MP-07). One process, JSON lines on stdin
# and stdout, no port. The Stack starts it on the first sound, sends jobs one
# at a time, and stops it after the idle window or when a job is cancelled; it
# never outlives the Stack.
#
# Runtime: Stable Audio 3 Small-SFX (Stability AI's stable-audio-3 code, MIT,
# the pinned source archive; the weights are Stability AI Community Licence
# with a Gemma text encoder) on torch MPS in float32, 8 steps by default.
# The code is used as shipped; this file adds only what the Stack needs:
#   1. no network: the offline variables are set before any import, the model
#      config is read from the Stack's model folder and its text encoder is
#      pointed at the local folder (model_path; repo_id and subfolder are
#      dropped), and the hub loader in model_configs is never called;
#   2. progress by stage (load, sound, save);
#   3. the finish the Home side needs no tool for: the silent tail the model
#      leaves on a one-shot is cut (the clip is made a second longer than
#      asked, then cut back to the sound's end and to the asked length, with a
#      20 ms fade), and the loudness is set to one level for every sound
#      (ffmpeg loudnorm, two passes, linear gain), written as AAC in m4a
#      (44.1 kHz stereo, 192 kbps, faststart, no metadata).
# Nothing is logged with a description or audio: stderr carries the stage, a
# code and an exception type only.
import json
import os
import resource
import shutil
import subprocess
import sys
import time
import traceback
from contextlib import redirect_stdout

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

SAMPLE_RATE = 44100
AAC_BITRATE = "192k"
MAX_SECONDS = float(os.environ.get("SFX_MAX_SECONDS", "47"))
MAX_PROMPT_CHARS = 1000
# The tail cut: 50 ms blocks; the sound ends after the last block above the floor, plus a short pad, then a fade. The floor is
# -60 dBFS, or 45 dB under the loudest block when the whole sound is quiet (a soft ambience keeps its quiet end), never under
# -80 dBFS (the model's silent tail measures about -90).
BLOCK_SECONDS = 0.05
TAIL_FLOOR_DB = -60.0
TAIL_BELOW_LOUDEST_DB = 45.0
TAIL_FLOOR_MIN_DB = -80.0
TAIL_PAD_SECONDS = 0.05
FADE_SECONDS = 0.02
# The loudness every sound is set to (EBU R128 integrated), with a true-peak ceiling.
# The gain is capped so a near-silent ambience is not lifted into hiss, and a limiter under the ceiling catches the transients
# the AAC encoder would otherwise push past full scale (rain on a tin roof measured +1.8 dBTP without it, 2026-11-13).
TARGET_LUFS = float(os.environ.get("SFX_TARGET_LUFS", "-16"))
TARGET_TP = -2.0
MAX_GAIN_DB = 24.0
LIMIT_LINEAR = 0.79

_real_out = sys.stdout
_current = {"id": None, "stage": None}
_model = {"dir": None, "model": None, "device": None}


class SilentSound(RuntimeError):
    pass


def emit(obj):
    _real_out.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _real_out.flush()


def stage(name, fraction=None):
    event = {"id": _current["id"], "event": "stage", "stage": name}
    if fraction is not None:
        event["fraction"] = round(max(0.0, min(1.0, float(fraction))), 3)
    _current["stage"] = name
    emit(event)


def background_argv(argv):
    if os.path.exists("/usr/sbin/taskpolicy"):
        return ["/usr/sbin/taskpolicy", "-b", *argv]
    if shutil.which("nice"):
        return ["nice", "-n", "19", *argv]
    return argv


def local_config(model_dir):
    """The model's own config with the text encoder read from the local folder, never from the hub."""
    with open(os.path.join(model_dir, "model_config.json")) as f:
        config = json.load(f)
    found = False
    for conditioner in config["model"]["conditioning"]["configs"]:
        if conditioner.get("type") == "t5gemma":
            settings = conditioner["config"]
            settings.pop("repo_id", None)
            settings.pop("subfolder", None)
            settings["model_path"] = os.path.join(model_dir, "t5gemma-b-b-ul2")
            found = True
    if not found:
        raise FileNotFoundError("model_config.json names no T5Gemma text encoder")
    return config


def load(model_dir):
    if _model["model"] is not None and _model["dir"] == model_dir:
        return _model["model"]
    import torch
    from stable_audio_3.loading_utils import load_diffusion_cond
    from stable_audio_3.model import StableAudioModel

    for name in ("model.safetensors", "model_config.json", os.path.join("t5gemma-b-b-ul2", "model.safetensors"), os.path.join("t5gemma-b-b-ul2", "tokenizer.json")):
        if not os.path.exists(os.path.join(model_dir, name)):
            raise FileNotFoundError(name)
    config = local_config(model_dir)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    # float32 on Apple silicon: stable-audio-3 turns half precision off without CUDA (its own from_pretrained does the same).
    core = load_diffusion_cond(config, os.path.join(model_dir, "model.safetensors"), device=device, model_half=False)
    core.use_lora = False
    core.lora_names = []
    _model.update(dir=model_dir, model=StableAudioModel(core, config, device, False), device=device)
    return _model["model"]


def tail_cut(audio, asked_seconds):
    """Where the sound ends: after the last 50 ms block above the floor, plus a pad, never past the asked length. Returns a sample count."""
    import numpy as np

    block = int(SAMPLE_RATE * BLOCK_SECONDS)
    mono = np.mean(audio, axis=0)
    count = len(mono) // block
    if count == 0:
        raise SilentSound("empty")
    blocks = mono[: count * block].reshape(count, block)
    rms = np.sqrt(np.mean(blocks.astype(np.float64) ** 2, axis=1))
    levels = 20 * np.log10(rms + 1e-12)
    floor = max(TAIL_FLOOR_MIN_DB, min(TAIL_FLOOR_DB, float(levels.max()) - TAIL_BELOW_LOUDEST_DB))
    loud = np.nonzero(levels > floor)[0]
    if len(loud) == 0:
        raise SilentSound("silent")
    end = (int(loud[-1]) + 1) * block + int(SAMPLE_RATE * TAIL_PAD_SECONDS)
    return max(block, min(end, len(mono), int(round(asked_seconds * SAMPLE_RATE))))


def finish(audio, end):
    """The kept samples, with a short fade on the last FADE_SECONDS so the cut never clicks."""
    import numpy as np

    kept = audio[:, :end].copy()
    fade = min(int(SAMPLE_RATE * FADE_SECONDS), kept.shape[1])
    if fade > 1:
        kept[:, -fade:] *= np.linspace(1.0, 0.0, fade, dtype=kept.dtype)
    return kept


def measure_loudness(ffmpeg, wav):
    """ffmpeg loudnorm's first pass: the measured input loudness, as its JSON block."""
    args = [ffmpeg, "-nostdin", "-hide_banner", "-nostats", "-i", wav, "-af", "loudnorm=I=%g:TP=%g:LRA=11:print_format=json" % (TARGET_LUFS, TARGET_TP), "-f", "null", "-"]
    done = subprocess.run(background_argv(args), check=True, capture_output=True, text=True)
    text = done.stderr
    start = text.rfind("{")
    end = text.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("loudnorm printed no measurement")
    return json.loads(text[start : end + 1])


def encode(ffmpeg, wav, out_path):
    """Sets the loudness (linear gain from the first pass' numbers; a sound too quiet to measure keeps its level) and writes the m4a."""
    measured = measure_loudness(ffmpeg, wav)
    try:
        input_i = float(measured["input_i"])
    except (KeyError, TypeError, ValueError):
        input_i = float("-inf")
    filters = []
    normalised = input_i > -70.0
    if normalised:
        target = min(TARGET_LUFS, input_i + MAX_GAIN_DB)
        filters.append(
            "loudnorm=I=%g:TP=%g:LRA=11:measured_I=%s:measured_TP=%s:measured_LRA=%s:measured_thresh=%s:offset=%s:linear=true"
            % (target, TARGET_TP, measured["input_i"], measured["input_tp"], measured["input_lra"], measured["input_thresh"], measured["target_offset"])
        )
    filters.append("aresample=%d" % SAMPLE_RATE)
    filters.append("alimiter=limit=%g:level=false" % LIMIT_LINEAR)
    args = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-map_metadata", "-1", "-vn", "-af", ",".join(filters), "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "aac", "-b:a", AAC_BITRATE, "-movflags", "+faststart", out_path]
    subprocess.run(background_argv(args), check=True)
    return {"input_lufs": round(input_i, 1) if input_i != float("-inf") else None, "normalised": normalised}


def peak_bytes():
    # macOS reports ru_maxrss in bytes; Linux in kilobytes.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def run(request):
    import numpy as np
    import soundfile as sf
    import torch

    prompt = str(request.get("prompt") or "").strip()
    if not prompt or len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError("Describe the sound in words, in at most %d characters." % MAX_PROMPT_CHARS)
    seconds = float(request["seconds"])
    if not (0.5 <= seconds <= MAX_SECONDS):
        raise ValueError("A sound here is 1 to %d seconds long." % int(MAX_SECONDS))
    gen_seconds = float(request.get("gen_seconds") or seconds)
    steps = int(request.get("steps") or 8)
    seed = int(request.get("seed") if request.get("seed") is not None else 0)
    started = time.time()
    stage("load")
    # The library prints to stdout (missing keys, warnings); stdout is the protocol, so its prints go to stderr.
    with redirect_stdout(sys.stderr):
        model = load(request["model_dir"])
    stage("sound", 0.1)
    with redirect_stdout(sys.stderr), torch.inference_mode():
        audio = model.generate(prompt=prompt, duration=gen_seconds, steps=steps, seed=seed)
    if _model["device"] == "mps":
        torch.mps.synchronize()
    audio = audio[0] if audio.dim() == 3 else audio
    samples = audio.float().cpu().numpy()
    del audio
    if _model["device"] == "mps":
        torch.mps.empty_cache()
    stage("save", 0.9)
    end = tail_cut(samples, seconds)
    kept = finish(samples, end)
    wav = request["output"] + ".wav"
    try:
        sf.write(wav, np.ascontiguousarray(kept.T), SAMPLE_RATE, subtype="FLOAT")
        loudness = encode(request["ffmpeg"], wav, request["output"])
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass
    return {
        "duration_s": round(end / SAMPLE_RATE, 3), "seed": seed, "steps": steps, "ms": int((time.time() - started) * 1000), "peak_bytes": peak_bytes(),
        "trimmed_s": round(max(0.0, gen_seconds - end / SAMPLE_RATE), 3), **loudness,
    }


def classify(error):
    lowered = str(error).lower()
    if isinstance(error, SilentSound):
        return "silent", "The sound came out silent. Try other words for it."
    if isinstance(error, MemoryError) or "out of memory" in lowered or "insufficient memory" in lowered or "kiogpucommandbuffercallbackerror" in lowered:
        return "out_of_memory", "The computer ran out of memory while making the sound. Close other big apps and try again."
    if isinstance(error, FileNotFoundError):
        return "model_missing", "The sound effects model is not installed. Install it in Settings, AI and models, then try again."
    if isinstance(error, ValueError):
        return "bad_request", str(error)
    if isinstance(error, subprocess.CalledProcessError):
        return "failed", "The sound could not be saved as a sound file. Try again; if it keeps failing, restart the Stack."
    return "failed", "The sound could not be made (%s). Try again; if it keeps failing, restart the Stack." % type(error).__name__


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
            emit({"id": request["id"], "ok": True, **run(request)})
        except BaseException as error:  # noqa: BLE001 - every failure becomes a reply, the process stays up
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code, message = classify(error)
            sys.stderr.write("sfx worker: %s (%s) at %s\n" % (code, type(error).__name__, _current["stage"]))
            sys.stderr.flush()
            if os.environ.get("SFX_WORKER_DEBUG") == "1":
                traceback.print_exc()
            try:
                if os.path.exists(request.get("output", "")):
                    os.remove(request["output"])
            except OSError:
                pass
            emit({"id": request.get("id"), "ok": False, "code": code, "error": message})


if __name__ == "__main__":
    main()
