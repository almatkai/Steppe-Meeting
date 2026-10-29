"""Offline regression checks for multi-engine download and inference contracts."""

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import local_stt, whisper_service as service
from engine.stt_catalog import STT_MODELS_CATALOG, compatibility_error


class InlineThread:
    def __init__(self, target, **kwargs):
        self.target = target

    def start(self):
        self.target()


class LocalSTTTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, STEPPE_DATA_DIR=self.temp.name)
        self.env.start()
        service._download_state.update(downloading=False, model=None, status="idle", error=None)
        service._env_state.update(installing=False, model=None, error=None)
        service._model_cache.clear()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def weights(self, model_id, target=None, complete=True):
        target = target or service.get_model_path(model_id)
        sizes = {}
        for name in STT_MODELS_CATALOG[model_id]["required_files"]:
            file = target / name
            file.parent.mkdir(parents=True, exist_ok=True)
            with file.open("wb") as stream:
                stream.truncate(6 * 1024 * 1024 if file.suffix in (".bin", ".pt", ".safetensors", ".mdl") else 10)
            sizes[name] = file.stat().st_size
        if complete:
            (target / service._COMPLETE_FILE).write_text(json.dumps({"model": model_id, "files": sizes}))
        return target

    def test_quality_warning_is_separate_from_runtime_readiness(self):
        self.weights('whisper-turbo-kaz-rus-v1')
        with patch.object(service, 'is_env_installed', return_value=True), patch.object(service, 'env_error', return_value=None):
            status = service.get_whisper_full_status('local', '', '', '', 'whisper-turbo-kaz-rus-v1')
        self.assertTrue(status['ready'])
        self.assertIn('пропускает', status['local']['quality_warning'])
        selected = next(x for x in status['local']['catalog'] if x['id'] == 'whisper-turbo-kaz-rus-v1')
        self.assertEqual(selected['quality_warning'], status['local']['quality_warning'])
        self.assertEqual(status['local']['selected_model'], 'whisper-turbo-kaz-rus-v1')

    def test_catalog_contains_all_requested_formats(self):
        engines = {info["engine"] for info in STT_MODELS_CATALOG.values()}
        self.assertEqual(engines, {"faster-whisper", "gigaam-mlx", "wav2vec2-ctc", "vosk"})
        self.assertTrue(all(f"gigaam-multilingual-int{bits}" in STT_MODELS_CATALOG for bits in (4, 6, 8)))
        self.assertIn("whisper-turbo-kaz-rus-v1", STT_MODELS_CATALOG)
        self.assertEqual(STT_MODELS_CATALOG["wav2vec2-rukk"]["languages"], ["kk", "ru"])

    def test_unknown_ids_cannot_escape_model_directory(self):
        for action in (service.get_model_path, service.start_download_model, service.delete_downloaded_model):
            with self.assertRaises(ValueError):
                action("../../other-data")

    def test_new_models_need_completion_manifest(self):
        self.weights("wav2vec2-kk", complete=False)
        self.assertFalse(service.is_model_downloaded("wav2vec2-kk"))
        self.weights("wav2vec2-kk")
        self.assertTrue(service.is_model_downloaded("wav2vec2-kk"))

    def test_legacy_whisper_download_still_works(self):
        self.weights("small", complete=False)
        self.assertTrue(service.is_model_downloaded("small"))

    def test_weights_alone_are_not_a_complete_download(self):
        path = self.weights("small")
        (path / "config.json").unlink()
        self.assertFalse(service.is_model_downloaded("small"))

    def test_truncated_download_is_not_ready(self):
        path = self.weights("wav2vec2-rukk")
        (path / "asr/rukk/model.pt").write_bytes(b"partial")
        self.assertFalse(service.is_model_downloaded("wav2vec2-rukk"))

    def test_malformed_completion_manifest_is_not_ready(self):
        path = self.weights("wav2vec2-kk")
        for invalid in ("not json", "[]", '{"model":"wav2vec2-kk","files":null}'):
            (path / service._COMPLETE_FILE).write_text(invalid)
            self.assertFalse(service.is_model_downloaded("wav2vec2-kk"))

    def test_vosk_archive_is_flattened_and_cannot_escape_storage(self):
        info = STT_MODELS_CATALOG["vosk-small-ru"]
        root = info["archive_root"]
        target = Path(self.temp.name) / "staging"
        target.mkdir()
        for filename, valid in ((f"{root}/conf/mfcc.conf", True), (f"{root}/../escaped", False)):
            content = io.BytesIO()
            with zipfile.ZipFile(content, "w") as archive:
                archive.writestr(filename, "test data")
            response = MagicMock()
            response.headers = {}
            response.iter_bytes.return_value = [content.getvalue()]
            stream = MagicMock()
            stream.__enter__.return_value = response
            with patch("httpx.stream", return_value=stream):
                if valid:
                    service._download_zip(info, target)
                    self.assertEqual((target / "conf/mfcc.conf").read_text(), "test data")
                else:
                    with self.assertRaises(ValueError):
                        service._download_zip(info, target)
                    self.assertFalse((target.parent / "escaped").exists())
            self.assertFalse(target.with_name(target.name + ".zip").exists())

    def test_environment_readiness_is_model_specific(self):
        with patch.object(service.importlib.util, "find_spec", side_effect=lambda name: object() if name == "faster_whisper" else None):
            self.assertTrue(service.is_env_installed("small"))
            self.assertFalse(service.is_env_installed("wav2vec2-kk"))
            self.assertFalse(service.is_env_installed("vosk-small-kz"))

    def test_bad_pyav_is_not_ready_and_can_be_repaired_without_weights_download(self):
        from importlib.metadata import version as real_version
        self.weights("small")
        def bad_version(name):
            return "19.0.2" if name == "av" else real_version(name)
        with patch("importlib.metadata.version", side_effect=bad_version), \
             patch.object(service.importlib.util, "find_spec", return_value=object()), \
             patch.object(service, "_install_packages") as install, \
             patch.object(service.threading, "Thread", InlineThread):
            self.assertFalse(service.is_env_installed("small"))
            status = service.get_whisper_full_status("local", "", "", "", "small")
            self.assertFalse(status["ready"])
            self.assertFalse(status["local"]["model_ready"])
            self.assertIn("Установить среду", status["local"]["error"])
            self.assertEqual(service.start_install_env("small")["status"], "started")
            install.assert_called_once_with("small", unittest.mock.ANY, False)
        self.assertTrue(service.is_model_downloaded("small"))

    def test_unsupported_mlx_is_reported(self):
        with patch("engine.stt_catalog.sys.platform", "linux"):
            self.assertIsNotNone(compatibility_error("gigaam-multilingual-int4"))
            self.assertIsNone(compatibility_error("wav2vec2-kk"))
            with self.assertRaises(RuntimeError):
                service.start_download_model("gigaam-multilingual-int4")

    def test_download_installs_correct_engine_then_publishes(self):
        with patch.object(service, "is_env_installed", return_value=False), \
             patch.object(service, "_install_packages") as install, \
             patch.object(service, "_download_files", side_effect=lambda name, path: self.weights(name, path, complete=False)), \
             patch.object(service.threading, "Thread", InlineThread):
            self.assertEqual(service.start_download_model("wav2vec2-kk")["status"], "started")
        self.assertEqual(install.call_args.args[0], "wav2vec2-kk")
        self.assertTrue(service.is_model_downloaded("wav2vec2-kk"))
        self.assertEqual(service._download_state["status"], "completed")
        self.assertFalse(service._download_state["downloading"])

    def test_failed_download_cleans_staging_and_remains_unavailable(self):
        def fail(name, path):
            self.weights(name, path, complete=False)
            raise RuntimeError("connection dropped")
        with patch.object(service, "is_env_installed", return_value=True), \
             patch.object(service, "_download_files", side_effect=fail), \
             patch.object(service.threading, "Thread", InlineThread):
            service.start_download_model("wav2vec2-kk")
        self.assertFalse(service.is_model_downloaded("wav2vec2-kk"))
        self.assertFalse(service.get_model_path("wav2vec2-kk").with_name(".wav2vec2-kk.partial").exists())
        self.assertEqual(service._download_state["status"], "error")

    def test_background_state_is_reserved_before_thread_starts(self):
        with patch.object(service.threading, "Thread"):
            service.start_download_model("wav2vec2-kk")
            self.assertTrue(service._download_state["downloading"])
            self.assertEqual(service.start_download_model("vosk-small-kz")["status"], "busy")
            self.assertEqual(service.start_install_env("small")["status"], "already_running")
            with self.assertRaises(RuntimeError):
                service.delete_downloaded_model("wav2vec2-kk")

    def test_selective_ctc_download_avoids_language_models(self):
        with patch("huggingface_hub.snapshot_download") as download:
            service._download_files("wav2vec2-rukk", Path(self.temp.name))
        self.assertEqual(download.call_args.kwargs["allow_patterns"], ["asr/rukk/model.pt", "asr/rukk/tokens.lst", "LICENSE", "README.md"])
        self.assertEqual(len(download.call_args.kwargs["revision"]), 40)

    def test_delete_evicts_only_exact_model(self):
        self.weights("small")
        service._model_cache.update({"small:cpu": object(), "small-other:cpu": object()})
        self.assertEqual(service.delete_downloaded_model("small")["status"], "deleted")
        self.assertNotIn("small:cpu", service._model_cache)
        self.assertIn("small-other:cpu", service._model_cache)
        self.assertFalse(service.is_model_downloaded("small"))

    def test_ctc_repeat_and_blank_handling(self):
        self.assertEqual(local_stt.decode_ctc([0, 0, 3, 0, 1, 2, 2], {0: "а", 1: "|", 2: "б"}, 3), "аа б")
        self.assertEqual(local_stt.decode_ctc([3, 3], {0: "а"}, 3), "")

    def test_language_normalization_handles_kazakh_and_auto(self):
        self.assertEqual(local_stt.normalize_language("kz"), "kk")
        self.assertEqual(local_stt.normalize_language("kk"), "kk")
        self.assertIsNone(local_stt.normalize_language("multi"))

    def test_fixed_language_model_rejects_mismatched_meeting(self):
        with self.assertRaisesRegex(ValueError, "только kk"):
            local_stt.transcribe(object(), STT_MODELS_CATALOG["wav2vec2-kk"], "any.wav", "auto", "ru")

    def test_vad_chunks_keep_original_offsets_and_bound_length(self):
        import numpy as np
        with patch("faster_whisper.vad.get_speech_timestamps", return_value=[{"start": 16000, "end": 688000}]):
            chunks = list(local_stt.speech_chunks(np.zeros(700000, dtype=np.float32)))
        self.assertEqual(chunks[0][:2], (16000, 336000))
        self.assertEqual(chunks[-1][1], 688000)
        self.assertTrue(all(len(chunk) <= 320000 for _, _, chunk in chunks))

    def test_inference_dispatch_preserves_meeting_contract(self):
        audio = Path(self.temp.name) / "audio.wav"
        audio.touch()
        for name in ("wav2vec2-rukk", "gigaam-multilingual-int4", "vosk-small-kz"):
            with self.subTest(name=name), \
                 patch.object(service, "get_cached_model", return_value=object()), \
                 patch.object(local_stt, "transcribe", return_value=([(12.0, 14.0, "Сәлем")], 20, "kk")) as transcribe:
                result = service.transcribe_local(str(audio), name, language="kz")
                self.assertEqual(transcribe.call_args.args[1]["id"], name)
                self.assertEqual(result["duration"], 20)
                self.assertEqual(result["segments"][0]["timestamp_str"], "[00:00:12]")
                self.assertIn("Сәлем", result["text"])

    def test_vosk_flushes_final_result_and_clips_pcm(self):
        import numpy as np
        recognizer = MagicMock()
        recognizer.AcceptWaveform.return_value = False
        recognizer.FinalResult.return_value = json.dumps({"text": "hello", "result": [{"start": 0.2, "end": 0.7, "word": "hello"}]})
        with patch.dict(sys.modules, vosk=SimpleNamespace(KaldiRecognizer=MagicMock(return_value=recognizer))), \
             patch("faster_whisper.audio.decode_audio", return_value=np.array([2.0, -2.0, 0.0], dtype=np.float32)):
            segments, duration, language = local_stt.transcribe(object(), STT_MODELS_CATALOG["vosk-small-en-us"], "audio.webm", "auto", "multi")
        self.assertEqual(segments, [(0.2, 0.7, "hello")])
        self.assertEqual(language, "en")
        pcm = recognizer.AcceptWaveform.call_args.args[0]
        self.assertEqual(np.frombuffer(pcm, dtype="<i2").tolist(), [32767, -32767, 0])

    def test_whisper_uses_normalized_language_and_offline_cache(self):
        audio = Path(self.temp.name) / "audio.wav"
        audio.touch()
        model = MagicMock()
        model.transcribe.return_value = ([SimpleNamespace(start=1, end=2, text=" hello ")], SimpleNamespace(duration=3, language="kk"))
        with patch.object(service, "get_cached_model", return_value=model):
            result = service.transcribe_local(str(audio), "small", language="kk")
        self.assertEqual(model.transcribe.call_args.kwargs["language"], "kk")
        self.assertEqual(result["segments"][0]["text"], "hello")

    def test_whisper_model_profile_controls_tail_context_offline_and_streaming(self):
        audio = Path(self.temp.name) / "audio.wav"
        audio.touch()
        first = SimpleNamespace(start=5.0, end=74.0, text=" initial speech ")
        tail = SimpleNamespace(start=74.0, end=81.0, text=" final speech ")

        def recognize(_path, **options):
            # Synthetic reproduction of a later window suppressed by prior text.
            segments = [first] if options.get("condition_on_previous_text", True) else [first, tail]
            return iter(segments), SimpleNamespace(duration=82.0, language="ru")

        for name, info in STT_MODELS_CATALOG.items():
            if info["engine"] != "faster-whisper":
                continue
            for streaming in (False, True):
                with self.subTest(model=name, streaming=streaming):
                    model = MagicMock()
                    model.transcribe.side_effect = recognize
                    with patch.object(service, "get_cached_model", return_value=model) as load:
                        result = service.transcribe_local(str(audio), name, streaming=streaming)
                    load.assert_called_once_with(name, "auto")
                    conditioned = name != "whisper-turbo-kaz-rus-v1"
                    self.assertEqual(len(result["segments"]), 1 if conditioned else 2)
                    self.assertEqual(result["segments"][0]["text"], "initial speech")
                    self.assertEqual(result["duration"], 82.0)
                    if not conditioned:
                        self.assertEqual(result["segments"][-1]["text"], "final speech")
                        self.assertEqual(result["segments"][-1]["timestamp_end"], 81.0)
                    model.transcribe.assert_called_once()
                    self.assertEqual(model.transcribe.call_args.args, (str(audio),))
                    options = dict(model.transcribe.call_args.kwargs)
                    self.assertEqual(options.pop("condition_on_previous_text", True), conditioned)
                    self.assertEqual(options, {
                        "language": None, "beam_size": 1 if streaming else 5,
                        "vad_filter": True, "vad_parameters": {"min_silence_duration_ms": 500},
                    })

    def test_formatting_does_not_invent_multiple_speakers(self):
        result = local_stt.format_result([(0, 1, "one"), (3661, 3662, "two")], 3700, "en")
        self.assertEqual({s["speaker"] for s in result["segments"]}, {"Спикер 1"})
        self.assertEqual(result["segments"][1]["timestamp_str"], "[01:01:01]")


if __name__ == "__main__":
    unittest.main()
