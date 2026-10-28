"""Test packaged backend with empty user data, system PATH and a private port.

Use --app for the final .app; without it, test an exact resource staging copy.
No model downloads, external LLM calls, existing server or real user data.
--stt-codecs adds an explicit network dependency test in a separate venv.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def hashes(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path)
    parser.add_argument("--stt-codecs", action="store_true", help="Test optional production STT install/repair in a separate environment")
    parser.add_argument("--timeout", type=int, default=110)
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    with tempfile.TemporaryDirectory(prefix="steppe-bundle-smoke-") as folder:
        work = Path(folder)
        if args.app:
            resources = args.app.resolve() / "Contents/Resources"
        else:
            resources = work / "Steppe Meeting.app/Contents/Resources"
            backend = resources / "backend"
            backend.mkdir(parents=True)
            for pattern in ("*.py", "engine/*.py", "engine/core/*.py"):
                for source in (ROOT / "backend").glob(pattern):
                    target = backend / source.relative_to(ROOT / "backend")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
            shutil.copy2(ROOT / "backend/run_backend.sh", backend)
            shutil.copytree(ROOT / "build/bundled-runtime", resources / "runtime")
            shutil.copytree(ROOT / "public/templates", resources / "public/templates")
        before = hashes(resources)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        data = work / "fresh-data"
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(work / "home"),
               "STEPPE_DATA_DIR": str(data), "DESKTOP_API_PORT": str(port),
               "STEPPE_APP_VERSION": version, "UV_OFFLINE": "1",
               "UV_PYTHON_DOWNLOADS": "never", "HF_HUB_OFFLINE": "1"}
        os.makedirs(env["HOME"])
        base = f"http://127.0.0.1:{port}/api/v1"

        def get(path):
            with urlopen(base + path, timeout=2) as response:
                return json.load(response)

        log_path = ROOT / "build/bundled-runtime-smoke.log"
        try:
            for launch in ("cold", "warm"):
                with log_path.open("a") as log:
                    process = subprocess.Popen(["/bin/bash", str(resources / "backend/run_backend.sh")],
                                               cwd="/", env=env, stdout=log, stderr=log, start_new_session=True)
                    try:
                        deadline = time.monotonic() + args.timeout
                        while True:
                            if process.poll() is not None:
                                raise RuntimeError(f"{launch} backend exited {process.returncode}; see {log_path}")
                            try:
                                health = get("/system/health")
                                break
                            except (OSError, ValueError):
                                if time.monotonic() >= deadline:
                                    raise RuntimeError(f"{launch} backend timed out; see {log_path}") from None
                                time.sleep(.2)
                        assert health["backend_dir"] == str(resources / "backend"), health
                        assert health["runtime"] == "bundled", health
                        assert health["app_version"] == version, health
                        assert health["pid"] == process.pid, health
                        assert len(get("/system/whisper/status")["local"]["catalog"]) == 17
                        assert get("/templates")
                        assert (data / "meetings.db").is_file()
                        assert hashes(resources) == before, "Signed resources changed during startup"
                        print(f"PASS {launch}: real health, 17-model catalog, templates, offline core, untouched resources", flush=True)
                    finally:
                        if process.poll() is None:
                            os.killpg(process.pid, signal.SIGTERM)
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                os.killpg(process.pid, signal.SIGKILL)
                                process.wait(timeout=5)
                        try:
                            get("/system/health")
                        except OSError:
                            pass
                        else:
                            raise AssertionError("Owned server survived shutdown")
            if args.stt_codecs:
                portable = next((data / "runtime").glob("*/python/bin/python3"))
                subprocess.run([str(portable), "-B", str(ROOT / "scripts/smoke-stt-codecs.py"),
                                "--resources", str(resources), "--python", str(portable),
                                "--report", str(ROOT / "build/stt-codec-smoke.json")],
                               check=True, timeout=1600)
                assert hashes(resources) == before, "STT smoke changed signed resources"
        finally:
            print(f"Runtime smoke log: {log_path}", flush=True)


if __name__ == "__main__":
    main()
