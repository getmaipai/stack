"""Offline JSON-lines worker for Fish Audio Drama 3 recorded speech."""
import json, os, select, subprocess, sys, time
from pathlib import Path
import wave

IDLE_SECONDS = 60
_model = None
_model_path = None

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n"); sys.stdout.flush()

def run(request):
    global _model, _model_path
    import numpy as np
    import soundfile as sf
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model

    started = time.time()
    mx.reset_peak_memory()
    if _model is None or _model_path != request["model"]:
        _model = load_model(request["model"])
        _model_path = request["model"]
    model = _model
    emit({"id": request["id"], "event": "stage", "stage": "rendering", "fraction": .15})
    refs = []
    for index, ref in enumerate(request["references"]):
        wav = Path(request["work_dir"]) / f"reference-{index}.wav"
        subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@24000", ref["audio"], str(wav)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with wave.open(str(wav), "rb") as stream:
            duration = stream.getnframes() / stream.getframerate()
        if duration < 6 or duration > 30:
            raise RuntimeError("The reference clip must be 6 to 30 seconds long.")
        refs.append({"audio": str(wav), "text": ref["text"]})
    if len(refs) == 1:
        ref_audio, ref_text = refs[0]["audio"], refs[0]["text"]
    else:
        ref_audio, ref_text = [r["audio"] for r in refs], [r["text"] for r in refs]
    chunks = []
    for result in model.generate(text=request["text"], ref_audio=ref_audio, ref_text=ref_text, stream=False):
        chunks.append(np.asarray(result.audio))
    if not chunks:
        raise RuntimeError("Speech rendering produced no audio.")
    audio = np.concatenate(chunks, axis=-1).astype(np.float32).reshape(-1)
    if not np.isfinite(audio).all() or not np.any(np.abs(audio) > 1e-6):
        raise RuntimeError("Speech rendering produced silent audio.")
    emit({"id": request["id"], "event": "stage", "stage": "saving", "fraction": .9})
    wav_path = Path(request["output_wav"])
    sf.write(wav_path, audio, int(model.sample_rate), subtype="PCM_16")
    if request["format"] == "m4a":
        subprocess.run(["/usr/bin/afconvert", "-f", "m4af", "-d", "aac", "-b", "192000", str(wav_path), request["output"]], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        Path(request["output"]).write_bytes(wav_path.read_bytes())
    return {"ms": int((time.time() - started) * 1000), "duration": len(audio) / int(model.sample_rate), "sample_rate": int(model.sample_rate), "peak_gb": round(mx.get_peak_memory() / 1e9, 3)}

def main():
    emit({"ready": True})
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], IDLE_SECONDS)
        if not ready:
            return
        line = sys.stdin.readline()
        if not line:
            return
        request = json.loads(line)
        try:
            result = run(request)
            emit({"id": request["id"], "ok": True, **result})
        except Exception:
            emit({"id": request.get("id"), "ok": False, "error": "Recorded speech could not be rendered. Check the clip and try again."})

if __name__ == "__main__":
    main()
