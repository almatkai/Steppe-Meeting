"""Private, content-addressed regression inputs, independent of meeting deletion.

Only finalized full recordings are retained. Retries share one immutable blob;
source/config manifests and replay results never enter the repository.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import tempfile
import sys
from pathlib import Path

from app_data import get_app_data_dir


def cache_dir() -> Path:
    return get_app_data_dir() / "stt-regression"


def private_dir(path: Path) -> Path:
    # pathlib's parents=True uses default permissions for intermediate parents.
    # Create each missing directory explicitly so nested case/report paths stay private.
    missing = []
    ancestor = path
    while not ancestor.exists():
        missing.append(ancestor)
        ancestor = ancestor.parent
    for directory in reversed(missing):
        directory.mkdir(exist_ok=True, mode=0o700)
        directory.chmod(0o700)
    path.chmod(0o700)
    return path


def fingerprint(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value) -> None:
    private_dir(path.parent)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def retain_recording(path: Path, source_id: str, config: dict, *, root: Path | None = None, source_name: str | None = None) -> dict:
    """Copy once, hash during copy, publish only a fully flushed immutable input.

    A manifest is success evidence: it is written only after blob verification.
    Failure propagates to the caller, leaving the original recording untouched.
    """
    root = private_dir(root or cache_dir())
    blobs = private_dir(root / "audio")
    before = path.stat()
    fd, temporary = tempfile.mkstemp(dir=blobs, prefix=".pending-")
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source, os.fdopen(fd, "wb") as output:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
                size += len(chunk)
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        after = path.stat()
        if not size or (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise OSError("Recording is empty or changed while caching")
        sha = digest.hexdigest()
        blob = blobs / f"{sha}.audio"
        os.chmod(temporary, 0o400)
        try:
            os.link(temporary, blob)  # exclusive publication; never replace an existing input
        except FileExistsError:
            if blob.is_symlink() or fingerprint(blob) != sha:
                raise OSError("Regression cache input failed integrity verification")
        safe_config = {key: config[key] for key in ("mode", "model", "device", "language", "streaming") if key in config}
        from engine.stt_catalog import STT_MODELS_CATALOG
        model_info = STT_MODELS_CATALOG.get(safe_config.get("model"), {})
        versions = {}
        for name in ("faster-whisper", "av", "ctranslate2", "torch", "vosk", "gigaam-multilingual-mlx"):
            try:
                versions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                pass
        manifest = {"schema": 1, "sha256": sha, "bytes": size, "source_id": source_id,
                    "source_name": source_name or path.name, "config": safe_config,
                    "runtime": {"python": sys.executable, "version": sys.version, "packages": versions},
                    "model_profile": {key: model_info[key] for key in ("engine", "revision", "base_revision", "transcription_options") if key in model_info},
                    "adapter_sha256": fingerprint(Path(__file__).parent / "engine" / "whisper_service.py")}
        source_key = hashlib.sha256(source_id.encode()).hexdigest()
        atomic_json(root / "cases" / sha / "sources" / f"{source_key}.json", manifest)
        return manifest
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_input(sha: str, root: Path | None = None) -> Path:
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise ValueError("Expected a SHA256 case id")
    path = (root or cache_dir()) / "audio" / f"{sha}.audio"
    if not path.is_file() or path.is_symlink() or fingerprint(path) != sha:
        raise ValueError(f"Required cached audio missing or corrupt: {sha}")
    return path
