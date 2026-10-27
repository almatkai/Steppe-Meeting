#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
TAURI_APP="$DIR/src-tauri/target/debug/bundle/macos/Steppe Meeting.app"
cd "$DIR"

# The native app owns backend startup, readiness, retry and shutdown, including
# when launched directly from Finder. No terminal-owned background server.
if [ ! -d node_modules ]; then
    pnpm install --frozen-lockfile
fi
pnpm exec tauri build --debug --bundles app
open -W "$TAURI_APP"
