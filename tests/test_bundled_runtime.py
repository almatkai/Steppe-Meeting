"""Packaging failure paths: damaged resources must never appear ready."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bundled_runtime", ROOT / "backend/bundled_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class BundledRuntimeTests(unittest.TestCase):
    def fixture(self, folder):
        resources, data = Path(folder) / "resources", Path(folder) / "data"
        resources.mkdir()
        data.mkdir()
        (resources / "requirements.lock").write_text("test-package==1\n")
        manifest = {"files": {"requirements.lock": hashlib.sha256((resources / "requirements.lock").read_bytes()).hexdigest()}}
        (resources / "manifest.json").write_text(json.dumps(manifest))
        return resources, data

    def test_damaged_resources_do_not_start_python_or_create_ready_stamp(self):
        with tempfile.TemporaryDirectory() as folder:
            resources, data = self.fixture(folder)
            (resources / "requirements.lock").write_text("modified")
            with patch.object(runtime, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "Повреждён"):
                    runtime.prepare(resources, data)
                run.assert_not_called()
            self.assertFalse((data / ".core-ready").exists())

    def test_failed_install_leaves_no_success_stamp(self):
        with tempfile.TemporaryDirectory() as folder:
            resources, data = self.fixture(folder)
            with patch.object(runtime, "run", side_effect=RuntimeError("failed offline setup")):
                with self.assertRaisesRegex(RuntimeError, "failed offline setup"):
                    runtime.prepare(resources, data)
            self.assertFalse((data / ".core-ready").exists())

    def test_complete_environment_survives_warm_launch_without_reinstall(self):
        with tempfile.TemporaryDirectory() as folder:
            resources, data = self.fixture(folder)
            python = data / ".venv/bin/python"
            python.parent.mkdir(parents=True)
            python.touch()
            (data / ".core-ready").write_text(hashlib.sha256((resources / "requirements.lock").read_bytes()).hexdigest())
            with patch.object(runtime.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)), patch.object(runtime, "run") as install:
                self.assertEqual(runtime.prepare(resources, data), python)
                install.assert_not_called()

    def test_incomplete_app_fails_without_external_bootstrap(self):
        with tempfile.TemporaryDirectory() as folder:
            contents = Path(folder) / "Example.app/Contents"
            backend = contents / "Resources/backend"
            backend.mkdir(parents=True)
            (contents / "MacOS").mkdir()
            (backend / "run_backend.sh").write_bytes((ROOT / "backend/run_backend.sh").read_bytes())
            result = subprocess.run(["/bin/bash", str(backend / "run_backend.sh")], cwd="/",
                                    env={"PATH": "/usr/bin:/bin", "HOME": folder, "STEPPE_DATA_DIR": folder},
                                    capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Отсутствует встроенный Python runtime", result.stderr)
            self.assertFalse((Path(folder) / "runtime").exists())


if __name__ == "__main__":
    unittest.main()
