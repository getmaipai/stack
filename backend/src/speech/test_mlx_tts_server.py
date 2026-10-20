import os
import sys
import unittest

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


if __name__ == "__main__":
    unittest.main()
