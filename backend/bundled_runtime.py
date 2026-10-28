"""Prepare the writable bundled Python environment, with no startup network access."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def run(command: list[str], timeout: int = 30) -> None:
    process = subprocess.Popen(command)
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise RuntimeError(f"Подготовка встроенного Python превысила {timeout} секунд. Повторите запуск; см. backend.log.") from None
    if code:
        raise RuntimeError(f"Не удалось подготовить встроенный Python (код {code}). Повторите запуск; см. backend.log.")


def prepare(resources: Path, root: Path) -> Path:
    manifest = json.loads((resources / "manifest.json").read_text())
    # Code signing protects resources; also detect an incomplete or damaged copy.
    for name, expected in manifest["files"].items():
        path = resources / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Повреждён встроенный runtime: {name}. Установите приложение заново.")
    python = root / ".venv/bin/python"
    stamp = root / ".core-ready"
    fingerprint = hashlib.sha256((resources / "requirements.lock").read_bytes()).hexdigest()
    probe = "import fastapi, uvicorn, pydantic_settings, multipart, httpx, semver, docx, docxtpl, backoff, lxml, PIL, reportlab"
    with (root / ".setup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ready = python.exists() and stamp.exists() and stamp.read_text().strip() == fingerprint
        if ready:
            try:
                result = subprocess.run([str(python), "-c", probe], timeout=15, capture_output=True)
                ready = result.returncode == 0
            except subprocess.TimeoutExpired:
                ready = False
        if not ready:
            uv = str(resources / "uv")
            if not python.exists():
                run([uv, "--no-config", "venv", "--offline", "--no-python-downloads", "--python", sys.executable, str(root / ".venv")])
            run([uv, "--no-config", "pip", "install", "--offline", "--no-cache", "--no-index", "--find-links", str(resources / "wheels"),
                 "--require-hashes", "--python", str(python), "-r", str(resources / "requirements.lock")])
            run([str(python), "-c", probe], timeout=15)
            stamp.write_text(fingerprint + "\n")
    return python


if __name__ == "__main__":
    try:
        resources, root, backend = map(Path, sys.argv[1:])
        python = prepare(resources, root)
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        os.environ["STEPPE_BUNDLED_RUNTIME"] = "1"
        os.execv(str(python), [str(python), str(backend / "desktop_server.py")])
    except Exception as error:
        print(f"Steppe Meeting: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
