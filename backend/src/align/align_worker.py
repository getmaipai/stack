"""One cold-start forced-alignment worker (torchaudio MMS_FA). JSON-lines on stdin/stdout.

Known lyrics plus an audio file in, one {t, end, text} per word out. Only the alignment lives here:
no anchor filtering, interpolation or LRCLIB reconcile (Home does those). Lyric text never reaches
a log line, stderr or an error message: every failure is reported by a fixed sentence.
"""
import hashlib
import json
import os
import select
import subprocess
import sys
import time
import unicodedata

IDLE_SECONDS = 60


class AlignError(Exception):
    """A failure with a fixed, lyric-free sentence the caller may show."""


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def background_argv(argv):
    if os.path.exists("/usr/sbin/taskpolicy"):
        return ["/usr/sbin/taskpolicy", "-b", *argv]
    return argv


def normalize_word(word):
    """Fold a lyric word to the aligner's latin set: strip accents, lowercase, keep a-z and the apostrophe.
    Returns '' for a word that does not survive (punctuation, notes, other scripts)."""
    decomposed = unicodedata.normalize("NFKD", word)
    kept = []
    for ch in decomposed.lower():
        if unicodedata.combining(ch):
            continue
        if ("a" <= ch <= "z") or ch == "'":
            kept.append(ch)
    return "".join(kept).strip("'")


def split_lyrics(text):
    """Returns (transcript, raw_tokens, line_starts). line_starts has one entry per source line:
    the index of its first word, or -1 for a line with no alignable word."""
    transcript, raw_tokens, line_starts = [], [], []
    for line in text.split("\n"):
        first = -1
        for token in line.split():
            norm = normalize_word(token)
            if norm:
                if first < 0:
                    first = len(transcript)
                transcript.append(norm)
                raw_tokens.append(token)
        line_starts.append(first)
    return transcript, raw_tokens, line_starts


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def decode_mono_16k(request, work_dir):
    """ffmpeg converts any container (m4a, mp3, flac, wav) to a 16 kHz mono wav first; soundfile reads that."""
    import soundfile
    wav_path = os.path.join(work_dir, "align-%s.wav" % request["id"])
    argv = [request["ffmpeg"], "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", request["source"]]
    if request.get("maxSeconds"):
        argv += ["-t", str(request["maxSeconds"] + 1)]
    argv += ["-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le", wav_path]
    try:
        subprocess.run(background_argv(argv), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        data, rate = soundfile.read(wav_path, dtype="float32", always_2d=True)
    except Exception:
        raise AlignError("That audio file could not be read. Try an m4a, mp3, wav or flac file.")
    finally:
        try:
            os.remove(wav_path)
        except OSError:
            pass
    return data.mean(axis=1), rate


def run(request):
    import numpy as np
    import torch
    import torchaudio

    emit({"id": request["id"], "event": "stage", "stage": "loading", "fraction": 0.05})
    if sha256_of(request["modelPath"]) != request["modelHash"]:
        raise AlignError("The pinned alignment model failed verification. Reinstall it from Home's Engines page.")
    transcript, raw_tokens, line_starts = split_lyrics(request["lyrics"])
    total_words = len(transcript)
    if total_words == 0:
        raise AlignError("The lyrics have no words the aligner can use. Send lyrics in the Latin alphabet.")
    samples, rate = decode_mono_16k(request, request["workDir"])
    max_seconds = request.get("maxSeconds")
    if max_seconds and len(samples) / rate > max_seconds:
        raise AlignError("That file is too long to align. Try one under %d minutes." % (max_seconds // 60))
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)  # reads TORCH_HOME/hub/checkpoints/model.pt, no network
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    model.eval()
    waveform = torch.from_numpy(np.ascontiguousarray(samples)).unsqueeze(0)
    emit({"id": request["id"], "event": "stage", "stage": "aligning", "fraction": 0.3})
    with torch.inference_mode():
        emission, _ = model(waveform)
        spans = aligner(emission[0], tokenizer(transcript))
    ratio = (waveform.size(1) / emission.size(1)) / bundle.sample_rate
    words, index_of = [], {}
    for global_index, word_spans in enumerate(spans):
        if global_index < total_words and word_spans:
            index_of[global_index] = len(words)
            words.append({"t": round(float(word_spans[0].start) * ratio, 3), "end": round(float(word_spans[-1].end) * ratio, 3), "text": raw_tokens[global_index]})
    if not words:
        raise AlignError("The aligner could not place any of the words in this audio.")
    # line_starts is relative to the words list; a line whose first word was not placed takes its next placed word, or -1.
    mapped = []
    for start in line_starts:
        if start < 0:
            mapped.append(-1)
            continue
        probe = start
        while probe < total_words and probe not in index_of:
            probe += 1
        mapped.append(index_of.get(probe, -1))
    return {"words": words, "aligned_words": len(words), "total_words": total_words, "line_starts": mapped}


def main():
    emit({"ready": True})
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], IDLE_SECONDS)
        if not ready:
            return
        line = sys.stdin.readline()
        if not line:
            return
        request = {}
        try:
            request = json.loads(line)
            started = time.monotonic()
            result = run(request)
            emit({"id": request["id"], "ok": True, **result, "ms": int((time.monotonic() - started) * 1000)})
        except AlignError as exc:
            emit({"id": request.get("id"), "ok": False, "code": "failed", "error": str(exc)})
        except Exception as exc:
            # Never the exception text: it can quote a lyric word. The class name is enough to find the cause.
            sys.stderr.write("align worker failed: %s\n" % type(exc).__name__)
            emit({"id": request.get("id"), "ok": False, "code": "failed", "error": "The alignment failed (%s). Try again." % type(exc).__name__})


if __name__ == "__main__":
    main()
