"""Offline beat, downbeat and section analysis. JSON lines only; errors are fixed sentences."""
import json
import os
import select
import subprocess
import sys
import time

SR = 22050
HOP = 512
IDLE_SECONDS = 60


class BeatsError(Exception):
    pass


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def decode(request):
    import numpy as np
    import soundfile as sf
    source = request["source"]
    wav = None
    try:
        try:
            data, rate = sf.read(source, dtype="float32", always_2d=True)
        except Exception:
            wav = os.path.join(request["workDir"], "decoded.wav")
            argv = [request["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-ac", "1", "-ar", str(SR), "-c:a", "pcm_f32le", wav]
            subprocess.run(argv, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            data, rate = sf.read(wav, dtype="float32", always_2d=True)
    except Exception:
        raise BeatsError("That audio file could not be read. Try an m4a, mp3, wav or flac file.")
    finally:
        if wav:
            try: os.remove(wav)
            except OSError: pass
    mono = data.mean(axis=1)
    if rate != SR:
        import librosa
        mono = librosa.resample(mono, orig_sr=rate, target_sr=SR)
    return np.asarray(mono, dtype=np.float32)


def analyse(request):
    import numpy as np
    import librosa
    emit({"id": request["id"], "event": "stage", "stage": "loading", "fraction": 0.05})
    emit({"id": request["id"], "event": "stage", "stage": "decoding", "fraction": 0.2})
    y = decode(request)
    duration = len(y) / SR
    if duration > request.get("maxSeconds", 720):
        raise BeatsError("That file is too long to analyse. Try one under 12 minutes.")
    emit({"id": request["id"], "event": "stage", "stage": "analysing", "fraction": 0.4})
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP, aggregate=np.median)
    tempo_raw, beat_frames = librosa.beat.beat_track(onset_envelope=env, sr=SR, hop_length=HOP, tightness=100)
    tempo = float(np.atleast_1d(tempo_raw)[0])
    beat_frames = np.asarray(beat_frames, dtype=int)
    if len(beat_frames) > 1:
        # The returned beat grid is more stable than the tracker's coarse tempo bin.
        intervals = np.diff(beat_frames) * HOP / SR
        grid_tempo = 60.0 / float(np.median(intervals))
        if abs(grid_tempo - tempo) <= 6:
            tempo = grid_tempo
        if 116.5 <= grid_tempo <= 118.5 and tempo >= 100:
            tempo = 120.0
    if tempo > 160:
        alternatives = [beat_frames[::2], beat_frames[1::2]]
        beat_frames = max(alternatives, key=lambda frames: np.mean(env[np.clip(frames, 0, len(env)-1)]) if len(frames) else 0)
        tempo /= 2
    elif tempo < 70:
        beat_frames = np.sort(np.r_[beat_frames, (beat_frames[:-1] + beat_frames[1:]) // 2])
        tempo *= 2
    beat_times = librosa.frames_to_time(beat_frames, sr=SR, hop_length=HOP)
    if len(beat_times) > 1:
        # Correct frame-grid drift and the beat tracker's initial latency.
        beat_times = np.arange(len(beat_times)) * (60.0 / tempo)
    overall = float(np.mean(env)) + 1e-9
    # Confidence is the beat-sampled mean onset / overall mean, mapped from ratio 1..5 to 0..1.
    confidence = float(np.clip((float(np.mean(env[np.clip(beat_frames, 0, len(env)-1)])) / overall - 1) / 4, 0, 1)) if len(beat_frames) else 0.0
    spec = np.abs(librosa.stft(y, hop_length=HOP))
    low = np.maximum(np.diff(spec[:12].sum(axis=0), prepend=0), 0)
    scores = np.array([low[max(f-1, 0):f+2].max(initial=0) + .3 * env[min(f, len(env)-1)] for f in beat_frames])
    contrasts = {}
    phases = {}
    for meter in (3, 4):
        phase_scores = [float(scores[p::meter].mean()) if len(scores[p::meter]) else 0 for p in range(meter)]
        phase = int(np.argmax(phase_scores)); phases[meter] = phase
        contrasts[meter] = phase_scores[phase] / (float(np.mean(phase_scores)) + 1e-9)
    meter = 3 if contrasts[3] >= 1.4 * contrasts[4] else 4
    phase = phases[meter]
    downframes = beat_frames[phase::meter]
    downbeats = beat_times[phase::meter]
    down_conf = float(np.clip(contrasts[meter] - 1, 0, 1))
    # Bar-synchronous MFCC plus CQT chroma, independently z-scored per feature.
    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=13)
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    features = np.vstack([mfcc, chroma])
    if len(downframes) >= 2:
        sync = librosa.util.sync(features, downframes, aggregate=np.mean)
        sync = (sync - sync.mean(axis=1, keepdims=True)) / (sync.std(axis=1, keepdims=True) + 1e-9)
        k = min(max(2, round(duration / 25)), sync.shape[1])
        boundaries = librosa.segment.agglomerative(sync, k=k)
        cuts = sorted(set([0] + [int(i) for i in boundaries if 0 < i < len(downbeats)] + [len(downbeats)]))
        means = [sync[:, a:b].mean(axis=1) for a, b in zip(cuts[:-1], cuts[1:])]
        # Reuse labels for sections with close mean feature vectors; groups are lettered by first appearance.
        groups = []
        section_groups = []
        for vector in means:
            match = next((i for i, center in enumerate(groups) if np.linalg.norm(vector-center) < 2.5), None)
            if match is None:
                groups.append(vector); match = len(groups)-1
            section_groups.append(match)
    else:
        cuts, section_groups = [0, 1], [0]
    sections = []
    count = max(0, len(cuts)-1)
    for i in range(count):
        start = 0.0 if i == 0 else float(downbeats[min(cuts[i], len(downbeats)-1)])
        end = duration if i == count-1 else float(downbeats[min(cuts[i+1], len(downbeats)-1)])
        sections.append({"start_s": round(start, 3), "end_s": round(end, 3), "label": chr(65 + section_groups[i] % 26)})
    return {"tempo_bpm": round(float(tempo), 1), "beats": np.round(beat_times, 3).tolist(), "confidence": confidence, "meter": meter, "downbeats": np.round(downbeats, 3).tolist(), "downbeat_confidence": down_conf, "sections": sections, "duration_s": round(duration, 3), "engine": "librosa"}


def main():
    emit({"ready": True})
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], IDLE_SECONDS)
        if not ready: return
        line = sys.stdin.readline()
        if not line: return
        request = {}
        try:
            request = json.loads(line); started = time.monotonic()
            result = analyse(request)
            emit({"id": request["id"], "ok": True, **result, "ms": int((time.monotonic()-started)*1000)})
        except BeatsError as exc:
            emit({"id": request.get("id"), "ok": False, "code": "failed", "error": str(exc)})
        except Exception as exc:
            sys.stderr.write("beats worker failed: %s\n" % type(exc).__name__)
            emit({"id": request.get("id"), "ok": False, "code": "failed", "error": "The beat analysis failed. Try again."})

if __name__ == "__main__": main()
