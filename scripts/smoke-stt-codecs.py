"""Network-enabled, model-free STT installation/repair in an isolated bundle venv.

The app stays core-only. Use its portable Python, uv, core wheels and production
installer to test fresh setup and repair from beta.1's incompatible PyAV 19.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    resources = args.resources.resolve()
    backend = resources / "backend"
    runtime = resources / "runtime"
    with tempfile.TemporaryDirectory(prefix="steppe-stt-codecs-") as folder:
        work = Path(folder)
        data = work / "data"
        root = work / "runtime"
        root.mkdir()
        home = work / "home"
        home.mkdir()
        env = {"PATH": f"{runtime}:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
               "STEPPE_DATA_DIR": str(data), "PYTHONDONTWRITEBYTECODE": "1",
               "UV_PYTHON_DOWNLOADS": "never", "HF_HUB_OFFLINE": "1",
               "HF_HUB_DISABLE_TELEMETRY": "1"}

        def run(command, timeout=120):
            subprocess.run(list(map(str, command)), cwd="/", env=env, check=True, timeout=timeout)

        bootstrap = f"import sys; sys.path.insert(0, {str(backend)!r}); "
        run([args.python, "-B", "-c", bootstrap +
             f"from pathlib import Path; from bundled_runtime import prepare; prepare(Path({str(runtime)!r}), Path({str(root)!r}))"])
        python = root / ".venv/bin/python"
        run([python, "-B", "-c", "import importlib.util; assert importlib.util.find_spec('faster_whisper') is None; print('PASS core-only baseline: no optional STT')"])
        # An unrelated environment file and user model data must survive repair.
        sentinel = root / ".venv/preserve-existing-dependencies"
        sentinel.write_text("unrelated model dependencies")
        weights = data / "models/whisper/synthetic-preserve/weights.bin"
        weights.parent.mkdir(parents=True)
        weights.write_bytes(b"synthetic weights sentinel")
        driver = bootstrap + '''
import time
from engine import whisper_service as service
assert service.start_install_env("small")["status"] == "started"
deadline = time.monotonic() + 660
while service._env_state["installing"]:
    assert time.monotonic() < deadline, "installer exceeded deadline"
    time.sleep(.1)
assert not service._env_state["error"], service._env_state
assert service.is_env_installed("small"), service.env_error("small")
assert service.start_install_env("small")["status"] == "already_installed"
print("PASS production installer, actual decode and idempotent setup")
'''
        run([python, "-B", "-c", driver], timeout=700)
        decode = bootstrap + '''
import io, json, wave
import av
import numpy as np
from importlib.metadata import version
from faster_whisper.audio import decode_audio
from engine.stt_runtime import decode_probe
from engine import whisper_service as service
assert service.is_env_installed("small"), service.env_error("small")
decode_probe()
webm = io.BytesIO()
with av.open(webm, "w", format="webm") as output:
    stream = output.add_stream("libopus", rate=48000)
    stream.layout = "mono"
    frame = av.AudioFrame.from_ndarray(np.zeros((1, 9600), dtype=np.float32), format="flt", layout="mono")
    frame.sample_rate = 48000
    for packet in stream.encode(frame):
        output.mux(packet)
    for packet in stream.encode(None):
        output.mux(packet)
webm.seek(0)
audio = decode_audio(webm, sampling_rate=16000)
assert len(audio) == 3200, len(audio)
assert np.isfinite(audio).all()
try:
    decode_audio(io.BytesIO(b"deliberately corrupt audio"), sampling_rate=16000)
except av.error.InvalidDataError:
    pass
else:
    raise AssertionError("corrupt audio should remain an audio error")
assert service.is_env_installed("small"), "corrupt input must not invalidate environment"
print("PASS WAV 1600 + WebM/Opus 3200 samples + corrupt-input distinction", json.dumps({n: version(n) for n in ("faster-whisper", "av", "ctranslate2")}))
'''
        run([python, "-B", "-c", decode])
        print("PASS fresh production STT profile in portable bundled runtime", flush=True)
        run([runtime / "uv", "pip", "install", "--python", python, "av==19.0.2"], timeout=180)
        run([python, "-B", "-c", bootstrap + '''
from engine import whisper_service as service
from engine.stt_runtime import decode_probe
try:
    decode_probe()
except TypeError as error:
    assert "metadata_errors" in str(error), str(error)
else:
    raise AssertionError("bad PyAV must reproduce installed beta.1 failure")
assert not service.is_env_installed("small")
status = service.get_whisper_full_status("local", "", "", "", "small")
assert not status["ready"]
assert "Установить среду" in status["local"]["error"], status
for name in ("small", "wav2vec2-kk", "vosk-small-kz"):
    assert not service.is_env_installed(name)
print("PASS beta.1 exact TypeError reproduced; status rejects bad PyAV with repair action")
'''])
        run([python, "-B", "-c", driver], timeout=700)
        run([python, "-B", "-c", decode])
        assert sentinel.read_text() == "unrelated model dependencies"
        assert weights.read_bytes() == b"synthetic weights sentinel"
        print("PASS upgrade/repair from av 19.0.2; existing dependency files and model data preserved", flush=True)
        if args.report:
            versions = json.loads(subprocess.check_output([str(python), "-B", "-c",
                "import json; from importlib.metadata import version; print(json.dumps({n: version(n) for n in ('faster-whisper', 'av', 'ctranslate2')}))"],
                env=env, cwd="/", text=True, timeout=20))
            args.report.write_text(json.dumps({"result": "passed", "profile": versions,
                "runtime": "packaged portable CPython", "fresh_install": True,
                "upgrade_from_av": "19.0.2", "wav_samples": 1600, "webm_opus_samples": 3200,
                "corrupt_audio_distinct": True, "model_downloads": False,
                "existing_model_data_preserved": True}, indent=2) + "\n")


if __name__ == "__main__":
    main()
