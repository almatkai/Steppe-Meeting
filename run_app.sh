#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
BACKEND_DIR="$DIR/backend"
TAURI_BIN="$DIR/src-tauri/target/debug/steppe-desktop"

echo "=================================================="
echo "    Steppe Meeting - Local Desktop Application"
echo "=================================================="

# 1. Start Local Backend Server if not running
BACKEND_PID=""
VITE_PID=""

cleanup() {
    echo ""
    echo "Shutting down Steppe Meeting background processes..."
    if [ -n "$VITE_PID" ]; then
        kill "$VITE_PID" 2>/dev/null || true
    fi
    if [ -n "$BACKEND_PID" ]; then
        kill "$BACKEND_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

if ! curl -s http://127.0.0.1:8008/api/v1/system/status >/dev/null 2>&1; then
    echo "Starting local Python backend server on port 8008..."
    "$BACKEND_DIR/run_backend.sh" &
    BACKEND_PID=$!
    echo "Backend started with PID $BACKEND_PID"
    sleep 2
else
    echo "Backend is already running on port 8008."
fi

# 2. Start local Vite dev server on port 1420 with Hot Module Replacement (HMR)
# Live reload enabled: no need to run 'npm run build' or 'pnpm build' every day!
if ! curl -s http://localhost:1420 >/dev/null 2>&1; then
    echo "Starting local Vite dev server on port 1420 (HMR live reload enabled)..."
    cd "$DIR"
    npx vite --port 1420 --host &
    VITE_PID=$!
    sleep 2
else
    echo "Dev server is already running on port 1420."
fi

# 4. Build Tauri binary if not built
if [ ! -f "$TAURI_BIN" ]; then
    echo "Tauri binary not found. Building now..."
    cd "$DIR/src-tauri" && cargo build
fi

# 5. Launch Tauri Native Desktop App
echo "Launching Steppe Meeting Tauri Desktop App..."
"$TAURI_BIN"
