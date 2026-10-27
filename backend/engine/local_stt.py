"""Native MLX, TorchScript CTC, and Vosk inference adapters.

All engines return the same timed segments consumed by the meeting pipeline.
Audio decoding uses PyAV (bundled with faster-whisper), including MP3/M4A/WebM.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

SAMPLE_RATE = 16_000


def normalize_language(language: str | None) -> str | None:
    if not language or language in ("multi", "auto"):
        return None
    return "kk" if language == "kz" else language


def load_model(info: dict[str, Any], path: Path, device: str) -> Any:
    engine = info["engine"]
    if engine == "gigaam-mlx":
        import mlx.core as mx
        from gigaam_multilingual_mlx import load_model as load_gigaam

        with mx.stream(mx.new_stream(mx.cpu if device == "cpu" else mx.gpu)):
            return load_gigaam(str(path), local_files_only=True)
    if engine == "wav2vec2-ctc":
        import torch

        model = torch.jit.load(str(path / info["required_files"][0]), map_location="cpu").eval()
        tokens = {}
        for line in (path / info["required_files"][1]).read_text(encoding="utf-8").splitlines():
            if line.strip():
                symbol, index = line.split("\t")
                tokens[int(index)] = symbol
        return model, tokens, max(tokens) + 1
    if engine == "vosk":
        from vosk import Model

        return Model(str(path))
    raise ValueError(f"Unsupported STT engine: {engine}")


def speech_chunks(audio):
    """Bound CTC inference memory while retaining offsets in the original recording."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    for span in get_speech_timestamps(audio, VadOptions(
        min_speech_duration_ms=100, max_speech_duration_s=20,
        min_silence_duration_ms=500, speech_pad_ms=200,
    )):
        # Padding around VAD boundaries can extend a span past the maximum.
        for start in range(span["start"], span["end"], 20 * SAMPLE_RATE):
            end = min(start + 20 * SAMPLE_RATE, span["end"])
            yield start, end, audio[start:end]


def decode_ctc(ids, tokens: dict[int, str], blank: int) -> str:
    previous = None
    pieces = []
    for token in ids:
        if token != previous and token != blank:
            pieces.append(tokens.get(token, ""))
        previous = token
    return re.sub(r"\s+", " ", "".join(pieces).replace("|", " ").replace("_", " ")).strip()


def transcribe(model: Any, info: dict[str, Any], audio_path: str, device: str, language: str | None):
    import numpy as np
    from faster_whisper.audio import decode_audio

    language = normalize_language(language)
    fixed_language = info.get("language")
    if fixed_language and fixed_language != "multi" and language and language != fixed_language:
        raise ValueError(f"Модель {info['name']} распознаёт только {fixed_language}; выберите подходящую модель или язык встречи")
    audio = decode_audio(audio_path, sampling_rate=SAMPLE_RATE)
    duration = len(audio) / SAMPLE_RATE
    engine = info["engine"]
    segments = []

    if engine == "vosk":
        from vosk import KaldiRecognizer

        recognizer = KaldiRecognizer(model, SAMPLE_RATE)
        recognizer.SetWords(True)

        def add_result(raw):
            result = json.loads(raw)
            words = result.get("result", [])
            if result.get("text", "").strip() and words:
                segments.append((float(words[0]["start"]), float(words[-1]["end"]), result["text"].strip()))

        # Feed the native streaming recognizer 250 ms of mono signed PCM at a time.
        for start in range(0, len(audio), 4000):
            pcm = (np.clip(audio[start:start + 4000], -1, 1) * 32767).astype("<i2").tobytes()
            if recognizer.AcceptWaveform(pcm):
                add_result(recognizer.Result())
        add_result(recognizer.FinalResult())
    else:
        for start, end, chunk in speech_chunks(audio):
            # The feature extractors need a minimum input length.
            if len(chunk) < 3200:
                chunk = np.pad(chunk, (0, 3200 - len(chunk)))
            if engine == "wav2vec2-ctc":
                import torch

                acoustic_model, tokens, blank = model
                with torch.inference_mode():
                    output = acoustic_model(torch.from_numpy(chunk).unsqueeze(0))
                    logits = output[0] if isinstance(output, (tuple, list)) else output
                    text = decode_ctc(logits[0].argmax(-1).tolist(), tokens, blank)
            else:
                import mlx.core as mx

                with mx.stream(mx.new_stream(mx.cpu if device == "cpu" else mx.gpu)):
                    logits, lengths = model(mx.array(chunk[None, :], dtype=mx.float32))
                    text = model.greedy_decode(logits, lengths)[0]["text"].strip()
            if text:
                segments.append((start / SAMPLE_RATE, end / SAMPLE_RATE, text))

    detected_language = fixed_language or language or "multi"
    return segments, duration, detected_language


def format_result(timed_segments, duration: float, language: str | None) -> dict[str, Any]:
    """Format the existing transcript contract without inventing speaker changes."""
    segments = []
    for start, end, text in timed_segments:
        if not text.strip():
            continue
        seconds = max(0, int(start))
        timestamp = f"[{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}]"
        segments.append({
            "index": len(segments), "speaker": "Спикер 1", "text": text.strip(),
            "timestamp_start": round(start, 2), "timestamp_end": round(end, 2),
            "timestamp_str": timestamp,
        })
    return {
        "text": "\n".join(f"[{s['speaker']}] {s['timestamp_str']}\n{s['text']}\n" for s in segments),
        "segments": segments, "duration": duration, "language": language,
    }
