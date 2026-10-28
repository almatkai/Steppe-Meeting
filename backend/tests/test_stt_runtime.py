"""Compatibility checks exercise real decoding independently of model inference."""
import io
import os
import tempfile
import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import stt_runtime, whisper_service
from engine.stt_catalog import RUNTIMES


class STTRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, STEPPE_DATA_DIR=self.temp.name)
        self.env.start()
        stt_runtime._codec_probe.cache_clear()

    def tearDown(self):
        stt_runtime._codec_probe.cache_clear()
        self.env.stop()
        self.temp.cleanup()

    def test_every_engine_uses_same_tested_codec_pair(self):
        for profile in RUNTIMES.values():
            self.assertTrue(set(stt_runtime.STT_CODEC_PACKAGES).issubset(profile["packages"]))

    def test_actual_tiny_decode(self):
        stt_runtime.decode_probe()

    def test_corrupt_input_keeps_original_audio_error(self):
        import av
        from faster_whisper.audio import decode_audio
        with self.assertRaises(av.error.InvalidDataError):
            decode_audio(io.BytesIO(b"not an audio file"))
        self.assertIsNone(stt_runtime.codec_error())

    def test_status_probes_once_and_never_installs(self):
        with patch.object(stt_runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as probe, \
             patch.object(whisper_service, "_install_packages") as installer:
            for _ in range(3):
                self.assertIsNone(stt_runtime.codec_error())
            probe.assert_called_once()
            self.assertIn("--probe", probe.call_args.args[0])
            self.assertEqual(probe.call_args.kwargs["timeout"], 20)
            installer.assert_not_called()

    def test_matching_versions_with_actual_probe_failure_are_not_ready(self):
        with patch.object(stt_runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, stderr="native decode failure")), \
             patch.object(whisper_service.importlib.util, "find_spec", return_value=object()):
            for model in ("small", "wav2vec2-kk", "vosk-small-kz"):
                self.assertFalse(whisper_service.is_env_installed(model))
                self.assertIn("Установить среду", whisper_service.env_error(model))
            status = whisper_service.get_whisper_full_status("local", "", "", "", "small")
            self.assertFalse(status["ready"])
            self.assertIn("декодирования", status["local"]["error"])

    def test_probe_timeout_has_actionable_message(self):
        with patch.object(stt_runtime.subprocess, "run", side_effect=subprocess.TimeoutExpired("probe", 20)):
            self.assertIn("Установить среду", stt_runtime.codec_error())

    def test_installer_checks_decode_in_fresh_process_and_refreshes_status_cache(self):
        with patch.object(whisper_service.shutil, "which", return_value="/test/uv"), \
             patch.object(whisper_service.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            whisper_service._install_packages("small", lambda _: None, False)
        install = run.call_args_list[0]
        self.assertIn("faster-whisper==1.2.1", install.args[0])
        self.assertIn("av==18.1.0", install.args[0])
        self.assertNotIn("--reinstall", install.args[0])
        self.assertIn("stt_runtime.py", run.call_args_list[1].args[0][-1])
        self.assertGreaterEqual(len(run.call_args_list), 3)

    def test_installer_decode_failure_never_reports_success(self):
        calls = [subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 1, stderr="TypeError metadata_errors")]
        with patch.object(whisper_service.shutil, "which", return_value="/test/uv"), \
             patch.object(whisper_service.subprocess, "run", side_effect=calls):
            with self.assertRaisesRegex(RuntimeError, "Установить среду"):
                whisper_service._install_packages("small", lambda _: None, False)


if __name__ == "__main__":
    unittest.main()
