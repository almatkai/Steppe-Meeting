"""Local STT catalog, background setup/downloads, and offline inference.

The historical module and API names remain compatible with saved Whisper settings.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from app_data import get_app_data_dir
from . import local_stt
from .stt_catalog import RUNTIMES, STT_MODELS_CATALOG, compatibility_error, get_model_info

logger = logging.getLogger("steppe.desktop.whisper")
WHISPER_MODELS_CATALOG = STT_MODELS_CATALOG
_env_state = {"installing": False, "model": None, "progress": "", "error": None}
_download_state = {"downloading": False, "model": None, "status": "idle", "progress_text": "", "error": None}
_state_lock = threading.Lock()
# Serialize loading/inference/deletion; MLX and the cached acoustic models can be
# stateful, and keeping multiple large engines resident wastes laptop memory.
_cache_lock = threading.RLock()
_model_cache: Dict[str, Any] = {}
_COMPLETE_FILE = ".download-complete.json"


def is_env_installed(model_name: str = "small", include_setup: bool = False) -> bool:
    try:
        info = get_model_info(model_name)
        if compatibility_error(model_name):
            return False
        modules = list(RUNTIMES[info["engine"]]["modules"])
        if include_setup:
            modules.extend(info.get("setup_modules", ()))
        return all(importlib.util.find_spec(module) is not None for module in modules)
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def get_whisper_models_dir() -> Path:
    models_dir = get_app_data_dir() / "models" / "whisper"
    models_dir.mkdir(parents=True, exist_ok=True)
    return models_dir


def get_model_path(model_name: str) -> Path:
    # Catalog validation also prevents path traversal in download/delete APIs.
    get_model_info(model_name)
    return get_whisper_models_dir() / model_name


def _validate_model_files(model_name: str, path: Path) -> bool:
    for name in get_model_info(model_name)["required_files"]:
        file = path / name
        minimum = 5 * 1024 * 1024 if file.suffix in (".bin", ".pt", ".safetensors", ".mdl") else 1
        if not file.is_file() or file.stat().st_size < minimum:
            return False
    return True


def is_model_downloaded(model_name: str) -> bool:
    info = get_model_info(model_name)
    path = get_model_path(model_name)
    try:
        if not _validate_model_files(model_name, path):
            return False
        marker = path / _COMPLETE_FILE
        # Existing standard Whisper downloads predate the completion manifest.
        if not marker.is_file():
            return info["download_kind"] == "whisper"
        manifest = json.loads(marker.read_text())
        if not isinstance(manifest, dict) or manifest.get("model") != model_name:
            return False
        files = manifest.get("files")
        if not isinstance(files, dict):
            return False
        return all(files.get(name) == (path / name).stat().st_size for name in info["required_files"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def get_model_disk_size_mb(model_name: str) -> float:
    path = get_model_path(model_name)
    try:
        total = sum(file.stat().st_size for file in path.rglob("*") if file.is_file())
        return round(total / (1024 * 1024), 1)
    except OSError:
        return 0.0


def get_available_models() -> List[str]:
    return [model_id for model_id in STT_MODELS_CATALOG if is_model_downloaded(model_id)]


def get_models_catalog_status() -> List[Dict[str, Any]]:
    result = []
    public_fields = ("id", "name", "size_mb", "description", "recommended", "engine", "languages", "streaming", "source_url")
    for model_id, info in STT_MODELS_CATALOG.items():
        downloaded = is_model_downloaded(model_id)
        error = compatibility_error(model_id)
        result.append({
            **{key: info[key] for key in public_fields},
            "downloaded": downloaded,
            "disk_size_mb": get_model_disk_size_mb(model_id) if downloaded else 0.0,
            "is_downloading": _download_state["downloading"] and _download_state["model"] == model_id,
            "env_installed": is_env_installed(model_id),
            "supported": error is None, "compatibility_error": error,
        })
    return result


def get_whisper_full_status(active_mode: str, external_url: str, external_model: str, external_key: str, local_model_name: str) -> Dict[str, Any]:
    known = local_model_name in STT_MODELS_CATALOG
    error = compatibility_error(local_model_name) if known else f"Неизвестная локальная модель: {local_model_name}"
    env_ok = known and is_env_installed(local_model_name)
    available = get_available_models()
    local_ready = env_ok and local_model_name in available
    if not error and not env_ok:
        error = "Рабочая среда выбранной модели не установлена. Установите её в настройках."
    elif not error and not local_ready:
        error = f"Модель '{local_model_name}' не скачана. Нажмите «Скачать» в настройках."
    return {
        "connected": local_ready if active_mode == "local" else False,
        "mode": active_mode,
        "local": {
            "env_installed": env_ok, "installing_env": _env_state["installing"],
            "installing_model": _env_state["model"],
            "env_install_progress": _env_state["progress"], "env_install_error": _env_state["error"],
            "selected_model": local_model_name, "engine": STT_MODELS_CATALOG.get(local_model_name, {}).get("engine"),
            "model_ready": local_ready, "error": error,
            "available_models": available, "catalog": get_models_catalog_status(),
            "downloading": _download_state["downloading"], "downloading_model": _download_state["model"],
            "download_status": _download_state["status"], "download_progress_text": _download_state["progress_text"],
            "download_error": _download_state["error"],
        },
        "custom": {"url": external_url, "model": external_model, "has_api_key": bool(external_key and external_key.strip())},
        "ready": local_ready if active_mode == "local" else False,
    }


def _install_packages(model_name: str, progress, include_setup: bool):
    info = get_model_info(model_name)
    packages = list(RUNTIMES[info["engine"]]["packages"])
    if include_setup:
        packages.extend(info.get("setup_packages", ()))
    progress(f"Установка среды {info['engine']}...")
    uv = shutil.which("uv")
    cmd = [uv, "pip", "install", "--python", sys.executable] if uv else [sys.executable, "-m", "pip", "install"]
    proc = subprocess.run([*cmd, *packages], capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError((proc.stderr or proc.stdout or f"Exit code {proc.returncode}")[-1200:])
    importlib.invalidate_caches()
    # Verify real imports in a fresh process without loading heavy packages into
    # the server just to report status. Conversion dependencies are setup-only.
    modules = list(RUNTIMES[info["engine"]]["modules"])
    if include_setup:
        modules.extend(info.get("setup_modules", ()))
    check = subprocess.run([sys.executable, "-c", "; ".join(f"import {name}" for name in modules)], capture_output=True, text=True)
    if check.returncode:
        raise RuntimeError((check.stderr or check.stdout)[-1200:])


def start_install_env(model_name: str = "small") -> Dict[str, Any]:
    get_model_info(model_name)
    if error := compatibility_error(model_name):
        raise RuntimeError(error)
    include_setup = not is_model_downloaded(model_name)
    with _state_lock:
        if _env_state["installing"] or _download_state["downloading"]:
            return {"status": "already_running", "message": "Установка или скачивание уже выполняется"}
        if is_env_installed(model_name, include_setup=include_setup):
            return {"status": "already_installed", "message": "Рабочая среда выбранной модели уже установлена"}
        _env_state.update(installing=True, model=model_name, progress="Запуск установки...", error=None)

    def worker():
        try:
            _install_packages(model_name, lambda message: _env_state.update(progress=message), include_setup)
            _env_state["progress"] = "Установка успешно завершена"
        except Exception as exc:
            _env_state["error"] = f"Ошибка установки: {exc}"
            logger.exception("STT environment installation failed")
        finally:
            with _state_lock:
                _env_state["installing"] = False

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "started", "message": "Установка рабочей среды запущена в фоне"}


def _download_zip(info: dict, target: Path):
    import httpx

    archive = target.parent / (target.name + ".zip")
    try:
        with httpx.stream("GET", info["download_url"], follow_redirects=True, timeout=60) as response:
            response.raise_for_status()
            total = int(response.headers.get("Content-Length", 0))
            received = 0
            with archive.open("wb") as file:
                for chunk in response.iter_bytes(1024 * 1024):
                    file.write(chunk)
                    received += len(chunk)
                    _download_state["progress_text"] = f"Скачивание {info['name']}: {received // (1024 * 1024)} МБ" + (f" / {total // (1024 * 1024)} МБ" if total else "")
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                parts = Path(member.filename).parts
                if not parts or parts[0] != info["archive_root"] or member.is_dir():
                    continue
                relative = Path(*parts[1:])
                destination = target / relative
                if not destination.resolve().is_relative_to(target.resolve()):
                    raise ValueError("Недопустимый путь внутри архива модели")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.open(member) as src, destination.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
    finally:
        archive.unlink(missing_ok=True)


def _download_files(model_name: str, target: Path):
    info = get_model_info(model_name)
    kind = info["download_kind"]
    if kind == "whisper":
        from faster_whisper import download_model

        download_model(model_name, output_dir=str(target))
    elif kind == "snapshot":
        from huggingface_hub import snapshot_download

        snapshot_download(info["repo_id"], revision=info["revision"], local_dir=str(target), allow_patterns=info["allow_patterns"])
    elif kind == "zip":
        _download_zip(info, target)
    else:
        _download_state["status"] = "converting"
        _download_state["progress_text"] = "Скачивание базы и LoRA, конвертация Whisper в INT8. Это может занять несколько минут..."
        converter = Path(__file__).with_name("convert_whisper_lora.py")
        proc = subprocess.run([sys.executable, str(converter), model_name, str(target)], capture_output=True, text=True)
        if proc.returncode:
            raise RuntimeError((proc.stderr or proc.stdout or f"Exit code {proc.returncode}")[-1500:])


def start_download_model(model_name: str) -> Dict[str, Any]:
    get_model_info(model_name)
    if error := compatibility_error(model_name):
        raise RuntimeError(error)
    with _state_lock:
        if _download_state["downloading"] or _env_state["installing"]:
            return {"status": "busy", "message": "Сейчас выполняется установка или скачивание. Дождитесь завершения."}
        if is_model_downloaded(model_name):
            return {"status": "already_downloaded", "message": f"Модель {model_name} уже скачана"}
        _download_state.update(downloading=True, model=model_name, status="downloading", progress_text=f"Подготовка модели {model_name}...", error=None)
    target = get_model_path(model_name)
    staging = target.with_name(f".{model_name}.partial")

    def worker():
        try:
            if not is_env_installed(model_name, include_setup=True):
                _download_state["status"] = "installing_environment"
                _install_packages(model_name, lambda message: _download_state.update(progress_text=message), include_setup=True)
            _download_state.update(status="downloading", progress_text=f"Скачивание весов модели {model_name}...")
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True)
            _download_files(model_name, staging)
            if not _validate_model_files(model_name, staging):
                raise RuntimeError("Не все файлы модели скачаны или конвертация не завершена")
            info = get_model_info(model_name)
            (staging / _COMPLETE_FILE).write_text(json.dumps({
                "model": model_name,
                "files": {name: (staging / name).stat().st_size for name in info["required_files"]},
            }))
            # Publish only after all downloads/conversion have completed.
            with _cache_lock:
                if target.exists():
                    shutil.rmtree(target)
                staging.rename(target)
            _download_state.update(status="completed", progress_text=f"Модель {info['name']} успешно скачана!")
        except Exception as exc:
            logger.exception("Error downloading local STT model %s", model_name)
            _download_state.update(status="error", error=f"Ошибка скачивания: {exc}")
            shutil.rmtree(staging, ignore_errors=True)
        finally:
            with _state_lock:
                _download_state["downloading"] = False

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "started", "model": model_name, "message": f"Скачивание модели {model_name} запущено"}


def delete_downloaded_model(model_name: str) -> Dict[str, Any]:
    target = get_model_path(model_name)
    with _state_lock:
        if _download_state["downloading"] and _download_state["model"] == model_name:
            raise RuntimeError("Нельзя удалить модель во время скачивания")
        with _cache_lock:
            if not target.exists():
                return {"status": "not_found", "message": "Модель не найдена на диске"}
            for key in list(_model_cache):
                if key.split(":", 1)[0] == model_name:
                    del _model_cache[key]
            shutil.rmtree(target)
    return {"status": "deleted", "model": model_name}


def get_cached_model(model_name: str, device: str = "auto"):
    info = get_model_info(model_name)
    if not is_env_installed(model_name):
        raise RuntimeError(compatibility_error(model_name) or "Рабочая среда выбранной модели не установлена")
    if not is_model_downloaded(model_name):
        raise RuntimeError(f"Модель '{model_name}' не скачана локально")
    path = get_model_path(model_name)
    key = f"{model_name}:{device}"
    with _cache_lock:
        if key not in _model_cache:
            _model_cache.clear()
            if info["engine"] == "faster-whisper":
                from faster_whisper import WhisperModel

                model = WhisperModel(str(path), device="cpu" if device in ("auto", "cpu") else device,
                                     compute_type="int8", local_files_only=True)
            else:
                model = local_stt.load_model(info, path, device)
            _model_cache[key] = model
        return _model_cache[key]


def transcribe_local(audio_path: str, model_name: str = "small", device: str = "auto", language: Optional[str] = None, streaming: bool = False) -> Dict[str, Any]:
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")
    info = get_model_info(model_name)
    started = time.monotonic()
    with _cache_lock:
        model = get_cached_model(model_name, device)
        if info["engine"] == "faster-whisper":
            segments_iter, metadata = model.transcribe(
                audio_path, language=local_stt.normalize_language(language), beam_size=1 if streaming else 5,
                vad_filter=True, vad_parameters=dict(min_silence_duration_ms=500),
                condition_on_previous_text=info.get("transcription_options", {}).get("condition_on_previous_text", True),
            )
            segments = [(float(s.start or 0), float(s.end or 0), s.text.strip()) for s in segments_iter]
            duration = float(metadata.duration or 0)
            detected_language = metadata.language
        else:
            segments, duration, detected_language = local_stt.transcribe(model, info, audio_path, device, language)
    logger.info("Local %s transcription finished in %.2fs (%d segments)", info["engine"], time.monotonic() - started, len(segments))
    return local_stt.format_result(segments, duration, detected_language)
