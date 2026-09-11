"""Verification harness for engine/stt.py. Runs without FastAPI."""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from engine import stt  # noqa: E402

FAILURES = []


def check(name, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {name}" + (f"  -> {detail}" if detail else ""))
    if not condition:
        FAILURES.append(name)


# --- 1. ffmpeg discovery -----------------------------------------------------
ffmpeg = stt.resolve_ffmpeg()
check("ffmpeg resolves", bool(ffmpeg), ffmpeg or "not found")

# --- 2. URL building ---------------------------------------------------------
cases = [
    ("http://localhost:8000/v1", "http://localhost:8000/v1/audio/transcriptions"),
    ("http://localhost:8000/v1/", "http://localhost:8000/v1/audio/transcriptions"),
    ("https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1/audio/transcriptions"),
    ("http://localhost:8000", "http://localhost:8000/v1/audio/transcriptions"),
    ("http://x/v1/audio/transcriptions", "http://x/v1/audio/transcriptions"),
]
for raw, expected in cases:
    got = stt.transcriptions_url(raw)
    check(f"url {raw}", got == expected, got)

try:
    stt.transcriptions_url("")
    check("empty url raises", False)
except stt.STTError:
    check("empty url raises", True)

# --- 3. auth headers ---------------------------------------------------------
check("no key -> no header", stt.build_headers("") == {})
check("key -> bearer", stt.build_headers("gsk_abc") == {"Authorization": "Bearer gsk_abc"})
check("key is stripped", stt.build_headers("  gsk_abc  ") == {"Authorization": "Bearer gsk_abc"})

# --- 4. speaker turn detection ----------------------------------------------
segments = [
    {"text": "Добрый день, начинаем совещание.", "start": 0.0, "end": 3.0, "speaker": None},
    {"text": "Первый вопрос по бюджету.", "start": 3.1, "end": 6.0, "speaker": None},
    {"text": "Я подготовил расчёты.", "start": 9.5, "end": 12.0, "speaker": None},
    {"text": "Цифры сходятся.", "start": 12.2, "end": 14.0, "speaker": None},
    {"text": "Хорошо, принимаем.", "start": 18.0, "end": 20.0, "speaker": None},
]
result, source = stt.assign_speaker_turns([dict(s) for s in segments])
turns = [s["turn"] for s in result]
speakers = [s["speaker"] for s in result]
check("pause detection source", source == "pause", source)
check("turn 1 groups first two", turns[0] == turns[1] == 1, str(turns))
check("long pause starts turn 2", turns[2] == 2, str(turns))
check("short pause keeps turn 2", turns[3] == 2, str(turns))
check("third turn detected", turns[4] == 3, str(turns))
check("no round-robin within a turn", speakers[0] == speakers[1], str(speakers))
check("speaker changes across turns", speakers[0] != speakers[2], str(speakers))

# provider diarization wins when present
diarized = [
    {"text": "a", "start": 0, "end": 1, "speaker": "SPEAKER_00"},
    {"text": "b", "start": 1, "end": 2, "speaker": "SPEAKER_01"},
]
result2, source2 = stt.assign_speaker_turns(diarized)
check("provider diarization respected", source2 == "provider", source2)
check("provider labels kept", result2[0]["speaker"] == "SPEAKER_00")

check("empty input safe", stt.assign_speaker_turns([]) == ([], "none"))

# --- 5. payload normalisation with offsets ----------------------------------
payload = {
    "text": "привет мир",
    "segments": [
        {"start": 0.0, "end": 2.0, "text": " привет"},
        {"start": 2.0, "end": 4.0, "text": " мир"},
        {"start": 4.0, "end": 5.0, "text": "   "},
    ],
}
segs, raw = stt._segments_from_payload(payload, offset=600.0)
check("offset applied", segs[0]["start"] == 600.0, str(segs[0]))
check("blank segments dropped", len(segs) == 2, str(len(segs)))
check("text trimmed", segs[0]["text"] == "привет", segs[0]["text"])

# fallback when no segments
segs2, raw2 = stt._segments_from_payload({"text": "Первое. Второе! Третье?"}, offset=0.0)
check("sentence fallback splits", len(segs2) == 3, str([s["text"] for s in segs2]))

# --- 6. rename + rebuild -----------------------------------------------------
renamed = stt.rename_speaker([dict(s) for s in result], "Спикер 1", "Айдана")
check("rename applies", renamed[0]["speaker"] == "Айдана")
check("rename leaves others", renamed[2]["speaker"] == "Спикер 2", renamed[2]["speaker"])
try:
    stt.rename_speaker(renamed, "Айдана", "  ")
    check("empty rename rejected", False)
except stt.STTError:
    check("empty rename rejected", True)

text = stt.rebuild_transcript_text(renamed)
check("rebuilt text has name", "[Айдана]" in text, text.split("\n")[0])

# --- 7. real ffmpeg conversion + chunking -----------------------------------
if ffmpeg:
    work = tempfile.mkdtemp()
    src = os.path.join(work, "source.mp4")
    # 25 seconds of tone in an MP4 container with a video stream, mimicking the
    # Tauri screen recorder output.
    subprocess.run([
        ffmpeg, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=25",
        "-f", "lavfi", "-i", "color=c=black:s=128x128:d=25",
        "-shortest", "-c:v", "libx264", "-c:a", "aac", src,
    ], capture_output=True)

    ok = pathlib.Path(src).exists()
    check("test mp4 created", ok)

    if ok:
        src_mb = pathlib.Path(src).stat().st_size
        out_dir = tempfile.mkdtemp()
        wav, duration, converted = stt.prepare_audio(src, out_dir)
        check("mp4 converted to wav", converted and wav.endswith(".wav"), wav)
        check("duration probed", 24 < duration < 26, f"{duration:.1f}s")

        probe = subprocess.run([ffmpeg, "-i", wav], capture_output=True, text=True).stderr
        check("16kHz mono pcm", "16000 Hz, mono" in probe, probe.split("Stream #0:0")[-1][:60].strip())
        check("video stream dropped", "Video:" not in probe.split("Input #0")[-1])

        chunks = stt.split_audio(wav, out_dir, chunk_seconds=10)
        check("split into 3 chunks", len(chunks) == 3, str(len(chunks)))
        check("offsets correct", [c[1] for c in chunks] == [0.0, 10.0, 20.0], str([c[1] for c in chunks]))

        short = stt.split_audio(wav, out_dir, chunk_seconds=600)
        check("short audio not split", len(short) == 1, str(len(short)))

# --- 8. progress callback ordering ------------------------------------------
reported = []


async def fake_flow():
    """Drive transcribe_audio against a stub provider to check progress + stitching."""
    calls = []

    class StubResponse:
        status_code = 200

        def __init__(self, index):
            self.index = index

        def json(self):
            return {
                "text": f"chunk {self.index}",
                "segments": [
                    {"start": 0.0, "end": 3.0, "text": f"реплика {self.index} первая."},
                    {"start": 5.0, "end": 8.0, "text": f"реплика {self.index} вторая."},
                ],
            }

    class StubClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, files=None, data=None, headers=None):
            calls.append({"url": url, "headers": headers, "model": data.get("model")})
            return StubResponse(len(calls))

    original = stt.httpx.AsyncClient
    stt.httpx.AsyncClient = StubClient
    try:
        res = await stt.transcribe_audio(
            src,
            base_url="https://api.groq.com/openai/v1",
            model="whisper-large-v3-turbo",
            api_key="gsk_test",
            provider="http",
            chunk_seconds=10,
            progress=lambda p, l: reported.append((round(p), l)),
        )
    finally:
        stt.httpx.AsyncClient = original

    return res, calls


if ffmpeg and pathlib.Path(src).exists():
    res, calls = asyncio.run(fake_flow())
    check("three chunks posted", len(calls) == 3, str(len(calls)))
    check("auth header sent", calls[0]["headers"] == {"Authorization": "Bearer gsk_test"}, str(calls[0]["headers"]))
    check("correct endpoint", calls[0]["url"] == "https://api.groq.com/openai/v1/audio/transcriptions", calls[0]["url"])
    check("segments stitched", len(res.segments) == 6, str(len(res.segments)))
    starts = [s.timestamp_start for s in res.segments]
    check("timestamps offset per chunk", starts == [0.0, 5.0, 10.0, 15.0, 20.0, 25.0], str(starts))
    check("timestamps monotonic", starts == sorted(starts))
    check("indices renumbered", [s.index for s in res.segments] == list(range(6)))
    check("progress reported", len(reported) >= 4, str(reported))
    check("progress monotonic", [p for p, _ in reported] == sorted(p for p, _ in reported), str([p for p, _ in reported]))
    check("chunk labels", any("часть 2 из 3" in l for _, l in reported), str([l for _, l in reported]))
    formatted = res.formatted_text()
    check("formatted transcript built", "[Спикер" in formatted and "[00:00:15]" in formatted, formatted.split("\n")[0])
    check("segments serialise to json", bool(json.dumps(res.segments_as_dicts(), ensure_ascii=False)))

# --- 9. offline default -----------------------------------------------------
import inspect
sig = inspect.signature(stt.transcribe_audio)
check("builtin is the default provider", sig.parameters["provider"].default == "builtin",
      str(sig.parameters["provider"].default))
check("builtin path needs no base_url", sig.parameters["base_url"].default == "")
check("faster_whisper_available does not raise", isinstance(stt.faster_whisper_available(), bool))
device, compute = stt.detect_compute_device()
check("device detection returns a pair", device in ("cpu", "cuda"), f"{device}/{compute}")
check("cpu recommends small", stt.recommended_model("cpu") == "small")
check("gpu recommends large", stt.recommended_model("cuda") == "large-v3")

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("All checks passed.")
