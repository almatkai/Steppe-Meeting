"""Pre-download everything the app needs, so the demo runs with no network.

Run this ONCE while you still have internet. After it finishes, the app makes
no external request: the Whisper weights sit in the local Hugging Face cache
and Ollama serves the language model from disk.

    python download_models.py            # auto-pick a Whisper size
    python download_models.py --model small
    python download_models.py --check     # verify without downloading
"""

import argparse
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

OLLAMA_MODEL = "qwen2.5:latest"


def ok(message: str) -> None:
    print(f"  [OK]   {message}")


def fail(message: str) -> None:
    print(f"  [FAIL] {message}")


def warn(message: str) -> None:
    print(f"  [WARN] {message}")


def check_ffmpeg() -> bool:
    print("\nffmpeg")
    from engine import stt

    path = stt.resolve_ffmpeg()
    if path:
        ok(f"найден: {path}")
        return True
    fail("не найден. Выполните: pip install imageio-ffmpeg")
    return False


def check_whisper(model_size: str, download: bool) -> bool:
    print("\nЛокальный Whisper (faster-whisper)")
    from engine import stt

    if not stt.faster_whisper_available():
        fail("библиотека не установлена. Выполните: pip install faster-whisper")
        return False

    device, compute_type = stt.detect_compute_device()
    ok(f"устройство: {device} ({compute_type})")

    size = model_size or stt.recommended_model(device)
    if device == "cpu" and size in ("large-v3", "large-v2", "medium"):
        warn(f"модель {size} на CPU будет очень медленной. Для демо лучше 'small'")

    if not download:
        print(f"  -> модель, которая будет использована: {size}")
        return True

    print(f"  Загружаю модель '{size}'. Первый раз это несколько минут...")
    try:
        stt.load_whisper_model(size, device, compute_type, allow_download=True)
    except Exception as error:
        fail(str(error))
        return False

    ok(f"модель '{size}' готова и закеширована локально")
    return True


def check_ollama(download: bool) -> bool:
    print("\nOllama (языковая модель)")

    try:
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=4) as response:
            import json

            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError:
        fail("Ollama не отвечает на http://localhost:11434")
        print("         Установите с https://ollama.com/download, затем: ollama serve")
        return False
    except Exception as error:
        fail(f"не удалось опросить Ollama: {error}")
        return False

    models = [m.get("name", "") for m in data.get("models", [])]
    if models:
        ok(f"запущена, модели: {', '.join(models)}")
    else:
        warn("запущена, но ни одна модель не скачана")

    if any(name.startswith(OLLAMA_MODEL.split(":")[0]) for name in models):
        ok(f"{OLLAMA_MODEL} доступна")
        return True

    if not download:
        fail(f"{OLLAMA_MODEL} не скачана. Выполните: ollama pull {OLLAMA_MODEL}")
        return False

    if not shutil.which("ollama"):
        fail(f"команда ollama не найдена в PATH. Выполните вручную: ollama pull {OLLAMA_MODEL}")
        return False

    print(f"  Скачиваю {OLLAMA_MODEL}, это несколько гигабайт...")
    result = subprocess.run(["ollama", "pull", OLLAMA_MODEL])
    if result.returncode != 0:
        fail("ollama pull завершился с ошибкой")
        return False

    ok(f"{OLLAMA_MODEL} скачана")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="", help="Размер модели Whisper (tiny, base, small, medium, large-v3)")
    parser.add_argument("--check", action="store_true", help="Только проверить, ничего не скачивать")
    args = parser.parse_args()

    download = not args.check

    print("=" * 62)
    print("  Steppe Meeting: подготовка к автономной работе")
    print("=" * 62)

    results = [
        check_ffmpeg(),
        check_whisper(args.model, download),
        check_ollama(download),
    ]

    print("\n" + "=" * 62)
    if all(results):
        print("  Всё готово. Приложение может работать без интернета.")
        print("=" * 62)
        return 0

    print("  Есть незакрытые пункты, смотрите [FAIL] выше.")
    print("=" * 62)
    return 1


if __name__ == "__main__":
    sys.exit(main())
