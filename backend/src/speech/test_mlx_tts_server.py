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



class StreamIntervalTest(unittest.TestCase):
    def test_default_is_point_six(self):
        self.assertEqual(server.DEFAULT_STREAM_INTERVAL_SECONDS, 0.6)
        self.assertEqual(server.stream_interval_from_env({}), 0.6)

    def test_env_override_and_clamp(self):
        f = lambda v: server.stream_interval_from_env({"MAIPAI_TTS_STREAM_INTERVAL_SECONDS": v})
        self.assertEqual(f("1.0"), 1.0)
        self.assertEqual(f("0.1"), 0.4)
        self.assertEqual(f("9"), 2.0)

    def test_invalid_falls_back(self):
        f = lambda v: server.stream_interval_from_env({"MAIPAI_TTS_STREAM_INTERVAL_SECONDS": v})
        for bad in ("", "fast", "nan", "inf", "-inf"):
            self.assertEqual(f(bad), 0.6, bad)

class StagedChunkTest(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(server.chunk_plan_from_env({}), (25, 50))

    def test_env_overrides_and_clamp(self):
        f = lambda a, b: server.chunk_plan_from_env({"MAIPAI_TTS_FIRST_CHUNK_TOKENS": a, "MAIPAI_TTS_LATER_CHUNK_TOKENS": b})
        self.assertEqual(f("12", "50"), (12, 50))
        self.assertEqual(f("1", "1000"), (10, 100))
        self.assertEqual(f("99", "20"), (25, 25))  # later is never below first

    def test_invalid_falls_back(self):
        f = lambda a, b: server.chunk_plan_from_env({"MAIPAI_TTS_FIRST_CHUNK_TOKENS": a, "MAIPAI_TTS_LATER_CHUNK_TOKENS": b})
        self.assertEqual(f("fast", ""), (25, 50))
        self.assertEqual(f("1.5", "nan"), (25, 50))

    def test_staged_size_ends_first_chunk_small_then_large(self):
        size = server.StagedChunkSize(12, 40)
        ends = []
        pending = 0
        for _ in range(130):
            pending += 1
            if pending >= size:
                ends.append(pending)
                pending = 0
        self.assertEqual(ends, [12, 40, 40])

    def test_wrapper_gives_every_call_a_fresh_stage(self):
        class Fake:
            def inference_turbo_stream(self, chunk_size=40, **kwargs):
                "if len(chunk_tokens) >= chunk_size:"
                return chunk_size
        t3 = Fake()
        self.assertTrue(server.install_staged_chunks(t3, 12, 40))
        a, b = t3.inference_turbo_stream(), t3.inference_turbo_stream()
        self.assertIsNot(a, b)
        self.assertFalse(11 >= a)
        self.assertTrue(12 >= a)

    def test_library_mismatch_falls_back(self):
        class Other:
            def inference_turbo_stream(self, chunk_size=40):
                return chunk_size
        t3 = Other()
        original = t3.inference_turbo_stream
        self.assertFalse(server.install_staged_chunks(t3, 12, 40))
        self.assertEqual(t3.inference_turbo_stream(), 40)
        self.assertEqual(t3.inference_turbo_stream.__func__, original.__func__)


class VoxPlanTest(unittest.TestCase):
    def test_piece_plan_starts_small_then_grows(self):
        self.assertEqual(server.VOX_SCHEDULE, (1, 2, 4))
        self.assertEqual(server.vox_piece_plan(7), [1, 2, 4])
        self.assertEqual(server.vox_piece_plan(13), [1, 2, 4, 4, 2])
        self.assertEqual(server.vox_piece_plan(1), [1])
        self.assertEqual(server.vox_piece_plan(0), [])
        self.assertEqual(sum(server.vox_piece_plan(37)), 37)

    def test_first_piece_is_one_patch_of_160_ms(self):
        self.assertAlmostEqual(server.vox_piece_plan(10)[0] * server.VOX_PATCH_SECONDS, 0.16)

    def test_timesteps_default_env_clamp_and_garbage(self):
        self.assertEqual(server.vox_timesteps_from_env({}), 6)
        self.assertEqual(server.vox_timesteps_from_env({"MAIPAI_TTS_VOX_TIMESTEPS": "8"}), 8)
        self.assertEqual(server.vox_timesteps_from_env({"MAIPAI_TTS_VOX_TIMESTEPS": "1"}), 4)
        self.assertEqual(server.vox_timesteps_from_env({"MAIPAI_TTS_VOX_TIMESTEPS": "99"}), 10)
        self.assertEqual(server.vox_timesteps_from_env({"MAIPAI_TTS_VOX_TIMESTEPS": "fast"}), 6)

    def test_runaway_limit_follows_text_length_with_a_floor(self):
        self.assertAlmostEqual(server.vox_runaway_limit_seconds("Hi."), 2.2 * 1.5)
        self.assertAlmostEqual(server.vox_runaway_limit_seconds("x" * 140), 2.2 * 10.0)

    def test_engine_is_selectable_and_chatterbox_stays_the_default(self):
        self.assertIn("voxcpm2", server.ENGINES)
        self.assertEqual(server.ChatterboxTurbo.id, "chatterbox-turbo")
        parser_default = [a for a in __import__("inspect").getsource(server.main).splitlines() if "--engine" in a][0]
        self.assertIn("ChatterboxTurbo.id", parser_default)
        self.assertEqual(server.VoxCPM2.id, "voxcpm2")


class VoxAudioTest(unittest.TestCase):
    def test_resampler_halves_48k_to_24k_across_pieces(self):
        t = np.arange(48000) / 48000
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        resample = server.Resampler(48000, 24000)
        out = np.concatenate([resample(tone[i:i + 7680]) for i in range(0, len(tone), 7680)])
        self.assertAlmostEqual(len(out), 24000, delta=4)
        peak_hz = float(np.argmax(np.abs(np.fft.rfft(out))) * SR / len(out))
        self.assertLess(abs(peak_hz - 440), 3)

    def test_resampler_same_rate_is_a_passthrough(self):
        x = np.arange(10, dtype=np.float32)
        np.testing.assert_array_equal(server.Resampler(24000, 24000)(x), x)

    def test_shaper_drops_leading_silence_and_caps_trailing(self):
        shaper = server.SpeechShaper()
        speech = make_voiced_signal(duration=0.5) * 0.3
        silence = np.zeros(SR, np.float32)
        self.assertIsNone(shaper.feed(silence))
        out = [shaper.feed(speech), shaper.feed(silence)]
        tail = shaper.finish()
        joined = np.concatenate([x for x in out + [tail] if x is not None])
        self.assertLess(len(joined), len(speech) + int(0.2 * SR))
        self.assertGreater(len(joined), len(speech) - 200)

    def test_trim_and_normalize_a_reference_clip(self):
        voiced = make_voiced_signal(duration=1.0) * 0.05
        clip = np.concatenate([np.zeros(SR, np.float32), voiced, np.zeros(SR, np.float32)])
        trimmed = server.trim_silence(clip, SR)
        self.assertLess(len(trimmed), len(voiced) + int(0.2 * SR))
        loud = server.loudness_normalize(trimmed)
        self.assertLessEqual(float(np.abs(loud).max()), 0.951)
        self.assertGreater(float(np.sqrt((loud ** 2).mean())), float(np.sqrt((trimmed ** 2).mean())))
        self.assertEqual(len(server.trim_silence(np.zeros(100, np.float32), SR)), 0)


class VoxEngineTest(unittest.TestCase):
    """The VoxCPM2 engine with the model stubbed: form handling, the reference clip with its 300 ms pause, caching, streaming."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = server.VoxCPM2.__new__(server.VoxCPM2)
        self.engine.model = object()
        self.engine.native_rate = 48000
        self.engine.sample_rate = 24000
        self.engine.timesteps = 6
        self.engine.clips = __import__("collections").OrderedDict()
        self.engine.clip_dir = self.temp.name
        self.clip = b"RIFF\0\0\0\0WAVEclip-a"
        self.engine.fetch_clip = lambda _address: self.clip
        self.seconds = 10.0
        self.engine.read_clip = lambda _path: make_voiced_signal(duration=self.seconds) * 0.2
        self.transcribed = []
        self.engine.transcribe = lambda path: self.transcribed.append(path) or "heard words"
        self.prepared = []
        self.pieces_seen = []
        self.engine.prepare = lambda audio, text: self.prepared.append((len(audio), text)) or {"text": text}
        self.native = [np.full(7680, 0.2, np.float32), np.full(15360, 0.2, np.float32)]

        def pieces(text, prepared, noise):
            self.pieces_seen.append((text, prepared, noise))
            yield from self.native
        self.engine.pieces = pieces

    def tearDown(self):
        self.temp.cleanup()

    def run_stream(self, voice="http://home/clip", **kwargs):
        return list(self.engine.stream("hello there", voice, **kwargs))

    def test_streams_24k_pieces_and_no_clip_means_zero_shot(self):
        out = self.run_stream(voice=None)
        self.assertEqual(self.pieces_seen[-1][1], None)
        self.assertEqual(self.pieces_seen[-1][2], 1.0)
        self.assertGreater(len(out), 0)
        total = sum(len(x) for x in out)
        self.assertAlmostEqual(total, 11520, delta=2200)  # 23040 native samples halve; the shaper may add up to 80 ms

    def test_form_words_are_used_and_the_clip_is_not_recognized(self):
        self.run_stream(voice_text="  the words  ")
        self.assertEqual(self.prepared[-1][1], "the words")
        self.assertEqual(self.transcribed, [])
        self.assertEqual(self.pieces_seen[-1][1], {"text": "the words"})

    def test_missing_words_are_recognized_once_and_remembered(self):
        self.run_stream()
        self.run_stream()
        self.assertEqual(len(self.transcribed), 1)
        self.assertEqual(len(self.prepared), 1)
        self.assertEqual(self.prepared[0][1], "heard words")

    def test_clip_cache_distinguishes_clips_and_words_and_keeps_eight(self):
        self.run_stream(voice_text="a")
        self.run_stream(voice_text="b")
        self.assertEqual(len(self.prepared), 2)
        for index in range(9):
            self.clip = b"RIFF\0\0\0\0WAVE" + bytes([index])
            self.run_stream(voice_text="w")
        self.assertEqual(len(self.engine.clips), 8)

    def test_clip_length_out_of_range_refuses_before_preparing(self):
        for seconds in (3.0, 45.0):
            self.seconds = seconds
            self.clip = b"RIFF\0\0\0\0WAVE" + bytes([int(seconds)])
            with self.assertRaises(server.ClipError) as caught:
                self.run_stream(voice_text="w")
            self.assertIn("6 to 30 seconds", str(caught.exception))
        self.assertEqual(self.prepared, [])

    def test_not_a_known_audio_format_is_refused(self):
        self.clip = b"not audio at all"
        with self.assertRaises(server.ClipError):
            self.run_stream(voice_text="w")

    def test_temperature_becomes_the_noise_and_unknown_voice_is_zero_shot(self):
        self.run_stream(voice="preset-name", temperature=0.7)
        self.assertEqual(self.pieces_seen[-1][1:], (None, 0.7))

    def test_runaway_audio_is_cut_at_the_limit(self):
        self.native = [np.full(48000, 0.2, np.float32)] * 6  # 3 s at 24 kHz for a 2-character text
        out = [x for x in self.engine.stream("Hi", None)]
        self.assertLessEqual(sum(len(x) for x in out), int(2.2 * 1.5 * SR) + int(0.1 * SR))

    def test_pitch_shift_buffers_then_shifts_once(self):
        calls = []
        with patch.object(server, "pitch_shift", side_effect=lambda audio, rate, semitones: calls.append((len(audio), rate, semitones)) or audio):
            out = self.run_stream(voice=None, pitch=2.0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1:], (SR, 2.0))
        self.assertEqual(len(out), 1)

    def test_generator_is_closed_when_the_listener_leaves(self):
        closed = []

        def pieces(text, prepared, noise):
            try:
                while True:
                    yield np.full(7680, 0.2, np.float32)
            finally:
                closed.append(True)
        self.engine.pieces = pieces
        stream = self.engine.stream("hello there, how are you", None)
        next(stream)
        stream.close()
        self.assertEqual(closed, [True])

    def test_pieces_builds_the_lab_call_for_zero_shot_and_for_a_clip(self):
        calls = []
        fake = type(sys)("voxcpm_stream")
        fake.stream_patches = lambda model, text, prep, **kw: calls.append((text, prep, kw)) or iter(())
        engine = server.VoxCPM2.__new__(server.VoxCPM2)
        engine.model, engine.timesteps = object(), 5
        with patch.dict(sys.modules, {"voxcpm_stream": fake}):
            engine.pieces("hi", None, 1.0)
            engine.pieces("hi", {"text": "words"}, 0.8)
        self.assertEqual(calls[0][1], {"text": ""})  # zero-shot still carries the key the loop reads
        self.assertEqual(calls[0][2]["mode"], "none")
        self.assertEqual((calls[1][2]["mode"], calls[1][2]["sep"], calls[1][2]["noise"]), ("cont", " ", 0.8))
        self.assertEqual((calls[1][2]["schedule"], calls[1][2]["timesteps"], calls[1][2]["cfg_value"]), ((1, 2, 4), 5, 2.0))


class VoxFormTest(unittest.TestCase):
    def test_job_carries_the_clip_words(self):
        job = server.Job("hi", "http://home/clip", 0.9, 1.5, "words")
        self.assertEqual((job.text, job.voice, job.temperature, job.pitch, job.voice_text), ("hi", "http://home/clip", 0.9, 1.5, "words"))
        self.assertIsNone(server.Job("hi", None).voice_text)

    def test_read_form_reads_the_words_field_from_multipart_and_json(self):
        body = b"--b\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nhello\r\n--b\r\nContent-Disposition: form-data; name=\"voice_text\"\r\n\r\nsome words\r\n--b--\r\n"

        def handler(kind, data):
            return type("H", (), {"headers": {"Content-Length": str(len(data)), "Content-Type": kind}, "rfile": __import__("io").BytesIO(data)})()
        form = server.read_form(handler("multipart/form-data; boundary=b", body))
        self.assertEqual((form["text"], form["voice_text"]), ("hello", "some words"))
        self.assertEqual(server.read_form(handler("application/json", b'{"text":"a","voice_text":"b"}'))["voice_text"], "b")

    def test_chatterbox_accepts_and_ignores_the_words(self):
        engine = ReferenceClipTests.FakeModel()
        chatterbox = server.ChatterboxTurbo.__new__(server.ChatterboxTurbo)
        chatterbox.model, chatterbox.sample_rate, chatterbox.default_conds = engine, 24000, "default"
        self.assertEqual(len(list(chatterbox.stream("hi", None, None, 0.0, "ignored words"))), 2)


if __name__ == "__main__":
    unittest.main()
