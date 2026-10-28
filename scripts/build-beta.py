"""Build, verify and package a local beta. Never publish, tag or install it.

Run with a Python that has pip: python3 scripts/build-beta.py
Prerequisites: Apple Silicon macOS 15+, Xcode CLI tools, Rust, Node, pnpm install.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, timeout=240):
    print("Running:", " ".join(map(str, command)), flush=True)
    subprocess.run(list(map(str, command)), cwd=ROOT, check=True, timeout=timeout)


def inputs():
    patterns = ["src/**/*", "src-tauri/src/**/*", "src-tauri/icons/*", "public/**/*",
                "backend/*.py", "backend/engine/*.py", "backend/engine/core/*.py",
                "backend/run_backend.sh", "backend/requirements*.txt", "backend/requirements*.lock"]
    files = {p for pattern in patterns for p in ROOT.glob(pattern) if p.is_file()}
    files.update(ROOT / p for p in ("package.json", "pnpm-lock.yaml", "src-tauri/Cargo.lock",
                                    "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json", "src-tauri/tauri.beta.conf.json", "src-tauri/build.rs",
                                    "src-tauri/Info.plist", "src-tauri/Entitlements.plist", "scripts/runtime-sources.json"))
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(files)}


def native_build():
    # Direct JS entry points avoid executable shell shims. Do not weaken macOS
    # policy or replace blocked binaries. Bound inactivity and stop our group.
    overlay = json.loads((ROOT / "src-tauri/tauri.beta.conf.json").read_text())
    overlay["build"] = {"beforeBuildCommand": ""}
    command = ["node", "node_modules/@tauri-apps/cli/tauri.js", "build", "--ci", "--bundles", "app",
               "--config", json.dumps(overlay), "--", "--locked"]
    path = BUILD / "release-build.log"
    with path.open("w") as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
        start = last_change = time.monotonic()
        size = 0
        try:
            while process.poll() is None:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                current = path.stat().st_size
                if current != size:
                    size, last_change = current, time.monotonic()
                if time.monotonic() - last_change > 180 or time.monotonic() - start > 1800:
                    raise RuntimeError(f"Native build stopped after inactivity/time limit; inspect {path}")
            if process.returncode:
                raise RuntimeError(f"Native build failed ({process.returncode}); inspect {path}")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


def audit(app, stamp):
    resources = app / "Contents/Resources"
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    config["bundle"]["resources"].update(json.loads((ROOT / "src-tauri/tauri.beta.conf.json").read_text())["bundle"]["resources"])
    expected = set()
    # Check every configured resource byte-for-byte, and reject extra data.
    for pattern, destination in config["bundle"]["resources"].items():
        source_pattern = ROOT / "src-tauri" / pattern
        if source_pattern.is_dir():
            for source in source_pattern.rglob("*"):
                if source.is_file():
                    relative = Path(destination) / source.relative_to(source_pattern)
                    assert sha(source) == sha(resources / relative), relative
                    expected.add(str(relative))
        elif "*" in pattern:
            for source in source_pattern.parent.glob(source_pattern.name):
                relative = Path(destination) / source.name
                assert sha(source) == sha(resources / relative), relative
                expected.add(str(relative))
        else:
            relative = Path(destination)
            assert sha(source_pattern) == sha(resources / relative), relative
            expected.add(str(relative))
    actual = {str(p.relative_to(resources)) for p in resources.rglob("*") if p.is_file()}
    extras = actual - expected
    assert all(Path(p).suffix == ".icns" and len(Path(p).parts) == 1 for p in extras), extras
    assert not any(p.suffix in {".db", ".sqlite", ".sqlite3", ".wav", ".webm", ".m4a", ".key", ".pem"}
                   or p.name.startswith(".env") or "__pycache__" in p.parts for p in resources.rglob("*"))
    assert json.loads((resources / "build-info.json").read_text()) == stamp
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    assert info["CFBundleShortVersionString"] == stamp["version"], info
    run(["/usr/bin/lipo", "-verify_arch", "arm64", app / "Contents/MacOS/steppe-desktop"])
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    return {str(p.relative_to(app)): sha(p) for p in sorted(app.rglob("*")) if p.is_file()}


def main():
    assert platform.system() == "Darwin" and platform.machine() == "arm64", "Build on Apple Silicon macOS"
    BUILD.mkdir(exist_ok=True)
    package = json.loads((ROOT / "package.json").read_text())
    version = package["version"]
    assert version == "0.2.0-beta.1"
    assert json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"] == version
    assert f'version = "{version}"' in (ROOT / "src-tauri/Cargo.toml").read_text()
    run([sys.executable, ROOT / "scripts/prepare-runtime.py"], timeout=360)
    run(["node", "node_modules/typescript/bin/tsc", "-b"])
    run(["node", "node_modules/vite/bin/vite.js", "build"])
    source = inputs()
    stamp = {"version": version, "arch": "aarch64", "source_head": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "source_files": source,
        "frontend_files": {str(p.relative_to(ROOT / "dist")): sha(p) for p in sorted((ROOT / "dist").rglob("*")) if p.is_file()},
        "runtime_manifest_sha256": sha(BUILD / "bundled-runtime/manifest.json")}
    (BUILD / "build-info.json").write_text(json.dumps(stamp, indent=2) + "\n")
    native_build()
    assert inputs() == source, "Source changed during native build; rebuild before distributing"
    built = ROOT / "src-tauri/target/release/bundle/macos/Steppe Meeting.app"
    manifest = audit(built, stamp)
    run([sys.executable, ROOT / "scripts/smoke-bundled-runtime.py", "--app", built], timeout=260)
    # A failing runtime test stops here, before anything is labelled distributable.
    output = BUILD / f"release-{version}-aarch64"
    output.mkdir(exist_ok=True)
    app = output / f"Steppe-Meeting_{version}_aarch64.app"
    if app.exists():
        shutil.rmtree(app)
    run(["/usr/bin/ditto", built, app])
    staging = output / "dmg-staging"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    run(["/usr/bin/ditto", app, staging / "Steppe Meeting.app"])
    (staging / "Applications").symlink_to("/Applications")
    dmg = output / f"Steppe-Meeting_{version}_aarch64.dmg"
    run(["/usr/bin/hdiutil", "create", "-ov", "-format", "UDZO", "-volname", f"Steppe Meeting {version}",
         "-srcfolder", staging, dmg])
    mounted = plistlib.loads(subprocess.check_output(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(dmg)]))
    mount = next(Path(item["mount-point"]) for item in mounted["system-entities"] if "mount-point" in item)
    try:
        assert (mount / "Applications").is_symlink()
        assert os.readlink(mount / "Applications") == "/Applications"
        assert audit(mount / "Steppe Meeting.app", stamp) == manifest
    finally:
        run(["/usr/bin/hdiutil", "detach", mount])
    (output / "app-content-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    shutil.copy2(BUILD / "build-info.json", output)
    shutil.copy2(ROOT / "DISTRIBUTION.md", output)
    (output / "SHA256SUMS").write_text(f"{sha(dmg)}  {dmg.name}\n")
    print(f"VERIFIED LOCAL BETA: {dmg} ({dmg.stat().st_size} bytes), SHA256 {sha(dmg)}", flush=True)


if __name__ == "__main__":
    main()
