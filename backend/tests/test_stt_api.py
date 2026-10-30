"""API regressions using an isolated data directory and no external services."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Server initialization creates SQLite/storage. Never touch the user's meetings.
_storage = tempfile.TemporaryDirectory(prefix="steppe-api-test-")
with patch.dict(os.environ, STEPPE_DATA_DIR=_storage.name):
    import desktop_server as server

from fastapi.testclient import TestClient


class STTAPITests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(server.app)

    def test_health_does_not_depend_on_ai_services(self):
        with patch.object(server.whisper_service, "get_whisper_full_status", side_effect=AssertionError("AI readiness is separate")):
            response = self.client.get("/api/v1/system/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["service"], "steppe-meeting")
        self.assertEqual(response.json()["backend_dir"], str(server.BASE_DIR))
        self.assertEqual(response.json()["pid"], os.getpid())

    def test_health_identifies_bundled_version_without_ai_probe(self):
        version = json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["version"]
        with patch.dict(os.environ, STEPPE_APP_VERSION=version, STEPPE_BUNDLED_RUNTIME="1"):
            response = self.client.get("/api/v1/system/health")
        self.assertEqual(response.json()["app_version"], version)
        self.assertEqual(response.json()["runtime"], "bundled")

    def test_installer_targets_requested_model(self):
        with patch.object(server.whisper_service, "start_install_env", return_value={"status": "started"}) as installer:
            response = self.client.post("/api/v1/system/whisper/install-env", json={"model": "wav2vec2-rukk"})
        self.assertEqual(response.status_code, 200)
        installer.assert_called_once_with("wav2vec2-rukk")

    def test_legacy_installer_uses_saved_model(self):
        with patch.object(server, "get_setting", return_value="vosk-small-kz"), \
             patch.object(server.whisper_service, "start_install_env", return_value={"status": "started"}) as installer:
            response = self.client.post("/api/v1/system/whisper/install-env")
        self.assertEqual(response.status_code, 200)
        installer.assert_called_once_with("vosk-small-kz")

    def test_status_exposes_recommendation_evidence_without_model_or_environment_setup(self):
        service = server.whisper_service
        with patch.object(service, "is_model_downloaded", return_value=False), \
             patch.object(service, "is_env_installed", return_value=False), \
             patch.object(service, "env_error", return_value=None), \
             patch.object(service, "compatibility_error", return_value=None), \
             patch.object(server, "get_setting", side_effect=lambda key, default=None: default):
            response = self.client.get("/api/v1/system/whisper/status")
        self.assertEqual(response.status_code, 200)
        catalog = {item["id"]: item for item in response.json()["local"]["catalog"]}
        self.assertEqual(catalog["gigaam-multilingual-int8"]["recommendation"]["labels"], ["Лучший в целом", "Лучший для казахского"])
        self.assertIn("английский не сравнивали", catalog["large-v3-turbo"]["recommendation"]["use_case_caveat"])
        self.assertIsNone(catalog["whisper-turbo-kaz-rus-v1"]["recommendation"])

    def test_model_action_errors_are_useful_client_errors(self):
        for action in ("install-env", "download-model", "delete-model"):
            response = self.client.post(f"/api/v1/system/whisper/{action}", json={"model": "../outside"})
            self.assertEqual(response.status_code, 400)
            self.assertIn("Неизвестная", response.json()["detail"])

    def test_invalid_config_does_not_partially_save(self):
        with patch.object(server, "set_setting") as save:
            response = self.client.post("/api/v1/system/config", json={"llm_model": "updated", "whisper_local_model": "unknown"})
        self.assertEqual(response.status_code, 400)
        save.assert_not_called()

    def test_stt_readiness_cannot_override_llm_readiness(self):
        # A ready LLM and missing STT used to share/overwrite `model_ready`.
        values = {"llm_base_url": "http://localhost:11434/v1", "llm_api_key": "", "llm_model": "test:latest", "whisper_mode": "local"}
        response = server.httpx.Response(200, json={"models": [{"name": "test:latest"}]})
        http = AsyncMock()
        http.__aenter__.return_value = http
        http.get.return_value = response
        local = {"ready": False, "local": {"model_ready": False, "error": "STT model missing"}}
        with patch.object(server, "get_setting", side_effect=lambda key, default=None: values.get(key, default)), \
             patch.object(server.httpx, "AsyncClient", return_value=http), \
             patch.object(server.whisper_service, "get_whisper_full_status", return_value=local):
            response = self.client.get("/api/v1/system/status")
        self.assertEqual(response.status_code, 200)
        status = response.json()
        self.assertTrue(status["ollama"]["connected"])
        self.assertTrue(status["ollama"]["model_ready"])
        self.assertFalse(status["whisper"]["connected"])
        self.assertEqual(status["whisper"]["error"], "STT model missing")


if __name__ == "__main__":
    unittest.main()
