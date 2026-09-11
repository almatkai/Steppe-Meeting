#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
PYTHON="$DIR/.venv/bin/python"

if [ ! -f "$PYTHON" ]; then
    echo "Creating virtual environment in $DIR/.venv..."
    uv venv "$DIR/.venv"
    uv pip install -r "$DIR/requirements.txt" --python "$PYTHON"
fi

echo "Starting Steppe Meeting Local Backend Server..."
cd "$DIR"
exec "$PYTHON" "$DIR/desktop_server.py"
