"""One cold-start Demucs htdemucs worker. JSON-lines on stdin/stdout."""
import json
import os
import sys
import time
import traceback
import select

IDLE_SECONDS = 60


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run(request):
    import numpy as np
    import torch
    from demucs.hf import load_safetensors_model
    from demucs.apply import apply_model

    emit({"id": request["id"], "event": "stage", "stage": "loading", "fraction": 0.05})
    from pathlib import Path
    config_hash = __import__("hashlib").sha256(Path(request["config"]).read_bytes()).hexdigest()
    if config_hash != "239c445d0b14454d541ad8bd9bb271c9e536d267e8a4625208744cbb2e7bb66c":
        raise RuntimeError("The pinned htdemucs model configuration failed verification.")
    checkpoint_hash = __import__("hashlib").sha256(Path(request["checkpoint"]).read_bytes()).hexdigest()
    if checkpoint_hash != "d9fa14133cfcc034a6758923bb3a8ca9f8dfd0b582134643bbf83f72c17576dd":
        raise RuntimeError("The pinned htdemucs checkpoint failed verification.")
    model = load_safetensors_model(request["checkpoint"])
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model.to(device).eval()
    import subprocess
    decoded = subprocess.run([request["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error", "-i", request["source"], "-f", "f32le", "-ar", str(model.samplerate), "-ac", "2", "pipe:1"], check=True, stdout=subprocess.PIPE).stdout
    waveform = np.frombuffer(decoded, dtype="<f4").reshape(-1, 2).copy()
    mix = torch.from_numpy(waveform.T.copy()).unsqueeze(0).to(device)
    emit({"id": request["id"], "event": "stage", "stage": "splitting", "fraction": 0.2})
    with __import__("torch").inference_mode():
        separated = apply_model(model, mix, device=device, shifts=1, split=True, overlap=0.25, progress=False)[0]
    files = []
    for index, name in enumerate(model.sources):
        stem = separated[index].detach().float().cpu().numpy()
        rms = float(np.sqrt(np.mean(np.square(stem), dtype=np.float64)))
        if rms < 1e-4:
            continue
        path = request["outputs"][name]
        emit({"id": request["id"], "event": "stage", "stage": "encoding", "fraction": 0.7 + 0.07 * index})
        subprocess.run([request["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "f32le", "-ar", str(model.samplerate), "-ac", "2", "-i", "pipe:0", "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", path], input=stem.T.astype("<f4", copy=False).tobytes(), check=True)
        files.append({"stem": name, "path": path, "rms": rms})
    return {"files": files}


def main():
    emit({"ready": True})
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], IDLE_SECONDS)
        if not ready:
            return
        line = sys.stdin.readline()
        if not line:
            return
        try:
            request = json.loads(line)
            started = time.monotonic()
            result = run(request)
            emit({"id": request["id"], "ok": True, **result, "ms": int((time.monotonic() - started) * 1000)})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit({"id": locals().get("request", {}).get("id"), "ok": False, "code": "failed", "error": str(exc)[:500]})


if __name__ == "__main__":
    main()
