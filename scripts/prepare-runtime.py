"""Prepare offline Apple Silicon resources using official, checksum-pinned sources.

Build prerequisite: Python 3 with pip (not needed by the distributed app).
The output is intentionally ignored by Git; never copy a developer venv.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "build/bundled-runtime"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    sources = json.loads((ROOT / "scripts/runtime-sources.json").read_text())
    cache = ROOT / "build/runtime-downloads"
    cache.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ("python", "uv"):
        source = sources[name]
        archive = cache / f"{name}.tar.gz"
        if not archive.exists() or digest(archive) != source["sha256"]:
            with urlopen(source["url"], timeout=60) as response, archive.open("wb") as target:
                shutil.copyfileobj(response, target)
        if digest(archive) != source["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {name}")
    shutil.copy2(cache / "python.tar.gz", OUTPUT / "python.tar.gz")
    with tarfile.open(cache / "uv.tar.gz") as archive:
        # Extract only known files, never arbitrary archive paths.
        for name in ("uv",):
            member = next(m for m in archive.getmembers() if m.name.endswith("/" + name))
            with archive.extractfile(member) as source, (OUTPUT / name).open("wb") as target:
                shutil.copyfileobj(source, target)
    for name, checksum in sources["uv-licenses"].items():
        with urlopen(f"https://raw.githubusercontent.com/astral-sh/uv/{sources['uv']['version']}/{name}", timeout=30) as response:
            license_text = response.read()
        if hashlib.sha256(license_text).hexdigest() != checksum:
            raise RuntimeError(f"Checksum mismatch: {name}")
        (OUTPUT / name).write_bytes(license_text)
    (OUTPUT / "uv").chmod(0o755)
    lock = ROOT / "backend/requirements-macos-arm64.lock"
    shutil.copy2(lock, OUTPUT / "requirements.lock")
    wheels = OUTPUT / "wheels"
    if wheels.exists():
        shutil.rmtree(wheels)
    wheels.mkdir()
    subprocess.run([
        sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
        "--index-url", "https://pypi.org/simple", "--only-binary=:all:", "--no-deps",
        "--require-hashes", "--python-version", "3.12", "--implementation", "cp",
        "--abi", "cp312", "--abi", "abi3", "--abi", "none",
        "--platform", "macosx_15_0_arm64", "--dest", str(wheels), "-r", str(lock),
    ], check=True, timeout=240)
    files = {str(p.relative_to(OUTPUT)): digest(p) for p in sorted(OUTPUT.rglob("*"))
             if p.is_file() and p.name != "manifest.json"}
    (OUTPUT / "manifest.json").write_text(json.dumps({"sources": sources, "files": files}, indent=2) + "\n")
    print(f"Prepared {len(files)} offline runtime resources in {OUTPUT}")


if __name__ == "__main__":
    main()
