import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from scipy.signal import lfilter

sys.path.insert(0, os.path.dirname(__file__))
import mlx_tts_server as server

SR = 24000


def make_voiced_signal(f0=150.0, duration=1.5):
    """Glottal-like harmonic series at f0 passed through two formant resonators."""
    n = int(SR * duration)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for h in range(1, 200):
        freq = f0 * h
        if freq >= SR / 2:
            break
        sig += np.sin(2 * np.pi * freq * t) / h
    sig /= np.max(np.abs(sig))
    r_pole = 0.97
    for f_formant in [700.0, 1500.0]:
        w = 2 * np.pi * f_formant / SR
        a = [1.0, -2 * r_pole * np.cos(w), r_pole ** 2]
        sig = lfilter([1.0], a, sig)
    sig /= np.max(np.abs(sig))
    return sig.astype(np.float32)


def f0_of(signal):
    """Pitch by autocorrelation over the middle second, parabolic interpolation."""
    n = len(signal)
    mid = n // 2
    seg = signal[mid - SR // 2:mid + SR // 2].astype(np.float64)
    seg -= np.mean(seg)
    n_fft = 2 ** int(np.ceil(np.log2(2 * len(seg))))
    F = np.fft.rfft(seg, n_fft)
    ac = np.fft.irfft(F * np.conj(F), n_fft)[: len(seg)]
    lag_min = int(SR / 400)
    lag_max = min(int(SR / 60), len(ac) - 1)
    ac_s = ac[lag_min:lag_max + 1]
    peak = int(np.argmax(ac_s))
    if 0 < peak < len(ac_s) - 1:
        a, b, c = ac_s[peak - 1], ac_s[peak], ac_s[peak + 1]
        denom = 2 * (2 * b - a - c)
        vertex = (a - c) / denom if denom != 0 else 0.0
        peak_lag = peak + vertex
    else:
        peak_lag = float(peak)
    return SR / (lag_min + peak_lag)


def formant_peak(signal):
    """Largest peak of the smoothed spectral envelope between 400 and 2500 Hz: the power spectrum averaged over 2048-sample
    frames, then cepstral liftering (first 40 quefrencies) so the harmonics fall away and only the resonances stay."""
    seg = signal[len(signal) // 4:3 * len(signal) // 4].astype(np.float64)
    frames = np.stack([seg[i:i + 2048] * np.hanning(2048) for i in range(0, len(seg) - 2048, 512)])
    power = np.mean(np.abs(np.fft.rfft(frames, axis=1)) ** 2, axis=0)
    cep = np.fft.irfft(np.log(power + 1e-12), 2048)
    cep[40:2048 - 40 + 1] = 0.0
    env = np.fft.rfft(cep).real
    freqs = np.fft.rfftfreq(2048, 1.0 / SR)
    return freqs[int(np.argmax(np.where((freqs >= 400) & (freqs <= 2500), env, -np.inf)))]


class TestPitchShift(unittest.TestCase):
    def test_zero_shift_returns_input_unchanged(self):
        x = make_voiced_signal()
        self.assertIs(server.pitch_shift(x, SR, 0.0), x)

    def test_minus_one_semitone_lowers_pitch_by_one_semitone(self):
        x = make_voiced_signal(f0=150.0)
        out = server.pitch_shift(x, SR, -1.0)
        ratio = f0_of(out) / f0_of(x)
        expected = 2 ** (-1 / 12)
        self.assertAlmostEqual(ratio, expected, delta=0.03)

    def test_plus_two_semitones_raises_pitch(self):
        x = make_voiced_signal(f0=150.0)
        out = server.pitch_shift(x, SR, 2.0)
        ratio = f0_of(out) / f0_of(x)
        expected = 2 ** (2 / 12)
        self.assertAlmostEqual(ratio, expected, delta=0.03)

    def test_formants_stay_put(self):
        x = make_voiced_signal(f0=150.0)
        f_in = formant_peak(x)
        for semitones in [-1.0, 2.0]:
            out = server.pitch_shift(x, SR, semitones)
            f_out = formant_peak(out)
            self.assertAlmostEqual(f_out, f_in, delta=0.06 * f_in)

    def test_length_is_kept(self):
        x = make_voiced_signal()
        out = server.pitch_shift(x, SR, -1.0)
        self.assertLessEqual(abs(len(out) - len(x)), 512)

    def test_output_is_finite_and_in_range(self):
        x = make_voiced_signal()
        out = server.pitch_shift(x, SR, 2.0)
        self.assertTrue(np.all(np.isfinite(out)))
        self.assertLessEqual(float(np.max(np.abs(out))), 1.0)


class ReferenceClipTests(unittest.TestCase):
    class FakeModel:
        sample_rate = 24000

        def __init__(self):
            self._conds = "default"
            self.prepared = []
            self.generated = []
            self.prepare_count = 0
            self.raise_generate = False

        def prepare_conditionals(self, path):
            self.prepared.append(path)
            self.prepare_count += 1
            self._conds = f"conds-{self.prepare_count}"

        def generate(self, text, stream, streaming_interval, **kwargs):
            self.generated.append((kwargs, self._conds))
            if self.raise_generate:
                raise RuntimeError("generation failed")
            yield type("Result", (), {"audio": np.array([0.1, 0.2], dtype=np.float32)})()
            yield type("Result", (), {"audio": np.array([0.3], dtype=np.float32)})()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = server.ChatterboxTurbo.__new__(server.ChatterboxTurbo)
        self.engine.model = self.FakeModel()
        self.engine.sample_rate = 24000
        self.engine.default_conds = "default"
        self.engine.clips = __import__("collections").OrderedDict()
        self.engine.clip_dir = self.temp.name
        self.engine.cloner_ready = True
        self.current_clip = b"RIFF\0\0\0\0WAVEclip-a"
        self.seconds = 10.0
        self.engine.fetch_clip = lambda _address: self.current_clip
        self.engine.clip_seconds = lambda _path: self.seconds

    def tearDown(self):
        self.temp.cleanup()

    def run_stream(self, voice="http://home/clip", **kwargs):
        return list(self.engine.stream("hello", voice, **kwargs))

    def test_temperature_passed_only_when_given(self):
        self.run_stream(voice=None, temperature=1.05)
        self.assertEqual(self.engine.model.generated[-1][0], {"temperature": 1.05})
        self.run_stream(voice=None)
        self.assertNotIn("temperature", self.engine.model.generated[-1][0])

    def test_clip_conditioning_restored_after_job_and_error(self):
        self.run_stream()
        self.assertEqual(self.engine.model.generated[-1][1], "conds-1")
        self.assertEqual(self.engine.model._conds, "default")
        self.engine.model.raise_generate = True
        with self.assertRaises(RuntimeError):
            self.run_stream()
        self.assertEqual(self.engine.model._conds, "default")

    def test_clip_cache_reuses_and_distinguishes_bytes(self):
        self.run_stream()
        self.run_stream()
        self.assertEqual(len(self.engine.model.prepared), 1)
        self.current_clip = b"RIFF\0\0\0\0WAVEclip-b"
        self.run_stream()
        self.assertEqual(len(self.engine.model.prepared), 2)

    def test_ninth_clip_drops_least_recently_used(self):
        for i in range(8):
            self.current_clip = b"RIFF\0\0\0\0WAVE" + f"clip-{i}".encode()
            self.run_stream()
        self.current_clip = b"RIFF\0\0\0\0WAVEclip-1"
        self.run_stream()  # make the first entry recently used
        self.current_clip = b"RIFF\0\0\0\0WAVEclip-8"
        self.run_stream()
        self.assertEqual(len(self.engine.clips), 8)
        self.current_clip = b"RIFF\0\0\0\0WAVEclip-0"
        self.run_stream()
        self.assertEqual(len(self.engine.model.prepared), 10)

    def test_clip_duration_out_of_range_refuses_before_preparation(self):
        for seconds in (5.0, 31.0):
            self.seconds = seconds
            with self.assertRaises(server.ClipError) as caught:
                self.run_stream()
            self.assertIn("6 to 30 seconds", str(caught.exception))
            self.assertIn(f"{seconds:.1f}", str(caught.exception))
        self.assertEqual(self.engine.model.prepared, [])

    def test_pitch_zero_bypasses_shift_and_nonzero_shifts_once(self):
        with patch.object(server, "pitch_shift", side_effect=AssertionError("called")):
            chunks = self.run_stream(voice=None, pitch=0.0)
        self.assertEqual(len(chunks), 2)
        seen = []
        shifted = np.array([0.7], dtype=np.float32)

        def shift(audio, sample_rate, semitones):
            seen.append((audio.copy(), sample_rate, semitones))
            return shifted

        with patch.object(server, "pitch_shift", side_effect=shift):
            chunks = self.run_stream(voice=None, pitch=-1.0)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1:], (24000, -1.0))
        np.testing.assert_array_equal(seen[0][0], np.array([0.1, 0.2, 0.3], dtype=np.float32))
        self.assertEqual(len(chunks), 1)
        np.testing.assert_array_equal(chunks[0], shifted)

    def test_missing_cloner_weights_refuses(self):
        self.engine.cloner_ready = False
        with patch.dict(sys.modules, {"huggingface_hub": type("Hub", (), {
            "hf_hub_download": staticmethod(lambda *args, **kwargs: (_ for _ in ()).throw(OSError("missing")))
        })()}):
            with self.assertRaises(server.ClipError) as caught:
                self.run_stream()
        self.assertIn("Voice cloning is not ready", str(caught.exception))

    def test_parse_job_fields_ranges_and_missing_values(self):
        for value in ("0.05", "2.5", "abc"):
            with self.assertRaises(server.ClipError) as caught:
                server.parse_job_fields({"temperature": value})
            self.assertEqual(str(caught.exception), "The sampling temperature must be a number from 0.1 to 2.0.")
        for value in ("13", "-13"):
            with self.assertRaises(server.ClipError) as caught:
                server.parse_job_fields({"pitch_semitones": value})
            self.assertEqual(str(caught.exception), "The pitch offset must be a number from -12 to 12 semitones.")
        self.assertEqual(server.parse_job_fields({"temperature": "0.1", "pitch_semitones": "-12"}), (0.1, -12.0))
        self.assertEqual(server.parse_job_fields({"temperature": "2.0", "pitch_semitones": "12"}), (2.0, 12.0))
        self.assertEqual(server.parse_job_fields({"temperature": "", "pitch_semitones": ""}), (None, 0.0))
        self.assertEqual(server.parse_job_fields({}), (None, 0.0))


class ClipFormatTests(unittest.TestCase):
    def test_extension_is_read_from_the_bytes(self):
        self.assertEqual(server.clip_extension(b"RIFF\0\0\0\0WAVEfmt "), "wav")
        self.assertEqual(server.clip_extension(b"fLaC\0\0"), "flac")
        self.assertEqual(server.clip_extension(b"ID3\4\0"), "mp3")
        self.assertEqual(server.clip_extension(b"\xff\xfb\x90\x00"), "mp3")

    def test_formats_that_need_ffmpeg_are_refused(self):
        for data in (b"OggS\0\2", b"\x1aE\xdf\xa3webm", b"\0\0\0\x20ftypM4A "):
            self.assertIsNone(server.clip_extension(data))


if __name__ == "__main__":
    unittest.main()
