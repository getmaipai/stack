"""Offline regression checks for the on-demand music bench."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'music_sung_words', Path(__file__).with_name('music-sung-words.py'))
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class SungWordsTests(unittest.TestCase):
    def test_collapsed_ending_includes_five_tail_rows(self):
        lrc = ('[00:00.00][Verse]\n[00:01.00]One\n[00:57.00]Two\n'
               '[00:59.92]Three\n[00:59.92]Four\n[00:59.92][Outro]\n[00:59.92]Five')
        report = bench.make_report('One two three four five', {'segments': []}, lrc, 60)
        self.assertEqual(len(report['squeezed_lines']), 5)
        self.assertFalse(report['pass'])

    def test_distinct_ending_timestamps_pass(self):
        lrc = '[00:57.00]One\n[00:58.60]Two\n[00:59.20]Three\n[00:59.92]Four'
        self.assertTrue(bench.make_report('One', {'segments': []}, lrc, 60)['pass'])

    def test_earlier_duplicates_do_not_fail(self):
        rows = bench.parse_lrc('[00:01.00][Verse]\n[00:01.00]One\n[00:59.00]Two')
        self.assertEqual(bench.squeezed_lines(rows, 60), [])

    def test_recall_extras_and_section(self):
        transcript = {'segments': [{'words': [
            {'word': 'One', 'start': 1}, {'word': 'growl!', 'start': 2},
            {'word': 'three', 'start': 3}, {'word': 'three', 'start': 4}]}]}
        report = bench.make_report('[Verse]\nOne two three', transcript,
                                   '[00:00.00][Verse]\n[00:03.50][Outro]', 60)
        self.assertEqual(report['lyric_words'], 3)
        self.assertEqual(report['heard_words'], 4)
        self.assertEqual(report['in_order_recall'], 2 / 3)
        self.assertEqual(report['words_not_in_lyrics'], 2)
        self.assertEqual(report['extras'], [
            {'word': 'growl', 'time': 2, 'section': '[Verse]'},
            {'word': 'three', 'time': 4, 'section': '[Outro]'}])
        self.assertTrue(report['pass'])

    def test_normalization_and_repeated_word_alignment(self):
        self.assertEqual(bench.split_words("[Chorus]\nDON'T stop, 123!"), ["don't", 'stop', '123'])
        self.assertEqual(bench.lcs_alignment(['go', 'go'], ['go']), [(0, 0)])


if __name__ == '__main__':
    unittest.main()
