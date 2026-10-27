"""Update-channel API writes to an isolated SQLite file, never user settings."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_storage = tempfile.TemporaryDirectory(prefix="steppe-updates-api-")
for directory in ("templates", "audio", "exports"):
    (Path(_storage.name) / directory).mkdir()
import app_data
with patch.dict(os.environ, STEPPE_DATA_DIR=_storage.name), \
     patch.object(app_data, "prepare_app_data_dir", return_value=Path(_storage.name)):
    import desktop_server as server
from release_updates import ReleaseChecker


class UpdateAPITests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="steppe-update-settings-")
        self.addCleanup(self.directory.cleanup)
        self.db_patch = patch.object(server, "DB_PATH", Path(self.directory.name) / "isolated.db")
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        server.init_db()
        self.requests = []
        def handle(request):
            self.requests.append(request)
            return httpx.Response(200, json=[])
        self.checker_patch = patch.object(server, "update_checker", ReleaseChecker(transport=httpx.MockTransport(handle)))
        self.checker_patch.start()
        self.addCleanup(self.checker_patch.stop)
        self.client = TestClient(server.app)

    def test_model_discovery_uses_unsaved_connection_without_model_or_writes(self):
        server.set_setting("llm_base_url", "http://saved.invalid/v1")
        server.set_setting("llm_model", "saved-model")
        requests = []
        def handle(request):
            requests.append(request)
            if request.url.path == "/api/tags":
                return httpx.Response(404)
            return httpx.Response(200, json={"data": [{"id": "new-model"}]})
        client_type = httpx.AsyncClient
        with patch.object(server.httpx, "AsyncClient", side_effect=lambda **kwargs: client_type(transport=httpx.MockTransport(handle), **kwargs)):
            response = self.client.post("/api/v1/system/models", json={"base_url": "https://draft.example/v1", "api_key": "test-only"})
        self.assertEqual(response.json(), ["new-model"])
        self.assertEqual(str(requests[-1].url), "https://draft.example/v1/models")
        self.assertEqual(requests[-1].headers["authorization"], "Bearer test-only")
        self.assertEqual(server.get_setting("llm_base_url"), "http://saved.invalid/v1")
        self.assertEqual(server.get_setting("llm_model"), "saved-model")
        self.assertEqual(self.client.post("/api/v1/system/models", json={"base_url": "relative"}).status_code, 400)

    def test_default_channel_and_saved_channel_override_does_not_persist(self):
        self.assertEqual(self.client.get("/api/v1/system/config").json()["update_channel"], "stable")
        self.assertEqual(self.client.post("/api/v1/system/updates/channel", json={"channel": "beta"}).json(), {"channel": "beta"})
        saved = self.client.get("/api/v1/system/updates", params={"current_version": "0.1.0"}).json()
        self.assertEqual((saved["channel"], saved["status"], saved["repository"]), ("beta", "no_releases", "almatkai/Steppe-Meeting"))
        override = self.client.get("/api/v1/system/updates", params={"current_version": "0.1.0", "channel": "stable", "platform": "darwin", "arch": "aarch64", "force": "false"}).json()
        self.assertEqual(override["channel"], "stable")
        self.assertIn("checked_at", override)
        self.assertEqual(server.get_setting("update_channel"), "beta")
        self.assertEqual(len(self.requests), 1)

    def test_channel_save_changes_only_one_key_and_works_with_invalid_llm_settings(self):
        values = {"llm_mode": "cli", "llm_cli_provider": "codex", "llm_cli": '{"codex":{"model":"custom"}}',
                  "llm_base_url": "legacy invalid", "llm_api_key": "test-only", "whisper_local_model": "custom"}
        for key, value in values.items():
            server.set_setting(key, value)
        self.assertEqual(self.client.post("/api/v1/system/updates/channel", json={"channel": "beta"}).status_code, 200)
        for key, value in values.items():
            self.assertEqual(server.get_setting(key), value)
        with server.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM settings").fetchone()[0], len(values) + 1)

    def test_legacy_config_save_preserves_immediate_channel_and_explicit_channel_is_validated(self):
        self.client.post("/api/v1/system/updates/channel", json={"channel": "beta"})
        with patch.object(server, "sync_generation_settings"):
            result = self.client.post("/api/v1/system/config", json={"llm_model": "new-model"})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(server.get_setting("update_channel"), "beta")
            self.assertEqual(self.client.post("/api/v1/system/config", json={"update_channel": "stable"}).status_code, 200)
        self.assertEqual(server.get_setting("update_channel"), "stable")
        for path, payload in (("/api/v1/system/updates/channel", {"channel": "nightly"}),
                              ("/api/v1/system/config", {"update_channel": "nightly", "llm_model": "must-not-save"})):
            self.assertEqual(self.client.post(path, json=payload).status_code, 422)
        self.assertEqual(server.get_setting("llm_model"), "new-model")

    def test_invalid_or_missing_current_version_and_channel_do_not_fetch(self):
        self.assertEqual(self.client.get("/api/v1/system/updates").status_code, 422)
        self.assertEqual(self.client.get("/api/v1/system/updates?current_version=0.1.0&channel=nightly").status_code, 422)
        response = self.client.get("/api/v1/system/updates?current_version=unknown")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "error")
        self.assertEqual(self.requests, [])


if __name__ == "__main__":
    unittest.main()
