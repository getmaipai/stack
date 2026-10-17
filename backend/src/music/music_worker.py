# The Stack's music generation worker (MUSIC-GEN-01). One process, JSON lines
# on stdin and stdout, no port. The Stack starts it on the first music job,
# sends jobs one at a time, and stops it after five idle minutes or when a job
# is cancelled; it never outlives the Stack.
#
# Runtime: ACE-Step 1.5 (MIT, ace-step/ACE-Step-1.5, the pinned source
# archive) on Apple silicon: the 2B turbo DiT and the music VAE through
# ACE-Step's own MLX path, the 5 Hz planning LM through its MLX backend, the
# text encoder on torch MPS. ACE-Step is used as shipped, in process; this
# file adds only what the Stack needs around it:
#   1. no network: HF_HUB_OFFLINE and friends are set before any import, the
#      checkpoints folder is the Stack's model folder, the downloader is never
#      called (the Stack installs the pins first);
#   2. memory: a tiled VAE decode (ACESTEP_MLX_VAE_CHUNK) and a capped MLX
#      buffer cache, measured in Home's design note
#      docs/design/music-generation-2026-10-17.md section 4;
#   3. progress by stage (plan, music, mix, save) from ACE-Step's own
#      progress callback;
#   4. the cheap edits (trim, fade, loudness) on the decoded samples, and the
#      AAC file (48 kHz stereo, 256 kbps, faststart, no metadata) every
#      result is written as;
#   5. lyric timings (LRC) for a sung song, so a later edit can name a section.
# Nothing is logged with a description, lyrics or audio: stderr carries the
# stage, a code and an exception type only.
import gc
import io
import json
import math
import os
import subprocess
import sys
import time
import traceback

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("ACESTEP_MLX_VAE_CHUNK", "256")

# Hard ceilings, mirrored in the Stack's service.
MIN_SECONDS = 10.0
MAX_SECONDS = float(os.environ.get("MUSIC_MAX_SECONDS", "240"))
MAX_EXTEND_SECONDS = 120.0
MAX_TEXT_CHARS = 4000
SAMPLE_RATE = 48000
AAC_BITRATE = "256k"

_real_out = sys.stdout
_current = {"id": None, "stage": None}
_handlers = {"dit": None, "llm": None, "lm": None, "ckpt": None}


def emit(obj):
    _real_out.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _real_out.flush()


def stage(name, fraction=None):
    event = {"id": _current["id"], "event": "stage", "stage": name}
    if fraction is not None:
        event["fraction"] = round(max(0.0, min(1.0, float(fraction))), 3)
    _current["stage"] = name
    emit(event)


def _progress(value, desc=None, *args, **kwargs):
    """ACE-Step's progress callback: 0 to 0.51 is the planning LM, 0.51 to 0.8 the DiT, 0.8 on the VAE decode."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return
    if v < 0.51:
        stage("plan", v / 0.51)
    elif v < 0.8:
        stage("music", (v - 0.51) / 0.29)
    else:
        stage("mix", (v - 0.8) / 0.2)


class _Quiet(io.TextIOBase):
    """ACE-Step prints progress bars and, at debug level, the prompt it built. None of it is forwarded."""

    def write(self, text):
        return len(text)

    def flush(self):
        pass


def _quiet_logs():
    try:
        from loguru import logger

        logger.remove()
        logger.add(sys.stderr, level="ERROR", format="music worker: {level} {name}", filter=lambda record: True)
    except Exception:  # noqa: BLE001
        pass


def _ensure_models(ckpt_dir, lm_name, cache_gb):
    """Loads the DiT, VAE and text encoder once, and the planning LM named by the request (switching it if the quality changed)."""
    import mlx.core as mx

    mx.set_cache_limit(int(cache_gb * (1 << 30)))
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = ckpt_dir
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler

    if _handlers["dit"] is None or _handlers["ckpt"] != ckpt_dir:
        stage("load")
        if not os.path.isfile(os.path.join(ckpt_dir, "acestep-v15-turbo", "model.safetensors")):
            raise FileNotFoundError("the music model is not installed")
        dit = AceStepHandler()
        message, ok = _ok(dit.initialize_service(project_root=os.path.dirname(ckpt_dir), config_path="acestep-v15-turbo", device="mps", use_mlx_dit=True))
        if not ok:
            raise RuntimeError("model load failed")
        _handlers.update(dit=dit, ckpt=ckpt_dir, llm=None, lm=None)
    if lm_name and _handlers["lm"] != lm_name:
        stage("load")
        if not os.path.isfile(os.path.join(ckpt_dir, lm_name, "model.safetensors")):
            raise FileNotFoundError("the music model is not installed")
        if _handlers["llm"] is not None:
            try:
                _handlers["llm"].unload()
            except Exception:  # noqa: BLE001
                pass
            _handlers["llm"] = None
            gc.collect()
            mx.clear_cache()
        llm = LLMHandler()
        message, ok = _ok(llm.initialize(checkpoint_dir=ckpt_dir, lm_model_path=lm_name, backend="mlx", device="mps"))
        if not ok:
            raise RuntimeError("planning model load failed")
        _handlers.update(llm=llm, lm=lm_name)


def _ok(result):
    if isinstance(result, tuple) and len(result) >= 2:
        return result[0], bool(result[1])
    return result, True


def _text(value, name):
    text = (value or "").strip() if isinstance(value, str) else ""
    if len(text) > MAX_TEXT_CHARS:
        raise ValueError("%s is longer than %d characters" % (name, MAX_TEXT_CHARS))
    return text


def _read(path):
    import soundfile as sf

    data, rate = sf.read(path, always_2d=True, dtype="float32")
    if rate != SAMPLE_RATE:
        raise ValueError("the source is not 48 kHz audio made by this Stack")
    return data


def _decode_source(request, workdir):
    """The source track (an AAC file this Stack made) as a 48 kHz WAV ACE-Step can read."""
    src = request.get("source")
    if not src:
        raise ValueError("this change needs the song it starts from")
    wav = os.path.join(workdir, "source.wav")
    subprocess.run([request["ffmpeg"], "-nostdin", "-loglevel", "error", "-y", "-i", src, "-vn", "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", wav], check=True)
    return wav


def _encode(wav_path, out_path, ffmpeg, title=None):
    args = [ffmpeg, "-nostdin", "-loglevel", "error", "-y", "-i", wav_path, "-map_metadata", "-1", "-vn", "-ac", "2", "-ar", str(SAMPLE_RATE), "-c:a", "aac", "-b:a", AAC_BITRATE, "-movflags", "+faststart"]
    if title:
        args += ["-metadata", "title=" + title[:200]]
    subprocess.run(args + [out_path], check=True)


def _write_wav(data, path):
    import soundfile as sf

    sf.write(path, data, SAMPLE_RATE, subtype="PCM_16")


def _seconds(value, default):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) else default


def cheap_edit(request, workdir):
    """trim, fade or loudness on the decoded samples: no model, well under a second."""
    import numpy as np

    data = _read(_decode_source(request, workdir))
    total = data.shape[0] / SAMPLE_RATE
    edit = request.get("edit") or {}
    op = edit.get("op")
    if op == "trim":
        start = max(0.0, _seconds(edit.get("from_s"), 0.0))
        end = min(total, _seconds(edit.get("to_s"), total))
        if end - start < 1.0:
            raise ValueError("the part to keep must be at least one second long")
        data = data[int(start * SAMPLE_RATE):int(end * SAMPLE_RATE)]
        fade = min(0.02, (end - start) / 4)
        n = int(fade * SAMPLE_RATE)
        if n > 0:
            ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)[:, None]
            data[:n] *= ramp
            data[-n:] *= ramp[::-1]
    elif op == "fade":
        seconds = min(max(0.1, _seconds(edit.get("seconds"), 3.0)), total / 2)
        n = int(seconds * SAMPLE_RATE)
        ramp = (np.linspace(0.0, 1.0, n, dtype=np.float32) ** 2)[:, None]
        if edit.get("where", "out") in ("in", "both"):
            data[:n] *= ramp
        if edit.get("where", "out") in ("out", "both"):
            data[-n:] *= ramp[::-1]
    elif op == "loudness":
        target = max(-30.0, min(-8.0, _seconds(edit.get("lufs"), -14.0)))
        rms = float(np.sqrt(np.mean(np.square(data)))) or 1e-9
        current = 20 * math.log10(rms) - 0.691 + 3.0  # an RMS stand-in for integrated loudness, within about 1 LU on full mixes
        gain = 10 ** ((target - current) / 20)
        data = data * gain
        peak = float(np.max(np.abs(data))) or 1e-9
        if peak > 0.891:  # keep 1 dB of headroom: never clip
            data = data * (0.891 / peak)
    else:
        raise ValueError("unknown edit")
    stage("save")
    wav = os.path.join(workdir, "edited.wav")
    _write_wav(data, wav)
    _encode(wav, request["output"], request["ffmpeg"], request.get("title"))
    return {"duration_s": round(data.shape[0] / SAMPLE_RATE, 2), "seed": None, "task": op, "lrc": None}


def generate(request, workdir):
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    task = request.get("task") or "text2music"
    if task not in ("text2music", "cover", "repaint", "extend"):
        raise ValueError("unknown task")
    caption = _text(request.get("caption"), "the description")
    lyrics = _text(request.get("lyrics"), "the lyrics")
    instrumental = bool(request.get("instrumental")) or not lyrics
    if instrumental:
        lyrics = "[Instrumental]"
    if not caption and instrumental:
        raise ValueError("describe the music")
    seed = int(request.get("seed") if request.get("seed") is not None else -1)
    lm_name = request.get("lm") if task == "text2music" else None
    _ensure_models(request["ckpt_dir"], lm_name or _handlers.get("lm"), float(request.get("cache_gb") or 2))
    kwargs = dict(caption=caption, lyrics=lyrics, instrumental=instrumental, seed=seed, vocal_language=request.get("language") or ("unknown" if instrumental else "en"))
    if request.get("bpm"):
        kwargs["bpm"] = max(30, min(300, int(request["bpm"])))
    if request.get("key"):
        kwargs["keyscale"] = _text(request["key"], "the key")[:20]
    if task == "text2music":
        duration = _seconds(request.get("duration_s"), 60.0)
        if duration < MIN_SECONDS or duration > MAX_SECONDS:
            raise ValueError("a song is %d to %d seconds long" % (MIN_SECONDS, MAX_SECONDS))
        params = GenerationParams(task_type="text2music", duration=duration, thinking=True, use_cot_lyrics=False, **kwargs)
    else:
        src = _decode_source(request, workdir)
        total = _read(src).shape[0] / SAMPLE_RATE
        if task == "cover":
            strength = max(0.1, min(1.0, _seconds(request.get("strength"), 0.6)))
            params = GenerationParams(task_type="cover", src_audio=src, audio_cover_strength=strength, thinking=False, **kwargs)
        elif task == "repaint":
            start = max(0.0, _seconds(request.get("from_s"), 0.0))
            end = min(total, _seconds(request.get("to_s"), total))
            if end - start < 2.0:
                raise ValueError("the part to change must be at least two seconds long")
            params = GenerationParams(task_type="repaint", src_audio=src, repainting_start=start, repainting_end=end, chunk_mask_mode="explicit", thinking=False, **kwargs)
        else:  # extend: ACE-Step's repaint pads the source past its end (or before its start) and fills the new part
            add = _seconds(request.get("add_s"), 20.0)
            if add < 5.0 or add > MAX_EXTEND_SECONDS or total + add > MAX_SECONDS:
                raise ValueError("a song can grow by 5 to %d seconds, up to %d seconds in all" % (MAX_EXTEND_SECONDS, MAX_SECONDS))
            if request.get("at") == "start":
                params = GenerationParams(task_type="repaint", src_audio=src, repainting_start=-add, repainting_end=0.0, chunk_mask_mode="explicit", thinking=False, **kwargs)
            else:
                params = GenerationParams(task_type="repaint", src_audio=src, repainting_start=total, repainting_end=total + add, chunk_mask_mode="explicit", thinking=False, **kwargs)
    config = GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=seed < 0, seeds=[seed] if seed >= 0 else None)
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = _Quiet()
    try:
        result = generate_music(_handlers["dit"], _handlers["llm"] if task == "text2music" else None, params, config, save_dir=workdir, progress=_progress)
    finally:
        sys.stdout = old_out
        sys.stderr = old_err
    if not result.success or not result.audios:
        raise RuntimeError("generation failed")
    audio = result.audios[0]
    used_seed = (audio.get("params") or {}).get("seed")
    lrc = None
    if not instrumental and task in ("text2music", "repaint", "extend") and request.get("lrc", True):
        stage("mix", 0.9)
        lrc = _lrc(result, params, request)
    stage("save")
    data = _read(audio["path"])
    _encode(audio["path"], request["output"], request["ffmpeg"], request.get("title"))
    return {"duration_s": round(data.shape[0] / SAMPLE_RATE, 2), "seed": int(used_seed) if used_seed is not None else None, "task": task, "lrc": lrc}


def _lrc(result, params, request):
    """Lyric timings from ACE-Step's own aligner; a failure only means no timings."""
    try:
        extra = result.extra_outputs or {}
        need = ["pred_latents", "encoder_hidden_states", "encoder_attention_mask", "context_latents", "lyric_token_idss"]
        if not all(extra.get(k) is not None for k in need):
            return None
        out = _handlers["dit"].get_lyric_timestamp(
            pred_latent=extra["pred_latents"][0:1],
            encoder_hidden_states=extra["encoder_hidden_states"][0:1],
            encoder_attention_mask=extra["encoder_attention_mask"][0:1],
            context_latents=extra["context_latents"][0:1],
            lyric_token_ids=extra["lyric_token_idss"][0:1],
            total_duration_seconds=float(extra["pred_latents"].shape[1] / 25.0),
            vocal_language=params.vocal_language if params.vocal_language != "unknown" else "en",
            inference_steps=8,
            seed=42,
        )
        return out.get("lrc_text") if out.get("success") else None
    except Exception:  # noqa: BLE001
        return None


def run(request):
    import tempfile

    import mlx.core as mx

    started = time.time()
    workdir = tempfile.mkdtemp(prefix="music-", dir=request.get("workdir") or None)
    try:
        mx.reset_peak_memory()
        if request.get("op") == "edit":
            out = cheap_edit(request, workdir)
        else:
            out = generate(request, workdir)
        out.update(ms=int((time.time() - started) * 1000), peak_bytes=int(mx.get_peak_memory()))
        return out
    finally:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
        gc.collect()
        mx.clear_cache()


def classify(error):
    text = str(error)
    lowered = text.lower()
    if isinstance(error, MemoryError) or "out of memory" in lowered or "insufficient memory" in lowered or "kiogpucommandbuffercallbackerror" in lowered:
        return "out_of_memory", "The computer ran out of memory while making the song. Close other big apps and try again."
    if isinstance(error, FileNotFoundError):
        return "model_missing", "The music model is not installed. Install it in Settings, Models and storage, then try again."
    if isinstance(error, ValueError):
        return "bad_request", text
    if isinstance(error, subprocess.CalledProcessError):
        return "failed", "The song could not be saved as a sound file. Try again; if it keeps failing, restart the Stack."
    return "failed", "The song could not be made (%s). Try again; if it keeps failing, restart the Stack." % type(error).__name__


def main():
    _quiet_logs()
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
            result = run(request)
            emit({"id": request["id"], "ok": True, **result})
        except BaseException as error:  # noqa: BLE001 - every failure becomes a reply, the process stays up
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            code, message = classify(error)
            sys.stderr.write("music worker: %s (%s) at %s\n" % (code, type(error).__name__, _current["stage"]))
            sys.stderr.flush()
            if os.environ.get("MUSIC_WORKER_DEBUG") == "1":
                traceback.print_exc()
            emit({"id": request.get("id"), "ok": False, "code": code, "error": message})


if __name__ == "__main__":
    main()
