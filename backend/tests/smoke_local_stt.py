"""Opt-in real offline inference check; downloads only with --download.

Example (from the repo root):
  backend/.venv/bin/python backend/tests/smoke_local_stt.py \
    --model wav2vec2-rukk --audio sample.wav --language multi --expect қазақстан
"""

import argparse
import json
import socket
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import whisper_service as stt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=stt.STT_MODELS_CATALOG)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="multi")
    parser.add_argument("--expect", action="append", default=[])
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    if not Path(args.audio).is_file():
        parser.error("Audio file does not exist")
    if args.download:
        action = stt.start_download_model(args.model)
        if action["status"] == "busy":
            raise RuntimeError(action["message"])
        deadline = time.monotonic() + 1800
        previous = None
        while stt._download_state["downloading"]:
            progress = stt._download_state["progress_text"]
            if progress != previous:
                print(progress, flush=True)
                previous = progress
            if time.monotonic() > deadline:
                raise TimeoutError("Model setup/download exceeded 30 minutes")
            time.sleep(1)
    if not stt.is_model_downloaded(args.model):
        raise RuntimeError(stt._download_state["error"] or "Download this model in settings or pass --download")
    started = time.monotonic()
    with patch.object(socket.socket, "connect", side_effect=AssertionError("Inference attempted network access")):
        result = stt.transcribe_local(args.audio, args.model, language=args.language)
    text = " ".join(segment["text"] for segment in result["segments"]).casefold()
    assert text, "No speech was recognized"
    for phrase in args.expect:
        assert phrase.casefold() in text, f"Expected transcript to contain {phrase!r}: {text}"
    assert all(0 <= segment["timestamp_start"] < segment["timestamp_end"] <= result["duration"] + 0.1
               for segment in result["segments"]), "Invalid timestamps"
    print(json.dumps({"elapsed_seconds": round(time.monotonic() - started, 2), **result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
