"""Download sources and runtime requirements for offline speech recognition."""

from __future__ import annotations

import platform
import sys
from typing import Any


RUNTIMES = {
    "faster-whisper": {
        "modules": ("faster_whisper",),
        "packages": ("faster-whisper>=1.2,<2",),
    },
    "gigaam-mlx": {
        "modules": ("faster_whisper", "gigaam_multilingual_mlx", "mlx.core"),
        "packages": ("faster-whisper>=1.2,<2", "gigaam-multilingual-mlx==0.1.5"),
    },
    "wav2vec2-ctc": {
        "modules": ("faster_whisper", "torch"),
        "packages": ("faster-whisper>=1.2,<2", "torch>=2.9,<3"),
    },
    "vosk": {
        "modules": ("faster_whisper", "vosk"),
        # 0.3.44 is the latest release with a macOS universal2 wheel.
        "packages": ("faster-whisper>=1.2,<2", "vosk>=0.3.44,<0.4"),
    },
}

STT_MODELS_CATALOG: dict[str, dict[str, Any]] = {}
for model_id, name, size, description in (
    ("tiny", "Whisper Tiny", 75, "Минимальные требования, быстрое распознавание"),
    ("base", "Whisper Base", 145, "Быстрая базовая модель для простых диалогов"),
    ("small", "Whisper Small", 480, "Баланс скорости и качества для русского и казахского"),
    ("medium", "Whisper Medium", 1500, "Высокая точность распознавания профессиональной речи"),
    ("large-v3-turbo", "Whisper Large v3 Turbo", 1600, "Многоязычная модель, включая казахский, русский и английский"),
):
    STT_MODELS_CATALOG[model_id] = {
        "id": model_id, "name": name, "size_mb": size, "description": description,
        "recommended": model_id == "small", "engine": "faster-whisper",
        "languages": ["kk", "ru", "en", "uz"], "streaming": "chunked",
        "source_url": "https://huggingface.co/" + ("mobiuslabsgmbh" if model_id == "large-v3-turbo" else "Systran") + "/faster-whisper-" + model_id,
        "download_kind": "whisper",
        "required_files": ("model.bin", "config.json", "tokenizer.json"),
    }

for bits, size, revision in (
    (4, 447, "5ff4bb49a64b1da65dc8896e69031aa443ae589f"),
    (6, 573, "022428cf79b5e5779b60bfb4efcab4da2098f433"),
    (8, 699, "626d938ebab64e81ffdd1e9abbda77d04e1064f1"),
):
    model_id = f"gigaam-multilingual-int{bits}"
    repo = f"ai-babai/gigaam-multilingual-mlx-int{bits}-g64"
    STT_MODELS_CATALOG[model_id] = {
        "id": model_id, "name": f"GigaAM Multilingual INT{bits} (MLX)",
        "size_mb": size, "description": "Apple Silicon: русский, казахский, кыргызский, узбекский; английский ограничен",
        "recommended": bits == 8, "engine": "gigaam-mlx",
        "languages": ["ru", "kk", "ky", "uz", "en"], "streaming": "chunked",
        "source_url": f"https://huggingface.co/{repo}", "repo_id": repo,
        "revision": revision, "download_kind": "snapshot",
        "required_files": ("config.json", "manifest.json", "model.safetensors"),
        "allow_patterns": ["config.json", "manifest.json", "model.safetensors", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    }

for language, label, size in (("kk", "Kazakh", 360), ("ru", "Russian", 360), ("rukk", "Kazakh + Russian Mixed", 721)):
    model_id = f"wav2vec2-{language}"
    files = (f"asr/{language}/model.pt", f"asr/{language}/tokens.lst")
    STT_MODELS_CATALOG[model_id] = {
        "id": model_id, "name": f"Wav2Vec2 {label}", "size_mb": size,
        "description": "Компактная CPU-модель alibiserikbay; VAD и порционное распознавание, greedy CTC",
        "recommended": False, "engine": "wav2vec2-ctc",
        "languages": ["kk", "ru"] if language == "rukk" else [language],
        "streaming": "chunked", "language": "multi" if language == "rukk" else language,
        "source_url": "https://huggingface.co/alibiserikbay/kazakh-russian-mixed-stt",
        "repo_id": "alibiserikbay/kazakh-russian-mixed-stt",
        "revision": "26298d2a61dc1573bfc11b7055c7d09a1e64b8a4",
        "download_kind": "snapshot", "required_files": files,
        "allow_patterns": [*files, "LICENSE", "README.md"],
    }

STT_MODELS_CATALOG["whisper-turbo-kaz-rus-v1"] = {
    "id": "whisper-turbo-kaz-rus-v1", "name": "Whisper Turbo Kazakh + Russian (INT8)",
    "size_mb": 850,
    "description": "abilmansplus: LoRA объединяется с базовой моделью и конвертируется в INT8. Первая установка требует ~5 ГБ свободного диска и дополнительной памяти",
    "recommended": False, "engine": "faster-whisper", "languages": ["kk", "ru", "en"],
    "streaming": "chunked", "download_kind": "whisper-lora",
    "source_url": "https://huggingface.co/abilmansplus/whisper-turbo-kaz-rus-v1",
    "repo_id": "abilmansplus/whisper-turbo-kaz-rus-v1",
    "revision": "904d5d22339952909001d1abcbc1ecf29d26d706",
    "base_repo_id": "abilmansplus/whisper-turbo-ksc2",
    "base_revision": "92847d02bbdb4311e4c85d9d3b4c7f82e31e59bf",
    "required_files": ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json"),
    "setup_modules": ("torch", "transformers", "peft"),
    "setup_packages": ("torch>=2.9,<3", "transformers>=4.57.1,<5", "peft>=0.18,<0.19"),
}

for language, version, size, label in (
    ("ru", "0.22", 45, "Russian"), ("kz", "0.42", 58, "Kazakh"),
    ("en-us", "0.15", 40, "English"), ("ky", "0.42", 49, "Kyrgyz"),
    ("uz", "0.22", 49, "Uzbek"),
):
    model_id = f"vosk-small-{language}"
    archive_root = f"vosk-model-small-{language}-{version}"
    STT_MODELS_CATALOG[model_id] = {
        "id": model_id, "name": f"Vosk Small {label}", "size_mb": size,
        "description": "Лёгкая CPU-модель с потоковым распознаванием; фиксированный язык",
        "recommended": False, "engine": "vosk", "streaming": "native",
        "languages": [{"kz": "kk", "en-us": "en"}.get(language, language)],
        "language": {"kz": "kk", "en-us": "en"}.get(language, language),
        "source_url": "https://alphacephei.com/vosk/models",
        "download_kind": "zip", "archive_root": archive_root,
        "download_url": f"https://alphacephei.com/vosk/models/{archive_root}.zip",
        "required_files": ("am/final.mdl", "conf/mfcc.conf", "conf/model.conf", "graph/Gr.fst", "graph/HCLr.fst"),
    }


def get_model_info(model_id: str) -> dict[str, Any]:
    if model_id not in STT_MODELS_CATALOG:
        raise ValueError(f"Неизвестная локальная модель: {model_id}")
    return STT_MODELS_CATALOG[model_id]


def compatibility_error(model_id: str) -> str | None:
    if get_model_info(model_id)["engine"] == "gigaam-mlx":
        if sys.platform != "darwin" or platform.machine().lower() != "arm64":
            return "GigaAM MLX требует Apple Silicon и ARM-версию Python"
        if not (3, 12) <= sys.version_info[:2] < (3, 14):
            return "GigaAM MLX требует Python 3.12 или 3.13"
        version = platform.mac_ver()[0]
        if version and int(version.split(".")[0]) < 14:
            return "GigaAM MLX требует macOS 14 или новее"
    return None
