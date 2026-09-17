import os
import shutil
import subprocess
import sys

env = os.environ.copy()
# Put the new Rust toolchain first in PATH
env["PATH"] = r"C:\Users\User\rust-toolchain-1.98\bin;" + env.get("PATH", "")

print("=== Checking Compiler ===", flush=True)
r_rustc = subprocess.run([r"C:\Users\User\rust-toolchain-1.98\bin\rustc.exe", "--version"], env=env, capture_output=True, text=True)
print("rustc:", r_rustc.stdout.strip(), flush=True)

r_cargo = subprocess.run([r"C:\Users\User\rust-toolchain-1.98\bin\cargo.exe", "--version"], env=env, capture_output=True, text=True)
print("cargo:", r_cargo.stdout.strip(), flush=True)

print("\n=== Building Frontend ===", flush=True)
subprocess.run([r"npx.cmd", "tsc", "-b"], env=env, check=True)
subprocess.run([r"npx.cmd", "vite", "build"], env=env, check=True)

print("\n=== Building Tauri Release ===", flush=True)
res = subprocess.run([r"npx.cmd", "@tauri-apps/cli", "build"], env=env)
print(f"\nTauri build finished with code {res.returncode}", flush=True)

if res.returncode == 0:
    src = r"src-tauri\target\release\steppe-desktop.exe"
    dst = r"Steppe-Meeting.exe"
    if os.path.exists(src):
        shutil.copy2(src, dst)
        print(f"Copied {src} -> {dst} ({os.path.getsize(dst)} bytes)", flush=True)

sys.exit(res.returncode)
