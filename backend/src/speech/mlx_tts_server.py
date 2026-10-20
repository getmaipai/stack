#!/usr/bin/env python3
"""The Stack's MLX voice engine (VOICE-STUDIO-01): one small server that speaks
the same wire as Pocket TTS, so Home's voice session needs no change.

  GET  /health   {"status": "ok"} once the model is loaded AND primed (the first
                 synthesis compiles kernels and costs 6 to 14 s; "ok" never
                 means a cold engine), {"status": "loading"} with 503 before.
  GET  /tags     {"engine": ..., "tags": [...]} the tags the engine honors.
  POST /tts      multipart form: text (required), voice_url (optional). The reply
                 is chunked audio/wav, 24 kHz mono 16-bit, the header written with
                 the placeholder data size Pocket TTS writes, then PCM as it is
                 generated (first chunk about 0.45 s on an M5 Max).

Engines are classes in ENGINES; a second MLX voice (Orpheus) is one more class
with `load`, `stream` and the `tags` list. Runs offline: the Stack placed every
file in the hub cache and sets HF_HUB_OFFLINE=1. All MLX work happens on one
worker thread (MLX streams are per thread); the HTTP threads only queue jobs
and write chunks, so /health answers while a synthesis runs.
"""
import argparse
import collections
import hashlib
import json
import os
import queue
import struct
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

SAMPLE_RATE = 24000
STREAM_INTERVAL_SECONDS = 1.0
PRIME_TEXT = "Hello there. This is the voice, warming up."
MAX_CLIP_BYTES = 20 * 1024 * 1024


class ClipError(Exception):
    """A reference voice request the person can fix and retry."""


def wav_header(sample_rate: int) -> bytes:
    """A streaming WAV header: the data size is a placeholder, as Pocket TTS writes."""
    return (b"RIFF" + struct.pack("<I", 2_000_000_036) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
            + b"data" + struct.pack("<I", 2_000_000_000))


def to_pcm16(samples) -> bytes:
    audio = np.asarray(samples, dtype=np.float32).reshape(-1)
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def pitch_shift(audio, sample_rate: int, semitones: float):
    """Shift the pitch of mono float audio by `semitones` (negative lowers), keeping the formants (the vocal-tract
    resonances) where they were, so a voice sounds like the same person at another pitch. Same length as the input."""
    if abs(semitones) <= 0.001:
        return audio
    from fractions import Fraction
    from scipy.signal import resample_poly

    x = np.asarray(audio, dtype=np.float64).reshape(-1)
    n = len(x)
    n_fft, hop, lifter = 2048, 512, 40
    half = n_fft // 2 + 1
    ratio = 2.0 ** (semitones / 12.0)
    window = np.hanning(n_fft + 1)[:n_fft]
    expected = 2.0 * np.pi * np.arange(half) * hop / n_fft  # phase a bin advances per hop

    def stft(signal):
        padded = np.concatenate([np.zeros(n_fft // 2), signal, np.zeros(n_fft)])
        count = (len(padded) - n_fft) // hop + 1
        index = np.arange(n_fft)[None, :] + hop * np.arange(count)[:, None]
        return np.fft.rfft(padded[index] * window, axis=1)

    def istft(spectrum, length):
        count = spectrum.shape[0]
        out = np.zeros(hop * (count - 1) + n_fft)
        weight = np.zeros_like(out)
        frames = np.fft.irfft(spectrum, n_fft, axis=1) * window
        for m in range(count):
            out[m * hop:m * hop + n_fft] += frames[m]
            weight[m * hop:m * hop + n_fft] += window ** 2
        out = out / np.maximum(weight, 1e-8)
        return out[n_fft // 2:n_fft // 2 + length]

    def envelope(spectrum):
        # Cepstral liftering: keeping only the first quefrencies leaves the smooth resonance shape, not the harmonics.
        log_mag = np.log(np.abs(spectrum) + 1e-10)
        cepstrum = np.fft.irfft(log_mag, n_fft, axis=1)
        cepstrum[:, lifter:n_fft - lifter + 1] = 0.0
        return np.exp(np.fft.rfft(cepstrum, axis=1).real)

    # Phase-vocoder time stretch by `ratio`, then play it back `ratio` times faster: the pitch moves by `ratio`, the length returns.
    source = stft(x)
    frames_in = source.shape[0]
    stretched_len = int(round(n * ratio))
    frames_out = max(2, stretched_len // hop + 2)
    spectrum = np.empty((frames_out, half), dtype=np.complex128)
    phase = np.angle(source[0])
    for m in range(frames_out):
        position = min(m / ratio, frames_in - 1.0001)
        a = int(position)
        frac = position - a
        magnitude = (1.0 - frac) * np.abs(source[a]) + frac * np.abs(source[a + 1])
        if m:
            delta = np.angle(source[a + 1]) - np.angle(source[a]) - expected
            phase = phase + expected + (delta + np.pi) % (2.0 * np.pi) - np.pi
        spectrum[m] = magnitude * np.exp(1j * phase)
    stretched = istft(spectrum, stretched_len)
    fraction = Fraction(ratio).limit_denominator(1000)
    shifted = resample_poly(stretched, fraction.denominator, fraction.numerator)
    shifted = np.pad(shifted, (0, max(0, n - len(shifted))))[:n]

    # Put the original resonances back: scale each frame so its smooth envelope matches the original's at the same moment.
    moved = stft(shifted)
    gain = np.clip(envelope(source[:moved.shape[0]]) / envelope(moved[:source.shape[0]]), 0.25, 4.0)
    count = min(len(gain), moved.shape[0])
    moved[:count] *= gain[:count]
    out = istft(moved, n)
    return np.clip(out, -1.0, 1.0).astype(np.float32)


class ChatterboxTurbo:
    """Chatterbox Turbo 350M through the mlx-audio port (MIT code; the weights card
    says Apache-2.0, upstream MIT). Tags are plain bracketed words in the text."""
    id = "chatterbox-turbo"
    # The tags the tokenizer knows AND the model renders as sound (measured, see
    # docs/design/studio-voice-2026-10-17.md); the Stack reads this list, never guesses.
    tags = ["[laugh]", "[chuckle]", "[cough]", "[sigh]", "[clear throat]", "[gasp]"]

    def load(self, repo: str) -> None:
        from mlx_audio.tts.utils import load_model
        self.model = load_model(repo)
        self.sample_rate = int(getattr(self.model, "sample_rate", SAMPLE_RATE))
        self.default_conds = getattr(self.model, "_conds", None)
        self.clips = collections.OrderedDict()
        self.clip_dir = tempfile.mkdtemp(prefix="mlx-tts-clips-")
        self.cloner_ready = self.cloner_in_cache()

    def cloner_in_cache(self) -> bool:
        try:
            from huggingface_hub import try_to_load_from_cache
            return isinstance(try_to_load_from_cache("mlx-community/S3TokenizerV2", "model.safetensors"), str)
        except Exception:
            return False

    def ensure_tokenizer(self) -> None:
        if self.cloner_ready:
            return
        try:
            from huggingface_hub import hf_hub_download
            import mlx.core as mx
            path = hf_hub_download("mlx-community/S3TokenizerV2", "model.safetensors", local_files_only=True)
            weights = mx.load(path)
            if hasattr(self.model._s3tokenizer, "sanitize"):
                weights = self.model._s3tokenizer.sanitize(weights)
            self.model._s3tokenizer.load_weights(list(weights.items()), strict=False)
            mx.eval(self.model._s3tokenizer.parameters())
            self.cloner_ready = True
        except Exception as error:
            raise ClipError("Voice cloning is not ready: the speech helper file is missing. Restart the voice engine, then try the voice again.") from error

    def fetch_clip(self, address: str) -> bytes:
        try:
            with urllib.request.urlopen(address, timeout=15) as response:
                data = response.read(MAX_CLIP_BYTES + 1)
        except (urllib.error.URLError, OSError) as error:
            raise ClipError("The reference recording could not be fetched from Home. Check that Home is running, then try the voice again.") from error
        if not data:
            raise ClipError("The reference recording is empty. Choose a recording between 6 and 30 seconds long.")
        if len(data) > MAX_CLIP_BYTES:
            raise ClipError("The reference recording is too large. Choose a recording under 20 MB.")
        return data

    def clip_seconds(self, path: str) -> float:
        from mlx_audio.utils import load_audio
        return len(load_audio(path, sample_rate=SAMPLE_RATE)) / SAMPLE_RATE

    def stream(self, text: str, voice: str | None, temperature: float | None = None, pitch: float = 0.0):
        try:
            if voice and (voice.startswith("http://") or voice.startswith("https://")):
                data = self.fetch_clip(voice)
                key = hashlib.sha256(data).hexdigest()
                if key in self.clips:
                    self.clips.move_to_end(key)
                else:
                    path = os.path.join(self.clip_dir, key)
                    with open(path, "wb") as clip_file:
                        clip_file.write(data)
                    seconds = self.clip_seconds(path)
                    if seconds < 6.0 or seconds > 30.0:
                        raise ClipError(f"The reference recording must be 6 to 30 seconds long; this one is {seconds:.1f} seconds.")
                    self.ensure_tokenizer()
                    self.model.prepare_conditionals(path)
                    self.clips[key] = self.model._conds
                    if len(self.clips) > 8:
                        self.clips.popitem(last=False)
                self.model._conds = self.clips[key]

            generate_options = {"text": text, "stream": True, "streaming_interval": STREAM_INTERVAL_SECONDS}
            if temperature is not None:
                generate_options["temperature"] = temperature
            if abs(pitch) < 0.001:
                for result in self.model.generate(**generate_options):
                    yield np.array(result.audio).reshape(-1)
            else:
                chunks = [np.array(result.audio).reshape(-1) for result in self.model.generate(**generate_options)]
                audio = np.concatenate(chunks) if chunks else np.array([], dtype=np.float32)
                yield pitch_shift(audio, self.sample_rate, pitch)
        finally:
            self.model._conds = self.default_conds


ENGINES = {ChatterboxTurbo.id: ChatterboxTurbo}


class Job:
    def __init__(self, text: str, voice: str | None, temperature: float | None = None, pitch: float = 0.0):
        self.text = text
        self.voice = voice
        self.temperature = temperature
        self.pitch = pitch
        self.out: "queue.Queue" = queue.Queue()
        self.cancelled = threading.Event()


JOBS: "queue.Queue[Job | None]" = queue.Queue()
STATE = {"ready": False, "engine": None, "error": None}


def release_cache() -> None:
    """Hand MLX's buffer cache back after a synthesis so the process footprint the
    Stack's governor watches stays near the weights, not the largest request seen."""
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:
        pass


def worker(engine_id: str, repo: str) -> None:
    try:
        engine = ENGINES[engine_id]()
        started = time.time()
        engine.load(repo)
        loaded = time.time()
        for _ in engine.stream(PRIME_TEXT, None):
            pass
        print(f"mlx-tts: {engine_id} loaded in {loaded - started:.1f}s, primed in {time.time() - loaded:.1f}s", file=sys.stderr, flush=True)
        STATE["engine"] = engine
        STATE["ready"] = True
    except Exception as error:  # the Stack reads stderr when the process exits before health
        STATE["error"] = f"{type(error).__name__}: {error}"
        print(f"mlx-tts: could not start: {STATE['error']}", file=sys.stderr, flush=True)
        os._exit(3)  # the Stack sees the exit before health and reads this line
    while True:
        job = JOBS.get()
        if job is None:
            return
        try:
            for chunk in engine.stream(job.text, job.voice, job.temperature, job.pitch):
                if job.cancelled.is_set():
                    break
                job.out.put(to_pcm16(chunk))
            job.out.put(None)
        except Exception as error:
            job.out.put(error)
        release_cache()


def read_form(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length") or 0)
    body = handler.rfile.read(length) if length else b""
    kind = handler.headers.get("Content-Type", "")
    if kind.startswith("application/json"):
        return json.loads(body or b"{}")
    if kind.startswith("multipart/form-data"):
        message = BytesParser(policy=HTTP).parsebytes(b"Content-Type: " + kind.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
        fields = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if name:
                fields[name] = part.get_payload(decode=True).decode("utf-8", "replace")
        return fields
    from urllib.parse import parse_qs
    return {key: values[0] for key, values in parse_qs(body.decode("utf-8", "replace")).items()}


def parse_job_fields(form: dict) -> tuple[float | None, float]:
    temperature_value = form.get("temperature")
    temperature = None
    if temperature_value is not None and str(temperature_value).strip():
        try:
            temperature = float(temperature_value)
        except (TypeError, ValueError):
            temperature = None
        if temperature is None or not 0.1 <= temperature <= 2.0:
            raise ClipError("The sampling temperature must be a number from 0.1 to 2.0.")
    pitch_value = form.get("pitch_semitones")
    pitch = 0.0
    if pitch_value is not None and str(pitch_value).strip():
        try:
            pitch = float(pitch_value)
        except (TypeError, ValueError):
            pitch = None
        if pitch is None or not -12.0 <= pitch <= 12.0:
            raise ClipError("The pitch offset must be a number from -12 to 12 semitones.")
    return temperature, pitch


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:
        pass

    def reply_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_GET(self) -> None:
        if self.path == "/health":
            if STATE["ready"]:
                return self.reply_json(200, {"status": "ok", "cloning": bool(STATE["engine"].cloner_ready)})
            return self.reply_json(503, {"status": "loading" if not STATE["error"] else "failed", "error": STATE["error"]})
        if self.path == "/tags":
            engine = STATE["engine"]
            return self.reply_json(200, {"engine": engine.id if engine else None, "tags": engine.tags if engine else []})
        self.reply_json(404, {"detail": "Not found."})

    def do_POST(self) -> None:
        if self.path != "/tts":
            return self.reply_json(404, {"detail": "Not found."})
        if not STATE["ready"]:
            return self.reply_json(503, {"detail": "The voice engine is still loading."})
        try:
            form = read_form(self)
        except Exception as error:
            return self.reply_json(400, {"detail": f"The request could not be read: {error}"})
        text = str(form.get("text") or "").strip()
        if not text:
            return self.reply_json(400, {"detail": "text is required."})
        try:
            temperature, pitch = parse_job_fields(form)
        except ClipError as error:
            return self.reply_json(400, {"detail": str(error)})
        voice = form.get("voice_url") or None
        if voice and not (str(voice).startswith("http://") or str(voice).startswith("https://")):
            voice = None
        job = Job(text, voice, temperature, pitch)
        JOBS.put(job)
        first = job.out.get()
        if isinstance(first, Exception):
            status = 400 if isinstance(first, ClipError) else 500
            detail = str(first) if isinstance(first, ClipError) else f"{type(first).__name__}: {first}"
            return self.reply_json(status, {"detail": detail})
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def write(data: bytes) -> None:
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        try:
            write(wav_header(STATE["engine"].sample_rate))
            item = first
            while item is not None and not isinstance(item, Exception):
                write(item)
                item = job.out.get()
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            job.cancelled.set()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--engine", default=ChatterboxTurbo.id, choices=sorted(ENGINES))
    parser.add_argument("--repo", required=True, help="the Hugging Face repository the Stack placed in the hub cache")
    args = parser.parse_args()
    threading.Thread(target=worker, args=(args.engine, args.repo), daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
