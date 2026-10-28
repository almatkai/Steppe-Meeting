"""Shared, tested STT codec profile and a model-free readiness probe.

PyAV 19 removed metadata_errors from av.open; faster-whisper 1.2.1 uses it.
https://github.com/PyAV-Org/PyAV/blob/v19.0.0/CHANGELOG.rst
Keep these pins together until a newer pair passes the packaged codec smoke.
"""
from __future__ import annotations

from functools import lru_cache
import importlib.metadata
import io
from pathlib import Path
import subprocess
import sys
import wave

STT_CODEC_VERSIONS = {"faster-whisper": "1.2.1", "av": "18.1.0"}
STT_CODEC_PACKAGES = tuple(f"{name}=={version}" for name, version in STT_CODEC_VERSIONS.items())
REPAIR_MESSAGE = 'Откройте Настройки → STT и нажмите «Установить среду». Скачанные модели сохранятся.'


def decode_probe():
    """Exercise the exact faster-whisper decoder with 0.1s synthetic PCM."""
    from faster_whisper.audio import decode_audio

    audio = io.BytesIO()
    with wave.open(audio, "wb") as output:
        output.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * 1600)
    audio.seek(0)
    decoded = decode_audio(audio, sampling_rate=16000)
    if len(decoded) != 1600:
        raise RuntimeError(f"Expected 1600 decoded samples, got {len(decoded)}")


@lru_cache(maxsize=8)
def _codec_probe(versions: tuple[str, ...]) -> str | None:
    # A subprocess avoids loading native inference libraries in the status API
    # and sees newly repaired wheels instead of stale modules in sys.modules.
    try:
        result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "--probe"],
                                capture_output=True, text=True, timeout=20)
        if result.returncode:
            return f"Проверка декодирования аудио в среде STT не пройдена. {REPAIR_MESSAGE}"
    except (OSError, subprocess.TimeoutExpired):
        return f"Не удалось проверить декодер аудио STT. {REPAIR_MESSAGE}"
    return None


def codec_error() -> str | None:
    versions = []
    for name, expected in STT_CODEC_VERSIONS.items():
        try:
            actual = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            return f"Не установлен пакет {name} для STT. {REPAIR_MESSAGE}"
        if actual != expected:
            return f"Несовместимая среда STT: {name} {actual}, требуется {expected}. {REPAIR_MESSAGE}"
        versions.append(actual)
    return _codec_probe(tuple(versions))


if __name__ == "__main__":
    decode_probe()
    print("PASS faster-whisper synthetic WAV: 1600 samples")
