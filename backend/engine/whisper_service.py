"""Local Whisper STT management and inference service.

Handles:
1. Environment detection & on-demand package installation (`faster-whisper`).
2. Model catalog, status detection, background model download and deletion.
3. In-memory model caching & fast local speech-to-text inference.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from app_data import get_app_data_dir

logger = logging.getLogger("steppe.desktop.whisper")

# Catalog of supported Whisper models
WHISPER_MODELS_CATALOG: Dict[str, Dict[str, Any]] = {
    "tiny": {
        "id": "tiny",
        "name": "Tiny",
        "size_mb": 75,
        "description": "Сверхбыстрая, минимальные требования (75 МБ)",
        "recommended": False,
    },
    "base": {
        "id": "base",
        "name": "Base",
        "size_mb": 145,
        "description": "Быстрая базовая модель для простых диалогов (145 МБ)",
        "recommended": False,
    },
    "small": {
        "id": "small",
        "name": "Small",
        "size_mb": 480,
        "description": "Рекомендуется: отличный баланс качества для русского и казахского (480 МБ)",
        "recommended": True,
    },
    "medium": {
        "id": "medium",
        "name": "Medium",
        "size_mb": 1500,
        "description": "Высокая точность распознавания профессиональной речи (1.5 ГБ)",
        "recommended": False,
    },
    "large-v3-turbo": {
        "id": "large-v3-turbo",
        "name": "Large v3 Turbo",
        "size_mb": 1600,
        "description": "Максимальное качество и скорость последнего поколения (1.6 ГБ)",
        "recommended": False,
    },
}

# State trackers
_env_state = {
    "installing": False,
    "progress": "",
    "error": None,
    "last_installed": False,
}

_download_state = {
    "downloading": False,
    "model": None,
    "status": "idle",
    "progress_text": "",
    "error": None,
}

_model_cache: Dict[str, Any] = {}
_cache_lock = threading.Lock()


def is_env_installed() -> bool:
    """Check if faster-whisper is importable in the current Python environment."""
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def get_whisper_models_dir() -> Path:
    """Return the directory where local Whisper model weights are stored."""
    models_dir = get_app_data_dir() / "models" / "whisper"
    models_dir.mkdir(parents=True, exist_ok=True)
    return models_dir


def get_model_path(model_name: str) -> Path:
    """Return path to model folder inside local app data."""
    return get_whisper_models_dir() / model_name


def is_model_downloaded(model_name: str) -> bool:
    """Check if model files exist on disk and are complete."""
    p = get_model_path(model_name)
    if not p.is_dir():
        return False
    bin_file = p / "model.bin"
    if not bin_file.is_file():
        return False
    # Model binary should be larger than 5 MB
    return bin_file.stat().st_size > 5 * 1024 * 1024


def get_model_disk_size_mb(model_name: str) -> float:
    """Calculate total size of model directory in MB."""
    p = get_model_path(model_name)
    if not p.is_dir():
        return 0.0
    total = sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
    return round(total / (1024 * 1024), 1)


def get_available_models() -> List[str]:
    """Return list of model ids that are currently downloaded."""
    available = []
    for model_id in WHISPER_MODELS_CATALOG:
        if is_model_downloaded(model_id):
            available.append(model_id)
    return available


def get_models_catalog_status() -> List[Dict[str, Any]]:
    """Return full catalog with download status and disk sizes."""
    result = []
    for model_id, info in WHISPER_MODELS_CATALOG.items():
        downloaded = is_model_downloaded(model_id)
        disk_size = get_model_disk_size_mb(model_id) if downloaded else 0.0
        result.append({
            **info,
            "downloaded": downloaded,
            "disk_size_mb": disk_size,
            "is_downloading": (_download_state["downloading"] and _download_state["model"] == model_id),
        })
    return result


def get_whisper_full_status(active_mode: str, external_url: str, external_model: str, external_key: str, local_model_name: str) -> Dict[str, Any]:
    """Comprehensive status object for the Whisper STT service."""
    env_ok = is_env_installed()
    available = get_available_models()
    local_ready = env_ok and (local_model_name in available)

    return {
        "mode": active_mode,
        "local": {
            "env_installed": env_ok,
            "installing_env": _env_state["installing"],
            "env_install_progress": _env_state["progress"],
            "env_install_error": _env_state["error"],
            "selected_model": local_model_name,
            "model_ready": local_ready,
            "available_models": available,
            "catalog": get_models_catalog_status(),
            "downloading": _download_state["downloading"],
            "downloading_model": _download_state["model"],
            "download_status": _download_state["status"],
            "download_progress_text": _download_state["progress_text"],
            "download_error": _download_state["error"],
        },
        "custom": {
            "url": external_url,
            "model": external_model,
            "has_api_key": bool(external_key and external_key.strip()),
        },
        "ready": local_ready if active_mode == "local" else False,
    }


def start_install_env() -> Dict[str, Any]:
    """Trigger background installation of faster-whisper into current python."""
    if is_env_installed():
        return {"status": "already_installed", "message": "Рабочая среда faster-whisper уже установлена"}

    if _env_state["installing"]:
        return {"status": "already_running", "message": "Установка уже выполняется"}

    def _worker():
        _env_state["installing"] = True
        _env_state["progress"] = "Запуск установки пакета faster-whisper..."
        _env_state["error"] = None
        logger.info("Starting background install of faster-whisper...")

        uv_bin = shutil.which("uv")
        python_bin = sys.executable

        try:
            if uv_bin:
                _env_state["progress"] = "Установка зависимостей через uv..."
                cmd = [uv_bin, "pip", "install", "faster-whisper", "--python", python_bin]
            else:
                _env_state["progress"] = "Установка зависимостей через pip..."
                cmd = [python_bin, "-m", "pip", "install", "faster-whisper"]

            logger.info("Running install command: %s", " ".join(cmd))
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            if proc.returncode != 0:
                err_msg = proc.stderr.strip() or proc.stdout.strip() or f"Exit code {proc.returncode}"
                _env_state["error"] = f"Ошибка установки: {err_msg[:400]}"
                logger.error("faster-whisper installation failed: %s", err_msg)
            else:
                _env_state["progress"] = "Установка успешно завершена"
                logger.info("faster-whisper successfully installed!")
        except Exception as e:
            _env_state["error"] = str(e)
            logger.exception("Unexpected error during faster-whisper installation")
        finally:
            _env_state["installing"] = False

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()
    return {"status": "started", "message": "Установка рабочей среды запущена в фоне"}


def start_download_model(model_name: str) -> Dict[str, Any]:
    """Trigger background download of a Whisper model."""
    if model_name not in WHISPER_MODELS_CATALOG:
        raise ValueError(f"Неизвестная модель '{model_name}'. Допустимые: {list(WHISPER_MODELS_CATALOG.keys())}")

    if not is_env_installed():
        raise RuntimeError("Сначала установите рабочую среду faster-whisper")

    if is_model_downloaded(model_name):
        return {"status": "already_downloaded", "message": f"Модель {model_name} уже скачана"}

    if _download_state["downloading"]:
        return {
            "status": "busy",
            "message": f"Сейчас уже скачивается модель {_download_state['model']}. Дождитесь завершения.",
        }

    target_dir = get_model_path(model_name)

    def _download_worker():
        _download_state["downloading"] = True
        _download_state["model"] = model_name
        _download_state["status"] = "downloading"
        _download_state["progress_text"] = f"Скачивание весов модели {model_name}..."
        _download_state["error"] = None
        logger.info("Starting model download for %s into %s", model_name, target_dir)

        try:
            from faster_whisper import download_model

            target_dir.mkdir(parents=True, exist_ok=True)
            download_model(model_name, output_dir=str(target_dir))

            # Verify model.bin exists
            if is_model_downloaded(model_name):
                _download_state["status"] = "completed"
                _download_state["progress_text"] = f"Модель {model_name} успешно скачана!"
                logger.info("Model %s downloaded successfully", model_name)
            else:
                _download_state["status"] = "error"
                _download_state["error"] = "Файлы модели повреждены или не найдены после скачивания"
        except Exception as e:
            logger.exception("Error downloading model %s", model_name)
            _download_state["status"] = "error"
            _download_state["error"] = f"Ошибка скачивания: {str(e)[:300]}"
            # Cleanup broken directory
            if target_dir.is_dir() and not is_model_downloaded(model_name):
                shutil.rmtree(target_dir, ignore_errors=True)
        finally:
            _download_state["downloading"] = False

    thread = threading.Thread(target=_download_worker, daemon=True)
    thread.start()
    return {"status": "started", "model": model_name, "message": f"Скачивание модели {model_name} запущено"}


def delete_downloaded_model(model_name: str) -> Dict[str, Any]:
    """Delete a downloaded model to free disk space."""
    target_dir = get_model_path(model_name)
    if not target_dir.exists():
        return {"status": "not_found", "message": "Модель не найдена на диске"}

    # Evict from cache if loaded
    with _cache_lock:
        keys_to_remove = [k for k in _model_cache if k.startswith(model_name)]
        for k in keys_to_remove:
            del _model_cache[k]

    shutil.rmtree(target_dir, ignore_errors=True)
    logger.info("Deleted model %s from %s", model_name, target_dir)
    return {"status": "deleted", "model": model_name}


def get_cached_model(model_name: str, device: str = "auto"):
    """Return cached WhisperModel instance or instantiate a new one."""
    if not is_env_installed():
        raise RuntimeError("Рабочая среда faster-whisper не установлена")

    if not is_model_downloaded(model_name):
        raise RuntimeError(f"Модель Whisper '{model_name}' не скачана локально")

    from faster_whisper import WhisperModel

    model_dir = str(get_model_path(model_name))
    cache_key = f"{model_name}:{device}"

    with _cache_lock:
        if cache_key in _model_cache:
            return _model_cache[cache_key]

        # Determine compute type for optimal performance
        compute_type = "int8"
        actual_device = "cpu" if device in ("auto", "cpu") else device

        logger.info("Instantiating WhisperModel from %s (device=%s, compute=%s)...", model_dir, actual_device, compute_type)
        model = WhisperModel(
            model_dir,
            device=actual_device,
            compute_type=compute_type,
            local_files_only=True,
        )
        _model_cache[cache_key] = model
        return model


def transcribe_local(
    audio_path: str,
    model_name: str = "small",
    device: str = "auto",
    language: Optional[str] = None,
) -> Dict[str, Any]:
    """Run local speech-to-text inference with faster-whisper."""
    if not os.path.exists(audio_path):
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    model = get_cached_model(model_name=model_name, device=device)

    lang_arg = None
    if language and language in ("ru", "kz", "en"):
        # Kazakh language code in whisper is 'kk' or 'kz'
        lang_arg = "kk" if language == "kz" else language

    logger.info("Running local transcription on %s with model %s (lang=%s)...", audio_path, model_name, lang_arg)
    start_time = time.time()

    segments_iter, info = model.transcribe(
        audio_path,
        language=lang_arg,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    segments = []
    text_pieces = []

    for idx, s in enumerate(segments_iter):
        start_sec = float(s.start or 0.0)
        end_sec = float(s.end or 0.0)
        start_str = time.strftime("%H:%M:%S", time.gmtime(max(0.0, start_sec)))
        text = s.text.strip()
        speaker = f"Спикер {(idx % 3) + 1}"

        if text:
            text_pieces.append(text)
            segments.append({
                "index": idx,
                "speaker": speaker,
                "text": text,
                "timestamp_start": round(start_sec, 2),
                "timestamp_end": round(end_sec, 2),
                "timestamp_str": f"[{start_str}]",
            })

    elapsed = time.time() - start_time
    full_text = "\n".join(
        f"[{s['speaker']}] {s['timestamp_str']}\n{s['text']}\n" for s in segments
    ) or "\n".join(text_pieces)

    total_duration = float(info.duration) if hasattr(info, "duration") and info.duration else 0.0
    if not total_duration and segments:
        total_duration = max((s["timestamp_end"] for s in segments), default=0.0)

    logger.info(
        "Local transcription finished in %.2fs (audio duration: %.1fs, segments: %d, lang: %s)",
        elapsed, total_duration, len(segments), getattr(info, "language", "unknown")
    )

    return {
        "text": full_text,
        "segments": segments,
        "duration": total_duration,
        "language": getattr(info, "language", language),
    }
