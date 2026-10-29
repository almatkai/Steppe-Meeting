"""The opt-in real-audio gate must reject missing speech even with full duration."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('replay_recordings', Path(__file__).resolve().parents[2] / 'scripts/replay-recordings.py')
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)


class ReplayCompletenessTests(unittest.TestCase):
    def setUp(self):
        self.case = {'min_duration': 60, 'anchors': [
            {'start': start, 'end': start + 5, 'pattern': word, 'provenance': 'Synthetic test specification'}
            for start, word in [(1, 'beginning'), (40, 'middle'), (76, 'ending')]]}
        self.result = {'duration': 82.44, 'segments': [
            {'timestamp_start': start, 'timestamp_end': start + 5, 'text': word}
            for start, word in [(1, 'beginning'), (40, 'middle'), (76, 'ending')]]}

    def test_full_duration_single_segment_does_not_hide_missing_words(self):
        self.result['segments'] = [{'timestamp_start': 0, 'timestamp_end': 82.44, 'text': 'ending'}]
        checks, valid = replay.evaluate_result(self.case, self.result, 82.44)
        self.assertTrue(valid)
        self.assertEqual(checks, [False, False, True])

    def test_beginning_middle_and_end_at_original_times(self):
        self.assertEqual(replay.evaluate_result(self.case, self.result, 82.44), ([True]*3, True))
        self.result['segments'][0]['text'] = 'middle'
        self.result['segments'][1]['text'] = 'beginning'
        self.assertEqual(replay.evaluate_result(self.case, self.result, 82.44)[0], [False, False, True])

    def test_truncated_audio_is_not_a_pass(self):
        self.result['duration'] = 29
        self.assertFalse(replay.evaluate_result(self.case, self.result, 82.44)[1])

    def test_independent_provenance_required(self):
        self.case['anchors'][0]['provenance'] = ''
        with self.assertRaises(ValueError):
            replay.evaluate_result(self.case, self.result, 82.44)

    def test_invalid_or_out_of_order_timestamps_fail(self):
        for start in [float('nan'), -1, 83]:
            self.result['segments'][1]['timestamp_start'] = start
            self.assertFalse(replay.evaluate_result(self.case, self.result, 82.44)[1])


class FullReferenceTests(unittest.TestCase):
    def test_punctuation_and_yo_normalization(self):
        case = {'reference_text': 'Зелёный поезд идёт домой.', 'reference_provenance': 'Prewritten',
                'max_wer': .2, 'min_token_recall': .85}
        result = {'segments': [{'text': 'ЗЕЛЕНЫЙ поезд идет домой!'}]}
        self.assertEqual(replay.reference_metrics(case, result)['wer'], 0)
        self.assertTrue(replay.reference_metrics(case, result)['pass'])

    def test_full_reference_detects_missing_middle_despite_all_anchor_words(self):
        case = {'reference_text': 'начало один два три четыре пять конец',
                'reference_provenance': 'Prewritten', 'max_wer': .2, 'min_token_recall': .85}
        metrics = replay.reference_metrics(case, {'segments': [{'text': 'начало конец'}]})
        self.assertFalse(metrics['pass'])
        self.assertEqual(metrics['edit_distance'], 5)

    def test_reordered_tokens_do_not_get_full_recall(self):
        case = {'reference_text': 'один два три четыре', 'reference_provenance': 'Prewritten',
                'max_wer': .2, 'min_token_recall': .85}
        self.assertFalse(replay.reference_metrics(case, {'segments': [{'text': 'четыре три два один'}]})['pass'])

    def test_empty_or_unattributed_reference_fails(self):
        for case in [{'reference_text': ''}, {'reference_text': '', 'reference_provenance': 'Prewritten'}]:
            with self.assertRaises(ValueError):
                replay.reference_metrics(case, {'segments': []})
