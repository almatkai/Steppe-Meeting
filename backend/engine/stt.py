"""Speech to text pipeline for Steppe Meeting Desktop.

The old implementation posted the raw upload straight at a Whisper endpoint with
a hard coded ``audio/mpeg`` content type, no Authorization header, a single 600
second timeout and no progress reporting. A one hour meeting recorded as MP4
therefore uploaded hundreds of megabytes of video, timed out, and surfaced as a
bare exception string.

This module replaces that with:

* ffmpeg normalisation, so video containers and exotic codecs become a 16 kHz
  mono WAV before anything is uploaded,
* chunking, so long meetings are transcribed in pieces with timestamps stitched
  back together,
* bearer auth, so hosted providers (Groq, OpenAI, any OpenAI compatible server)
  work identically to a local Whisper server,
* progress callbacks, so the UI can show real percentages instead of a spinner.

Everything degrades: without ffmpeg the original file is posted as before, just
with a correct content type and working auth.
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from inspect import isawaitable
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import httpx

logger = logging.getLogger("steppe.stt")

# Chunk length in seconds. Ten minutes keeps each upload well under the request
# size limits hosted providers impose (Groq caps at 25 MB, which is roughly 40
# minutes of 16 kHz mono WAV) while keeping the number of round trips low.
DEFAULT_CHUNK_SECONDS = 600

# A pause longer than this between two Whisper segments is treated as a speaker
# turn boundary. Tuned against meeting recordings: below ~0.6s it fires on
# ordinary breathing pauses, above ~1.5s it merges genuine handovers.
DEFAULT_PAUSE_THRESHOLD = 0.9

PROGRESS_PREPARE = 5.0
PROGRESS_TRANSCRIBE_START = 10.0
PROGRESS_TRANSCRIBE_END = 92.0


class STTError(Exception):
    """Raised when transcription cannot be completed.

    Carries a message that is safe and useful to show the user directly, rather
    than a raw traceback string.
    """


# ---------------------------------------------------------------------------
# Built-in offline transcription
#
# faster-whisper runs the model inside this process, so transcription makes no
# network request at all and needs no second server. That is what lets the app
# claim full offline operation honestly: there is no endpoint to point at, so
# there is nothing to accidentally send audio to.
# ---------------------------------------------------------------------------

_whisper_model = None
_whisper_model_key: Optional[Tuple[str, str, str]] = None


def faster_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def detect_compute_device() -> Tuple[str, str]:
    """Pick the best device and precision available on this machine."""
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception as error:
        logger.debug("CUDA probe failed, using CPU: %s", error)
    return "cpu", "int8"


def query_gpu_memory_mb() -> Optional[int]:
    """Total VRAM on the first GPU, or None when it cannot be determined."""
    try:
        result = _run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            timeout=10.0,
        )
    except Exception as error:
        logger.debug("nvidia-smi unavailable: %s", error)
        return None

    if result.returncode != 0:
        return None

    first = (result.stdout or "").strip().splitlines()
    if not first:
        return None
    try:
        return int(first[0].strip())
    except ValueError:
        return None


def release_whisper_model() -> bool:
    """Drop the cached model so its VRAM goes back to the pool.

    Transcription and protocol generation run back to back, and the language
    model in Ollama wants the same GPU memory the Whisper weights are sitting
    in. On a card where both do not fit, holding the transcriber resident is
    what makes generation fail.
    """
    global _whisper_model, _whisper_model_key

    if _whisper_model is None:
        return False

    _whisper_model = None
    _whisper_model_key = None

    import gc

    gc.collect()
    logger.info("Released the local Whisper model, VRAM returned to the pool")
    return True


def should_release_after_use(device: str) -> bool:
    """Free the transcriber between stages only when the GPU is too small for both.

    Roughly: large-v3 in float16 needs about 4.5 GB and a 7B language model
    another 5 GB, so anything under 12 GB is where they start fighting.
    """
    if device != "cuda":
        return False
    total = query_gpu_memory_mb()
    if total is None:
        return True  # unknown card, so be safe
    tight = total < 12000
    logger.info("GPU has %d MB VRAM, release-between-stages=%s", total, tight)
    return tight


def recommended_model(device: str) -> str:
    """Larger models are only worth it when there is a GPU to run them.

    On CPU `small` is the point where Russian and Kazakh are still usable while
    a two minute clip finishes in well under a minute, which is what the demo
    is timed on.
    """
    return "large-v3" if device == "cuda" else "small"


def load_whisper_model(
    model_size: str = "",
    device: str = "",
    compute_type: str = "",
    allow_download: bool = False,
):
    """Load and cache the local Whisper model.

    ``allow_download`` is off by default so normal operation never reaches the
    network; the setup script turns it on for the one-time fetch.
    """
    global _whisper_model, _whisper_model_key

    if not faster_whisper_available():
        raise STTError(
            "Локальная модель распознавания не установлена. "
            "Выполните: pip install faster-whisper"
        )

    from faster_whisper import WhisperModel

    if not device:
        device, auto_compute = detect_compute_device()
        compute_type = compute_type or auto_compute
    compute_type = compute_type or "int8"
    model_size = model_size or recommended_model(device)

    key = (model_size, device, compute_type)
    if _whisper_model is not None and _whisper_model_key == key:
        return _whisper_model

    logger.info("Loading local Whisper model %s on %s (%s)", model_size, device, compute_type)

    # Load from the local cache only. Without this, faster-whisper contacts
    # Hugging Face on every load to compare revisions: a request that leaves the
    # machine even though the weights are already on disk, and one that stalls
    # startup when the venue network is down. Falling back to an online load
    # keeps the very first download working.
    try:
        _whisper_model = WhisperModel(
            model_size, device=device, compute_type=compute_type, local_files_only=True
        )
    except Exception as offline_error:
        if not allow_download:
            raise STTError(
                f"Модель '{model_size}' не найдена в локальном кеше. "
                "Запустите backend/download_models.py при наличии интернета."
            ) from offline_error

        logger.info("Model not cached yet, downloading '%s' once", model_size)
        try:
            _whisper_model = WhisperModel(model_size, device=device, compute_type=compute_type)
        except Exception as error:
            raise STTError(
                f"Не удалось загрузить локальную модель '{model_size}': {error}. "
                "Если модель ещё не скачана, запустите backend/download_models.py при наличии интернета."
            ) from error

    _whisper_model_key = key
    return _whisper_model


class DecodeStalled(Exception):
    """The decoder produced nothing for long enough that it is not coming back."""


# How long to wait for the FIRST segment before deciding the device is wedged.
# A healthy GPU emits one within a couple of seconds; a broken cuDNN install
# loads the weights fine and then hangs forever inside the encoder, which is
# exactly the failure this guards against.
FIRST_SEGMENT_TIMEOUT = 75.0
# Ceiling on the whole decode, generous enough for a long meeting on CPU.
TOTAL_DECODE_TIMEOUT = 1800.0


async def _invoke_report(report, percent: float, label: str) -> None:
    """Call a progress hook that may be sync, async, or a no-op returning None.

    Self-test and some callers pass ``lambda p, l: None``. Awaiting that
    outcome raises ``TypeError: object NoneType can't be used in 'await'
    expression``. Only await when the hook actually returned a coroutine.
    """
    if report is None:
        return
    outcome = report(percent, label)
    if isawaitable(outcome):
        await outcome


def _decode_sync(
    model,
    audio_path: str,
    language: Optional[str],
    beam_size: int,
    sink: List[Any],
) -> bool:
    """Run the decode, pushing each segment into ``sink`` as it appears.

    Results go through the shared list rather than a return value so the event
    loop can watch progress, and abandon the thread if it wedges.

    faster-whisper's ``transcribe`` is synchronous; callers must run this
    function in a worker via ``asyncio.to_thread``. Always returns a bool so
    the thread future is never ``None``.
    """
    try:
        segments_iter, info = model.transcribe(
            audio_path,
            language=language,      # None lets the model auto-detect mixed RU/KZ speech
            beam_size=beam_size,
            vad_filter=True,        # drop silence: faster, and stops the model
            vad_parameters={"min_silence_duration_ms": 500},
            condition_on_previous_text=False,  # stops it looping on repeated phrases
        )

        total = float(getattr(info, "duration", 0.0) or 0.0)
        sink.append(("duration", total))

        for segment in segments_iter:
            text = (segment.text or "").strip()
            if not text:
                continue
            sink.append(("segment", {
                "text": text,
                "start": float(segment.start or 0.0),
                "end": float(segment.end or 0.0),
                "speaker": None,
            }))

        sink.append(("done", None))
        return True
    except Exception as error:  # surfaced by the watcher
        sink.append(("error", error))
        return False


async def _decode_on_device(
    audio_path: str,
    *,
    model_size: str,
    device: str,
    compute_type: str,
    language: Optional[str],
    beam_size: int,
    report,
    label: str,
) -> Tuple[List[Dict[str, Any]], str, float]:
    """Decode on one device, raising DecodeStalled rather than hanging forever."""
    model = await asyncio.to_thread(load_whisper_model, model_size, device, compute_type)
    await _invoke_report(report, PROGRESS_TRANSCRIBE_START, label)

    sink: List[Any] = []
    started = time.monotonic()
    logger.info("Decode start: model=%s device=%s beam=%d", model_size, device, beam_size)

    task = asyncio.create_task(
        asyncio.to_thread(_decode_sync, model, audio_path, language, beam_size, sink)
    )

    collected: List[Dict[str, Any]] = []
    texts: List[str] = []
    total = 0.0
    first_segment_at: Optional[float] = None
    consumed = 0
    span = PROGRESS_TRANSCRIBE_END - PROGRESS_TRANSCRIBE_START

    while True:
        # Drain whatever the worker has produced since the last tick.
        while consumed < len(sink):
            kind, value = sink[consumed]
            consumed += 1

            if kind == "duration":
                total = value
            elif kind == "segment":
                if first_segment_at is None:
                    first_segment_at = time.monotonic() - started
                    logger.info("First segment after %.1fs", first_segment_at)
                collected.append(value)
                texts.append(value["text"])
                if total > 0:
                    fraction = min(1.0, value["end"] / total)
                    await _invoke_report(
                        report, PROGRESS_TRANSCRIBE_START + span * fraction, label
                    )
            elif kind == "error":
                raise value
            elif kind == "done":
                elapsed = time.monotonic() - started
                logger.info(
                    "Decode finished: %d segments, %.0fs audio, %.1fs wall, %.1fx realtime",
                    len(collected), total, elapsed, (total / elapsed) if elapsed > 0 else 0.0,
                )
                return collected, " ".join(texts).strip(), total

        if task.done():
            # Thread ended without a terminal marker: re-raise whatever it hit.
            finished = await task
            if finished is None:
                logger.warning("Decode thread returned None; treating as finished")
            return collected, " ".join(texts).strip(), total

        elapsed = time.monotonic() - started
        if first_segment_at is None and elapsed > FIRST_SEGMENT_TIMEOUT:
            raise DecodeStalled(
                f"{device} produced no output in {elapsed:.0f}s"
            )
        if elapsed > TOTAL_DECODE_TIMEOUT:
            raise DecodeStalled(f"decode exceeded {TOTAL_DECODE_TIMEOUT:.0f}s on {device}")

        await asyncio.sleep(0.5)


async def _transcribe_builtin(
    audio_path: str,
    *,
    model_size: str,
    language: Optional[str],
    report,
) -> Tuple[List[Dict[str, Any]], str, float]:
    """Transcribe in-process, falling back to CPU if the GPU path wedges.

    A stalled GPU used to mean a job stuck forever. Now it costs one wasted
    minute and the transcript still arrives, which matters far more than
    finishing fast when someone is watching a demo.
    """
    device, compute_type = detect_compute_device()
    size = model_size or recommended_model(device)
    beam = 5 if device == "cuda" else 1

    try:
        return await _decode_on_device(
            audio_path,
            model_size=size,
            device=device,
            compute_type=compute_type,
            language=language,
            beam_size=beam,
            report=report,
            label="Расшифровка (локальная модель)",
        )
    except DecodeStalled as error:
        if device == "cpu":
            raise STTError(
                "Локальная модель не отвечает. Попробуйте модель поменьше: "
                "в настройках задайте размер 'base'."
            ) from error
        logger.warning("GPU decode stalled (%s). Falling back to CPU.", error)
    except Exception as error:
        if device == "cpu":
            raise
        logger.warning("GPU decode failed (%s: %s). Falling back to CPU.", type(error).__name__, error)

    # The wedged thread may still be holding the GPU, so drop our reference and
    # continue on CPU with a model sized for it.
    release_whisper_model()

    await _invoke_report(
        report, PROGRESS_TRANSCRIBE_START, "Видеокарта не отвечает, перехожу на процессор"
    )
    return await _decode_on_device(
        audio_path,
        model_size=model_size or recommended_model("cpu"),
        device="cpu",
        compute_type="int8",
        language=language,
        beam_size=1,
        report=report,
        label="Расшифровка (процессор)",
    )


ProgressCallback = Callable[[float, str], Any]


@dataclass
class TranscriptSegment:
    index: int
    speaker: str
    text: str
    timestamp_start: float
    timestamp_end: float
    timestamp_str: str = ""
    turn: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "speaker": self.speaker,
            "text": self.text,
            "timestamp_start": round(self.timestamp_start, 3),
            "timestamp_end": round(self.timestamp_end, 3),
            "timestamp_str": self.timestamp_str or format_timestamp(self.timestamp_start),
            "turn": self.turn,
        }


@dataclass
class TranscriptionResult:
    segments: List[TranscriptSegment] = field(default_factory=list)
    duration_seconds: float = 0.0
    raw_text: str = ""
    speaker_source: str = "none"
    chunk_count: int = 1

    def formatted_text(self) -> str:
        if not self.segments:
            return self.raw_text
        return "\n".join(
            f"[{segment.speaker}] {segment.timestamp_str or format_timestamp(segment.timestamp_start)}\n{segment.text}\n"
            for segment in self.segments
        )

    def segments_as_dicts(self) -> List[Dict[str, Any]]:
        return [segment.as_dict() for segment in self.segments]


def format_timestamp(seconds: float) -> str:
    seconds = max(0.0, float(seconds or 0.0))
    return f"[{time.strftime('%H:%M:%S', time.gmtime(seconds))}]"


# ---------------------------------------------------------------------------
# ffmpeg discovery
# ---------------------------------------------------------------------------

_ffmpeg_path: Optional[str] = None
_ffmpeg_checked = False


def resolve_ffmpeg() -> Optional[str]:
    """Locate an ffmpeg binary.

    Prefers ``imageio-ffmpeg``, which ships a static build as a wheel, because
    that is the only option that works on a fresh Windows machine without the
    user installing anything system wide. Falls back to ffmpeg on PATH.
    """
    global _ffmpeg_path, _ffmpeg_checked
    if _ffmpeg_checked:
        return _ffmpeg_path

    _ffmpeg_checked = True

    override = os.environ.get("STEPPE_FFMPEG")
    if override and pathlib.Path(override).exists():
        _ffmpeg_path = override
        logger.info("Using ffmpeg from STEPPE_FFMPEG: %s", override)
        return _ffmpeg_path

    try:
        import imageio_ffmpeg  # type: ignore

        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if candidate and pathlib.Path(candidate).exists():
            _ffmpeg_path = candidate
            logger.info("Using bundled ffmpeg from imageio-ffmpeg: %s", candidate)
            return _ffmpeg_path
    except Exception as error:  # pragma: no cover - optional dependency
        logger.debug("imageio-ffmpeg unavailable: %s", error)

    candidate = shutil.which("ffmpeg")
    if candidate:
        _ffmpeg_path = candidate
        logger.info("Using system ffmpeg: %s", candidate)
        return _ffmpeg_path

    logger.warning(
        "ffmpeg not found. Audio will be uploaded unconverted, which is slower "
        "and fails on large video files. Install imageio-ffmpeg to fix this."
    )
    _ffmpeg_path = None
    return None


def _run(command: Sequence[str], timeout: float = 900.0) -> subprocess.CompletedProcess:
    # CREATE_NO_WINDOW keeps a console window from flashing on every ffmpeg call
    # when the app is launched from a Windows shortcut.
    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        list(command),
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=creationflags,
    )


def probe_duration(path: str) -> float:
    """Return media duration in seconds, or 0.0 when it cannot be determined."""
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return 0.0

    # ffprobe usually sits next to ffmpeg, but the imageio wheel ships ffmpeg
    # only, so parse ffmpeg's own stderr banner instead of requiring ffprobe.
    try:
        result = _run([ffmpeg, "-i", path], timeout=120.0)
    except Exception as error:
        logger.debug("Duration probe failed for %s: %s", path, error)
        return 0.0

    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+\.?\d*)", result.stderr or "")
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def prepare_audio(source_path: str, work_dir: str) -> Tuple[str, float, bool]:
    """Normalise any input into 16 kHz mono WAV.

    Returns ``(path, duration_seconds, converted)``. When ffmpeg is missing the
    original path is returned untouched so the caller can still upload it.
    """
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return source_path, 0.0, False

    target = str(pathlib.Path(work_dir) / "normalized.wav")
    command = [
        ffmpeg,
        "-y",
        "-i", source_path,
        "-vn",                  # drop video, meetings recorded as MP4 carry a
                                # 128x128 dummy stream that is pure upload cost
        "-ac", "1",             # mono, Whisper downmixes anyway
        "-ar", "16000",         # 16 kHz is Whisper's native sample rate
        "-c:a", "pcm_s16le",
        target,
    ]

    try:
        result = _run(command)
    except subprocess.TimeoutExpired as error:
        raise STTError("ffmpeg timed out while converting the recording") from error
    except Exception as error:
        logger.warning("ffmpeg conversion failed, falling back to raw upload: %s", error)
        return source_path, 0.0, False

    if result.returncode != 0 or not pathlib.Path(target).exists():
        tail = (result.stderr or "")[-400:]
        logger.warning("ffmpeg returned %s, falling back to raw upload. %s", result.returncode, tail)
        return source_path, 0.0, False

    duration = probe_duration(target)
    size_mb = pathlib.Path(target).stat().st_size / (1024 * 1024)
    logger.info("Normalised audio: %.1f MB, %.0f seconds", size_mb, duration)
    return target, duration, True


def split_audio(wav_path: str, work_dir: str, chunk_seconds: int) -> List[Tuple[str, float]]:
    """Split a WAV into chunks, returning ``(path, offset_seconds)`` pairs."""
    ffmpeg = resolve_ffmpeg()
    duration = probe_duration(wav_path)

    if not ffmpeg or duration <= 0 or duration <= chunk_seconds:
        return [(wav_path, 0.0)]

    pattern = str(pathlib.Path(work_dir) / "chunk_%04d.wav")
    command = [
        ffmpeg,
        "-y",
        "-i", wav_path,
        "-f", "segment",
        "-segment_time", str(chunk_seconds),
        "-c", "copy",
        pattern,
    ]

    try:
        result = _run(command)
    except Exception as error:
        logger.warning("Chunk split failed, transcribing as one piece: %s", error)
        return [(wav_path, 0.0)]

    if result.returncode != 0:
        logger.warning("Chunk split returned %s, transcribing as one piece", result.returncode)
        return [(wav_path, 0.0)]

    chunks = sorted(pathlib.Path(work_dir).glob("chunk_*.wav"))
    if not chunks:
        return [(wav_path, 0.0)]

    return [(str(path), index * float(chunk_seconds)) for index, path in enumerate(chunks)]


# ---------------------------------------------------------------------------
# Provider call
# ---------------------------------------------------------------------------

def build_headers(api_key: Optional[str]) -> Dict[str, str]:
    """Bearer header for hosted providers, empty for a local server.

    The absence of this was the single reason no cloud STT provider could ever
    be configured in the previous build.
    """
    key = (api_key or "").strip()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def transcriptions_url(base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if not base:
        raise STTError("Whisper base URL is not configured")
    if base.endswith("/audio/transcriptions"):
        return base
    if not base.endswith("/v1") and "/v1/" not in base:
        base = f"{base}/v1"
    return f"{base}/audio/transcriptions"


def _guess_content_type(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    if guessed and guessed.startswith(("audio/", "video/")):
        return guessed
    if path.lower().endswith(".wav"):
        return "audio/wav"
    return "application/octet-stream"


async def _post_chunk(
    client: httpx.AsyncClient,
    url: str,
    headers: Dict[str, str],
    model: str,
    chunk_path: str,
    language: Optional[str],
) -> Dict[str, Any]:
    """Post one chunk, retrying once without verbose_json for strict servers."""
    filename = os.path.basename(chunk_path)
    content_type = _guess_content_type(chunk_path)

    attempts: List[Dict[str, str]] = [{"model": model, "response_format": "verbose_json"}]
    if language:
        attempts[0]["language"] = language
    attempts.append({"model": model})

    last_error = ""
    for payload in attempts:
        with open(chunk_path, "rb") as handle:
            files = {"file": (filename, handle, content_type)}
            try:
                response = await client.post(url, files=files, data=payload, headers=headers)
            except httpx.ConnectError as error:
                raise STTError(
                    f"Cannot reach the Whisper server at {url}. "
                    "Check the URL in Settings, or switch to a cloud provider."
                ) from error
            except httpx.TimeoutException as error:
                raise STTError(
                    "The Whisper server did not respond in time. "
                    "A smaller model or a cloud provider will be faster."
                ) from error

        if response.status_code == 200:
            try:
                return response.json()
            except json.JSONDecodeError:
                return {"text": response.text}

        last_error = f"HTTP {response.status_code}: {response.text[:300]}"
        if response.status_code in (401, 403):
            raise STTError(
                "The Whisper provider rejected the API key. "
                "Check the key in Settings."
            )
        if response.status_code == 413:
            raise STTError(
                "The audio chunk was rejected as too large. "
                "Install ffmpeg support so recordings can be split."
            )

    raise STTError(f"Whisper request failed. {last_error}")


def _segments_from_payload(payload: Dict[str, Any], offset: float) -> Tuple[List[Dict[str, Any]], str]:
    """Normalise a provider response into flat segment dicts with an offset applied."""
    raw_text = (payload.get("text") or "").strip()
    raw_segments = payload.get("segments")

    if isinstance(raw_segments, list) and raw_segments:
        segments = []
        for item in raw_segments:
            text = (item.get("text") or "").strip()
            if not text:
                continue
            start = float(item.get("start", 0) or 0) + offset
            end = float(item.get("end", start) or start) + offset
            segments.append({
                "text": text,
                "start": start,
                "end": end,
                "speaker": item.get("speaker"),
            })
        return segments, raw_text

    # No segment timings: split on sentence boundaries so the protocol generator
    # still receives something structured rather than one giant paragraph.
    if not raw_text:
        return [], ""

    pieces = [piece.strip() for piece in re.split(r"(?<=[.!?…])\s+", raw_text) if piece.strip()]
    segments = []
    for index, piece in enumerate(pieces):
        start = offset + index * 8.0
        segments.append({
            "text": piece,
            "start": start,
            "end": start + 8.0,
            "speaker": None,
        })
    return segments, raw_text


# ---------------------------------------------------------------------------
# Speaker turns
# ---------------------------------------------------------------------------

def assign_speaker_turns(
    segments: List[Dict[str, Any]],
    pause_threshold: float = DEFAULT_PAUSE_THRESHOLD,
    max_speakers: int = 6,
) -> Tuple[List[Dict[str, Any]], str]:
    """Group segments into speaker turns using silence gaps.

    This is turn detection, not voice identification: it finds *where* the
    speaker changed, not *who* is talking. That is an honest improvement over
    the previous ``idx % 3`` rotation, which invented speaker changes mid
    sentence. Names come from either the provider's own diarization, an
    optional LLM attribution pass, or the user editing them in the UI.
    """
    if not segments:
        return [], "none"

    provider_labels = {segment.get("speaker") for segment in segments if segment.get("speaker")}
    if len(provider_labels) > 1:
        # The provider did real diarization; trust it and only number the turns.
        turn = 0
        previous_label = None
        for segment in segments:
            label = segment.get("speaker")
            if label != previous_label:
                turn += 1
                previous_label = label
            segment["turn"] = turn
            segment["speaker"] = str(label)
        return segments, "provider"

    turn = 1
    speaker_index = 1
    segments[0]["turn"] = turn
    segments[0]["speaker"] = f"Спикер {speaker_index}"

    for previous, current in zip(segments, segments[1:]):
        gap = float(current.get("start", 0.0)) - float(previous.get("end", 0.0))
        ends_sentence = previous["text"].rstrip().endswith((".", "!", "?", "…", ":"))

        # A long silence is a turn change. A shorter silence counts only when the
        # previous utterance also closed a sentence, which avoids splitting a
        # speaker who simply paused for breath mid clause.
        is_turn_change = gap >= pause_threshold or (gap >= pause_threshold * 0.55 and ends_sentence)

        if is_turn_change:
            turn += 1
            speaker_index = (speaker_index % max_speakers) + 1

        current["turn"] = turn
        current["speaker"] = f"Спикер {speaker_index}"

    return segments, "pause"


async def attribute_speakers_with_llm(
    segments: List[Dict[str, Any]],
    participants: List[Dict[str, Any]],
    llm_module: Any,
) -> Tuple[List[Dict[str, Any]], bool]:
    """Ask the configured LLM to map detected turns onto named participants.

    Only runs when participants were supplied. Failure is non fatal: the pause
    based labels stay in place. The UI marks the result as auto attributed so a
    user checks it before exporting an official document.
    """
    names = [str(person.get("name") or "").strip() for person in participants if person.get("name")]
    if len(names) < 2 or not segments:
        return segments, False

    turns: List[Tuple[int, str]] = []
    for segment in segments:
        turn = int(segment.get("turn") or 0)
        if turns and turns[-1][0] == turn:
            turns[-1] = (turn, f"{turns[-1][1]} {segment['text']}")
        else:
            turns.append((turn, segment["text"]))

    # Cap the prompt so a three hour meeting does not blow the context window of
    # a small local model. Later turns keep their pause based labels.
    if len(turns) > 80:
        turns = turns[:80]

    preview = "\n".join(f"{turn}: {text[:220]}" for turn, text in turns)
    roster = "\n".join(f"- {name}" for name in names)

    prompt = (
        "Ниже реплики совещания, разбитые по сменам говорящего, и список участников.\n"
        "Определи, кто произносит каждую реплику, опираясь на обращения по имени, "
        "самопредставления, должностные формулировки и логику диалога.\n"
        "Если для реплики нет уверенной привязки, поставь null.\n\n"
        f"УЧАСТНИКИ:\n{roster}\n\n"
        f"РЕПЛИКИ:\n{preview}\n\n"
        'Верни только JSON вида {"1": "Имя", "2": null, ...} без пояснений.'
    )

    try:
        mapping = await llm_module.complete_json(
            [{"role": "user", "content": prompt}],
            temperature=0.0,
        )
    except Exception as error:
        # Attribution is a bonus pass. A model that is offline, slow or bad at
        # JSON must not cost the user their transcript.
        logger.info("LLM speaker attribution skipped: %s", error)
        return segments, False

    if isinstance(mapping, dict) and "speakers" in mapping:
        mapping = mapping["speakers"]
    if not isinstance(mapping, dict):
        return segments, False

    valid = {name.lower(): name for name in names}
    resolved: Dict[int, str] = {}
    for key, value in mapping.items():
        if not value:
            continue
        canonical = valid.get(str(value).strip().lower())
        if not canonical:
            continue
        try:
            resolved[int(key)] = canonical
        except (TypeError, ValueError):
            continue

    if not resolved:
        return segments, False

    for segment in segments:
        name = resolved.get(int(segment.get("turn") or 0))
        if name:
            segment["speaker"] = name

    logger.info("LLM attributed %d of %d turns to named participants", len(resolved), len(turns))
    return segments, True


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def transcribe_audio(
    audio_path: str,
    *,
    base_url: str = "",
    model: str = "",
    api_key: Optional[str] = None,
    provider: str = "builtin",
    language: Optional[str] = None,
    participants: Optional[List[Dict[str, Any]]] = None,
    llm_module: Any = None,
    chunk_seconds: int = DEFAULT_CHUNK_SECONDS,
    request_timeout: float = 900.0,
    progress: Optional[ProgressCallback] = None,
) -> TranscriptionResult:
    """Transcribe a recording end to end and return structured segments.

    ``provider="builtin"`` runs faster-whisper in this process and touches no
    network. ``provider="http"`` posts to an OpenAI-compatible endpoint, which
    may be a Whisper server on localhost or a hosted API.
    """

    if not os.path.exists(audio_path):
        raise STTError("The uploaded recording could not be found on disk")

    async def report(percent: float, label: str) -> None:
        await _invoke_report(progress, percent, label)

    work_dir = tempfile.mkdtemp(prefix="steppe_stt_")
    try:
        await report(PROGRESS_PREPARE, "Подготовка аудио")

        prepared_path, duration, converted = await asyncio.to_thread(
            prepare_audio, audio_path, work_dir
        )

        collected: List[Dict[str, Any]] = []
        raw_texts: List[str] = []
        total_chunks = 1

        if provider == "builtin":
            collected, raw_text, builtin_duration = await _transcribe_builtin(
                prepared_path,
                model_size=model,
                language=language,
                report=report,
            )
            if raw_text:
                raw_texts.append(raw_text)
            duration = duration or builtin_duration
        else:
            url = transcriptions_url(base_url)
            headers = build_headers(api_key)

            chunks = (
                await asyncio.to_thread(split_audio, prepared_path, work_dir, chunk_seconds)
                if converted
                else [(prepared_path, 0.0)]
            )
            total_chunks = len(chunks)
            logger.info("Transcribing %s in %d chunk(s) via %s", audio_path, total_chunks, url)

            span = PROGRESS_TRANSCRIBE_END - PROGRESS_TRANSCRIBE_START

            async with httpx.AsyncClient(timeout=request_timeout) as client:
                for position, (chunk_path, offset) in enumerate(chunks):
                    label = (
                        f"Расшифровка, часть {position + 1} из {total_chunks}"
                        if total_chunks > 1
                        else "Расшифровка аудио"
                    )
                    await report(
                        PROGRESS_TRANSCRIBE_START + span * (position / total_chunks), label
                    )

                    payload = await _post_chunk(client, url, headers, model, chunk_path, language)
                    chunk_segments, chunk_text = _segments_from_payload(payload, offset)
                    collected.extend(chunk_segments)
                    if chunk_text:
                        raw_texts.append(chunk_text)

        await report(PROGRESS_TRANSCRIBE_END, "Определение говорящих")

        if not collected and not raw_texts:
            raise STTError(
                "The provider returned an empty transcript. "
                "The recording may be silent or in an unsupported format."
            )

        collected.sort(key=lambda item: item.get("start", 0.0))
        collected, speaker_source = assign_speaker_turns(collected)

        if participants and llm_module is not None:
            collected, attributed = await attribute_speakers_with_llm(
                collected, participants, llm_module
            )
            if attributed:
                speaker_source = f"{speaker_source}+llm"

        segments = [
            TranscriptSegment(
                index=index,
                speaker=str(item.get("speaker") or "Спикер 1"),
                text=item["text"],
                timestamp_start=float(item.get("start", 0.0)),
                timestamp_end=float(item.get("end", 0.0)),
                timestamp_str=format_timestamp(item.get("start", 0.0)),
                turn=int(item.get("turn") or 0),
            )
            for index, item in enumerate(collected)
        ]

        if not duration and segments:
            duration = max(segment.timestamp_end for segment in segments)

        return TranscriptionResult(
            segments=segments,
            duration_seconds=duration,
            raw_text=" ".join(raw_texts).strip(),
            speaker_source=speaker_source,
            chunk_count=total_chunks,
        )

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def rename_speaker(segments: List[Dict[str, Any]], old_label: str, new_label: str) -> List[Dict[str, Any]]:
    """Rename every occurrence of a speaker label across a transcript."""
    new_label = (new_label or "").strip()
    if not new_label:
        raise STTError("The new speaker name cannot be empty")

    for segment in segments:
        if segment.get("speaker") == old_label:
            segment["speaker"] = new_label
    return segments


def rebuild_transcript_text(segments: List[Dict[str, Any]]) -> str:
    """Regenerate the flat transcript text after segments were edited."""
    return "\n".join(
        f"[{segment.get('speaker', 'Спикер 1')}] "
        f"{segment.get('timestamp_str') or format_timestamp(segment.get('timestamp_start', 0))}\n"
        f"{segment.get('text', '')}\n"
        for segment in segments
    )
