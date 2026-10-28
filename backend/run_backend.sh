#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Release resources are self-contained. Extract portable CPython into user data;
# never run pip, write bytecode, or create a venv inside the signed .app.
if [ -f "$DIR/../runtime/manifest.json" ]; then
    RESOURCES="$(cd "$DIR/../runtime" && pwd)"
    export PATH="$RESOURCES:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    export PYTHONDONTWRITEBYTECODE=1
    unset PYTHONHOME PYTHONPATH
    RUNTIME_ID="$(/usr/bin/shasum -a 256 "$RESOURCES/manifest.json" | /usr/bin/cut -c1-20)"
    RUNTIME_DIR="${STEPPE_DATA_DIR:-$HOME/Library/Application Support/Steppe Meeting}/runtime/$RUNTIME_ID"
    /bin/mkdir -p "$RUNTIME_DIR"
    if [ ! -x "$RUNTIME_DIR/python/bin/python3" ]; then
        # mkdir acts as a bounded cross-process extraction lock.
        LOCK="$RUNTIME_DIR/.extract-lock"
        for ((attempt=0; attempt<30; attempt++)); do
            if /bin/mkdir "$LOCK" 2>/dev/null; then break; fi
            owner="$(/bin/cat "$LOCK/pid" 2>/dev/null || true)"
            case "$owner" in
                ''|*[!0-9]*) ;;
                *) if ! kill -0 "$owner" 2>/dev/null; then
                       /bin/rm -f "$LOCK/pid"
                       /bin/rmdir "$LOCK" 2>/dev/null || true
                   fi ;;
            esac
            /bin/sleep 1
        done
        if [ "$attempt" -eq 30 ]; then
            echo "Встроенный Python занят подготовкой. Повторите запуск через минуту; см. backend.log." >&2
            exit 1
        fi
        printf '%s\n' "$$" > "$LOCK/pid"
        TEMP_RUNTIME="$(/usr/bin/mktemp -d "$RUNTIME_DIR/.extract.XXXXXX")"
        trap '/bin/rm -rf "$TEMP_RUNTIME"; /bin/rm -f "$LOCK/pid"; /bin/rmdir "$LOCK" 2>/dev/null || true' EXIT
        if [ ! -x "$RUNTIME_DIR/python/bin/python3" ]; then
            /usr/bin/tar -xzf "$RESOURCES/python.tar.gz" -C "$TEMP_RUNTIME"
            /bin/mv "$TEMP_RUNTIME/python" "$RUNTIME_DIR/python"
        fi
        /bin/rm -rf "$TEMP_RUNTIME"
        /bin/rm -f "$LOCK/pid"
        /bin/rmdir "$LOCK"
        trap - EXIT
    fi
    cd /
    exec "$RUNTIME_DIR/python/bin/python3" "$DIR/bundled_runtime.py" "$RESOURCES" "$RUNTIME_DIR" "$DIR"
fi

# A production bundle with incomplete resources must fail instead of silently
# borrowing a checkout or requiring a user to install development tools.
if [ -d "$DIR/../MacOS" ] || [ -d "$DIR/../../MacOS" ]; then
    echo "Отсутствует встроенный Python runtime. Установите полную сборку Steppe Meeting заново." >&2
    exit 1
fi
# Finder does not inherit a terminal's PATH. Keep package tools discoverable for
# both initial setup and the model-specific STT installer inside Python.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -n "${TMPDIR:-}" ] && [ ! -d "$TMPDIR" ]; then
    unset TMPDIR
fi

ENV_DIR="$DIR/.venv"
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
