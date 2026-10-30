"""Public recommendation evidence and device compatibility, without inference."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import whisper_service as service
from engine.stt_catalog import STT_MODELS_CATALOG, get_model_recommendation


class STTRecommendationTests(unittest.TestCase):
    def catalog(self, incompatible=False):
        with patch.object(service, "is_model_downloaded", return_value=False), \
             patch.object(service, "is_env_installed", return_value=False), \
             patch.object(service, "env_error", return_value=None), \
             patch.object(service, "compatibility_error", side_effect=lambda model: "Apple Silicon required" if incompatible and model.startswith("gigaam") else None):
            return {item["id"]: item for item in service.get_models_catalog_status()}

    def test_only_measured_catalog_winners_receive_labels(self):
        catalog = self.catalog()
        winners = {model: item["recommendation"]["labels"] for model, item in catalog.items() if item.get("recommendation") and item["recommendation"]["labels"]}
        self.assertEqual(winners, {
            "gigaam-multilingual-int8": ["Лучший в целом", "Лучший для казахского"],
            "large-v3-turbo": ["Лучший для русского"],
        })
        self.assertEqual([model for model, item in catalog.items() if item["recommended"]], ["gigaam-multilingual-int8"])
        for item in catalog.values():
            if item.get("quality_warning"):
                self.assertIsNone(item["recommendation"])
            recommendation = item.get("recommendation")
            if recommendation:
                self.assertNotIn("англ", " ".join(recommendation["labels"]).lower())
                self.assertLessEqual(len(recommendation["labels"]) + bool(recommendation["use_case"]), 2)
                self.assertIn("среди проверенных моделей Steppe", recommendation["basis"])
                self.assertIn("30.10.2026", recommendation["basis"])
                self.assertIn("живое переключение языков не проверялось", recommendation["basis"])
                if recommendation["use_case"]:
                    self.assertTrue(recommendation["use_case_caveat"])
        self.assertIn("английский не сравнивали", catalog["large-v3-turbo"]["recommendation"]["use_case_caveat"])

    def test_unsupported_gigaam_is_not_an_actionable_winner(self):
        catalog = self.catalog(incompatible=True)
        giga = catalog["gigaam-multilingual-int8"]
        self.assertFalse(giga["supported"])
        self.assertFalse(giga["recommended"])
        self.assertEqual(giga["recommendation"]["labels"], [])
        self.assertIn("Apple Silicon", giga["recommendation"]["note"])
        self.assertEqual(catalog["wav2vec2-rukk"]["recommendation"]["labels"], [])
        self.assertIn("CPU", catalog["wav2vec2-rukk"]["recommendation"]["note"])

    def test_serialization_does_not_mutate_catalog_or_claim_untested_variants(self):
        first = get_model_recommendation("gigaam-multilingual-int8", True)
        first["labels"].clear()
        self.assertEqual(len(get_model_recommendation("gigaam-multilingual-int8", True)["labels"]), 2)
        self.assertEqual(len(get_model_recommendation("gigaam-multilingual-int8", False)["labels"]), 0)
        for model in ("tiny", "base", "small", "medium", "gigaam-multilingual-int4", "gigaam-multilingual-int6", "vosk-small-ru"):
            self.assertIsNone(get_model_recommendation(model, True), model)
        self.assertFalse(STT_MODELS_CATALOG["small"]["recommended"])


if __name__ == "__main__":
    unittest.main()
