#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
# Finder does not inherit a terminal's PATH. Keep package tools discoverable for
# both initial setup and the model-specific STT installer inside Python.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -n "${TMPDIR:-}" ] && [ ! -d "$TMPDIR" ]; then
    unset TMPDIR
fi

# A bundled app is read-only. Reuse the checkout's environment when available;
# otherwise keep its Python environment alongside the user's application data.
if [ -d "$DIR/.venv" ] || [ ! -d "$DIR/../MacOS" -a ! -d "$DIR/../../MacOS" ]; then
    ENV_DIR="$DIR/.venv"
else
    ENV_DIR="${STEPPE_DATA_DIR:-$HOME/Library/Application Support/Steppe Meeting}/runtime/.venv"
fi
PYTHON="$ENV_DIR/bin/python"
if [ ! -x "$PYTHON" ]; then
    if ! command -v uv >/dev/null 2>&1; then
        echo "Для подготовки Python установите uv, затем повторите запуск: https://docs.astral.sh/uv/" >&2
        exit 1
    fi
    uv venv --python 3.12 "$ENV_DIR"
fi

# Existing venvs also need dependency updates. The stamp avoids contacting a
# package index on subsequent launches, while the import probe repairs damage.
FINGERPRINT="$(shasum -a 256 "$DIR/requirements.txt" | cut -d ' ' -f 1)"
STAMP="$ENV_DIR/.steppe-requirements"
if [ "$(cat "$STAMP" 2>/dev/null || true)" != "$FINGERPRINT" ] || ! "$PYTHON" -c 'import fastapi, uvicorn, pydantic_settings, multipart, httpx, docx, docxtpl, backoff, lxml, PIL' >/dev/null 2>&1; then
    if command -v uv >/dev/null 2>&1; then
        uv pip install -r "$DIR/requirements.txt" --python "$PYTHON"
    else
        "$PYTHON" -m pip install -r "$DIR/requirements.txt"
    fi
    printf '%s\n' "$FINGERPRINT" > "$STAMP"
fi

echo "Starting Steppe Meeting Local Backend Server..."
cd "$DIR"
exec "$PYTHON" "$DIR/desktop_server.py"
